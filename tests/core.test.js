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

test('筐候选清单：列桌面上的所有条目（不筛后缀）、标出已在筐里的、按名称排序', () => {
  const desktop = [
    'C:\\Users\\me\\Desktop\\价格.txt',
    'C:\\Users\\me\\Desktop\\QQ音乐.lnk',
    'C:\\Users\\me\\Desktop\\学业',
    'C:\\Users\\me\\Desktop\\QQ音乐.lnk', // 重复
    ''
  ];
  const rows = dockmodel.basketCandidates(desktop, ['C:\\Users\\me\\Desktop\\QQ音乐.lnk']);
  assert.deepStrictEqual(
    rows.map((row) => row.name),
    [...rows.map((row) => row.name)].sort((a, b) => a.localeCompare(b, 'zh'))
  );
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows.find((row) => row.name === 'QQ音乐.lnk').inBasket, true);
  assert.strictEqual(rows.find((row) => row.name === '价格.txt').inBasket, false);
  assert.strictEqual(rows.find((row) => row.name === '学业').inBasket, false, '文件夹也能进筐');
  assert.deepStrictEqual(dockmodel.basketCandidates(null, null), []);
});

test('默认配置：完全透明 ＋ Dock 开着且自动收起', () => {
  assert.strictEqual(store.DEFAULTS.accent_mode, 'off');
  assert.strictEqual(store.DEFAULTS.dock_enabled, true);
  assert.strictEqual(store.DEFAULTS.dock_auto_hide, true);
  assert.strictEqual(store.DEFAULTS.shortcuts_dir, '', '收录来源默认空串＝系统桌面');
});

test('收录来源目录：只认写出来就是绝对路径的字符串，其余回退系统桌面', () => {
  // 平台无关地构造一个绝对路径（测试可能跑在任何系统上）
  const abs = path.join(os.tmpdir(), '快捷方式');
  assert.strictEqual(store.mergedSettings({ shortcuts_dir: abs }).shortcuts_dir, path.normalize(abs));
  // 结尾的分隔符与 "." 段会被 normalize 收拾干净
  assert.strictEqual(
    store.mergedSettings({ shortcuts_dir: abs + path.sep + '.' }).shortcuts_dir,
    path.normalize(abs)
  );
  // 缺省/空串/纯空白 → 空（= 系统桌面）
  assert.strictEqual(store.mergedSettings({}).shortcuts_dir, '');
  assert.strictEqual(store.mergedSettings({ shortcuts_dir: '' }).shortcuts_dir, '');
  assert.strictEqual(store.mergedSettings({ shortcuts_dir: '   ' }).shortcuts_dir, '');
  // 相对路径 resolve 后会落在进程目录下，是意外，不收
  assert.strictEqual(store.mergedSettings({ shortcuts_dir: '快捷方式' }).shortcuts_dir, '');
  assert.strictEqual(store.mergedSettings({ shortcuts_dir: './快捷方式' }).shortcuts_dir, '');
  // 非字符串一律回退
  assert.strictEqual(store.mergedSettings({ shortcuts_dir: 42 }).shortcuts_dir, '');
  assert.strictEqual(store.mergedSettings({ shortcuts_dir: null }).shortcuts_dir, '');
  // Windows 盘符与 UNC 只有在 win32 上才算绝对（UNC 的 normalize 会补结尾分隔符，
  // 因为 \\nas\share 本身就是「根」，这里只跟 path.normalize 的结果对齐）
  if (process.platform === 'win32') {
    assert.strictEqual(store.mergedSettings({ shortcuts_dir: 'E:\\shortcuts' }).shortcuts_dir, 'E:\\shortcuts');
    assert.strictEqual(
      store.mergedSettings({ shortcuts_dir: '\\\\nas\\share' }).shortcuts_dir,
      path.normalize('\\\\nas\\share')
    );
  }
});

test('退休字段：读到旧配置里的 basket_behavior / dock_behavior 会被清掉', () => {
  // 这两个字段已经没有任何代码读取，留着会让人以为"能调但没效果"
  const merged = store.mergedSettings({
    basket_behavior: 'floating',
    dock_behavior: 'desktop',
    dock_always_visible: true,
    dock_auto_hide: false
  });
  assert.ok(!('basket_behavior' in merged));
  assert.ok(!('dock_behavior' in merged));
  assert.ok(!('dock_always_visible' in merged));
  assert.strictEqual(merged.dock_auto_hide, false);
});

