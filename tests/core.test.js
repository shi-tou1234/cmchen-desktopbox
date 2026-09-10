'use strict';

// 纯逻辑单测（node --test）。覆盖配置、筐模型、Dock 逻辑、目录浏览。
// 这些行为都是上一版（Python/Qt）踩过坑之后定下来的，这里逐条锁住。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../src/main/store');
const baskets = require('../src/main/baskets');
const dockmodel = require('../src/main/dockmodel');
const filebrowse = require('../src/main/filebrowse');
const behavior = require('../src/main/windowBehavior');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deskbasket-test-'));
}

// 存储根目录只能用测试钩子注入（对外 API 不接受路径参数），用完还原
function withRoot(dir, fn) {
  store.__setRootForTests(dir);
  try {
    return fn();
  } finally {
    store.__setRootForTests(null);
  }
}

// 只接受纯文件名 + 根目录边界校验：测试里也按安全写法来，
// 免得把「动态拼路径直接写盘」的习惯带进代码库。
function makeLinks(dir, names) {
  const root = path.resolve(dir);
  return names.map((name) => {
    const safe = path.basename(name);
    assert.strictEqual(safe, name, `只接受纯文件名：${name}`);
    const target = path.resolve(root, safe);
    assert.ok(
      target === root || target.startsWith(root + path.sep),
      '目标必须落在测试目录内'
    );
    fs.writeFileSync(target, '');
    return target;
  });
}

// ---------------------------------------------------------------- 配置

test('默认配置：磨砂玻璃（token 默认）＋ Dock 常驻', () => {
  assert.strictEqual(store.DEFAULTS.accent_mode, 'acrylic');
  assert.strictEqual(store.DEFAULTS.dock_always_visible, true);
  assert.strictEqual(store.DEFAULTS.dock_enabled, true);
});

test('默认窗口行为：文件筐＝普通窗口，Dock＝固定于桌面', () => {
  assert.strictEqual(store.DEFAULTS.basket_behavior, 'normal');
  assert.strictEqual(store.DEFAULTS.dock_behavior, 'desktop');
});

test('窗口行为三个 profile 与 token 一致', () => {
  const floating = behavior.WINDOW_BEHAVIOR_PROFILES.floating;
  assert.strictEqual(floating.alwaysOnTop, true);
  assert.strictEqual(floating.draggable, true);

  const normal = behavior.WINDOW_BEHAVIOR_PROFILES.normal;
  assert.strictEqual(normal.alwaysOnTop, false);
  assert.strictEqual(normal.draggable, true);
  assert.strictEqual(normal.resizable, true);
  assert.strictEqual(normal.focusable, true);

  const desktop = behavior.WINDOW_BEHAVIOR_PROFILES.desktop;
  assert.strictEqual(desktop.alwaysOnTop, false, '固定于桌面不置顶');
  assert.strictEqual(desktop.draggable, false, '固定于桌面不可拖');
  assert.strictEqual(desktop.resizable, false, '固定于桌面不可缩放');
  assert.strictEqual(desktop.cssClass, 'desktop-mode');
});

test('窗口行为取值非法时回退，兼容旧的 alwaysOnTop 字段', () => {
  assert.strictEqual(behavior.normalizeWindowBehavior('乱写', 'normal'), 'normal');
  assert.strictEqual(behavior.normalizeWindowBehavior('DESKTOP'), 'desktop');
  assert.strictEqual(behavior.modeFromSettings({ alwaysOnTop: true }), 'floating');
  assert.strictEqual(behavior.modeFromSettings({ alwaysOnTop: false }), 'normal');
  assert.strictEqual(behavior.modeFromSettings({ windowBehavior: 'desktop' }), 'desktop');
});

test('坏 JSON 回退默认，不抛异常', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, store.SETTINGS_FILENAME ?? 'settings.json'), '{ 这不是合法 JSON ');
  const loaded = withRoot(dir, () => store.loadSettings());
  assert.strictEqual(loaded.accent_mode, store.DEFAULTS.accent_mode);
  assert.deepStrictEqual(loaded.baskets, []);
});

