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

  // 文件
  getIcon: (target, size) => ipcRenderer.invoke('file:icon', { path: target, size }),
  openPath: (target) => ipcRenderer.invoke('file:open', { path: target }),
  revealPath: (target) => ipcRenderer.invoke('file:reveal', { path: target }),
  listDir: (target) => ipcRenderer.invoke('file:list', { path: target }),
  openExplorer: (target) => ipcRenderer.invoke('window:explorer', { path: target }),

  // 设置
  openSettings: () => ipcRenderer.invoke('window:settings'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', { patch }),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: (enabled) => ipcRenderer.invoke('autostart:set', { enabled }),

  // 窗口自身的动作
  closeWindow: () => ipcRenderer.invoke('window:close'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  saveGeometry: (rect) => ipcRenderer.invoke('window:geometry', { rect }),
  startDrag: (offset) => ipcRenderer.send('window:drag-start', offset),

  // 拖放：把 DataTransfer 里的文件转成本地路径
  pathsFromFiles: (files) =>
    Array.from(files || [])
      .map(filePathOf)
      .filter(Boolean)
});
