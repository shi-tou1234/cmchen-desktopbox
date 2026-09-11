'use strict';

// 渲染进程与主进程之间的桥。渲染页面不直接碰 Node，全部走这里。

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function filePathOf(file) {
  // Electron 32 起 File.path 被移除，必须用 webUtils.getPathForFile
  try {
    return webUtils.getPathForFile(file);
  } catch (_) {
    return '';
  }
}

contextBridge.exposeInMainWorld('deskbasket', {
  // 状态
  getState: () => ipcRenderer.invoke('state:get'),
  onStateChanged: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('state:changed', listener);
    return () => ipcRenderer.removeListener('state:changed', listener);
  },

  // 筐
  basketGet: (basketId) => ipcRenderer.invoke('basket:get', { basketId }),
  addPaths: (basketId, paths) => ipcRenderer.invoke('basket:add', { basketId, paths }),
  removeItem: (basketId, itemPath) => ipcRenderer.invoke('basket:remove', { basketId, itemPath }),
  updateBasket: (basket) => ipcRenderer.invoke('basket:update', { basket }),
  pruneMissing: (basketId) => ipcRenderer.invoke('basket:prune', { basketId }),
  createBasket: (name) => ipcRenderer.invoke('basket:create', { name }),
  deleteBasket: (basketId) => ipcRenderer.invoke('basket:delete', { basketId }),

  // Dock
  getDockItems: () => ipcRenderer.invoke('dock:get'),
  addDockPaths: (paths) => ipcRenderer.invoke('dock:add', { paths }),
  removeDockItem: (itemPath) => ipcRenderer.invoke('dock:remove', { itemPath }),
  reorderDock: (items) => ipcRenderer.invoke('dock:reorder', { items }),
  // 逐个添加：桌面候选清单 ＋ 从磁盘挑文件
  dockCandidates: () => ipcRenderer.invoke('dock:candidates'),
  pickDockFiles: () => ipcRenderer.invoke('dock:pick'),
  // 系统虚拟项（此电脑 / 回收站）
  getSpecialIcon: (id) => ipcRenderer.invoke('special:icon', { id }),
  openSpecial: (id) => ipcRenderer.invoke('special:open', { id }),
  removeDockSpecial: (id) => ipcRenderer.invoke('dock:remove-special', { id }),
  // 点击 Dock 条目：指向文件夹的弹文件夹弹窗（再点一次收起），其余交给系统打开
  activateDockItem: (itemPath, itemCenterX) =>
    ipcRenderer.invoke('dock:activate', { path: itemPath, itemCenterX }),
  // 点击 Dock 里的筐（文件夹）：切换对应弹窗
  toggleFolder: (payload, itemCenterX) =>
    ipcRenderer.invoke('folder:toggle', { ...payload, itemCenterX }),

  // 文件
  getIcon: (target, size) => ipcRenderer.invoke('file:icon', { path: target, size }),
  openPath: (target) => ipcRenderer.invoke('file:open', { path: target }),
  revealPath: (target) => ipcRenderer.invoke('file:reveal', { path: target }),
  listDir: (target) => ipcRenderer.invoke('file:list', { path: target }),

  // 文件夹弹窗（自研磨砂）
  popupReady: () => ipcRenderer.invoke('popup:ready'),
  popupPresent: () => ipcRenderer.invoke('popup:present'),
  popupClose: () => ipcRenderer.invoke('popup:close'),
  popupNavigate: (target) => ipcRenderer.invoke('popup:navigate', { path: target }),
  // 主进程要收窗口时先通知渲染层播"收回"动画
  onPopupClosing: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('popup:closing', listener);
    return () => ipcRenderer.removeListener('popup:closing', listener);
  },
  // 弹窗里把文件拖到筐外/Dock 的场景不需要；反向（往筐里加）走 basket:add
  addPathsToBasket: (basketId, paths) => ipcRenderer.invoke('basket:add', { basketId, paths }),

  // 设置
  openSettings: (basketId) => ipcRenderer.invoke('window:settings', { basketId }),
  // 被点名改名的筐：面板选中它并聚焦名字输入框
  onSelectBasket: (handler) => {
    const listener = (_event, basketId) => handler(basketId);
    ipcRenderer.on('settings:select-basket', listener);
    return () => ipcRenderer.removeListener('settings:select-basket', listener);
  },
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', { patch }),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: (enabled) => ipcRenderer.invoke('autostart:set', { enabled }),

  // 窗口自身的动作
  closeWindow: () => ipcRenderer.invoke('window:close'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  saveGeometry: (rect) => ipcRenderer.invoke('window:geometry', { rect }),
  startDrag: (offset) => ipcRenderer.send('window:drag-start', offset),

  // 页面内右键菜单：交给主进程弹原生菜单，避免被小窗口裁掉
  popupMenu: (items, x, y) => ipcRenderer.invoke('menu:popup', { items, x, y }),

  // 拖放：把 DataTransfer 里的文件转成本地路径
  pathsFromFiles: (files) =>
    Array.from(files || [])
      .map(filePathOf)
      .filter(Boolean)
});