test('不认识的字段原样保留（版本间往返不丢）', () => {
  const dir = tmpdir();
  const merged = store.mergedSettings({ unknown_scalar: '保留我', future: { theme: 'dark' } });
  const reloaded = withRoot(dir, () => {
    store.saveSettings(merged);
    return store.loadSettings();
  });
  assert.strictEqual(reloaded.unknown_scalar, '保留我');
  assert.deepStrictEqual(reloaded.future, { theme: 'dark' });
});

test('旧配置缺的字段补默认，旧字段不丢', () => {
  const legacy = {
    accent_mode: 'acrylic',
    icon_size: 48,
    baskets: [
      { id: 'b1', name: '桌面文件筐', x: 90, y: 110, w: 420, h: 300, items: ['C:\\a\\QQ.lnk'] }
    ]
  };
  const merged = store.mergedSettings(legacy);
  assert.strictEqual(merged.dock_enabled, true);
  assert.strictEqual(merged.baskets[0].name, '桌面文件筐');
  assert.strictEqual(merged.baskets[0].items.length, 1);
  assert.strictEqual(merged.baskets[0].visible, true, '旧配置没有 visible，默认应显示');
});

test('非法取值回退默认', () => {
  const merged = store.mergedSettings({
    accent_mode: '金属',
    icon_size: 9999,
    dock_hide_delay_ms: 5
  });
  assert.strictEqual(merged.accent_mode, 'acrylic');
  assert.strictEqual(merged.icon_size, store.DEFAULTS.icon_size);
  assert.strictEqual(merged.dock_hide_delay_ms, store.DEFAULTS.dock_hide_delay_ms);
});

test('写盘是原子的：不留临时文件，重读一致', () => {
  const dir = tmpdir();
  const saved = withRoot(dir, () => store.saveSettings({ icon_size: 64, baskets: [] }));
  assert.deepStrictEqual(fs.readdirSync(dir), ['settings.json']);
  assert.deepStrictEqual(withRoot(dir, () => store.loadSettings()), saved);
});

// ---------------------------------------------------------------- 筐模型

test('筐只存路径，重复路径去重', () => {
  const basket = baskets.normalizeBasket({ id: 'b1' });
  const first = baskets.addItem(basket, 'C:\\a\\QQ.lnk');
  assert.strictEqual(first.result, 'added');
  const second = baskets.addItem(first.basket, 'C:\\a\\QQ.lnk');
  assert.strictEqual(second.result, 'duplicate');
  assert.strictEqual(second.basket.items.length, 1);
});

test('非法路径被拒，筐保持原样', () => {
  const basket = baskets.normalizeBasket({ id: 'b1' });
  const result = baskets.addItem(basket, null);
  assert.strictEqual(result.result, 'invalid');
  assert.deepStrictEqual(result.basket.items, []);
});

test('移除条目只动数据，不碰磁盘', () => {
  const dir = tmpdir();
  const [link] = makeLinks(dir, ['QQ.lnk']);
  let basket = baskets.normalizeBasket({ id: 'b1' });
  basket = baskets.addItem(basket, link).basket;
  const after = baskets.removeItem(basket, link);
  assert.strictEqual(after.items.length, 0);
  assert.ok(fs.existsSync(link), '移除只该动登记，磁盘文件必须还在');
});

test('筐尺寸被夹在合法范围', () => {
  const small = baskets.normalizeBasket({ id: 'b1', w: 5, h: 99999 });
  assert.strictEqual(small.w, baskets.MIN_WIDTH);
  assert.strictEqual(small.h, baskets.MAX_DIMENSION);
});

test('筐 id 去重：重名加序号，缺 id 按位置补', () => {
  const list = baskets.normalizeBaskets([{ id: 'b1' }, { id: 'b1' }, {}]);
  assert.deepStrictEqual(list.map((b) => b.id), ['b1', 'b1-2', 'b3']);
});

test('新建筐取最小可用编号', () => {
  const list = baskets.normalizeBaskets([{ id: 'b1' }, { id: 'b3' }]);
  assert.strictEqual(baskets.createBasket(list).basket.id, 'b2');
});