test('未知字段仍然原样保留（版本间往返不丢）', () => {
  assert.strictEqual(store.mergedSettings({ 未来字段: 42 }).未来字段, 42);
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
  assert.strictEqual(merged.accent_mode, 'off');
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

test('换收录来源目录：黑名单按文件名迁到新目录，冲突条目请出 Dock', () => {
  // 旧目录里手动移除过的，换了目录之后路径对不上、但意愿还在：
  // 新目录里同名文件对应的路径要补进黑名单，旧条目原样保留
  const removed = ['C:\\Users\\me\\Desktop\\Snipaste.lnk', 'C:\\Users\\me\\Desktop\\查无此文件.lnk'];
  const newDir = ['E:\\shortcuts\\Snipaste.lnk', 'E:\\shortcuts\\微信.lnk', 'E:\\shortcuts\\价格.txt'];
  const migrated = dockmodel.migrateRemoved(removed, newDir);
  assert.ok(migrated.includes('E:\\shortcuts\\Snipaste.lnk'), '同名文件的新路径进黑名单');
  assert.ok(migrated.includes(removed[0]) && migrated.includes(removed[1]), '旧黑名单条目保留');
  assert.strictEqual(migrated.length, 3, '不同名的（微信）不受牵连');
  assert.deepStrictEqual(dockmodel.migrateRemoved([], newDir), [], '空黑名单原样返回');
  assert.deepStrictEqual(dockmodel.migrateRemoved(removed, null), removed, '无新目录可迁时原样返回');

  // 与黑名单冲突的现存条目被请出 Dock，其余与顺序保持不变
  const items = ['E:\\shortcuts\\Snipaste.lnk', 'E:\\shortcuts\\微信.lnk', 'E:\\shortcuts\\QQ.lnk'];
  assert.deepStrictEqual(
    dockmodel.removeItems(items, migrated),
    ['E:\\shortcuts\\微信.lnk', 'E:\\shortcuts\\QQ.lnk']
  );
  assert.deepStrictEqual(dockmodel.removeItems([], migrated), []);
  // win32 上路径键不区分大小写
  if (process.platform === 'win32') {
    assert.deepStrictEqual(
      dockmodel.removeItems(['e:\\SHORTCUTS\\snipaste.lnk'], migrated),
      []
    );
  }
});

test('排序：越界与同位置都是原样返回', () => {
  const items = ['a', 'b', 'c'];
  assert.deepStrictEqual(dockmodel.moveItem(items, 0, 2), ['b', 'c', 'a']);
  assert.deepStrictEqual(dockmodel.moveItem(items, 5, 0), items);
  assert.deepStrictEqual(dockmodel.moveItem(items, 1, 1), items);
});

// ---------------------------------------------------------------- Dock 多行布局与弹窗

test('多行布局：单行时不加宽，放不下自动折行', () => {
  const screen = { width: 1920 };
  // 单行：5 项 × (48+12) + 16 = 316
  const single = dockmodel.dockLayout(5, 48, screen.width, 8);
  assert.strictEqual(single.rows, 1);
  assert.strictEqual(single.width, 8 * 2 + 5 * (48 + 12));

  // 45 项：perRow = floor((1920*0.96-16)/60) = 30，折成 2 行
  const multi = dockmodel.dockLayout(45, 48, screen.width, 8);
  assert.strictEqual(multi.rows, 2);
  assert.ok(multi.width <= 1920 * dockmodel.DOCK_WIDTH_RATIO + 1);
  // 高度必须给两行留足空间（含图标下面那行名字），且顶部有余量（放大动画向上生长）
  assert.strictEqual(
    multi.height,
    Math.ceil(48 * dockmodel.DOCK_HEADROOM) +
      2 * (48 + dockmodel.DOCK_CAPTION_H + dockmodel.DOCK_ROW_PITCH) +
      8
  );
});

test('布局：图标下面留了一行名字的高度（只有文件夹筐会写名字）', () => {
  const layout = dockmodel.dockLayout(3, 48, 1920, 8);
  assert.strictEqual(
    layout.height,
    Math.ceil(48 * dockmodel.DOCK_HEADROOM) +
      (48 + dockmodel.DOCK_CAPTION_H + dockmodel.DOCK_ROW_PITCH) +
      8
  );
  // 名字那一行确实占地方：比不留给它的时候高 15
  assert.ok(layout.height > Math.ceil(48 * dockmodel.DOCK_HEADROOM) + (48 + 16) + 8);
});

test('多行布局：图标大过半屏也保证至少一项一行', () => {
  const layout = dockmodel.dockLayout(9, 128, 300, 8);
  assert.strictEqual(layout.perRow, 1);
  assert.strictEqual(layout.rows, 9);
  assert.ok(layout.width <= 300);
});

test('弹窗位置：锚定图标中心、不出屏、不压顶', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const dock = { x: 660, y: 1000, width: 600, height: 110 };
  const popup = { width: 480, height: 460 };
  const rect = dockmodel.popupGeometry(area, dock, 300, popup, 8, 10);
  // 锚点屏幕坐标 = 660+300 = 960，弹窗中心应正对它
  assert.strictEqual(rect.x + rect.width / 2 >= 959 && rect.x + rect.width / 2 <= 961, true);
  // 底边 = dock 顶边 - 10
  assert.strictEqual(rect.y + rect.height, dock.y - 10);
  assert.ok(rect.x >= 8 && rect.x + rect.width <= 1920 - 8);
});

test('弹窗位置：靠边图标被夹回屏内，Dock 太靠上则贴顶', () => {
  const area = { x: 0, y: 0, width: 1280, height: 720 };
  const dock = { x: 0, y: 640, width: 1280, height: 80 };
  const popup = { width: 480, height: 460 };
  const rect = dockmodel.popupGeometry(area, dock, 10, popup, 8, 10);
  assert.strictEqual(rect.x, 8, '最左图标弹窗夹到左边缘');
  assert.ok(rect.x + rect.width <= 1280 - 8);

  // Dock 顶边太靠上（放不下 460 高的弹窗）时夹到顶部边缘
  const tall = dockmodel.popupGeometry(area, { ...dock, y: 400 }, 640, popup, 8, 10);
  assert.strictEqual(tall.y, 8, '顶部放不下时贴顶');
});

test('弹窗位置：Dock 不在时退化为工作区底部居中', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const rect = dockmodel.popupGeometry(area, null, 0, { width: 480, height: 460 });
  assert.strictEqual(Math.round(rect.x + 240), 960);
});

