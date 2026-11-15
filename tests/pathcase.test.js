'use strict';

// 审查 F18：路径键的大小写口径按平台区分（Windows 不敏感 / 其它平台敏感）。
// 用 basketfiles.__setPlatformForTests 注入平台，在同一台机器上把两种语义都验一遍；
// 每次注入都在 finally 里还原成 null（生产默认取 process.platform），不污染同进程内其它用例。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const basketfiles = require('../src/main/basketfiles');
const store = require('../src/main/store');

// 用宿主 path 生成绝对路径，只改大小写：验证的是「折叠口径」，与 path 模块的平台语义无关，
// 因此在 Windows / macOS / Linux 任一宿主上都能跑。
const BASE = process.platform === 'win32'
  ? path.join('C:', 'DeskBasketCase', 'Notes', 'A.txt')
  : path.join(path.sep, 'tmp', 'DeskBasketCase', 'Notes', 'A.txt');
const LOWER = BASE.toLowerCase();

function withPlatform(value, fn) {
  basketfiles.__setPlatformForTests(value);
  try {
    return fn();
  } finally {
    basketfiles.__setPlatformForTests(null);
  }
}

test('foldPathCase：Windows 折小写，POSIX 保留大小写（审查 F18）', () => {
  withPlatform('win32', () => {
    assert.strictEqual(basketfiles.foldPathCase('/Tmp/A.TXT'), '/tmp/a.txt');
  });
  for (const value of ['linux', 'darwin']) {
    withPlatform(value, () => {
      assert.strictEqual(basketfiles.foldPathCase('/Tmp/A.TXT'), '/Tmp/A.TXT');
    });
  }
});

test('Windows 语义：keyOf / samePath / isInside / store.pathKey 都不区分大小写，且两处一致', () => {
  withPlatform('win32', () => {
    assert.strictEqual(basketfiles.keyOf(BASE), basketfiles.keyOf(LOWER));
    assert.strictEqual(basketfiles.samePath(BASE, LOWER), true);
    assert.strictEqual(basketfiles.isInside(path.dirname(BASE), BASE), true);
    assert.strictEqual(basketfiles.isInside(path.dirname(BASE).toLowerCase(), BASE), true);
    assert.strictEqual(store.pathKey(BASE), store.pathKey(LOWER));
    // 两处共用同一个 foldPathCase：对同一绝对路径，keyOf 与 pathKey 的键必须相等
    assert.strictEqual(basketfiles.keyOf(BASE), store.pathKey(BASE));
    // 沿用原行为：大小写变体算同一路径，去重只留一项
    assert.deepStrictEqual(store.normalizePathList([BASE, LOWER]), [store.normalizePath(BASE)]);
  });
});

test('POSIX 语义（linux / darwin）：大小写敏感，大小写变体是不同路径，且两处一致', () => {
  for (const value of ['linux', 'darwin']) {
    withPlatform(value, () => {
      assert.notStrictEqual(basketfiles.keyOf(BASE), basketfiles.keyOf(LOWER));
      assert.strictEqual(basketfiles.samePath(BASE, LOWER), false);
      assert.strictEqual(basketfiles.samePath(BASE, BASE), true);
      assert.strictEqual(basketfiles.isInside(path.dirname(BASE), BASE), true);
      assert.notStrictEqual(store.pathKey(BASE), store.pathKey(LOWER));
      assert.strictEqual(basketfiles.keyOf(BASE), store.pathKey(BASE));
      // 不再折叠大小写：两个变体都保留
      assert.strictEqual(store.normalizePathList([BASE, LOWER]).length, 2);
    });
  }
});

test('keyOf 保持单参数签名：.map(keyOf) 不会把下标当平台参数', () => {
  withPlatform('linux', () => {
    assert.deepStrictEqual(
      [BASE, LOWER].map(basketfiles.keyOf),
      [basketfiles.keyOf(BASE), basketfiles.keyOf(LOWER)]
    );
  });
});

test('已有存档兼容：settings.json 存 normalizePath 原始路径，不受 pathKey 折叠影响', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskbasket-pathcase-'));
  try {
    store.__setRootForTests(dir);
    for (const value of ['win32', 'linux']) {
      withPlatform(value, () => {
        store.saveSettings({ dock_items: [BASE] });
        const raw = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
        const saved = JSON.parse(raw).dock_items[0];
        // 落盘的是 normalizePath 后的原始大小写，不是被折成小写的比较键
        assert.strictEqual(saved, store.normalizePath(BASE));
        assert.notStrictEqual(saved, saved.toLowerCase(), '存档没有被折成小写');
        // 旧存档的读路径不变：读回来仍是原样，往返不丢大小写
        assert.deepStrictEqual(store.loadSettings().dock_items, [saved]);
      });
    }
  } finally {
    store.__setRootForTests(null);
    basketfiles.__setPlatformForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
