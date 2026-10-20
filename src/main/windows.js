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

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

// 应用图标（assets/icon.ico，见 scripts/make_ico.py）：挂到每个窗口上。打包后窗口图标
// 会落到 exe（electron-builder 认 build.win.icon），这里主要管开发态的任务栏/Alt-Tab，
// 以及 Dock 窗口在任务栏里的那一格。
const APP_ICON = path.join(__dirname, '..', 'assets', 'icon.ico');

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
    icon: APP_ICON,
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
  // 菜单条藏起来不够：Electron 默认菜单的加速键（Ctrl+A 全选/Ctrl+R 刷新/F11…）仍然
  // 活着且**抢在页面 keydown 之前**——弹窗里 Ctrl+A 全选失灵的真凶就是它。整个摘掉。
  win.removeMenu?.();
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
    icon: APP_ICON,
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
  // 菜单条藏起来不够：Electron 默认菜单的加速键（Ctrl+A 全选/Ctrl+R 刷新/F11…）仍然
  // 活着且**抢在页面 keydown 之前**——弹窗里 Ctrl+A 全选失灵的真凶就是它。整个摘掉。
  win.removeMenu?.();
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
// 置顶可聚焦（聚焦才能在失焦时自动关闭），不进任务栏。
// **刻意 resizable:false**：Windows 可缩放的无边框窗口左/右/下各有一圈 8px 隐形 resize 边、
// 顶部没有，页面永远画不到那圈里——1.3 的悬浮卡片就被它衬成了"套盒"。关掉原生缩放后
// 客户区＝窗口矩形，卡片才能铺满浑然一体；缩放走页面右下角把手（popup:resize → setBounds，
// setBounds 不受 resizable 影响）。
// 材质和 transparent 在窗口创建时锁定，所以改了模式要重新开一次弹窗才生效（本来就是每次点开重建）。
// hasShadow：软投影交给窗口原生投影画在窗口矩形之外。
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
    hasShadow: true,
    // 缩放只走页面把手（见上），窗口本身不吃原生 resize 边
    resizable: false,
    maximizable: false,
    minimizable: false,
    movable: false,
    focusable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    title,
    icon: APP_ICON,
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
  // 菜单条藏起来不够：Electron 默认菜单的加速键（Ctrl+A 全选/Ctrl+R 刷新/F11…）仍然
  // 活着且**抢在页面 keydown 之前**——弹窗里 Ctrl+A 全选失灵的真凶就是它。整个摘掉。
  win.removeMenu?.();
  return win;
}

// 音乐律动频谱（绘制窗）：Dock 图标行上方一条透明、鼠标穿透的频谱带。
// 它**只画不采**——真实频谱由隔壁的抓取窗（createVizCaptureWindow）做 FFT 后推过来（见 viz.js）。
// 关键几点：
//   · transparent:true + 全透明底——带子本身由页面自绘，四周完全透出去，绝不糊成一块黑；
//   · focusable:false + skipTaskbar:true——它是背景装饰，不抢焦点、不进任务栏 / Alt-Tab；
//   · **不置顶**：跟常驻 Dock 一样是个普通窗口，主进程 show 完之后会把它压到桌面层
//     （windowLayer.placeOnDesktopLayer）。屏保级置顶会让它压在一切应用之上，正是要修掉的毛病；
//   · resizable:false / movable:false——位置大小由主进程按设置摆，页面不需要拖。
// 用 glassOptions(false)（完全透明），不走系统材质——频谱要的是「浮在桌面壁纸上的一层光」，
// 拿磨砂去糊背后的窗口反而脏。
function createVizWindow(options = {}) {
  const { width = 960, height = 130, x, y, title = 'DeskBasket 律动' } = options;
  const win = new BrowserWindow({
    width,
    height,
    ...(Number.isInteger(x) ? { x } : {}),
    ...(Number.isInteger(y) ? { y } : {}),
    frame: false,
    show: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    skipTaskbar: true,
    title,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 窗口被应用盖住 = 被当成后台页：默认会节流定时器、停掉绘制。频谱要一直"活着"，
      // 不然露出来时是几秒前（甚至启动那一刻）的旧画面。
      backgroundThrottling: false
    },
    ...glassOptions(false)
  });
  win.setMenuBarVisibility?.(false);
  win.removeMenu?.();
  return win;
}

// 音乐律动抓取窗：Chromium 系统音频环回（loopback）就在这里跑——用 desktopCapturer 拿屏幕源、
// getUserMedia(chromeMediaSource:'desktop') 抓到的是**整机外放**（QQ音乐/网易云/网页都算），
// 直接喂 Web Audio AnalyserNode 做**真·逐频段 FFT**（MediaStream 是本页实时源，不受 file:// 那种
// 跨源污染限制，所以拿得到数据——这正是之前 Blob 方案在预览窗里做的事，只是源换成系统环回）。
// 与绘制窗分成两扇的原因：
//   · 绘制窗必须 focusable:false + 鼠标穿透（压在一切之上还不吃点击），这种窗在 Chromium 里
//     无法承载"授权/取流"所需的聚焦与（回退时的）用户手势；抓取窗要能在静默授权失败时
//     显出一个可点的"授权"面板，所以它 focusable:true、不穿透。
//   · 抓取窗常驻后台做 FFT，绝不能被 Chromium 的后台节流掐掉 → backgroundThrottling:false，
//     且用 setInterval（不是 rAF）读频谱：窗口隐藏时 rAF 会停，setInterval 不停。
// 用**独立 session 分区**（partition）：主进程只给这一个分区放行 'media' 权限，
// 不动默认 session，避免把麦克风/桌面共享权限意外开放给其它任何窗口。
function createVizCaptureWindow(options = {}) {
  const { width = 320, height = 96, x, y, title = 'DeskBasket 律动授权' } = options;
  const win = new BrowserWindow({
    width,
    height,
    ...(Number.isInteger(x) ? { x } : {}),
    ...(Number.isInteger(y) ? { y } : {}),
    frame: false,
    show: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: true,     // 需要能在静默失败时聚焦、接受一次"授权"点击
    skipTaskbar: true,
    alwaysOnTop: false,
    title,
    icon: APP_ICON,
    backgroundColor: '#00000000',
    transparent: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      partition: 'persist:deskbasket-vizcap'
    }
  });
  win.setMenuBarVisibility?.(false);
  win.removeMenu?.();
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
    icon: APP_ICON,
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
  // 菜单条藏起来不够：Electron 默认菜单的加速键（Ctrl+A 全选/Ctrl+R 刷新/F11…）仍然
  // 活着且**抢在页面 keydown 之前**——弹窗里 Ctrl+A 全选失灵的真凶就是它。整个摘掉。
  win.removeMenu?.();
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
    icon: APP_ICON,
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
  // 菜单条藏起来不够：Electron 默认菜单的加速键（Ctrl+A 全选/Ctrl+R 刷新/F11…）仍然
  // 活着且**抢在页面 keydown 之前**——弹窗里 Ctrl+A 全选失灵的真凶就是它。整个摘掉。
  win.removeMenu?.();
  return win;
}

module.exports = {
  GLASS_MATERIAL,
  createBehaviorWindow,
  createMenuWindow,
  createPopupWindow,
  createRenameWindow,
  createWeatherCardWindow,
  createVizCaptureWindow,
  createVizWindow,
  glassEnabled,
  glassOptions,
  listDisplays,
  loadPage,
  primaryBounds,
  primaryWorkArea
};
