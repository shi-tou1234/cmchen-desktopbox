'use strict';

// ready-to-show 只保证网页首帧存在，不保证异步 Dock 内容已经落位。
// 原生窗口和内容两边都就绪后才显示，避免 Windows 先合成空的启动表面。
function prepareDockStartup(win, ipcMain, show) {
  let nativeReady = false;
  let contentReady = false;
  let released = false;
  win.__dockPaintReady = false;
  const release = () => {
    if (released || win.isDestroyed() || !nativeReady || !contentReady) return;
    released = true;
    ipcMain.removeListener('dock:paint-ready', onPaint);
    win.__dockPaintReady = true;
    show();
  };
  const onPaint = (event) => {
    if (event.sender !== win.webContents) return;
    contentReady = true;
    release();
  };
  ipcMain.on('dock:paint-ready', onPaint);
  win.once('ready-to-show', () => { nativeReady = true; release(); });
  win.once('closed', () => ipcMain.removeListener('dock:paint-ready', onPaint));
}

function showDockWhenReady(win) {
  if (!win || win.isDestroyed() || !win.__dockPaintReady) return false;
  win.showInactive();
  return true;
}

module.exports = { prepareDockStartup, showDockWhenReady };
