'use strict';

// 一键整理桌面：分类器/规划器/撤销计划的纯逻辑单测

const test = require('node:test');
const assert = require('node:assert');
const { CATEGORIES, classifyName, planOrganization, undoPlan, MIN_GROUP, MAX_NEW } = require('../src/main/organize');

function entry(name, overrides = {}) {
  return { path: 'C:\\Desktop\\' + name, name, ...overrides };
}

test('classifyName: 六类各归各位，大小写不敏感', () => {
  assert.equal(classifyName('Arduino IDE.lnk'), 'shortcut');
  assert.equal(classifyName('学习通.URL'), 'shortcut');
  assert.equal(classifyName('周报.DOCX'), 'doc');
  assert.equal(classifyName('照片.PNG'), 'image');
  assert.equal(classifyName('发布会.MP4'), 'media');
  assert.equal(classifyName('setup.EXE'), 'archive');
  assert.equal(classifyName('资料.7z'), 'archive');
});

test('classifyName: 无扩展名/点开头/认不出的进其他', () => {
  assert.equal(classifyName('README'), 'other');
  assert.equal(classifyName('.gitignore'), 'other');
  assert.equal(classifyName('数据.xyz123'), 'other');
  assert.equal(classifyName(''), 'other');
});

test('planOrganization: 基本分组，够 2 项的类建筐', () => {
  const { groups, skipped } = planOrganization([
    entry('a.lnk'), entry('b.lnk'), entry('c.lnk'),
    entry('d.docx'), entry('e.pdf'),
    entry('f.png'),
    entry('文件夹笔记', { isDir: true })
  ], []);
  assert.equal(groups.length, 2);
  const shortcut = groups.find((g) => g.id === 'shortcut');
  assert.equal(shortcut.count, 3);
  assert.equal(shortcut.action, 'create');
  const doc = groups.find((g) => g.id === 'doc');
  assert.equal(doc.count, 2);
  // 单张图片不够 2 项 → 并进其他；但其他只有 1 项 → 不建筐
  assert.equal(groups.find((g) => g.id === 'other'), undefined);
  assert.deepEqual(skipped.map((s) => [s.name, s.reason]), [['文件夹笔记', 'dir']]);
});

test('planOrganization: 零散类并入其他，其他够 2 项就建筐', () => {
  const { groups } = planOrganization([
    entry('a.lnk'), entry('b.lnk'),
    entry('x.xyz'), entry('y.abc'), entry('README')
  ], []);
  const other = groups.find((g) => g.id === 'other');
  assert.ok(other, '其他筐应出现');
  assert.equal(other.count, 3);
  assert.equal(groups.length, 2);
});

test('planOrganization: 最多新建 4 个筐，落选类并入其他', () => {
  // 6 个类都够格（shortcut/doc/image/media/archive/other）→ 只有 4 个拿到自家筐
  const entries = [];
  const names = { shortcut: 'a.lnk', doc: 'd.docx', image: 'i.png', media: 'm.mp4', archive: 'z.zip' };
  for (const [id, base] of Object.entries(names)) {
    const ext = base.slice(base.indexOf('.'));
    for (let i = 0; i < 3; i += 1) entries.push(entry(`${base.slice(0, 1)}${i}${ext}`));
  }
  entries.push(entry('q1.weird'), entry('q2.weird'));
  const { groups } = planOrganization(entries, []);
  const own = groups.filter((g) => g.id !== 'other');
  assert.equal(own.length, MAX_NEW);
  const other = groups.find((g) => g.id === 'other');
  assert.ok(other, '落选类应并入其他');
  // 6 类里数量最少的那类（并列时按名字序）被挤进其他
  assert.equal(other.count, 5);
});

test('planOrganization: 已有同名筐则复用，不新建', () => {
  const { groups } = planOrganization([
    entry('a.lnk'), entry('b.lnk')
  ], [{ id: 'b3', name: '快捷方式' }]);
  assert.equal(groups[0].action, 'reuse');
  assert.equal(groups[0].basketId, 'b3');
});

test('planOrganization: registered/missing/hidden 全部跳过并说明原因', () => {
  const { groups, skipped } = planOrganization([
    entry('dock.lnk', { registered: true }),
    entry('ghost.lnk', { missing: true }),
    entry('system.bin', { hidden: true }),
    entry('a.lnk'), entry('b.lnk')
  ], []);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 2);
  assert.deepEqual(
    skipped.map((s) => s.reason).sort(),
    ['hidden', 'missing', 'registered']
  );
});

test('planOrganization: 不足 2 项时 groups 为空；两个零散文件并进其他够建筐', () => {
  // 只有一个文件：哪里都凑不够 2 项 → 没什么可整理
  assert.deepEqual(planOrganization([entry('a.lnk')], []).groups, []);
  // 两个不同类的零散文件：并入「其他」后刚好够 2 项 → 建一个其他筐
  const { groups } = planOrganization([entry('a.lnk'), entry('b.docx')], []);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'other');
  assert.equal(groups[0].count, 2);
});

test('undoPlan: to 在且 from 空才可撤销', () => {
  const records = [
    { from: 'C:\\Desktop\\a.lnk', to: 'E:\\筐\\快捷方式\\a.lnk' },
    { from: 'C:\\Desktop\\b.lnk', to: 'E:\\筐\\快捷方式\\b.lnk' },
    { from: 'C:\\Desktop\\c.lnk', to: 'E:\\筐\\快捷方式\\c.lnk' }
  ];
  // b 的 to 丢了（搬不回）、c 的原位被新文件占了（不敢覆盖）；
  // 其余原位都是空的（文件已搬走）、E: 的 to 都在——只有 a 能原路回去
  const steps = undoPlan(records, (p) => {
    if (p.endsWith('c.lnk') && p.startsWith('C:')) return true;
    if (p.endsWith('b.lnk') && p.startsWith('E:')) return false;
    if (p.startsWith('C:')) return false;
    return true;
  });
  assert.deepEqual(steps, [{ from: 'E:\\筐\\快捷方式\\a.lnk', to: 'C:\\Desktop\\a.lnk' }]);
});

test('undoPlan: 空/坏记录安全跳过', () => {
  assert.deepEqual(undoPlan([], () => true), []);
  assert.deepEqual(undoPlan([null, { from: '', to: 'x' }], () => true), []);
});

test('常量口径：MIN_GROUP=2、MAX_NEW=4、六个分类都齐', () => {
  assert.equal(MIN_GROUP, 2);
  assert.equal(MAX_NEW, 4);
  assert.deepEqual(CATEGORIES.map((c) => c.id), ['shortcut', 'doc', 'image', 'media', 'archive']);
});
