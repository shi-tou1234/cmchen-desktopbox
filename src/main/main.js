'use strict';

// DeskBasket 主进程：Dock 编排、文件夹弹窗、设置窗口、托盘、IPC、自启。
//
// 形态（按领导要求）：
// - 不再有"桌面文件筐"独立窗口：筐（文件夹）显示在 Dock 里，点击弹出文件夹弹窗；
// - Dock 完全透明（无任何系统材质、无底色）、紧贴屏幕底边、多行排布保证全部渲染；
// - 快捷方式图标：.lnk 先从 readShortcutLink 拿目标再取真实图标；拿不到目标的是
//   MSI 通告式快捷方式（.lnk 里只有 Darwin 描述符），改由 shellIcons 让 Windows
//   shell 自己解析（Electron 的 getFileIcon 对 .lnk 只会给通用白纸图标）；
// - 弹窗材质自研：透明窗口 + 截取弹窗背后的屏幕区域，渲染层自己高斯模糊成磨砂玻璃。

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell,
  screen
} = require('electron');

const store = require('./store');
const basketModel = require('./baskets');
const dockmodel = require('./dockmodel');
const filebrowse = require('./filebrowse');
const shellIcons = require('./shellIcons');
const specials = require('./specials');
const windowLayer = require('./windowLayer');
const winFactory = require('./windows');
const autostart = require('./autostart');

const APP_NAME = 'DeskBasket';
const DOCK_PADDING = 8;

// 文件夹弹窗：位置在 Dock 上方，大小固定
const POPUP_WIDTH = 480;
const POPUP_HEIGHT = 460;
const POPUP_EDGE_GAP = 8;    // 弹窗与屏幕左右/上边的最小距离
const POPUP_DOCK_GAP = 10;   // 弹窗与 Dock 上沿的间距
const POPUP_BLUR_CLOSE_MS = 220; // 失焦后多久关（留出"点击 Dock 图标切换"的时间）
const POPUP_CLOSE_ANIM_MS = 200; // 收起动画时长：先让渲染层缩回去，再销毁窗口
const POPUP_FADE_MS = 160;       // 窗口整体淡入/淡出：磨砂模式下材质底是不透明的，
const POPUP_FADE_STEPS = 7;      // 光靠内容缩放会和材质底对不上，所以两者一起做
// 鼠标离开自动关：弹窗显示不抢焦点（showInactive），拿不到系统失焦事件，
// 由主进程轮询鼠标位置——不在弹窗 ∪ Dock 的附近区域连续一段时间就关。
const POPUP_HOVER_CHECK_MS = 250;
const POPUP_AWAY_CLOSE_MS = 900;

let settings = null;
let tray = null;
let dockWindow = null;
let settingsWindow = null;

let popupWindow = null;        // 当前文件夹弹窗
let popupKey = null;           // 'basket:b1' 或 'dir:C:\\xx'，用于点同一个文件夹时切换关闭
let popupPayload = null;        // 弹窗渲染层就绪时取走的数据
let popupBlurTimer = null;
let popupHoverTimer = null;    // 鼠标离开自动关的轮询
let menuOpen = false;          // 有原生命令菜单在弹：期间弹窗不许"失焦即关"
let menuPicked = null;         // 命令菜单选中的 key

const iconCache = new Map();      // `${size}:${pathKey}` -> dataURL
const shortcutCache = new Map();  // pathKey -> shell.readShortcutLink 结果或 null

// ------------------------------------------------------------------ 工具

function desktopDir() {
  return path.join(os.homedir(), 'Desktop');
}

function desktopItems() {
  try {
    return fs
      .readdirSync(desktopDir())
      .filter((name) => name.toLowerCase() !== 'desktop.ini')
      .map((name) => path.join(desktopDir(), name));
  } catch (_) {
    return [];
  }
}

function persist() {
  settings = store.saveSettings(settings);
  broadcastState();
  return settings;
}