test('点在边界内判定：含余量，出界为假', () => {
  const bounds = { x: 100, y: 200, width: 300, height: 150 };
  assert.strictEqual(dockmodel.pointNearBounds({ x: 250, y: 275 }, bounds), true);
  assert.strictEqual(dockmodel.pointNearBounds({ x: 99, y: 275 }, bounds), false);
  assert.strictEqual(dockmodel.pointNearBounds({ x: 90, y: 275 }, bounds, 16), true);
  assert.strictEqual(dockmodel.pointNearBounds({ x: 450, y: 400 }, bounds, 16), false);
  assert.strictEqual(dockmodel.pointNearBounds(null, bounds), false);
  assert.strictEqual(dockmodel.pointNearBounds({ x: 0, y: 0 }, null), false);
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

// ---------------------------------------------------------------- 快捷方式图标来源
// 背景：Electron 的 app.getFileIcon 靠不住——对 .lnk 只给通用「白纸＋蓝箭头」，对个别
// 目标 exe 也给通用「窗口」图标（实测 ZCode）；MSI 通告式快捷方式（Edge / VS Code /
// Steam / QQ音乐 …）的 .lnk 里连目标都没存。所以快捷方式一律先让 Windows shell 解析，
// Electron 只做兜底。这张候选表锁住这个顺序，免得又退回通用图标。

const shellIcons = require('../src/main/shellIcons');

// 注入假的存在性判断，测试不碰真实文件系统
function existsOnly(...paths) {
  const set = new Set(paths.map((item) => String(item).toLowerCase()));
  return (candidate) => set.has(String(candidate).toLowerCase());
}

test('图标来源：快捷方式一律先问 shell，目标与 .lnk 自己只作兜底', () => {
  const lnk = 'C:\\Users\\me\\Desktop\\Arduino IDE.lnk';
  const exe = 'D:\\arduino\\Arduino IDE.exe';
  assert.deepStrictEqual(shellIcons.iconSources(lnk, { target: exe, icon: exe }, existsOnly(exe)), [
    { kind: 'shell', path: lnk },
    { kind: 'file', path: exe },
    { kind: 'file', path: lnk }
  ]);
});

test('图标来源：MSI 通告式快捷方式没有目标，兜底只能是 .lnk 自己', () => {
  const lnk = 'C:\\Users\\me\\Desktop\\Steam.lnk';
  assert.deepStrictEqual(shellIcons.iconSources(lnk, { target: '', icon: '' }, existsOnly()), [
    { kind: 'shell', path: lnk },
    { kind: 'file', path: lnk }
  ]);
});

test('图标来源：读不出快捷方式信息时仍先问 shell', () => {
  const lnk = 'C:\\Desktop\\broken.lnk';
  assert.deepStrictEqual(shellIcons.iconSources(lnk, null, existsOnly()), [
    { kind: 'shell', path: lnk },
    { kind: 'file', path: lnk }
  ]);
});

test('图标来源：目标失效但 .lnk 记了图标位置，兜底用图标位置', () => {
  const lnk = 'C:\\Desktop\\gone.lnk';
  const icon = 'C:\\Icons\\gone.ico';
  assert.deepStrictEqual(shellIcons.iconSources(lnk, { target: 'C:\\gone.exe', icon }, existsOnly(icon)), [
    { kind: 'shell', path: lnk },
    { kind: 'file', path: icon },
    { kind: 'file', path: lnk }
  ]);
});

test('图标来源：.url 的 IconFile 存在才用，之后退回 .url 自己', () => {
  const url = 'C:\\Desktop\\学习通.url';
  const ico = 'C:\\Icons\\chaoxing.ico';
  assert.deepStrictEqual(shellIcons.iconSources(url, { icon: ico }, existsOnly(ico)), [
    { kind: 'file', path: ico },
    { kind: 'file', path: url }
  ]);
  assert.deepStrictEqual(shellIcons.iconSources(url, { icon: ico }, existsOnly()), [
    { kind: 'file', path: url }
  ]);
});

test('图标来源：.exe 与普通文件问自己，只有一条候选', () => {
  const exe = 'C:\\Desktop\\万用表.exe';
  assert.deepStrictEqual(shellIcons.iconSources(exe, null, existsOnly(exe)), [
    { kind: 'file', path: exe }
  ]);
});

test('图标来源：任何快捷方式最后一条兜底都是 .lnk 自己，保证不会没图标可取', () => {
  const lnk = 'C:\\Desktop\\x.lnk';
  const sources = shellIcons.iconSources(lnk, { target: '', icon: '' }, existsOnly());
  const last = sources[sources.length - 1];
  assert.strictEqual(last.kind, 'file');
  assert.strictEqual(last.path, lnk);
});

// ---------------------------------------------------------------- shellIcons 行式协议
// 与 PowerShell 之间不用 JSON：PS 5.1 的 ConvertFrom-Json 在管道形式下会把整个数组
// 并成一个字符串（实测 COUNT=1），所以改成「base64 请求行 + 分块 base64 PNG」逐行传。
// 请求行第一位是种类：f=文件路径，p=shell 解析名（此电脑/回收站这类虚拟项）。
// 分块还能顺带避免宿主对超长行折行。

const encode = (text) => Buffer.from(text, 'utf8').toString('base64');
const marker = shellIcons.MARKER;

test('请求编码：文件与虚拟项各有种类前缀', () => {
  assert.deepStrictEqual(shellIcons.decodeRequest('fC:\\Desktop\\a.lnk'), {
    kind: 'file',
    value: 'C:\\Desktop\\a.lnk'
  });
  assert.deepStrictEqual(shellIcons.decodeRequest('p::{645FF040-5081-101B-9F08-00AA002F954E}'), {
    kind: 'parsing',
    value: '::{645FF040-5081-101B-9F08-00AA002F954E}'
  });
});

test('行式协议：分块按序号拼回完整 PNG', () => {
  const request = 'fC:\\Desktop\\QQ音乐.lnk';
  const png = 'AAAA' + 'BBBB'.repeat(30);
  const mid = Math.floor(png.length / 2);
  const text = [
    `${marker}${encode(request)} 1 ${png.slice(mid)}`, // 故意乱序：靠序号归位
    `${marker}${encode(request)} 0 ${png.slice(0, mid)}`,
    '这和图标无关的输出'
  ].join('\r\n');
  const rows = shellIcons.parseRows(text);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].request, request);
  assert.strictEqual(rows[0].png, png);
  assert.strictEqual(rows[0].err, '');
});