test('删除筐只删定义，不影响其它筐', () => {
  const list = baskets.normalizeBaskets([{ id: 'b1' }, { id: 'b2' }]);
  assert.deepStrictEqual(baskets.dropBasket(list, 'b1').map((b) => b.id), ['b2']);
});

// ---------------------------------------------------------------- Dock 逻辑

test('热区只在屏幕底部 3 像素内', () => {
  const screen = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.strictEqual(dockmodel.isHotZone({ x: 900, y: 1079 }, screen), true);
  assert.strictEqual(dockmodel.isHotZone({ x: 900, y: 1070 }, screen), false);
  assert.strictEqual(dockmodel.isHotZone({ x: 3000, y: 1079 }, screen), false);
});

test('最大化窗口不拦 Dock（DWM 阴影会让矩形溢出屏幕）', () => {
  const screen = { x: 0, y: 0, width: 1707, height: 1067 };
  const overflowing = { x: -5, y: -5, width: 1717, height: 1077 };
  assert.strictEqual(dockmodel.isFullscreen(overflowing, screen), true, '只看矩形确实像全屏');
  assert.strictEqual(
    dockmodel.foregroundBlocksDock(overflowing, screen, 'Chrome_WidgetWin_1', true),
    false,
    '最大化必须不拦'
  );
});

test('桌面与任务栏不算全屏程序', () => {
  const screen = { x: 0, y: 0, width: 1920, height: 1080 };
  const full = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.strictEqual(dockmodel.foregroundBlocksDock(full, screen, 'Progman'), false);
  assert.strictEqual(dockmodel.foregroundBlocksDock(full, screen, 'Shell_TrayWnd'), false);
  assert.strictEqual(dockmodel.foregroundBlocksDock(full, screen, 'Chrome_WidgetWin_1'), true);
});

test('显隐决策：全屏不弹、锁定不动', () => {
  assert.strictEqual(dockmodel.shouldReveal(true, false, false, false), 'show');
  assert.strictEqual(dockmodel.shouldReveal(true, true, false, false), 'none', '全屏不弹');
  assert.strictEqual(dockmodel.shouldReveal(true, true, false, true), 'hide', '全屏时已弹出要收回');
  assert.strictEqual(dockmodel.shouldReveal(true, false, true, false), 'none', '锁定不动');
});

test('收起要等延迟，鼠标还在 Dock 上就不收', () => {
  assert.strictEqual(dockmodel.shouldHide(false, false, false, 100), false);
  assert.strictEqual(dockmodel.shouldHide(false, false, false, 400), true);
  assert.strictEqual(dockmodel.shouldHide(true, false, false, 99999), false);
  assert.strictEqual(dockmodel.shouldHide(false, true, false, 0), true);
});

test('位置计算：滑出贴底、收起完全移出屏幕', () => {
  const screen = { x: 0, y: 0, width: 1920, height: 1080 };
  const size = { width: 600, height: 100 };
  const shown = dockmodel.revealedGeometry(screen, size, 'bottom', 6);
  assert.strictEqual(shown.y + shown.height, 1080 - 6);
  assert.strictEqual(shown.x, (1920 - 600) / 2);
  const hidden = dockmodel.hiddenGeometry(screen, size);
  assert.ok(hidden.y >= 1080, '收起后必须完全离开可视区');
});

test('给任务栏让位：anchor 把 Dock 抬到任务栏上方', () => {
  const screen = { x: 0, y: 0, width: 1920, height: 1080 };
  const size = { width: 600, height: 100 };
  assert.strictEqual(dockmodel.revealedGeometry(screen, size, 'bottom', 0, 1032).y + 100, 1032);
});

test('多显示器取主屏', () => {
  const displays = [
    { bounds: { x: 1920, y: 0, width: 1280, height: 1024 }, primary: false },
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, primary: true }
  ];
  assert.deepStrictEqual(dockmodel.monitorGeometry(displays, 'primary'), displays[1].bounds);
  assert.deepStrictEqual(dockmodel.monitorGeometry(displays, 0), displays[0].bounds);
  assert.deepStrictEqual(dockmodel.monitorGeometry(displays, 9), displays[1].bounds);
});

