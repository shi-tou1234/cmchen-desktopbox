'use strict';

// 窗口工厂：统一出「磨砂玻璃无边框窗口」。
//
// 材质配置是实测定的（1920x1080 / 100% 缩放，背景亮度 225 作基准）：
//   transparent:false + backgroundMaterial:'acrylic'  → 透光比 0.86、糊化比 0.09（真磨砂玻璃）
//   transparent:true（不挂材质）                       → 透光比 0.98、糊化比 0.26（几乎全透不磨砂）
// 注意两种配置都**不是**不透明底，之前 Qt 版那种"变黑块"的问题在 Electron 里不存在。
// 与 token 监测的写法一致：Win 上用系统材质，mac 上用 vibrancy。

const { BrowserWindow, screen } = require('electron');
const path = require('node:path');

const behavior = require('./windowBehavior');
const storeConstants = require('./store');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

const GLASS_MATERIAL = 'acrylic';

// 磨砂模式由设置决定：off 走完全透明（token 的透明模式），其余走系统材质（token 的磨砂模式）
function glassEnabled(settings) {
  return Boolean(settings) && settings.accent_mode !== 'off';
}

function glassOptions(enabled = true) {
  if (!enabled) return { transparent: true, backgroundColor: '#00000000' };
  if (process.platform === 'win32') {
    return {
      transparent: false,
      backgroundColor: '#00000000',
      backgroundMaterial: GLASS_MATERIAL
    };
  }
  if (process.platform === 'darwin') {
    return {
      transparent: true,
      backgroundColor: '#00000000',
      vibrancy: 'hud',
      visualEffectState: 'active'
    };
  }
  return { transparent: true, backgroundColor: '#00000000' };
}

function baseOptions(options = {}) {
  const {
    width = 480,
    height = 320,
    x,
    y,
    glass = true,
    resizable = false,
    minimizable = false,
    maximizable = false,
    focusable = false,
    skipTaskbar = true,
    movable = true,
    alwaysOnTop = false,
    title = 'DeskBasket'
  } = options;

  return {
    width,
    height,
    ...(Number.isInteger(x) ? { x } : {}),
    ...(Number.isInteger(y) ? { y } : {}),
    frame: false,
    show: false,
    hasShadow: false,
    resizable,
    movable,
    minimizable,
    maximizable,
    focusable,
    skipTaskbar,
    alwaysOnTop,
    title,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 渲染层只通过 preload 暴露的 API 操作文件，页面本身不碰 Node
      sandbox: false
    },
    ...glassOptions(glass)
  };
}

function loadPage(win, page, query) {
  const search = query ? `?${new URLSearchParams(query).toString()}` : undefined;
  const target = path.join(RENDERER_DIR, page);
  if (search) win.loadFile(target, { search });
  else win.loadFile(target);
  return win;
}

// 按行为模式建窗：floating / normal / desktop 三个 profile 与 token 一致
function createBehaviorWindow(behaviorName, options = {}) {
  const profile = behavior.WINDOW_BEHAVIOR_PROFILES[
    behavior.normalizeWindowBehavior(behaviorName, 'normal')
  ];
  // 显式传入的选项优先于 profile：Dock 需要"常驻可见 + 锁死位置大小"这个组合，
  // 它不是 token 三个 profile 里的任何一个，只能靠覆盖实现。
  const resolved = {
    focusable: profile.focusable,
    skipTaskbar: false,
    resizable: profile.resizable,
    movable: profile.draggable,
    minimizable: profile.mode !== 'desktop',
    maximizable: profile.mode !== 'desktop',
    alwaysOnTop: profile.alwaysOnTop,
    ...options
  };
  const win = new BrowserWindow(baseOptions(resolved));
  if (typeof win.setAlwaysOnTop === 'function') {
    win.setAlwaysOnTop(Boolean(resolved.alwaysOnTop), 'floating');
  }
  if (typeof win.setMovable === 'function') win.setMovable(Boolean(resolved.movable));
  if (typeof win.setResizable === 'function') win.setResizable(Boolean(resolved.resizable));
  win.__behavior = profile.mode;
  win.setMenuBarVisibility?.(false);
  return win;
}