test('行式协议：没有图标时标记为 - 并能带出原因', () => {
  const request = 'fC:\\Desktop\\微信.lnk';
  const text = `${marker}${encode(request)} - #${encode('add-type: 编译失败')}`;
  const rows = shellIcons.parseRows(text);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].png, '');
  assert.strictEqual(rows[0].err, 'add-type: 编译失败');
  assert.strictEqual(shellIcons.parseOutput(text).size, 0);
});

test('行式协议：中文路径经 base64 往返不乱码', () => {
  const request = 'fC:\\Users\\24256\\Desktop\\哔哩哔哩.lnk';
  assert.strictEqual(shellIcons.parseRows(`${marker}${encode(request)} -`)[0].request, request);
});

test('行式协议：没有标记的输出一律忽略', () => {
  assert.deepStrictEqual(shellIcons.parseRows('随便什么\r\nError: 找不到路径'), []);
});

test('行式协议：多条目互不串味', () => {
  const one = 'fC:\\Desktop\\a.lnk';
  const two = 'p::{645FF040-5081-101B-9F08-00AA002F954E}';
  const text = [
    `${marker}${encode(one)} 0 AAAA`,
    `${marker}${encode(two)} 0 BBBB`,
    `${marker}${encode(one)} 1 CCCC`
  ].join('\n');
  const rows = shellIcons.parseRows(text);
  const byRequest = new Map(rows.map((row) => [row.request, row.png]));
  assert.strictEqual(byRequest.get(one), 'AAAACCCC');
  assert.strictEqual(byRequest.get(two), 'BBBB');
});

