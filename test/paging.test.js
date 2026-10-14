const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../web/paging.js');

test('PAGE_SIZES 為 5/10/15/20', () => {
  assert.deepEqual(P.PAGE_SIZES, [5, 10, 15, 20]);
});

test('normalizeSize：合法值保留，其餘回 10', () => {
  assert.equal(P.normalizeSize(5), 5);
  assert.equal(P.normalizeSize('10'), 10);
  assert.equal(P.normalizeSize(15), 15);
  assert.equal(P.normalizeSize(20), 20);
  for (const bad of [7, 0, -5, null, undefined, '', 'abc', '1e1', NaN, {}, [5]]) assert.equal(P.normalizeSize(bad), 10, String(bad));
  assert.equal(P.normalizeSize('5'), 5);
});

test('pageCount：至少 1 頁，進位', () => {
  assert.equal(P.pageCount(0, 10), 1);
  assert.equal(P.pageCount(1, 10), 1);
  assert.equal(P.pageCount(10, 10), 1);
  assert.equal(P.pageCount(11, 10), 2);
  assert.equal(P.pageCount(128, 10), 13);
  assert.equal(P.pageCount(128, 20), 7);
});

test('clampPage：取整並夾在 1..pages，非數字回 1', () => {
  assert.equal(P.clampPage(0, 5), 1);
  assert.equal(P.clampPage(9, 5), 5);
  assert.equal(P.clampPage(-3, 5), 1);
  assert.equal(P.clampPage(NaN, 5), 1);
  assert.equal(P.clampPage('3', 5), 3);
  assert.equal(P.clampPage(2.7, 5), 2);
  assert.equal(P.clampPage(undefined, 5), 1);
});

test('slicePage：首頁、末頁（不足一頁）、空陣列', () => {
  const list = Array.from({ length: 25 }, (_, i) => i + 1);
  assert.deepEqual(P.slicePage(list, 1, 10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(P.slicePage(list, 3, 10), [21, 22, 23, 24, 25]);
  assert.deepEqual(P.slicePage([], 1, 10), []);
});

test('pageOf：回傳所在頁碼，找不到回 0', () => {
  const list = Array.from({ length: 25 }, (_, i) => ({ id: String(i + 1) }));
  assert.equal(P.pageOf(list, '11', 10), 2);
  assert.equal(P.pageOf(list, '10', 10), 1);
  assert.equal(P.pageOf(list, '25', 10), 3);
  assert.equal(P.pageOf(list, 'x', 10), 0);
});

test('pageWindow：頭尾與目前頁±1，不連續處用 …', () => {
  assert.deepEqual(P.pageWindow(1, 1), [1]);
  assert.deepEqual(P.pageWindow(3, 7), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(P.pageWindow(1, 13), [1, 2, '…', 13]);
  assert.deepEqual(P.pageWindow(7, 13), [1, '…', 6, 7, 8, '…', 13]);
  assert.deepEqual(P.pageWindow(13, 13), [1, '…', 12, 13]);
  assert.deepEqual(P.pageWindow(4, 8), [1, '…', 3, 4, 5, '…', 8]);
});
