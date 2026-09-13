'use strict';

// 筐的磁盘落地（3.3.0）：文件夹命名、重名顺延、移动/复制决策、复制校验。
// 只测纯函数与可注入 IO 的部分；真正的移动/复制在真机上验（见 PROGRESS）。

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const basketfiles = require('../src/main/basketfiles');
const baskets = require('../src/main/baskets');

test('筐名 → 文件夹名：非法字符换空格、去掉结尾的点和空格、限长', () => {
  assert.strictEqual(basketfiles.sanitizeFolderName('资料'), '资料');
  assert.strictEqual(basketfiles.sanitizeFolderName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.strictEqual(basketfiles.sanitizeFolderName('  期末 资料  '), '期末 资料');
  assert.strictEqual(basketfiles.sanitizeFolderName('资料...'), '资料');
  assert.strictEqual(basketfiles.sanitizeFolderName('x'.repeat(80)).length, basketfiles.NAME_MAX);
});

test('筐名 → 文件夹名：空名与 Windows 保留名兜底', () => {
  for (const raw of ['', '   ', '...', null, undefined, 'con', 'NUL', 'com1', 'Lpt9']) {
    assert.strictEqual(basketfiles.sanitizeFolderName(raw), '筐', String(raw));
  }
  assert.strictEqual(basketfiles.sanitizeFolderName('console'), 'console');
});

test('重名顺延：保留扩展名，加 (2)/(3)', () => {
  assert.strictEqual(basketfiles.uniqueName('a.txt', []), 'a.txt');
  assert.strictEqual(basketfiles.uniqueName('a.txt', ['a.txt']), 'a (2).txt');
  assert.strictEqual(basketfiles.uniqueName('a.txt', ['a.txt', 'a (2).txt']), 'a (3).txt');
  assert.strictEqual(basketfiles.uniqueName('资料', ['资料']), '资料 (2)');
  // Windows 不区分大小写：大小写不同也算重名
  assert.strictEqual(basketfiles.uniqueName('A.TXT', ['a.txt']), 'A (2).TXT');
  // taken 传 Set 也要能算（主进程里"别的筐占掉的目录名"就是个 Set）
  assert.strictEqual(basketfiles.uniqueName('资料', new Set(['资料'])), '资料 (2)');
  assert.strictEqual(basketfiles.uniqueName('资料', null), '资料');
});

test('路径判据：同盘、在内、大小写与末尾斜杠都不影响', () => {
  const dir = path.join('E:', '文件筐', '资料');
  assert.strictEqual(basketfiles.isInside(dir, path.join('E:', '文件筐', '资料', 'a.txt')), true);
  assert.strictEqual(basketfiles.isInside(dir, dir), true);
  assert.strictEqual(basketfiles.isInside(dir, path.join('E:', '文件筐', '资料备份', 'a.txt')), false);
  // 反斜杠与盘符是 Windows 语义：POSIX 上 '\\' 只是普通字符，这里按平台分别断言
  if (process.platform === 'win32') {
    assert.strictEqual(basketfiles.samePath('E:\\A\\b.txt', 'e:/a/b.txt'), true);
    assert.strictEqual(basketfiles.sameVolume('E:\\x\\a.txt', 'e:\\文件筐'), true);
    assert.strictEqual(basketfiles.sameVolume('C:\\x\\a.txt', 'E:\\文件筐'), false);
  } else {
    // POSIX 没有盘符概念：sameVolume 一律为真（跨挂载点的 rename 会抛 EXDEV，由 placeInto 兜）
    assert.strictEqual(basketfiles.samePath('/A/b.txt', '/a/B.txt'), true);
    assert.strictEqual(basketfiles.sameVolume('/x/a.txt', '/mnt/文件筐'), true);
  }
});

test('决策：已在筐目录里 / 源文件没了 / 被 Dock 或别的筐引用 / 可以搬', () => {
  const dir = path.join('E:', '文件筐', '资料');
  const item = path.join('D:', 'shortcuts', 'demo.lnk');
  const protect = new Set([basketfiles.keyOf(item)]);

  assert.deepStrictEqual(
    basketfiles.moveDecision({ item: path.join(dir, 'a.txt'), dir }),
    { action: 'inside' }
  );
  assert.deepStrictEqual(basketfiles.moveDecision({ item, dir, exists: false }), { action: 'missing' });
  assert.deepStrictEqual(basketfiles.moveDecision({ item, dir }), { action: 'move' });
  assert.deepStrictEqual(basketfiles.moveDecision({ item, dir, protectKeys: protect }), { action: 'copy' });
  // 已经在筐里、同时又被别处引用：仍然是"不用动"，不该再复制一份
  assert.deepStrictEqual(
    basketfiles.moveDecision({ item: path.join(dir, 'a.txt'), dir, protectKeys: protect }),
    { action: 'inside' }
  );
  assert.deepStrictEqual(basketfiles.moveDecision({}), { action: 'missing' });
});

test('树指纹：目录记 -1、文件记大小，逐层展开', () => {
  // 假 IO：键用 path.join 生成（实现里也是 path.join，Windows 上是反斜杠）
  const root = path.join('X:', 'root');
  const tree = {
    [root]: { type: 'dir', children: ['a.txt', 'sub'] },
    [path.join(root, 'a.txt')]: { type: 'file', size: 10 },
    [path.join(root, 'sub')]: { type: 'dir', children: ['b.txt'] },
    [path.join(root, 'sub', 'b.txt')]: { type: 'file', size: 20 }
  };
  const io = {
    readdirSync: (dir) => (tree[dir] && tree[dir].children) || [],
    statSync: (target) => {
      const entry = tree[target];
      if (!entry) throw new Error('no such file: ' + target);
      if (entry.type === 'dir') return { isDirectory: () => true, size: 0 };
      return { isDirectory: () => false, size: entry.size };
    }
  };
  assert.deepStrictEqual(basketfiles.snapshotTree(root, io), {
    '': -1,
    'a.txt': 10,
    sub: -1,
    'sub/b.txt': 20
  });
  // 单个文件（不是目录）
  const single = path.join('X:', 'a.txt');
  const io2 = {
    readdirSync: () => [],
    statSync: () => ({ isDirectory: () => false, size: 7 })
  };
  assert.deepStrictEqual(basketfiles.snapshotTree(single, io2), { '': 7 });
});

test('复制校验：一致通过；少项/多项/大小不同/类型不同都能指出来', () => {
  const base = { '': -1, 'a.txt': 10, sub: -1, 'sub/b.txt': 20 };
  assert.strictEqual(basketfiles.compareTrees(base, { ...base }), '');
  assert.match(basketfiles.compareTrees(base, { '': -1, 'a.txt': 10, sub: -1 }), /缺少 sub\/b.txt/);
  assert.match(basketfiles.compareTrees(base, { ...base, 'c.txt': 1 }), /多出 c.txt/);
  assert.match(basketfiles.compareTrees(base, { ...base, 'a.txt': 9 }), /a.txt 大小不一致/);
  assert.match(basketfiles.compareTrees(base, { ...base, sub: 12 }), /sub 不是目录/);
  assert.match(basketfiles.compareTrees({ '': -1 }, { '': 10 }), /不是目录/);
  assert.match(basketfiles.compareTrees({ '': 10 }, { '': -1 }), /大小不一致/);
});

test('改名用的文件名清洗：非法字符换空格、去掉结尾的点、保留名加前缀', () => {
  assert.strictEqual(basketfiles.sanitizeFileName('新建 BMP 图像.bmp'), '新建 BMP 图像.bmp');
  assert.strictEqual(basketfiles.sanitizeFileName('a<b>c|.txt'), 'a b c .txt');
  assert.strictEqual(basketfiles.sanitizeFileName('报告. '), '报告');
  // 中文句号不是 Windows 的结尾点，保留
  assert.strictEqual(basketfiles.sanitizeFileName('报告。'), '报告。');
  assert.strictEqual(basketfiles.sanitizeFileName('con'), '文件-con');
  assert.strictEqual(basketfiles.sanitizeFileName('CON.txt'), '文件-CON.txt');
  assert.strictEqual(basketfiles.sanitizeFileName(''), '');
  assert.strictEqual(basketfiles.sanitizeFileName('   '), '');
  assert.strictEqual(basketfiles.sanitizeFileName('x'.repeat(200)).length, 120);
});

test('清掉"文件已不在"的登记：删掉的就从清单消失，不动还活着的', () => {
  const items = ['E:\\文件筐\\学习\\a.txt', 'E:\\文件筐\\学习\\b.txt', 'E:\\文件筐\\学习\\c.txt'];
  const { items: kept, removed } = baskets.dropMissing(items, (item) => item !== items[1]);
  assert.deepStrictEqual(kept, [items[0], items[2]]);
  assert.deepStrictEqual(removed, [items[1]]);
  // 全都活着：原样返回，一项不动
  const all = baskets.dropMissing(items, () => true);
  assert.deepStrictEqual(all.items, items);
  assert.deepStrictEqual(all.removed, []);
  // 全都没了：清单清空（调用方要保证筐目录本身是好的才会走到这）
  const none = baskets.dropMissing(items, () => false);
  assert.deepStrictEqual(none.items, []);
  assert.deepStrictEqual(none.removed.length, 3);
});