// 出问题要看得见：页面加载失败、渲染进程抛错都转发到主进程 stderr
function attachDiagnostics(win, tag) {
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[${tag}] 页面加载失败 ${code} ${description} ${url}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[${tag}] 渲染进程退出`, details && details.reason);
  });
  win.webContents.on('console-message', (...args) => {
    const params = args[1];
    if (params && typeof params === 'object') {
      if (params.level === 'error') {
        console.error(`[${tag}] 渲染层报错: ${params.message} (${params.sourceId}:${params.lineNumber})`);
      }
      return;
    }
    if (Number(params) >= 2) {
      console.error(`[${tag}] 渲染层报错: ${args[2]} (${args[4]}:${args[3]})`);
    }
  });
  win.once('ready-to-show', () => console.log(`[${tag}] 已就绪`));
}

function broadcastState() {
  const payload = { settings };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('state:changed', payload);
  }
}

function findBasket(id) {
  return basketModel.findBasket(settings.baskets, id);
}

function replaceBasket(basket) {
  settings.baskets = settings.baskets.map((item) => (item.id === basket.id ? basket : item));
  persist();
  return basket;
}

// 把一个筐转成渲染层直接可用的视图：带上每个条目是否存在、是不是目录
function basketView(basket) {
  if (!basket) return null;
  return {
    ...basket,
    entries: (basket.items || []).map((item) => {
      let exists = false;
      let isDir = false;
      try {
        const stat = fs.statSync(item);
        exists = true;
        isDir = stat.isDirectory();
      } catch (_) {
        exists = false;
      }
      return { path: item, name: path.basename(item) || item, exists, isDir };
    })
  };
}

function ensureBasket() {
  if (settings.baskets.length) return settings;
  const created = basketModel.createBasket([], '桌面文件筐');
  settings.baskets = created.baskets;
  persist();
  return settings;
}

// ------------------------------------------------------------------ 快捷方式解析与图标

function readShortcutCached(target) {
  const key = store.pathKey(target);
  if (shortcutCache.has(key)) return shortcutCache.get(key);
  let info = null;
  try {
    info = shell.readShortcutLink(target);
  } catch (_) {
    info = null;
  }
  shortcutCache.set(key, info);
  return info;
}

// .url 文件是 INI：IconFile= 一行指向图标；%SystemRoot% 之类环境变量展开
function iconFileFromUrl(target) {
  const extract = (text) => {
    const match = /^[ \t]*IconFile[ \t]*=[ \t]*(.+)$/gim.exec(text);
    if (!match) return null;
    const raw = match[1].trim();
    if (!raw) return null;
    const expanded = raw.replace(/%([^%]+)%/g, (_all, name) => process.env[name] || '');
    return expanded || null;
  };
  try {
    const buffer = fs.readFileSync(target);
    // UTF-16 BOM 先按 utf16le 读，否则按 utf8
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      const found = extract(buffer.toString('utf16le'));
      if (found) return found;
    }
    return extract(buffer.toString('utf8'));
  } catch (_) {
    return null;
  }
}

// 快捷方式自己声明的落点 / 图标位置（.lnk 来自 readShortcutLink，.url 来自 IconFile）
function declaredIconSource(target) {
  const lowered = String(target).toLowerCase();
  if (lowered.endsWith('.lnk')) {
    const link = readShortcutCached(target);
    return link ? { target: link.target, icon: link.icon } : null;
  }
  if (lowered.endsWith('.url')) return { target: '', icon: iconFileFromUrl(target) };
  return null;
}

function iconExists(candidate) {
  try {
    return fs.existsSync(candidate);
  } catch (_) {
    return false;
  }
}

async function electronIcon(target, size) {
  try {
    const image = await app.getFileIcon(target, { size: size >= 48 ? 'large' : 'normal' });
    if (image && !image.isEmpty()) return image.toDataURL();
  } catch (_) {
    /* 取不到就走下一个候选来源 */
  }
  return '';
}

// 依次尝试候选来源，第一个拿到图标的即为结果（候选顺序见 shellIcons.iconSources）：
// 快捷方式先让 Windows shell 解析——Explorer 显示什么就显示什么；Electron 只兜底。
async function iconFor(target, size = 48) {
  const key = `${size}:${store.pathKey(target)}`;
  if (iconCache.has(key)) return iconCache.get(key);
  const sources = shellIcons.iconSources(target, declaredIconSource(target), iconExists);
  let dataUrl = '';
  for (const source of sources) {
    dataUrl =
      source.kind === 'shell'
        ? await shellIcons.iconDataUrl(source.path, shellIcons.ICON_PX)
        : await electronIcon(source.path, size);
    if (dataUrl) break;
  }
  iconCache.set(key, dataUrl);
  return dataUrl;
}

// 系统虚拟项（此电脑 / 回收站）的图标与打开方式。它们没有磁盘路径：
// 图标让 shell 按解析名换成 PIDL 去取（固定 128px，渲染层按需缩放），
// 打开交给 ShellExecute 的 shell: URI。
function specialIconFor(id) {
  const special = specials.findSpecial(id);
  if (!special) return Promise.resolve('');
  return shellIcons.parsingNameIconDataUrl(special.parsingName, shellIcons.ICON_PX);
}

async function openSpecial(id) {
  const special = specials.findSpecial(id);
  if (!special) return { ok: false, error: '未知的系统图标' };
  // 先用解析名打开（openPath 会回一个错误字符串，能拿到真实成败），失败再试 shell: URI
  const message = await shell.openPath(special.parsingName);
  if (!message) return { ok: true, error: '' };
  try {
    await shell.openExternal(special.openUri);
    return { ok: true, error: '' };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error || message) };
  }
}

// 点击 Dock 快捷方式时的落点：快捷方式指向文件夹（或拖进来的本来就是文件夹）就弹窗
function resolveDirTarget(target) {
  try {
    if (fs.statSync(target).isDirectory()) return target;
  } catch (_) {
    return null;
  }
  return null;
}

function dirTargetForShortcut(target) {
  const direct = resolveDirTarget(target);
  if (direct) return direct;
  const lowered = String(target).toLowerCase();
  if (lowered.endsWith('.lnk')) {
    const link = readShortcutCached(target);
    if (link && link.target) {
      const resolved = resolveDirTarget(link.target);
      if (resolved) return resolved;
    }
  }
  return null;
}

// ------------------------------------------------------------------ 窗口：Dock

function dockSize() {
  const display = screen.getPrimaryDisplay();
  // Dock 条目 = 系统虚拟项（此电脑/回收站）＋筐（文件夹）＋快捷方式
  const count =
    settings.dock_items.length +
    settings.dock_specials.length +
    Math.max(1, settings.baskets.length);
  const layout = dockmodel.dockLayout(count, settings.dock_icon_size, display.bounds.width, DOCK_PADDING);
  return { width: layout.width, height: layout.height };
}

function dockTargetGeometry() {
  const display = screen.getPrimaryDisplay();
  const size = dockSize();
  // 紧贴底部：任务栏占位（未自动隐藏）时贴其上沿，否则贴屏幕底边，一点缝都不留
  const anchor =
    display.workArea.height < display.bounds.height
      ? display.workArea.y + display.workArea.height
      : display.bounds.y + display.bounds.height;
  return dockmodel.revealedGeometry(display.bounds, size, dockmodel.EDGE_BOTTOM, 0, anchor);
}

function applyDockGeometry() {
  if (!dockWindow || dockWindow.isDestroyed()) return;
  // 收起状态下别把它拽回底边（比如改了图标大小触发几何重算时）
  const target =
    !settings.dock_auto_hide || dockRevealed ? dockTargetGeometry() : dockHiddenGeometry();
  dockWindow.setBounds(target);
}

// ------------------------------------------------------------------ Dock 自动收起
//
// 领导要求 Dock「只在桌面上显示，不浮在其他程序上面」。
// 真正的"桌面层"（窗口位于壁纸之上、所有应用窗口之下）在这台机器上做不到：
// 实测四种 SetWindowPos 插入点都会让窗口被壁纸盖住或掉到桌面层之下（"可见但看不见"），
// 与上一版 BLOCKED.md 里 Qt 的结论一致。
//
// 所以改用收放：鼠标不在 Dock 附近时把它滑到屏幕外，需要时碰一下底边就滑出来。
// 效果上它不会挡着任何窗口，而判定只用屏幕坐标（Electron 自带，不需要任何系统调用）。
const DOCK_WATCH_MS = 180;
const DOCK_SLIDE_STEPS = 8;
const DOCK_SLIDE_STEP_MS = 18;
const DOCK_PEEK_PX = 1;      // 收起时留一条发丝在屏幕内，避免窗口完全离屏
const DOCK_HOT_ZONE_PX = 8;  // 底边感应带厚度：太薄不好瞄（任务栏自己也占着底边）

let dockWatchTimer = null;
let dockSlideTimer = null;
let dockRevealed = true;
let dockLeftAt = 0;

function dockHiddenGeometry() {
  const display = screen.getPrimaryDisplay();
  return dockmodel.hiddenGeometry(display.bounds, dockSize(), dockmodel.EDGE_BOTTOM, DOCK_PEEK_PX);
}

// 平滑滑动到目标位置（逐帧改窗口 y，做出"滑出/收起"的手感）
function slideDockTo(target) {
  if (!dockWindow || dockWindow.isDestroyed()) return;
  clearInterval(dockSlideTimer);
  dockSlideTimer = null;
  const from = dockWindow.getBounds();
  if (from.y === target.y && from.x === target.x) return;
  let step = 0;
  dockSlideTimer = setInterval(() => {
    if (!dockWindow || dockWindow.isDestroyed()) {
      clearInterval(dockSlideTimer);
      dockSlideTimer = null;
      return;
    }
    step += 1;
    const t = Math.min(1, step / DOCK_SLIDE_STEPS);
    const eased = 1 - Math.pow(1 - t, 3);   // 缓出：收尾干脆
    dockWindow.setBounds({
      x: target.x,
      y: Math.round(from.y + (target.y - from.y) * eased),
      width: target.width,
      height: target.height
    });
    if (step >= DOCK_SLIDE_STEPS) {
      clearInterval(dockSlideTimer);
      dockSlideTimer = null;
    }
  }, DOCK_SLIDE_STEP_MS);
}

function cursorNearDock() {
  if (!dockWindow || dockWindow.isDestroyed()) return false;
  const display = screen.getPrimaryDisplay();
  const point = screen.getCursorScreenPoint();
  return (
    dockmodel.pointNearBounds(point, dockWindow.getBounds(), 6) ||
    dockmodel.isHotZone(point, display.bounds, dockmodel.EDGE_BOTTOM, DOCK_HOT_ZONE_PX)
  );
}

function tickDockAutoHide() {
  if (!dockWindow || dockWindow.isDestroyed()) return;
  if (!settings.dock_enabled) return;
  if (!settings.dock_auto_hide) {
    // 常驻显示：一直贴在底边
    if (!dockRevealed) {
      dockRevealed = true;
      slideDockTo(dockTargetGeometry());
    }
    return;
  }
  if (cursorNearDock()) {
    dockLeftAt = 0;
    if (!dockRevealed) {
      dockRevealed = true;
      slideDockTo(dockTargetGeometry());
      // 自动隐藏的任务栏会在光标贴底边时弹出来，并且它自己会重新置顶；
      // 这里把 Dock 再抬到最前，否则刚滑出来就被任务栏盖住。
      try {
        dockWindow.moveTop();
      } catch (_) {
        /* 个别平台没有 moveTop：忽略即可 */
      }
    }
    return;
  }
  if (!dockRevealed) return;
  if (!dockLeftAt) {
    dockLeftAt = Date.now();
    return;
  }
  if (Date.now() - dockLeftAt >= settings.dock_hide_delay_ms) {
    dockRevealed = false;
    dockLeftAt = 0;
    closeFolderPopup();
    slideDockTo(dockHiddenGeometry());
  }
}

function startDockAutoHide() {
  if (dockWatchTimer) clearInterval(dockWatchTimer);
  dockWatchTimer = setInterval(tickDockAutoHide, DOCK_WATCH_MS);
}

// 「常驻显示」＝放到桌面层：可见、但不压在其他程序上面（见 windowLayer）。
// 「自动收起」＝置顶，这样滑出来时盖得住同样贴着底边的任务栏。
function applyDockLayerMode() {
  if (!dockWindow || dockWindow.isDestroyed()) return;
  const topmost = Boolean(settings.dock_auto_hide);
  try {
    dockWindow.setAlwaysOnTop(topmost, 'floating');
  } catch (_) {
    /* 个别平台没有这个能力：忽略 */
  }
  if (!topmost) placeDockOnDesktopLayer(dockWindow);
}

function placeDockOnDesktopLayer(win) {
  windowLayer
    .placeOnDesktopLayer(win)
    .then((result) => {
      if (win.isDestroyed()) return;
      // 结果形如 'ABOVE_DESKTOP steps=...'；不是到位就把轨迹打出来，便于排查
      console.log(`[dock] 桌面层放置：${result || '（没做成）'}`);
    })
    .catch(() => {});
}

function createDockWindow() {
  // 自动收起模式下直接建在屏幕外；如果鼠标本来就在底边附近，下一次 tick 会把它滑出来
  const autoHide = settings.dock_auto_hide;
  const rect = autoHide ? dockHiddenGeometry() : dockTargetGeometry();
  dockRevealed = !autoHide;
  const win = winFactory.createBehaviorWindow('floating', {
    ...rect,
    movable: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    // 常驻模式下不能置顶，否则会压在其他程序上面；它会被放到桌面层去
    alwaysOnTop: autoHide,
    skipTaskbar: true,
    focusable: false,   // 不抢焦点：点图标不打断当前应用的输入
    glass: false,       // Dock 永远完全透明，不跟随磨砂模式
    title: `${APP_NAME} Dock`
  });
  attachDiagnostics(win, 'dock');
  winFactory.loadPage(win, 'dock.html');
  win.once('ready-to-show', () => {
    win.show();
    if (!autoHide) placeDockOnDesktopLayer(win);
  });
  win.on('closed', () => {
    dockWindow = null;
  });
  return win;
}

// 把若干路径加进 Dock：重复的跳过，并从"移除过"的黑名单里解封（拖入、设置面板勾选、
// 文件选择器三条路都走这里，行为一致）
function addDockPaths(paths) {
  let items = settings.dock_items;
  for (const item of paths || []) {
    const result = dockmodel.addItem(items, item);
    items = result.items;
    settings.dock_removed = dockmodel.removeItem(settings.dock_removed, item);
  }
  settings.dock_items = items;
  persist();
  syncDock();
  return items;
}

// 预取 Dock 里靠 shell 解析的图标（快捷方式与系统虚拟项）。从这里一次性发起，
// 避免渲染层逐条请求把同一批拆成好几个 PowerShell 进程——每次都重付一遍编译开销。
// 已有缓存时整批直接命中，等于空操作。
function prewarmDockIcons() {
  const jobs = [];
  for (const item of settings.dock_items) {
    if (String(item).toLowerCase().endsWith('.lnk')) {
      jobs.push(shellIcons.iconDataUrl(item, shellIcons.ICON_PX));
    }
  }
  for (const id of settings.dock_specials) {
    const special = specials.findSpecial(id);
    if (special) jobs.push(shellIcons.parsingNameIconDataUrl(special.parsingName, shellIcons.ICON_PX));
  }
  if (jobs.length) Promise.all(jobs).catch(() => {});
}

function syncDock() {
  if (!settings.dock_enabled) {
    if (dockWindow && !dockWindow.isDestroyed()) {
      dockWindow.destroy();
      dockWindow = null;
    }
    return;
  }
  prewarmDockIcons();
  if (!dockWindow || dockWindow.isDestroyed()) {
    dockWindow = createDockWindow();
    return;
  }
  applyDockGeometry();
  dockWindow.webContents.send('state:changed', { settings });
}

// Dock 条目同步：把桌面上新出现的快捷方式补进来（用户移除过的不再加回）
function syncDockItems() {
  const synced = dockmodel.syncDesktopShortcuts(
    settings.dock_items,
    settings.dock_removed,
    desktopItems()
  );
  if (synced.length !== settings.dock_items.length) {
    settings.dock_items = synced;
    persist();
  }
}

// ------------------------------------------------------------------ 窗口：文件夹弹窗（自研磨砂）

function popupKeyFor(kind, payload = {}) {
  return kind === 'basket' ? `basket:${payload.id}` : `dir:${store.pathKey(payload.path || '')}`;
}

function popupDataFor(kind, payload = {}) {
  if (kind === 'basket') {
    const basket = findBasket(payload.id);
    if (!basket) return null;
    const view = basketView(basket);
    return { kind, name: basket.name, basketId: basket.id, entries: view.entries };
  }
  if (kind === 'dir') {
    const listing = filebrowse.listEntries(payload.path);
    if (listing.error) return { kind, name: path.basename(payload.path) || payload.path, path: payload.path, entries: [], error: listing.error };
    return {
      kind,
      name: path.basename(payload.path) || payload.path,
      path: payload.path,
      entries: listing.entries
    };
  }
  return null;
}

// 窗口整体淡入/淡出。磨砂模式下窗口底是不透明的系统材质，只有内容缩放的话
// 会出现"磨砂矩形瞬间铺满、内容在里面缩"的错位，所以整体也淡一下。
function fadeWindow(win, from, to) {
  if (!win || win.isDestroyed() || typeof win.setOpacity !== 'function') return;
  try {
    win.setOpacity(from);
  } catch (_) {
    return;
  }
  let step = 0;
  const timer = setInterval(() => {
    if (!win || win.isDestroyed()) {
      clearInterval(timer);
      return;
    }
    step += 1;
    const ratio = Math.min(1, step / POPUP_FADE_STEPS);
    try {
      win.setOpacity(from + (to - from) * ratio);
    } catch (_) {
      clearInterval(timer);
      try {
        win.setOpacity(to);
      } catch (_) {
        /* 个别平台不支持透明度：那就保持原样 */
      }
      return;
    }
    if (ratio >= 1) clearInterval(timer);
  }, Math.max(12, Math.round(POPUP_FADE_MS / POPUP_FADE_STEPS)));
}

// 关文件夹弹窗：先通知渲染层播"收回"动画，动画时长后再销毁窗口。
// 立刻销毁会看到窗口"啪"地消失，和打开时的抽出动画对不上。
function closeFolderPopup() {
  clearTimeout(popupBlurTimer);
  popupBlurTimer = null;
  stopPopupAwayWatch();
  popupPayload = null;
  popupKey = null;
  if (!popupWindow || popupWindow.isDestroyed()) return;
  const win = popupWindow;
  popupWindow = null;
  try {
    win.webContents.send('popup:closing');
  } catch (_) {
    /* 页面可能还没就绪：直接销毁即可 */
  }
  fadeWindow(win, 1, 0);
  setTimeout(() => {
    if (!win.isDestroyed()) win.destroy();
  }, POPUP_CLOSE_ANIM_MS);
}

// 鼠标离开自动关的轮询
function stopPopupAwayWatch() {
  if (popupHoverTimer) {
    clearInterval(popupHoverTimer);
    popupHoverTimer = null;
  }
}

function startPopupAwayWatch() {
  stopPopupAwayWatch();
  let awayMs = 0;
  popupHoverTimer = setInterval(() => {
    if (!popupWindow || popupWindow.isDestroyed()) {
      stopPopupAwayWatch();
      return;
    }
    const point = screen.getCursorScreenPoint();
    const popupBounds = popupWindow.getBounds();
    const dockBounds = dockWindow && !dockWindow.isDestroyed() ? dockWindow.getBounds() : null;
    // Dock 向下多让一点（图标放大动画向上长，下方余量别误判离开）
    const near =
      dockmodel.pointNearBounds(point, popupBounds, 16) ||
      dockmodel.pointNearBounds(point, dockBounds, 16);
    if (near) {
      awayMs = 0;
      return;
    }
    awayMs += POPUP_HOVER_CHECK_MS;
    if (awayMs >= POPUP_AWAY_CLOSE_MS) closeFolderPopup();
  }, POPUP_HOVER_CHECK_MS);
}

function schedulePopupBlurClose() {
  clearTimeout(popupBlurTimer);
  popupBlurTimer = setTimeout(() => {
    popupBlurTimer = null;
    closeFolderPopup();
  }, POPUP_BLUR_CLOSE_MS);
}

function cancelPopupBlurClose() {
  clearTimeout(popupBlurTimer);
  popupBlurTimer = null;
}

// anchor: { centerX } —— Dock 窗口坐标里的图标中心 x（主进程换算到屏幕坐标）
async function openFolderPopup(kind, payload, anchorXInDock) {
  const data = popupDataFor(kind, payload);
  if (!data) return null;

  // 先关旧弹窗：一是不叠窗，二是它不能出现在磨砂背景的截屏里
  closeFolderPopup();

  const dockBounds = dockWindow && !dockWindow.isDestroyed() ? dockWindow.getContentBounds() : null;
  const display = screen.getPrimaryDisplay();
  const rect = dockmodel.popupGeometry(
    display.workArea,
    dockBounds,
    anchorXInDock || 0,
    { width: POPUP_WIDTH, height: POPUP_HEIGHT },
    POPUP_EDGE_GAP,
    POPUP_DOCK_GAP
  );

  popupKey = popupKeyFor(kind, payload);
  const win = winFactory.createPopupWindow({
    ...rect,
    // 跟随「磨砂模式」：完全透明就全透，磨砂就挂系统材质
    glass: winFactory.glassEnabled(settings),
    title: `${APP_NAME} · ${data.name}`
  });
  attachDiagnostics(win, 'popup');
  popupWindow = win;
  // 动画原点：被点开的 Dock 图标中心在弹窗里的横向比例（配合底边原点 = 从图标抽出来）
  const anchorScreenX = (dockBounds ? dockBounds.x : rect.x + rect.width / 2) + (anchorXInDock || 0);
  const originX = Math.max(0, Math.min(1, (anchorScreenX - rect.x) / rect.width));
  popupPayload = {
    ...data,
    originX,
    iconSize: settings.icon_size
  };
  win.on('closed', () => {
    if (popupWindow === win) {
      popupWindow = null;
      popupPayload = null;
      popupKey = null;
    }
  });
  win.on('blur', () => {
    if (popupWindow !== win) return;
    // 原生命令菜单弹着的这一小段时间不算"失焦"
    if (menuOpen) return;
    schedulePopupBlurClose();
  });
  win.on('focus', () => {
    if (popupWindow === win) cancelPopupBlurClose();
  });
  startPopupAwayWatch();
  winFactory.loadPage(win, 'popup.html', {
    kind,
    ...(kind === 'basket' ? { id: payload.id } : { path: payload.path })
  });
  return win;
}

async function toggleFolderPopup(kind, payload, anchorXInDock) {
  cancelPopupBlurClose();
  const key = popupKeyFor(kind, payload);
  console.log(`[popup] toggle kind=${kind} key=${key} 现有=${popupKey} 窗口=${Boolean(popupWindow)}`);
  if (popupWindow && popupKey === key) {
    closeFolderPopup();
    return { open: false };
  }
  await openFolderPopup(kind, payload, anchorXInDock);
  return { open: Boolean(popupWindow) };
}

// ------------------------------------------------------------------ 窗口：设置

// 打开设置窗口；带 basketId 时顺便让面板选中那个筐（Dock 右键「改名…」走这条路——
// Electron 不支持 window.prompt，调用它会阻塞渲染进程，Dock 看起来就像卡死了）。
function openSettings(basketId) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
  } else {
    settingsWindow = winFactory.createBehaviorWindow('normal', {
      glass: winFactory.glassEnabled(settings),
      width: 560,
      height: 560,
      title: `${APP_NAME} 设置`
    });
    attachDiagnostics(settingsWindow, 'settings');
    winFactory.loadPage(settingsWindow, 'settings.html');
    settingsWindow.once('ready-to-show', () => settingsWindow.show());
    settingsWindow.on('closed', () => {
      settingsWindow = null;
    });
  }
  if (basketId) {
    // 页面可能还没加载完：等它就绪再发（loadFile 完成前 send 会丢）
    const announce = () => {
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send('settings:select-basket', basketId);
      }
    };
    if (settingsWindow.webContents.isLoading()) {
      settingsWindow.webContents.once('did-finish-load', announce);
    } else {
      announce();
    }
  }
  return settingsWindow;
}

// ------------------------------------------------------------------ 托盘

function installTray() {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.ico');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) image = nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip(APP_NAME);
  const menu = Menu.buildFromTemplate([
    {
      label: '新建文件夹',
      click: () => {
        const created = basketModel.createBasket(settings.baskets);
        settings.baskets = created.baskets;
        persist();
        syncDock();
      }
    },
    { type: 'separator' },
    {
      label: '显示 Dock',
      type: 'checkbox',
      checked: settings.dock_enabled,
      click: (item) => {
        settings.dock_enabled = item.checked;
        persist();
        syncDock();
      }
    },
    { label: '设置…', click: () => openSettings() },
    { type: 'separator' },
    {
      label: '开机自启动',
      type: 'checkbox',
      checked: autostart.isEnabled(),
      click: (item) => {
        autostart.sync(item.checked);
        settings.autostart = item.checked;
        persist();
      }
    },
    { label: '退出', click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
  return tray;
}

// ------------------------------------------------------------------ IPC

function registerIpc() {
  ipcMain.handle('state:get', () => ({ settings, desktop: desktopDir() }));

  ipcMain.handle('basket:get', (_event, { basketId } = {}) => basketView(findBasket(basketId)));

  ipcMain.handle('basket:add', (_event, { basketId, paths }) => {
    const basket = findBasket(basketId);
    if (!basket) return null;
    let next = basket;
    for (const item of paths || []) {
      const result = basketModel.addItem(next, item);
      if (result.result === 'added') next = result.basket;
    }
    return replaceBasket(next);
  });

  ipcMain.handle('basket:remove', (_event, { basketId, itemPath }) => {
    const basket = findBasket(basketId);
    if (!basket) return null;
    return replaceBasket(basketModel.removeItem(basket, itemPath));
  });

  ipcMain.handle('basket:update', (_event, { basket }) => {
    const current = findBasket(basket && basket.id);
    if (!current) return null;
    const merged = { ...current, ...basket, items: current.items };
    settings.baskets = settings.baskets.map((item) =>
      item.id === merged.id ? merged : item
    );
    persist();
    // visible 变化会影响 Dock 条目数，窗口尺寸跟着变
    if (merged.visible !== current.visible) syncDock();
    return merged;
  });

  ipcMain.handle('basket:prune', (_event, { basketId }) => {
    const basket = findBasket(basketId);
    if (!basket) return null;
    const alive = [];
    const removed = [];
    for (const item of basket.items) {
      if (fs.existsSync(item)) alive.push(item);
      else removed.push(item);
    }
    replaceBasket(basketModel.updateItems(basket, alive));
    return { removed: removed.length };
  });

  ipcMain.handle('basket:create', (_event, { name } = {}) => {
    const created = basketModel.createBasket(settings.baskets, name);
    settings.baskets = created.baskets;
    persist();
    syncDock();
    return created.basket;
  });

  ipcMain.handle('basket:delete', (_event, { basketId }) => {
    if (popupWindow && popupKey === `basket:${basketId}`) closeFolderPopup();
    settings.baskets = basketModel.dropBasket(settings.baskets, basketId);
    persist();
    syncDock();
    return settings.baskets;
  });

  // Dock 条目 = 系统虚拟项（此电脑/回收站）＋筐（文件夹，点击弹文件夹弹窗）＋快捷方式；隐藏的筐不上 Dock
  ipcMain.handle('dock:get', () => ({
    specials: settings.dock_specials
      .map((id) => specials.findSpecial(id))
      .filter(Boolean)
      .map((item) => ({ id: item.id, label: item.label })),
    baskets: settings.baskets
      .filter((basket) => basket.visible !== false)
      .map((basket) => ({ id: basket.id, name: basket.name })),
    shortcuts: settings.dock_items
  }));

  ipcMain.handle('special:icon', (_event, { id }) => specialIconFor(id));

  ipcMain.handle('special:open', (_event, { id }) => openSpecial(id));

  ipcMain.handle('dock:remove-special', (_event, { id }) => {
    settings.dock_specials = settings.dock_specials.filter((item) => item !== id);
    persist();
    syncDock();
    return settings.dock_specials;
  });

  ipcMain.handle('dock:add', (_event, { paths }) => addDockPaths(paths));

  // 设置面板里的"逐个添加"：列出桌面上可收录的条目，并标出哪些已经在 Dock 上
  ipcMain.handle('dock:candidates', () =>
    dockmodel.shortcutCandidates(desktopItems(), settings.dock_items)
  );

  // 从磁盘任意位置挑文件加进 Dock（不限于桌面）
  ipcMain.handle('dock:pick', async () => {
    const options = {
      title: '选择要放进 Dock 的快捷方式',
      buttonLabel: '加入 Dock',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '快捷方式与程序', extensions: ['lnk', 'url', 'exe'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    };
    const owner = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : null;
    // 两个重载分开写：不要把 undefined 当第一个参数传进去
    const picked = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths.length) return settings.dock_items;
    return addDockPaths(picked.filePaths);
  });

  ipcMain.handle('dock:remove', (_event, { itemPath }) => {
    settings.dock_items = dockmodel.removeItem(settings.dock_items, itemPath);
    const blocked = dockmodel.addItem(settings.dock_removed, itemPath);
    settings.dock_removed = blocked.items;
    persist();
    syncDock();
    return settings.dock_items;
  });

  ipcMain.handle('dock:reorder', (_event, { items }) => {
    settings.dock_items = store.normalizePathList(items);
    persist();
    syncDock();
    return settings.dock_items;
  });

  // 点击 Dock 快捷方式：指向文件夹的弹文件夹弹窗（再点一次收起），其余交给系统打开
  ipcMain.handle('dock:activate', async (_event, { path: target, itemCenterX }) => {
    cancelPopupBlurClose();
    const dirTarget = dirTargetForShortcut(target);
    if (dirTarget) {
      const result = await toggleFolderPopup('dir', { path: dirTarget }, itemCenterX);
      return { opened: result.open ? 'popup' : 'none' };
    }
    if (popupWindow) closeFolderPopup();
    const error = await shell.openPath(target);
    return { opened: 'app', ok: !error, error: error || '' };
  });

  // 点击 Dock 里的文件夹（筐）：切换对应弹窗
  ipcMain.handle('folder:toggle', (_event, { kind, id, path: target, itemCenterX }) => {
    return toggleFolderPopup(
      kind === 'basket' ? 'basket' : 'dir',
      kind === 'basket' ? { id } : { path: target },
      itemCenterX
    );
  });

  // 右键菜单：弹原生菜单并等用户选完。原生菜单不受窗口尺寸限制，
  // 位置、键盘操作、点外面关闭都由系统处理，不会再被 Dock 那种小窗口裁掉。
  ipcMain.handle('menu:popup', (event, payload = {}) => {
    const items = Array.isArray(payload.items) ? payload.items : [];
    const actionable = items.some((item) => !item.separator && item.key);
    if (!actionable) return null;
    const template = items.map((item) =>
      item.separator
        ? { type: 'separator' }
        : {
            label: String(item.label || ''),
            click: () => {
              menuPicked = item.key;
            }
          }
    );
    return new Promise((resolve) => {
      // 原生命令菜单会短暂夺走前台，弹窗的"失焦即关"要在此期间暂停，
      // 否则菜单还开着、文件夹窗口先自己关了。
      menuOpen = true;
      menuPicked = null;
      const finish = () => {
        menuOpen = false;
        resolve(menuPicked);
      };
      try {
        const menu = Menu.buildFromTemplate(template);
        const win = BrowserWindow.fromWebContents(event.sender);
        menu.popup({
          ...(win && !win.isDestroyed() ? { window: win } : {}),
          ...(Number.isInteger(payload.x) ? { x: payload.x } : {}),
          ...(Number.isInteger(payload.y) ? { y: payload.y } : {}),
          callback: finish
        });
      } catch (error) {
        console.error('[menu] 弹菜单失败', error && error.message);
        finish();
      }
    });
  });

  ipcMain.handle('popup:ready', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win !== popupWindow || !popupPayload) return null;
    return popupPayload;
  });

  ipcMain.handle('popup:present', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    // showInactive：显示但不抢用户当前应用的焦点（Dock 本身也不抢焦点，体验一致）
    if (win === popupWindow && !win.isDestroyed()) {
      fadeWindow(win, 0, 1);
      win.showInactive();
    }
    return true;
  });

  ipcMain.handle('popup:close', () => {
    closeFolderPopup();
    return true;
  });

  // 弹窗内导航：进入子目录 / 返回上级。窗口不动，磨砂背景也不变。
  ipcMain.handle('popup:navigate', (event, { path: target }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win !== popupWindow || !target) return null;
    const listing = filebrowse.listEntries(target);
    return {
      kind: 'dir',
      name: path.basename(target) || target,
      path: target,
      parent: filebrowse.parentOf(target),
      entries: listing.entries,
      error: listing.error
    };
  });

  ipcMain.handle('file:icon', (_event, { path: target, size }) => iconFor(target, size || 48));

  ipcMain.handle('file:open', async (_event, { path: target }) => {
    if (!target) return false;
    const error = await shell.openPath(target);
    return { ok: !error, error: error || '' };
  });

  ipcMain.handle('file:reveal', (_event, { path: target }) => {
    if (target) shell.showItemInFolder(target);
    return true;
  });

  ipcMain.handle('file:list', (_event, { path: target }) => filebrowse.listEntries(target));

  ipcMain.handle('window:settings', (_event, payload = {}) => {
    openSettings(payload && payload.basketId);
    return true;
  });

  ipcMain.handle('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
    return true;
  });

  ipcMain.handle('settings:update', (_event, { patch }) => {
    const before = {
      dock_enabled: settings.dock_enabled,
      dock_auto_hide: settings.dock_auto_hide,
      dock_icon_size: settings.dock_icon_size,
      dock_magnify: settings.dock_magnify,
      basket_count: settings.baskets.length
    };
    settings = store.mergedSettings({ ...settings, ...(patch || {}) });
    persist();
    if (settings.dock_enabled !== before.dock_enabled) syncDock();
    else if (settings.dock_auto_hide !== before.dock_auto_hide) {
      // 常驻 ⇄ 自动收起：切换置顶，常驻时重新放到桌面层
      applyDockLayerMode();
    } else if (
      settings.dock_icon_size !== before.dock_icon_size ||
      settings.baskets.length !== before.basket_count
    ) {
      applyDockGeometry();
      if (dockWindow && !dockWindow.isDestroyed()) {
        dockWindow.webContents.send('state:changed', { settings });
      }
    } else if (settings.dock_magnify !== before.dock_magnify) {
      // 放大程度只影响渲染层动画，不用重建窗口
      if (dockWindow && !dockWindow.isDestroyed()) {
        dockWindow.webContents.send('state:changed', { settings });
      }
    }
    return settings;
  });

  ipcMain.handle('autostart:get', () => ({
    enabled: autostart.isEnabled(),
    command: autostart.currentCommand(),
    supported: autostart.isSupported()
  }));

  ipcMain.handle('autostart:set', (_event, { enabled }) => {
    autostart.sync(Boolean(enabled));
    settings.autostart = Boolean(enabled);
    persist();
    return autostart.isEnabled();
  });
}

// ------------------------------------------------------------------ 生命周期

// 命令行开关：`electron . --settings` 直接打开设置窗口（调试与截图核对用；
// 平时仍从托盘菜单打开）
function wantsSettingsWindow() {
  return process.argv.slice(1).includes('--settings');
}

function bootstrap() {
  settings = store.loadSettings();
  ensureBasket();
  syncDockItems();
  syncDock();
  installTray();
  startDockAutoHide();
  if (settings.autostart) autostart.sync(true);
  if (wantsSettingsWindow()) openSettings();
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  // 静默退出会让"程序没反应"变得无法排查，这里必须留一条日志
  console.log('已有实例在运行（单实例锁被占用），本次启动退出');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (dockWindow && !dockWindow.isDestroyed()) dockWindow.show();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.cmchen.deskbasket');
    // 页面配色是深色主题（浅色文字），而系统材质 acrylic 会跟随系统主题渲染：
    // 系统处于浅色模式时会画出一层浅色磨砂，浅色字压在浅色底上就"几乎看不见"。
    // 强制深色让系统材质、原生菜单、滚动条都与页面配色一致。
    nativeTheme.themeSource = 'dark';
    registerIpc();
    bootstrap();
    screen.on('display-metrics-changed', () => {
      applyDockGeometry();
    });
  });

  app.on('window-all-closed', () => {
    // 托盘常驻：窗口关光了也不退出
  });
}

module.exports = { bootstrap, dockTargetGeometry, dockSize };