// 天气悬浮卡片：鼠标靠近 Dock 上的天气图标时，在它上方浮出一张未来几天的小卡片。
// 只读展示，所以不可聚焦（也不抢焦点）、不进任务栏，材质跟菜单一样自绘
// （卡片要浮在任意画面之上，自己画的深/浅色底比让系统材质去糊背景更稳）。
function createWeatherCardWindow(options = {}) {
  const { width = 272, height = 250, x, y, title = 'DeskBasket 天气' } = options;
  const win = new BrowserWindow({
    width,
    height,
    ...(Number.isInteger(x) ? { x } : {}),
    ...(Number.isInteger(y) ? { y } : {}),
    frame: false,
    show: false,
    hasShadow: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    movable: false,
    focusable: false,   // 悬停提示不该把焦点从用户手上抢走
    skipTaskbar: true,
    alwaysOnTop: true,
    title,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    ...glassOptions(false)
  });
  win.setAlwaysOnTop(true, 'popup');
  win.setMenuBarVisibility?.(false);
  return win;
}

function primaryWorkArea() {
  return screen.getPrimaryDisplay().workArea;
}

function primaryBounds() {
  return screen.getPrimaryDisplay().bounds;
}

function listDisplays() {
  return screen.getAllDisplays().map((display) => ({
    bounds: display.bounds,
    primary: display.id === screen.getPrimaryDisplay().id
  }));
}

// 文件夹弹窗：跟随「磨砂模式」设置——完全透明模式就是全透明，磨砂模式挂系统材质。
// 置顶可聚焦（聚焦才能在失焦时自动关闭），不进任务栏，大小可调（右下角拖边缩放，主进程记住）。
// 材质和 transparent 在窗口创建时锁定，所以改了模式要重新开一次弹窗才生效（本来就是每次点开重建）。
function createPopupWindow(options = {}) {
  const {
    width = 480,
    height = 460,
    x,
    y,
    glass = true,
    title = 'DeskBasket 文件夹'
  } = options;
  const win = new BrowserWindow({
    width,
    height,
    ...(Number.isInteger(x) ? { x } : {}),
    ...(Number.isInteger(y) ? { y } : {}),
    frame: false,
    show: false,
    hasShadow: false,
    // 可缩放但不可移动：右下角边缘能拖大拖小，位置仍锚在 Dock 图标上方由主进程摆
    resizable: true,
    minWidth: storeConstants.POPUP_WIDTH_MIN,
    minHeight: storeConstants.POPUP_HEIGHT_MIN,
    maximizable: false,
    minimizable: false,
    movable: false,
    focusable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    title,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    ...glassOptions(glass)
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setMenuBarVisibility?.(false);
  return win;
}

// 改名输入窗：Electron 没有 window.prompt（调用会抛异常、把渲染进程卡住），
// Dock 窗口又不可聚焦、收不到键盘，所以改名用一个钉在 Dock 上方的可聚焦小窗。
// 不显示 name 之外的任何字段，输入完回车即提交。
function createRenameWindow(options = {}) {
  const { width = 320, height = 132, x, y, glass = true, title = 'DeskBasket 改名' } = options;
  const win = new BrowserWindow({
    width,
    height,
    ...(Number.isInteger(x) ? { x } : {}),
    ...(Number.isInteger(y) ? { y } : {}),
    frame: false,
    show: false,
    hasShadow: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    movable: true,
    focusable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    title,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    ...glassOptions(glass)
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setMenuBarVisibility?.(false);
  return win;
}

// 右键菜单窗：自绘菜单要一个尺寸刚好的可聚焦小窗。
// 不做系统材质——菜单要的是一直看得清，所以窗口全透明、底色由页面自己画。
function createMenuWindow(options = {}) {
  const { width = 220, height = 120, x, y, title = 'DeskBasket 菜单' } = options;
  const win = new BrowserWindow({
    width,
    height,
    ...(Number.isInteger(x) ? { x } : {}),
    ...(Number.isInteger(y) ? { y } : {}),
    frame: false,
    show: false,
    hasShadow: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    movable: false,
    focusable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    title,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    ...glassOptions(false)
  });
  win.setAlwaysOnTop(true, 'popup');
  win.setMenuBarVisibility?.(false);
  return win;
}

module.exports = {
  GLASS_MATERIAL,
  createBehaviorWindow,
  createMenuWindow,
  createPopupWindow,
  createRenameWindow,
  createWeatherCardWindow,
  glassEnabled,
  glassOptions,
  listDisplays,
  loadPage,
  primaryBounds,
  primaryWorkArea
};
