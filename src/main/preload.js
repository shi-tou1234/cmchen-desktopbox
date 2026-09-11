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
  pickBasketFiles: (basketId, mode) => ipcRenderer.invoke('basket:pick-add', { basketId, mode }),
  // 设置面板里的批量勾选清单：桌面上所有条目 + 是否已在这个筐里
  basketCandidates: (basketId) => ipcRenderer.invoke('basket:candidates', { basketId }),
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
  // 拖右下角改弹窗大小：主进程负责夹范围并落到该屏工作区内，尺寸随后被记住（#3）
  resizePopup: (width, height) => ipcRenderer.invoke('popup:resize', { width, height }),
  // 主进程要收窗口时先通知渲染层播"收回"动画
  onPopupClosing: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('popup:closing', listener);
    return () => ipcRenderer.removeListener('popup:closing', listener);
  },
  // 复用同一个热窗口时，新内容从这里送进来（页面重画 + 再播一次展开动画）
  onPopupData: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('popup:data', listener);
    return () => ipcRenderer.removeListener('popup:data', listener);
  },
  // 弹窗里把文件拖到筐外/Dock 的场景不需要；反向（往筐里加）走 basket:add
  addPathsToBasket: (basketId, paths) => ipcRenderer.invoke('basket:add', { basketId, paths }),

  // 设置
  openSettings: () => ipcRenderer.invoke('window:settings'),
  // 改名：开一个钉在 Dock 上方的小输入窗（Electron 没有 window.prompt，Dock 又收不到键盘）
  openRename: (payload) => ipcRenderer.invoke('rename:open', payload),
  commitRename: (value) => ipcRenderer.invoke('rename:commit', { value }),
  cancelRename: () => ipcRenderer.invoke('rename:cancel'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', { patch }),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: (enabled) => ipcRenderer.invoke('autostart:set', { enabled }),

  // 窗口自身的动作
  closeWindow: () => ipcRenderer.invoke('window:close'),
  startDrag: (offset) => ipcRenderer.send('window:drag-start', offset),

  // 提示框交给主进程弹：Dock 窗口不可聚焦，页内 alert 会阻塞渲染进程（和 window.prompt 同一类问题）
  alertMessage: (text) => ipcRenderer.invoke('ui:alert', { text: String(text || '') }),

  // 页面内右键菜单：主进程弹一个自绘的小菜单窗（失焦即关，支持键盘）
  openMenu: (items, x, y) => ipcRenderer.invoke('menu:open', { items, x, y }),
  // 菜单窗自己用：取要画的项、选中、取消
  menuItems: () => ipcRenderer.invoke('menu:items'),
  menuPick: (key) => ipcRenderer.invoke('menu:pick', { key }),
  menuDismiss: () => ipcRenderer.invoke('menu:dismiss'),

  // 拖放：把 DataTransfer 里的文件转成本地路径
  pathsFromFiles: (files) =>
    Array.from(files || [])
      .map(filePathOf)
      .filter(Boolean)
});