// ---------------------------------------------------------------- 系统虚拟项

const specials = require('../src/main/specials');

test('虚拟项：此电脑与回收站都带 shell 解析名和打开方式', () => {
  const pc = specials.findSpecial('thispc');
  const bin = specials.findSpecial('recyclebin');
  assert.strictEqual(pc.label, '此电脑');
  assert.strictEqual(pc.openUri, 'shell:MyComputerFolder');
  assert.ok(pc.parsingName.startsWith('::{'), '解析名必须是 ::{CLSID} 形式');
  assert.strictEqual(bin.label, '回收站');
  assert.strictEqual(bin.openUri, 'shell:RecycleBinFolder');
  assert.ok(bin.parsingName.startsWith('::{'));
});

test('虚拟项：天气指向 Windows 自带的天气应用（图标与打开同一个 AppsFolder 名）', () => {
  const weather = specials.findSpecial(specials.WEATHER_ID);
  assert.strictEqual(weather.label, '天气');
  assert.strictEqual(weather.kind, 'weather', '渲染层靠 kind 把它跟此电脑/回收站分开处理');
  assert.ok(weather.parsingName.startsWith('shell:AppsFolder\\'), 'UWP 应用只能靠 AppsFolder 解析名');
  assert.ok(weather.parsingName.includes('Microsoft.BingWeather_8wekyb3d8bbwe!App'));
  assert.strictEqual(weather.openUri, weather.parsingName, '图标与打开用同一个解析名');
  assert.ok(weather.webFallback.startsWith('https://'), '应用被卸载时要能退到网页版');
  // 另外两项是 shell 类，渲染层按 kind 分流
  assert.strictEqual(specials.findSpecial('recyclebin').kind, 'shell');
});

test('快捷方式候选：只列可收录的、去重、标出是否已在 Dock 上', () => {
  const desktop = [
    'C:\\Users\\me\\Desktop\\QQ音乐.lnk',
    'C:\\Users\\me\\Desktop\\价格.txt',
    'C:\\Users\\me\\Desktop\\ZCode.lnk',
    'C:\\Users\\me\\Desktop\\学习通.url',
    'C:\\Users\\me\\Desktop\\万用表.exe',
    'C:\\Users\\me\\Desktop\\QQ音乐.lnk' // 重复项
  ];
  const rows = dockmodel.shortcutCandidates(desktop, ['C:\\Users\\me\\Desktop\\ZCode.lnk']);
  assert.deepStrictEqual(
    rows.map((row) => row.name).sort(),
    ['QQ音乐.lnk', 'ZCode.lnk', '学习通.url', '万用表.exe'].sort()
  );
  assert.strictEqual(rows.find((row) => row.name === 'ZCode.lnk').onDock, true);
  assert.strictEqual(rows.find((row) => row.name === 'QQ音乐.lnk').onDock, false);
  assert.strictEqual(rows.find((row) => row.name === '学习通.url').onDock, false);
  // 没有任何候选时给空数组，不抛
  assert.deepStrictEqual(dockmodel.shortcutCandidates([], ['C:\\x.lnk']), []);
  assert.deepStrictEqual(dockmodel.shortcutCandidates(null, null), []);
});

// 改名：快捷方式改的是「别名」，只写进设置，磁盘上的文件名一个字都不动
test('别名：空白折叠、首尾去空格、超长截断到 24 字', () => {
  assert.strictEqual(store.normalizeAlias('  哔哩哔哩  '), '哔哩哔哩');
  assert.strictEqual(store.normalizeAlias('哔哩\n哔哩\tB站'), '哔哩 哔哩 B站');
  assert.strictEqual(store.normalizeAlias('一'.repeat(50)).length, store.ALIAS_MAX);
  assert.strictEqual(store.normalizeAlias('   '), '');
  assert.strictEqual(store.normalizeAlias(42), '');
  assert.strictEqual(store.normalizeAlias(null), '');
});

