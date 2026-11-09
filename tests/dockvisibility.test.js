'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const store = require('../src/main/store');
const mouseState = require('../src/main/mouseState');
const main = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8');

// 执行实际生产函数，模拟系统观测与窗口，不用源码字符串包含检查代替行为断言。
function functionSource(name) {
  const start = main.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  let depth = 0;
  for (let i = main.indexOf('{', start); i < main.length; i++) {
    if (main[i] === '{') depth++;
    if (main[i] === '}' && --depth === 0) return main.slice(start, i + 1);
  }
  throw new Error(`Unclosed function ${name}`);
}

function interactionContext() {
  const context = vm.createContext({
    focusActive: false, dockManuallyHidden: false,
    process: { platform: 'win32' },
    settings: { dock_enabled: true, dock_auto_hide: false },
    dockRevealed: true,
    dockWindow: { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false },
    mouseState: { poll: () => ({ known: true, dockExposed: true, pointer: { x: 200, y: 400 } }) },
    screen: { screenToDipPoint: p => ({ x: p.x / 2, y: p.y / 2 }), getCursorScreenPoint: () => ({ x: 100, y: 200 }) }
  });
  vm.runInContext(functionSource('dockCanInteract'), context);
  return context;
}

test('旧按住热键从默认、历史配置与恢复默认配置中迁出；未知用户字段保留', () => {
  assert.equal('dock_peek_hotkey' in store.DEFAULTS, false);
  for (const hotkey of ['Ctrl+Z', 'Ctrl+Win+Z', '', 7]) {
    const migrated = store.mergedSettings({ dock_peek_hotkey: hotkey, custom: '保留' });
    assert.equal('dock_peek_hotkey' in migrated, false);
    assert.equal(migrated.custom, '保留');
    assert.equal(migrated.dock_hotkey, 'F9');
  }
  assert.doesNotMatch(main, /require\(['"]\.\/keyHold|registerPeekHotkey|beginPeek|peekHeld/);
  for (const file of ['settings.html', 'settings.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../src/renderer', file), 'utf8'), /dockPeekHotkey|dock_peek_hotkey|Ctrl\+Win\+Z/);
  }
});

test('可见且未遮挡的 Dock 接受悬停，物理像素正确转换为 200% 缩放的 DIP', () => {
  assert.equal(interactionContext().dockCanInteract(), true);
});

test('被遮挡、已隐藏、最小化、收起和已禁用的 Dock 全部拒绝交互', () => {
  const cases = [
    c => { c.mouseState.poll = () => ({ known: true, dockExposed: false }); },
    c => { c.dockWindow.isVisible = () => false; },
    c => { c.dockWindow.isMinimized = () => true; },
    c => { c.dockRevealed = false; },
    c => { c.settings.dock_enabled = false; },
    c => { c.dockWindow = null; }
  ];
  for (const change of cases) {
    const c = interactionContext(); change(c);
    assert.equal(c.dockCanInteract(), false);
  }
});

test('侦察预热、报数丢失或指针已移动时，不使用旧的无遮挡结果', () => {
  const c = interactionContext();
  c.mouseState.poll = () => ({ known: false, held: true, grace: true });
  assert.equal(c.dockCanInteract(), false);
  c.mouseState.poll = () => ({ known: true, dockExposed: true, pointer: { x: 1000, y: 1000 } });
  assert.equal(c.dockCanInteract(), false);
});

test('即使渲染层发出天气请求，被遮挡的 Dock 也不会创建天气窗', () => {
  const c = interactionContext();
  c.settings.dock_specials = ['weather'];
  c.specials = { WEATHER_ID: 'weather' };
  c.mouseState.poll = () => ({ known: true, dockExposed: false });
  vm.runInContext(functionSource('showWeatherCard'), c);
  assert.equal(c.showWeatherCard(100), false);
});

test('鼠标侦察解析负坐标、多屏与真实顶层窗口句柄；旧报文保持兼容', () => {
  assert.deepEqual(mouseState.parseReport('1:0:1:-1920:1080:123456'), {
    held: true, overDesktop: false, dockExposed: true,
    pointer: { x: -1920, y: 1080 }, rootHandle: '123456'
  });
  assert.deepEqual(mouseState.parseReport('0:1'), { held: false, overDesktop: true });
  for (const malformed of ['0:0:2:1:2', '0:0:1:x:2', '0:0:1:1', '0:0:1:1:2:bad']) {
    assert.equal(mouseState.parseReport(malformed), null);
  }
});

test('Dock 只变宽高、左上角不动时仍更新实际窗口尺寸', () => {
  let bounds;
  const c = vm.createContext({
    focusActive: false, dockManuallyHidden: false,
    dockWindow: { isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }), setBounds: b => { bounds = b; } },
    dockSlideTimer: null, clearInterval() {}, settings: { reduce_motion: true }
  });
  vm.runInContext(functionSource('slideDockTo'), c);
  const target = { x: 0, y: 0, width: 200, height: 150 };
  c.slideDockTo(target);
  assert.deepEqual(bounds, target);
});

