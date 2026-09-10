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

// 桌面挂件类窗口：不抢焦点、不进任务栏、常驻置顶
function createWidgetWindow(options = {}) {
  const win = new BrowserWindow(
    baseOptions({ focusable: false, skipTaskbar: true, alwaysOnTop: true, ...options })
  );
  if (typeof win.setAlwaysOnTop === 'function') {
    win.setAlwaysOnTop(true, 'floating');
  }
  win.setMenuBarVisibility?.(false);
  return win;
}

// 普通窗口（按领导要求：文件夹做成普通窗口——可聚焦、进任务栏、可最小化）
function createNormalWindow(options = {}) {
  const win = new BrowserWindow(
    baseOptions({
      focusable: true,
      skipTaskbar: false,
      resizable: true,
      minimizable: true,
      alwaysOnTop: false,
      ...options
    })
  );
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

module.exports = {
  GLASS_MATERIAL,
  glassEnabled,
  createNormalWindow,
  createWidgetWindow,
  glassOptions,
  listDisplays,
  loadPage,
  primaryBounds,
  primaryWorkArea
};
