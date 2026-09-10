'use strict';

// DeskBasket 主进程：窗口编排（筐 / 浏览器 / Dock / 设置）、托盘、IPC、自启。
//
// 设计要点（与领导要求一致）：
// - 磨砂玻璃用系统的 acrylic 材质（实测透光 0.86、糊化 0.09，是真磨砂）；
// - 文件筐做成**普通窗口**：可聚焦、进任务栏、可缩放最小化，位置大小持久化；
// - Dock **固定于桌面**：常驻显示不收起来，位置锁在屏幕底部居中，始终置顶。

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  shell,
  screen
} = require('electron');

const store = require('./store');
const basketModel = require('./baskets');
const dockmodel = require('./dockmodel');
const filebrowse = require('./filebrowse');
const winFactory = require('./windows');
const autostart = require('./autostart');

const APP_NAME = 'DeskBasket';
const DOCK_HEIGHT_EXTRA = 34;
const DOCK_BAR_PADDING = 10;

let settings = null;
let tray = null;
let dockWindow = null;
let settingsWindow = null;
let dockGeometryLocked = true;

const basketWindows = new Map();   // basketId -> BrowserWindow
const explorerWindows = new Set();
const iconCache = new Map();       // `${size}:${pathKey}` -> dataURL

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

function desktopShortcuts() {
  return desktopItems().filter((item) => dockmodel.isCollectable(item));
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
    // Electron 43 改成 (event, params)；旧签名是 (event, level, message, line, source)
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
  const win = basketWindows.get(basket.id);
  if (win && !win.isDestroyed()) {
    win.webContents.send('state:changed', { settings });
    if (basket.visible === false) win.hide();
    else win.show();
  }
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
  const created = basketModel.createBasket([], '桌面文件筐', 90, 110);
  settings.baskets = created.baskets;
  persist();
  return settings;
}

// ------------------------------------------------------------------ 图标

async function iconFor(target, size = 48) {
  const key = `${size}:${store.pathKey(target)}`;
  if (iconCache.has(key)) return iconCache.get(key);
  let dataUrl = '';
  try {
    const image = await app.getFileIcon(target, { size: size >= 48 ? 'large' : 'normal' });
    if (image && !image.isEmpty()) dataUrl = image.toDataURL();
  } catch (_) {
    dataUrl = '';
  }
  iconCache.set(key, dataUrl);
  return dataUrl;
}

// ------------------------------------------------------------------ 窗口：筐

function createBasketWindow(basket) {
  const win = winFactory.createBehaviorWindow(settings.basket_behavior, {
    glass: winFactory.glassEnabled(settings),
    width: basket.w,
    height: basket.h,
    x: basket.x,
    y: basket.y,
    title: `${APP_NAME} · ${basket.name}`,
    minWidth: basketModel.MIN_WIDTH,
    minHeight: basketModel.MIN_HEIGHT
  });
  attachDiagnostics(win, `basket:${basket.id}`);
  winFactory.loadPage(win, 'basket.html', { id: basket.id });
  win.once('ready-to-show', () => {
    if (basket.visible !== false) win.show();
  });
  win.on('closed', () => basketWindows.delete(basket.id));
  return win;
}

function syncBasketWindows() {
  for (const basket of settings.baskets) {
    if (!basketWindows.has(basket.id)) {
      basketWindows.set(basket.id, createBasketWindow(basket));
    }
  }
  for (const [id, win] of basketWindows) {
    if (!findBasket(id)) {
      if (!win.isDestroyed()) win.destroy();
      basketWindows.delete(id);
    }
  }
}

// ------------------------------------------------------------------ 窗口：Dock

function dockSize() {
  const count = Math.max(1, settings.dock_items.length);
  const cell = settings.dock_icon_size + 12;
  const width = Math.min(
    Math.max(240, DOCK_BAR_PADDING * 2 + count * cell),
    Math.floor(screen.getPrimaryDisplay().bounds.width * 0.9)
  );
  const height = settings.dock_icon_size + DOCK_HEIGHT_EXTRA + DOCK_BAR_PADDING * 2;
  return { width, height };
}

function dockTargetGeometry() {
  const display = screen.getPrimaryDisplay();
  const bounds = display.bounds;
  const size = dockSize();
  // 固定于桌面底部居中；任务栏自动隐藏时不占用可用区
  return dockmodel.revealedGeometry(bounds, size, dockmodel.EDGE_BOTTOM, 6);
}

function applyDockGeometry() {
  if (!dockWindow || dockWindow.isDestroyed()) return;
  const rect = dockTargetGeometry();
  dockWindow.setBounds(rect);
}

function createDockWindow() {
  const rect = dockTargetGeometry();
  const win = winFactory.createBehaviorWindow(settings.dock_behavior, {
    ...rect,
    glass: winFactory.glassEnabled(settings),
    title: `${APP_NAME} Dock`
  });
  attachDiagnostics(win, 'dock');
  winFactory.loadPage(win, 'dock.html');
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    dockWindow = null;
  });
  // 行为完全交给 dock_behavior（默认 desktop：不置顶、不可拖、不可缩放）
  return win;
}