test('快速置顶后取消：过期 30ms 回调不能再次置顶；换窗口也不能串用回调', () => {
  const calls = [], callbacks = [];
  const win = {
    isDestroyed: () => false,
    setAlwaysOnTop: value => calls.push(value), moveTop() {}
  };
  const c = vm.createContext({
    focusActive: false, dockManuallyHidden: false,
    dockWindow: win, zorderSent: { on: null, at: 0 }, dockLayerRevision: 0,
    Date, setTimeout: fn => callbacks.push(fn),
    zorder: { ensureRunning() {}, apply: async (_, top) => ({ ok: true, top }) },
    windowLayer: { handleOf: () => '123' }
  });
  vm.runInContext(functionSource('setDockTopmost'), c);
  c.setDockTopmost(true);
  c.setDockTopmost(false);
  callbacks.shift()();
  assert.deepEqual(calls, [false, false]);
  c.setDockTopmost(true);
  c.dockWindow = { ...win };
  callbacks.shift()();
  assert.deepEqual(calls, [false, false, false]);
});

test('遮挡检测不会被拖拽绕过，也会清空已有悬停并恢复鼠标穿透', () => {
  const c = interactionContext();
  let ignored, probe = '未通知';
  Object.assign(c, {
    DOCK_DRAG_WATCH_PAD: 200, DOCK_MOVE_EPSILON: 6,
    dockPointerMoving: false, dockLastPoint: null, dockDragArmed: true,
    dockWatchAt: Date.now(), dockPointerNear: false, dockPointerInside: true,
    dockmodel: { pointNearBounds: () => true },
    setDockClickThrough: value => { ignored = value; },
    sendDockPointer: point => { probe = point; }
  });
  c.dockWindow.getBounds = () => ({ x: 0, y: 0, width: 500, height: 500 });
  c.mouseState.poll = () => ({ known: true, held: true, dockExposed: false });
  vm.runInContext(functionSource('tickDockClickThrough'), c);
  c.tickDockClickThrough();
  assert.equal(ignored, true);
  assert.equal(probe, null);
  assert.equal(c.dockDragArmed, false);
  assert.equal(c.dockPointerInside, false);
});

test('设置白名单接受空闲释放；恢复默认覆盖全部频谱选项且不覆盖用户筐', () => {
  const patchText = main.match(/const SETTINGS_PATCH_KEYS = new Set\(([\s\S]*?)\);/)[1];
  const resetText = main.match(/const RESETTABLE_KEYS = (\[[\s\S]*?\]);/)[1];
  const allowed = vm.runInNewContext(patchText);
  const reset = vm.runInNewContext(resetText);
  const changed = store.mergedSettings({ idle_release: false, viz_style: 'line', viz_theme: 'mint',
    viz_width: 'wide', viz_reflect: false, viz_position: 'top', viz_align: 'left' });
  const patch = { idle_release: false, baskets: [] };
  const accepted = Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.includes(key)));
  assert.deepEqual(accepted, { idle_release: false });
  const restored = store.mergedSettings({ ...changed, ...Object.fromEntries(reset.map(key => [key, store.DEFAULTS[key]])) });
  for (const key of ['idle_release', 'viz_style', 'viz_theme', 'viz_width', 'viz_reflect', 'viz_position', 'viz_align']) {
    assert.equal(restored[key], store.DEFAULTS[key], key);
  }
  assert.equal(reset.includes('baskets'), false);
});

test('窗口图标的实际路径存在于应用打包资源清单', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/windows.js'), 'utf8');
  const expression = source.match(/const APP_ICON = (.*);/)[1];
  const icon = vm.runInNewContext(expression, { path, __dirname: path.join(__dirname, '../src/main') });
  assert.equal(fs.existsSync(icon), true);
  const manifest = require('../package.json');
  assert.ok(manifest.build.files.includes(path.relative(path.join(__dirname, '..'), icon).replaceAll('\\', '/')));
});