test('别名表：键按绝对路径规范化，空名与非字符串丢掉', () => {
  const aliases = store.normalizeAliases({
    'C:\\Users\\me\\Desktop\\bilibili.lnk': '哔哩哔哩',
    'C:\\Users\\me\\Desktop\\empty.lnk': '   ',
    'C:\\Users\\me\\Desktop\\num.lnk': 7
  });
  assert.deepStrictEqual(Object.values(aliases), ['哔哩哔哩']);
  assert.strictEqual(aliases[path.normalize('C:\\Users\\me\\Desktop\\bilibili.lnk')], '哔哩哔哩');
  // 脏输入不抛，回空表
  assert.deepStrictEqual(store.normalizeAliases(null), {});
  assert.deepStrictEqual(store.normalizeAliases(['x']), {});
});

test('别名：读旧配置时补上空表，写回后仍在', () => {
  assert.deepStrictEqual(store.DEFAULTS.dock_aliases, {});
  assert.deepStrictEqual(store.mergedSettings({}).dock_aliases, {});
  const merged = store.mergedSettings({
    dock_aliases: { 'C:\\Users\\me\\Desktop\\bilibili.lnk': 'B站' }
  });
  assert.deepStrictEqual(Object.values(merged.dock_aliases), ['B站']);
});

test('显示名：有别名用别名，没有就用文件名去后缀，大小写不敏感', () => {
  const target = 'C:\\Users\\me\\Desktop\\bilibili.lnk';
  assert.strictEqual(dockmodel.displayName(target, {}), 'bilibili');
  assert.strictEqual(dockmodel.displayName(target, { [target]: '哔哩哔哩' }), '哔哩哔哩');
  // 键的大小写不同也要认出来（Windows 路径本来就大小写不敏感）
  assert.strictEqual(
    dockmodel.displayName(target, { 'C:\\Users\\me\\Desktop\\BiliBili.lnk': '哔哩哔哩' }),
    '哔哩哔哩'
  );
  assert.strictEqual(dockmodel.displayName('C:\\d\\学习通.url', {}), '学习通');
  assert.strictEqual(dockmodel.displayName('C:\\d\\万用表.exe', {}), '万用表');
  assert.strictEqual(dockmodel.displayName('C:\\d\\价格.txt', {}), '价格.txt');
  assert.strictEqual(dockmodel.displayName('', {}), '');
  assert.strictEqual(dockmodel.displayName(null, null), '');
});

test('虚拟项：不认识的 id 丢掉、重复去重、顺序保持', () => {
  assert.deepStrictEqual(
    specials.normalizeSpecials(['recyclebin', '不存在', 'thispc', 'recyclebin', 42, null]),
    ['recyclebin', 'thispc']
  );
  assert.deepStrictEqual(specials.normalizeSpecials('thispc'), []);
  assert.deepStrictEqual(specials.normalizeSpecials(undefined), []);
});

// ---------------------------------------------------------------- Dock 离底边的距离

test('配置：Dock 默认抬起 48px，越界/非法值回落默认', () => {
  assert.strictEqual(store.DEFAULTS.dock_bottom_gap, 48);
  assert.strictEqual(store.mergedSettings({}).dock_bottom_gap, 48);
  assert.strictEqual(store.mergedSettings({ dock_bottom_gap: 0 }).dock_bottom_gap, 0);
  assert.strictEqual(store.mergedSettings({ dock_bottom_gap: 80 }).dock_bottom_gap, 80);
  assert.strictEqual(store.mergedSettings({ dock_bottom_gap: 9999 }).dock_bottom_gap, 48);
  assert.strictEqual(store.mergedSettings({ dock_bottom_gap: -5 }).dock_bottom_gap, 48);
  assert.strictEqual(store.mergedSettings({ dock_bottom_gap: 12.5 }).dock_bottom_gap, 48);
});

