'use strict';

// 文件夹外观（Kimicon 图标包）的分配规则：同窗口不重款、分配过的不再变、坏配置能自愈。

const test = require('node:test');
const assert = require('node:assert');

const folderskins = require('../src/main/folderskins');
const store = require('../src/main/store');

const win = (...names) => names.map((name) => 'D:\\文件筐\\' + name);

const familiesOf = (byKey, paths) => paths.map((p) => folderskins.SKINS[byKey.get(folderskins.pathKey(p))].family);

test('外观：每个文件夹都分到一款，同一个窗口里不重复造型', () => {
  const paths = win('设计', '文档', '截图', '音乐', '归档', '临时');
  const plan = folderskins.assign({}, paths);
  assert.strictEqual(plan.changed, true);
  assert.strictEqual(plan.byKey.size, paths.length);
  const families = familiesOf(plan.byKey, paths);
  assert.strictEqual(new Set(families).size, families.length, '6 个文件夹应该拿到 6 种不同造型');
  for (const index of plan.byKey.values()) {
    assert.ok(Number.isInteger(index) && index >= 0 && index < folderskins.SKIN_COUNT);
  }
});

test('外观：分过的文件夹不再变——加一个新文件夹不会把别人洗牌', () => {
  const first = win('设计', '文档');
  const one = folderskins.assign({}, first);
  const keys = first.map((p) => folderskins.pathKey(p));
  const before = keys.map((key) => one.byKey.get(key));

  const second = [...first, 'D:\\文件筐\\截图'];
  const two = folderskins.assign(one.skins, second);
  assert.strictEqual(two.changed, true, '多出来那个才会触发落盘');
  assert.deepStrictEqual(keys.map((key) => two.byKey.get(key)), before, '老文件夹的图标必须原样不动');

  // 再走一遍什么都不变：changed=false，别每次都白写一次配置
  const again = folderskins.assign(two.skins, second);
  assert.strictEqual(again.changed, false);
  assert.deepStrictEqual(again.skins, two.skins);
});

test('外观：同一个目录的大小写变体算同一款（Windows 不区分大小写）', () => {
  const plan = folderskins.assign({}, ['D:\\文件筐\\设计']);
  const index = plan.byKey.get(folderskins.pathKey('D:\\文件筐\\设计'));
  const again = folderskins.assign(plan.skins, ['d:\\文件筐\\设计']);
  assert.strictEqual(again.byKey.get('d:\\文件筐\\设计'), index);
  assert.strictEqual(again.changed, false);
});

test('外观：文件夹超过 6 个时换用同造型的另一版，超过 12 个才允许完全重复', () => {
  const paths = win('1', '2', '3', '4', '5', '6', '7', '8');
  const plan = folderskins.assign({}, paths);
  const indices = paths.map((p) => plan.byKey.get(folderskins.pathKey(p)));
  assert.strictEqual(new Set(indices).size, 8, '8 个文件夹应该有 8 个不同下标（6 造型 × 2 版够用）');

  const many = folderskins.assign({}, win('1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'));
  assert.strictEqual(new Set(many.byKey.values()).size, 12, '12 个文件夹刚好把整套图标用完');
});

test('外观：配置里的坏下标／坏类型被忽略，重新分配', () => {
  const dir = 'D:\\文件筐\\设计';
  const broken = { [dir]: 99 };            // 越界：没有这一款
  const plan = folderskins.assign(broken, [dir]);
  assert.strictEqual(plan.changed, true);
  assert.ok(plan.byKey.get(folderskins.pathKey(dir)) < folderskins.SKIN_COUNT);

  assert.strictEqual(folderskins.skinAt(3).id, 'kimi-04');
  assert.strictEqual(folderskins.idAt(0), 'kimi-01');
  assert.strictEqual(folderskins.skinAt(-1), null);
  assert.strictEqual(folderskins.skinAt('2'), null);
  assert.strictEqual(folderskins.idAt(99), '');
});

test('外观：配置项归一化（folder_skin 认两种模式，folder_skins 只留合法项）', () => {
  assert.strictEqual(store.DEFAULTS.folder_skin, 'kimi');
  assert.deepStrictEqual(store.DEFAULTS.folder_skins, {});

  assert.strictEqual(store.mergedSettings({}).folder_skin, 'kimi');
  assert.strictEqual(store.mergedSettings({ folder_skin: 'system' }).folder_skin, 'system');
  assert.strictEqual(store.mergedSettings({ folder_skin: 'kimi' }).folder_skin, 'kimi');
  assert.strictEqual(store.mergedSettings({ folder_skin: 'lol' }).folder_skin, 'kimi');

  const skins = store.mergedSettings({
    folder_skins: {
      'D:\\文件筐\\设计': 3,
      'D:\\文件筐\\文档': -1,       // 负数：丢掉
      'D:\\文件筐\\音乐': '2',      // 字符串：丢掉
      '': 1                         // 空路径：丢掉
    }
  }).folder_skins;
  assert.deepStrictEqual(skins, { 'D:\\文件筐\\设计': 3 });
  assert.deepStrictEqual(store.mergedSettings({ folder_skins: [] }).folder_skins, {});
  assert.deepStrictEqual(store.mergedSettings({ folder_skins: null }).folder_skins, {});
});
