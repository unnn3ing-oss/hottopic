/* Cloudflare Worker：登入驗證閘道。
 * POST /login {password}            → 通過後簽發 12 小時憑證
 * POST /api   {session, action, args} → 驗憑證後加上 API_TOKEN 轉送 Apps Script
 * Secrets：APP_PASSWORD、SESSION_SECRET、API_TOKEN、APPS_SCRIPT_URL（各至少 32 字元，網址除外）
 * Variable：ALLOWED_ORIGIN（例如 https://unnn3ing-oss.github.io）
 * 選用：FAIL_DELAY_MS（登入失敗延遲毫秒，預設 1000）、LOGIN_LIMITER（Rate Limiting 綁定）
 * 回應 HTTP 一律 200（OPTIONS 為 204），格式 {ok:true,data} 或 {ok:false,code,error}。 */

export const SESSION_TTL_SEC = 43200;
const MAX_BODY = 65536;
const MIN_SECRET = 32;
const UPSTREAM_TIMEOUT_MS = 25000;
const enc = new TextEncoder();

const MESSAGES = {
  unauthorized: '密碼不正確或登入已過期。',
  rate_limited: '登入太頻繁，請稍後再試。',
  bad_request: '要求格式不正確。',
  not_configured: 'Worker 尚未設定完成。',
  mismatch: 'Worker 與後端的密碼設定不一致。',
  bad_upstream: '後端沒有回傳正確的資料。',
  unreachable: '連不上後端。',
  timeout: '後端沒有在時間內回應。'
};

/* ---------- 憑證 ---------- */
function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) return null;
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  try {
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch (e) { return null; }
}
function hmacKey(secret, usages) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

export async function signSession(secret, exp) {
  const payload = enc.encode(JSON.stringify({ exp }));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, ['sign']), payload);
  return b64urlEncode(payload) + '.' + b64urlEncode(new Uint8Array(sig));
}

export async function verifySession(secret, session, nowSec) {
  if (typeof session !== 'string') return false;
  const parts = session.split('.');
  if (parts.length !== 2) return false;
  const payload = b64urlDecode(parts[0]), sig = b64urlDecode(parts[1]);
  if (!payload || !sig || !payload.length || !sig.length) return false;
  let ok;
  try { ok = await crypto.subtle.verify('HMAC', await hmacKey(secret, ['verify']), sig, payload); } catch (e) { return false; }
  if (!ok) return false;
  let exp;
  try { exp = JSON.parse(new TextDecoder().decode(payload)).exp; } catch (e) { return false; }
  return typeof exp === 'number' && Number.isFinite(exp) && exp > nowSec;
}

/* 定時比對密碼：以隨機金鑰對輸入做 HMAC，再用 verify（定時比較）檢查它是否等於 expected 的 HMAC，長度不同也不洩漏 */
async function passwordMatches(input, expected) {
  const k = await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const mac = await crypto.subtle.sign('HMAC', k, enc.encode(input));
  return crypto.subtle.verify('HMAC', k, mac, enc.encode(expected));
}

/* ---------- 回應 ---------- */
function corsHeaders(request, env) {
  const h = { 'Vary': 'Origin' };
  const origin = request.headers.get('origin');
  if (origin && env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
function reply(request, env, body, status) {
  const headers = Object.assign({ 'Content-Type': 'application/json;charset=utf-8' }, corsHeaders(request, env));
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: status || 200, headers });
}
const fail = (request, env, code, error) =>
  reply(request, env, { ok: false, code, error: error || MESSAGES[code] || MESSAGES.bad_request });
const longEnough = (v) => typeof v === 'string' && v.length >= MIN_SECRET;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY || enc.encode(raw).length > MAX_BODY) return null;
  let obj;
  try { obj = JSON.parse(raw); } catch (e) { return null; }
  return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
}

/* ---------- 端點 ---------- */
async function handleLogin(request, env) {
  if (!longEnough(env.APP_PASSWORD) || !longEnough(env.SESSION_SECRET) || !env.ALLOWED_ORIGIN) {
    return fail(request, env, 'server_error', MESSAGES.not_configured);
  }
  if (env.LOGIN_LIMITER && typeof env.LOGIN_LIMITER.limit === 'function') {
    const key = request.headers.get('cf-connecting-ip') || 'unknown';
    const r = await env.LOGIN_LIMITER.limit({ key });
    if (!r || !r.success) return fail(request, env, 'rate_limited');
  }
  const body = await readJson(request);
  if (!body || typeof body.password !== 'string') return fail(request, env, 'bad_request');
  if (!(await passwordMatches(body.password, env.APP_PASSWORD))) {
    const ms = env.FAIL_DELAY_MS === undefined ? 1000 : Number(env.FAIL_DELAY_MS);
    if (ms > 0) await sleep(ms);
    return fail(request, env, 'unauthorized');
  }
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  return reply(request, env, { ok: true, data: { session: await signSession(env.SESSION_SECRET, exp), exp } });
}

async function handleApi(request, env) {
  if (!longEnough(env.SESSION_SECRET) || !longEnough(env.API_TOKEN) || !env.APPS_SCRIPT_URL || !env.ALLOWED_ORIGIN) {
    return fail(request, env, 'server_error', MESSAGES.not_configured);
  }
  const body = await readJson(request);
  if (!body) return fail(request, env, 'bad_request');
  if (!(await verifySession(env.SESSION_SECRET, body.session, Math.floor(Date.now() / 1000)))) return fail(request, env, 'unauthorized');
  const args = body.args === undefined ? {} : body.args;
  if (typeof body.action !== 'string' || !body.action || !args || typeof args !== 'object' || Array.isArray(args)) {
    return fail(request, env, 'bad_request');
  }
  let raw;
  try {
    const res = await fetch(env.APPS_SCRIPT_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow',
      body: JSON.stringify({ token: env.API_TOKEN, action: body.action, args }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
    raw = await res.text();
  } catch (e) {
    return fail(request, env, 'server_error', e && e.name === 'TimeoutError' ? MESSAGES.timeout : MESSAGES.unreachable);
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.ok !== 'boolean') return fail(request, env, 'server_error', MESSAGES.bad_upstream);
  if (parsed.ok === false && parsed.code === 'unauthorized') return fail(request, env, 'server_error', MESSAGES.mismatch);
  return reply(request, env, raw);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (request.method === 'OPTIONS') {
      const h = Object.assign({ 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' },
        corsHeaders(request, env));
      return new Response(null, { status: 204, headers: h });
    }
    if (request.method === 'POST' && path === '/login') return handleLogin(request, env);
    if (request.method === 'POST' && path === '/api') return handleApi(request, env);
    return fail(request, env, 'bad_request');
  }
};