test('自动收录只认 .lnk / .url / .exe', () => {
  assert.strictEqual(dockmodel.isCollectable('C:/d/QQ.lnk'), true);
  assert.strictEqual(dockmodel.isCollectable('C:/d/学习通.url'), true);
  assert.strictEqual(dockmodel.isCollectable('C:/d/万用表.exe'), true);
  assert.strictEqual(dockmodel.isCollectable('C:/d/价格.txt'), false);
  assert.strictEqual(dockmodel.isCollectable('C:/d/solidwork'), false);
});

test('同步桌面快捷方式：不重复、不复活被移除的', () => {
  const dir = tmpdir();
  const links = makeLinks(dir, ['QQ.lnk', 'Steam.lnk', '学习通.url', '价格.txt']);
  const synced = dockmodel.syncDesktopShortcuts([], [], links);
  assert.deepStrictEqual(
    synced.map((p) => path.basename(p)).sort(),
    ['QQ.lnk', 'Steam.lnk', '学习通.url'].sort()
  );
  const withRemoved = dockmodel.syncDesktopShortcuts([], [links[0]], links);
  assert.strictEqual(withRemoved.some((p) => path.basename(p) === 'QQ.lnk'), false);
});

test('排序：越界与同位置都是原样返回', () => {
  const items = ['a', 'b', 'c'];
  assert.deepStrictEqual(dockmodel.moveItem(items, 0, 2), ['b', 'c', 'a']);
  assert.deepStrictEqual(dockmodel.moveItem(items, 5, 0), items);
  assert.deepStrictEqual(dockmodel.moveItem(items, 1, 1), items);
});

// ---------------------------------------------------------------- 目录浏览

test('面包屑最后一段就是当前目录', () => {
  const dir = tmpdir();
  const sub = path.join(dir, '学习', '资料');
  fs.mkdirSync(sub, { recursive: true });
  const parts = filebrowse.breadcrumbParts(sub);
  assert.strictEqual(parts[parts.length - 1].path, path.normalize(sub));
  assert.strictEqual(parts[parts.length - 1].label, '资料');
});

test('盘符根没有上一级', () => {
  assert.strictEqual(filebrowse.parentOf('C:\\'), null);
  assert.strictEqual(filebrowse.isRoot('C:\\'), true);
});

test('上级目录正确', () => {
  const dir = tmpdir();
  const sub = path.join(dir, 'a', 'b');
  fs.mkdirSync(sub, { recursive: true });
  assert.strictEqual(filebrowse.parentOf(sub), path.join(dir, 'a'));
});

test('列目录：目录排前面，文件其次', () => {
  const dir = tmpdir();
  makeLinks(dir, ['b.txt']);
  fs.mkdirSync(path.join(dir, 'a_dir'));
  const result = filebrowse.listEntries(dir);
  assert.strictEqual(result.error, null);
  assert.deepStrictEqual(result.entries.map((e) => e.name), ['a_dir', 'b.txt']);
  assert.strictEqual(result.entries[0].isDir, true);
});

test('目录不存在给中文提示，不崩', () => {
  const result = filebrowse.listEntries(path.join(tmpdir(), '并不存在'));
  assert.strictEqual(result.error, filebrowse.ERROR_NOT_FOUND);
  assert.deepStrictEqual(result.entries, []);
});

test('对文件调用列目录会提示不是目录', () => {
  const dir = tmpdir();
  const [file] = makeLinks(dir, ['a.txt']);
  assert.strictEqual(filebrowse.listEntries(file).error, filebrowse.ERROR_NOT_DIR);
});

test('分批：2500 项也切得动', () => {
  const items = Array.from({ length: 2500 }, (_, i) => i);
  const batches = filebrowse.chunked(items);
  assert.strictEqual(batches.length, Math.ceil(2500 / filebrowse.CHUNK_SIZE));
  assert.strictEqual(batches.reduce((sum, b) => sum + b.length, 0), 2500);
});