function syncDock() {
  if (!settings.dock_enabled) {
    if (dockWindow && !dockWindow.isDestroyed()) {
      dockWindow.destroy();
      dockWindow = null;
    }
    return;
  }
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

// ------------------------------------------------------------------ 窗口：浏览器 / 设置

function openExplorer(target) {
  const win = winFactory.createBehaviorWindow('normal', {
    glass: winFactory.glassEnabled(settings),
    width: 720,
    height: 520,
    title: `${APP_NAME} 浏览`,
    minWidth: 420,
    minHeight: 300
  });
  attachDiagnostics(win, 'explorer');
  winFactory.loadPage(win, 'explorer.html', { path: target || desktopDir() });
  win.once('ready-to-show', () => win.show());
  explorerWindows.add(win);
  win.on('closed', () => explorerWindows.delete(win));
  return win;
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }
  settingsWindow = winFactory.createBehaviorWindow('normal', {
    glass: winFactory.glassEnabled(settings),
    width: 560,
    height: 640,
    title: `${APP_NAME} 设置`
  });
  attachDiagnostics(settingsWindow, 'settings');
  winFactory.loadPage(settingsWindow, 'settings.html');
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
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
    { label: '显示所有筐', click: showAllBaskets },
    { label: '新建文件筐', click: () => { basketModel.createBasket(settings.baskets); } },
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
    {
      label: 'Dock 常驻显示',
      type: 'checkbox',
      checked: settings.dock_always_visible,
      click: (item) => {
        settings.dock_always_visible = item.checked;
        persist();
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

// 磨砂模式切换后重建所有窗口（Electron 的覆盖式参数无法运行时修改）
function rebuildWindows() {
  for (const [id, win] of basketWindows) {
    if (!win.isDestroyed()) win.destroy();
    basketWindows.delete(id);
  }
  if (dockWindow && !dockWindow.isDestroyed()) {
    dockWindow.destroy();
    dockWindow = null;
  }
  for (const win of explorerWindows) {
    if (!win.isDestroyed()) win.destroy();
  }
  explorerWindows.clear();
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.destroy();
    settingsWindow = null;
  }
  syncBasketWindows();
  syncDock();
  openSettings();
}

function showAllBaskets() {
  for (const basket of settings.baskets) {
    basket.visible = true;
    const win = basketWindows.get(basket.id);
    if (win && !win.isDestroyed()) win.show();
  }
  persist();
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
    syncBasketWindows();
    return created.basket;
  });

  ipcMain.handle('basket:delete', (_event, { basketId }) => {
    const win = basketWindows.get(basketId);
    if (win && !win.isDestroyed()) win.destroy();
    basketWindows.delete(basketId);
    settings.baskets = basketModel.dropBasket(settings.baskets, basketId);
    persist();
    return settings.baskets;
  });

  ipcMain.handle('dock:get', () => settings.dock_items);

  ipcMain.handle('dock:add', (_event, { paths }) => {
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

  ipcMain.handle('window:explorer', (_event, { path: target }) => {
    openExplorer(target);
    return true;
  });

  ipcMain.handle('window:settings', () => {
    openSettings();
    return true;
  });

  ipcMain.handle('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
    return true;
  });

  ipcMain.handle('window:toggle-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });

  ipcMain.handle('window:geometry', (event, { rect }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || !rect) return false;
    const basket = settings.baskets.find((item) => {
      return basketWindows.get(item.id) === win;
    });
    if (!basket) return false;
    basket.x = rect.x;
    basket.y = rect.y;
    basket.w = rect.width;
    basket.h = rect.height;
    persist();
    return true;
  });

  ipcMain.handle('settings:update', (_event, { patch }) => {
    const before = settings.accent_mode;
    const beforeBehaviors = `${settings.basket_behavior}|${settings.dock_behavior}`;
    settings = store.mergedSettings({ ...settings, ...(patch || {}) });
    persist();
    const behaviorsChanged =
      beforeBehaviors !== `${settings.basket_behavior}|${settings.dock_behavior}`;
    if (before !== settings.accent_mode || behaviorsChanged) {
      // transparent / backgroundMaterial 在窗口创建时就锁定了，改模式必须重建窗口
      rebuildWindows();
    }
    syncDock();
    syncBasketWindows();
    for (const [, win] of basketWindows) {
      if (!win.isDestroyed()) win.webContents.send('state:changed', { settings });
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

  ipcMain.on('window:drag-start', (event) => {
    // 普通窗口由系统负责拖动，这里只处理 Dock 的锁定位置，不做任何事
    void event;
  });
}

// ------------------------------------------------------------------ 生命周期

function bootstrap() {
  settings = store.loadSettings();
  ensureBasket();
  syncDockItems();
  syncBasketWindows();
  syncDock();
  installTray();
  if (settings.autostart) autostart.sync(true);
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showAllBaskets();
    if (dockWindow && !dockWindow.isDestroyed()) dockWindow.show();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.cmchen.deskbasket');
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