test('几何：任务栏占位时贴它上沿，抬起高度足够时从屏幕底边算', () => {
  const screenRect = { x: 0, y: 0, width: 1920, height: 1080 };
  const taskbar = { x: 0, y: 0, width: 1920, height: 1038 };   // 任务栏占了 42px
  const full = { x: 0, y: 0, width: 1920, height: 1080 };      // 任务栏自动隐藏：工作区就是整屏
  // gap=0：老行为，贴着任务栏上沿
  assert.strictEqual(dockmodel.bottomAnchor(taskbar, screenRect, 0), 1038);
  // 自动隐藏的任务栏冒出来约 40px，gap 比它高就从屏幕底边往上算
  assert.strictEqual(dockmodel.bottomAnchor(full, screenRect, 48), 1032);
  assert.strictEqual(dockmodel.bottomAnchor(taskbar, screenRect, 48), 1032);
  // gap 比任务栏矮：不用白留一道缝，仍然贴着任务栏上沿
  assert.strictEqual(dockmodel.bottomAnchor(taskbar, screenRect, 20), 1038);
  // 没有工作区信息（极端情况）时退回屏幕底边
  assert.strictEqual(dockmodel.bottomAnchor(null, screenRect, 48), 1032);

  // 和 revealedGeometry 拼起来就是 Dock 窗口的 y
  const size = { width: 288, height: 111 };
  const anchor = dockmodel.bottomAnchor(full, screenRect, 48);
  assert.strictEqual(
    dockmodel.revealedGeometry(screenRect, size, dockmodel.EDGE_BOTTOM, 0, anchor).y,
    1080 - 48 - 111
  );
});

// ---------------------------------------------------------------- 右键菜单尺寸

test('菜单尺寸：按条目数累加高度，分隔线更矮', () => {
  const one = dockmodel.menuLayout([{ key: 'open', label: '打开' }]);
  assert.strictEqual(one.height, dockmodel.MENU_ITEM_H + dockmodel.MENU_PADDING_Y * 2);
  const two = dockmodel.menuLayout([
    { key: 'open', label: '打开' },
    { separator: true },
    { key: 'remove', label: '从 Dock 移除' }
  ]);
  assert.strictEqual(
    two.height,
    dockmodel.MENU_ITEM_H * 2 + dockmodel.MENU_SEPARATOR_H + dockmodel.MENU_PADDING_Y * 2
  );
  assert.ok(two.height > one.height);
});

test('菜单尺寸：宽度跟着最长的标签走，并且收在上下限内', () => {
  const narrow = dockmodel.menuLayout([{ key: 'a', label: '打开' }]);
  const wide = dockmodel.menuLayout([{ key: 'b', label: '用系统资源管理器打开所在位置' }]);
  assert.strictEqual(narrow.width, 180, '最短也留 180，别挤成一条');
  assert.ok(wide.width > narrow.width, '长标签要更宽');
  assert.ok(wide.width <= 320, '再长也不超过 320（超出交给省略号）');
  assert.ok(wide.width >= 220);
  // 空菜单不抛，给最小尺寸
  const empty = dockmodel.menuLayout([]);
  assert.strictEqual(empty.width, 180);
  assert.strictEqual(empty.height, dockmodel.MENU_ITEM_H + dockmodel.MENU_PADDING_Y * 2);
  assert.deepStrictEqual(dockmodel.menuLayout(null), empty);
});

test('配置：dock_specials 默认是此电脑＋回收站＋天气（没写过这一项的老配置也是这三个）', () => {
  assert.deepStrictEqual(store.DEFAULTS.dock_specials, ['thispc', 'recyclebin', 'weather']);
  assert.deepStrictEqual(store.mergedSettings({}).dock_specials, ['thispc', 'recyclebin', 'weather']);
  // 显式写过这一项的（比如在设置里撤下了天气）：以用户写的为准，不硬塞默认值
  assert.deepStrictEqual(store.mergedSettings({ dock_specials: ['thispc', 'recyclebin'] }).dock_specials, [
    'thispc',
    'recyclebin'
  ]);
});

test('配置：dock_specials 的脏值被清掉，显式清空要保住', () => {
  assert.deepStrictEqual(store.mergedSettings({ dock_specials: ['recyclebin'] }).dock_specials, [
    'recyclebin'
  ]);
  assert.deepStrictEqual(store.mergedSettings({ dock_specials: ['乱写的'] }).dock_specials, []);
  // 用户把两个都移除后要能保持空（不能被默认值顶回来）
  assert.deepStrictEqual(store.mergedSettings({ dock_specials: [] }).dock_specials, []);
});

// ---------------------------------------------------------------- 图标大小与放大程度

test('配置：Dock 图标大小与悬停放大程度都在范围内取值', () => {
  assert.strictEqual(store.DEFAULTS.dock_icon_size, 48);
  assert.strictEqual(store.DEFAULTS.dock_magnify, 50);

  const custom = store.mergedSettings({ dock_icon_size: 96, dock_magnify: 80 });
  assert.strictEqual(custom.dock_icon_size, 96);
  assert.strictEqual(custom.dock_magnify, 80);

  // 0 是合法值（完全不放大），不能被当成"没填"而回落到默认
  assert.strictEqual(store.mergedSettings({ dock_magnify: 0 }).dock_magnify, 0);
});

test('配置：图标大小与放大程度的越界/非法值回落到默认', () => {
  assert.strictEqual(store.mergedSettings({ dock_icon_size: 9999 }).dock_icon_size, 48);
  assert.strictEqual(store.mergedSettings({ dock_icon_size: 1 }).dock_icon_size, 48);
  assert.strictEqual(store.mergedSettings({ dock_magnify: 101 }).dock_magnify, 50);
  assert.strictEqual(store.mergedSettings({ dock_magnify: -1 }).dock_magnify, 50);
  assert.strictEqual(store.mergedSettings({ dock_magnify: 'x' }).dock_magnify, 50);
});

// ---------------------------------------------------------------- Dock 自动收起

test('配置：Dock 默认自动收起（鼠标离开就不挡窗口），可切回常驻显示', () => {
  assert.strictEqual(store.DEFAULTS.dock_auto_hide, true);
  assert.strictEqual(store.mergedSettings({}).dock_auto_hide, true);
  assert.strictEqual(store.mergedSettings({ dock_auto_hide: false }).dock_auto_hide, false);
  // 非布尔值回落到默认
  assert.strictEqual(store.mergedSettings({ dock_auto_hide: 'yes' }).dock_auto_hide, true);
});

test('自动收起：热区判定与显隐决策配套', () => {
  // 屏幕 1920×1080，底边 3px 为热区
  const screenRect = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.strictEqual(dockmodel.isHotZone({ x: 900, y: 1079 }, screenRect), true);
  assert.strictEqual(dockmodel.isHotZone({ x: 900, y: 1070 }, screenRect), false);

  // 鼠标在热区 → 滑出；离开超过延迟 → 收起
  assert.strictEqual(dockmodel.shouldReveal(true, false, false, false), 'show');
  assert.strictEqual(dockmodel.shouldHide(false, false, false, 100), false, '还没到延迟不收起');
  assert.strictEqual(dockmodel.shouldHide(false, false, false, 400), true, '到延迟收起');
  assert.strictEqual(dockmodel.shouldHide(true, false, false, 99999), false, '鼠标还在 Dock 上不收起');
});

test('自动收起：收起位置在屏幕外，滑出位置贴屏幕底边', () => {
  const screenRect = { x: 0, y: 0, width: 1920, height: 1080 };
  const size = { width: 400, height: 100 };
  const hidden = dockmodel.hiddenGeometry(screenRect, size, 'bottom', 0);
  const shown = dockmodel.revealedGeometry(screenRect, size, 'bottom', 0);
  assert.strictEqual(hidden.y, 1080, '收起时整体移到屏幕下沿之外');
  assert.strictEqual(shown.y + shown.height, 1080, '滑出时底边贴屏幕下沿');
  assert.strictEqual(hidden.x, shown.x, '只上下移动，水平居中不变');
});

// ---------------------------------------------------------------- Dock 桌面层

const windowLayer = require('../src/main/windowLayer');

test('桌面层：判据用的类名必须都在 dockmodel 的桌面外壳类里', () => {
  // PowerShell 脚本里那份类名是硬编码的（跨进程），这里把它钉在 dockmodel 的集合上
  assert.ok(windowLayer.DESKTOP_CLASSES.length > 0);
  for (const cls of windowLayer.DESKTOP_CLASSES) {
    assert.ok(
      dockmodel.SHELL_WINDOW_CLASSES.has(cls),
      `${cls} 必须属于 SHELL_WINDOW_CLASSES`
    );
  }
});

test('桌面层：窗口句柄按小端读出，拿不到回 "0" 不抛异常', () => {
  assert.strictEqual(
    windowLayer.handleOf({ getNativeWindowHandle: () => Buffer.from([0x78, 0x56, 0x34, 0x12]) }),
    String(0x12345678)
  );
  assert.strictEqual(
    windowLayer.handleOf({
      getNativeWindowHandle: () => Buffer.from([0x78, 0x56, 0x34, 0x12, 0, 0, 0, 0])
    }),
    String(0x12345678)
  );
  assert.strictEqual(windowLayer.handleOf(null), '0');
  assert.strictEqual(windowLayer.handleOf({}), '0');
  assert.strictEqual(
    windowLayer.handleOf({
      getNativeWindowHandle: () => {
        throw new Error('窗口已销毁');
      }
    }),
    '0'
  );
});
