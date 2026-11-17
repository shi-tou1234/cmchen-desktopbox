'use strict';

// ready-to-show 只保证网页首帧存在，不保证异步 Dock 内容已经落位。
// 原生窗口和内容两边都就绪后才显示，避免 Windows 先合成空的启动表面。
//
// 但这两个信号都可能缺席，而原实现只有"两端都到"这一条路、没有任何兜底：
//   · 原生侧：登录冷启动时 DWM 还没给透明窗口分配合成层，ready-to-show 会丢
//     （viz 绘制窗为此专门挂了 did-finish-load 兜底，Dock 当时漏了）；
//   · 内容侧：页面先等 dock:get，里面串行 await 每个筐的叠放预览图标
//     （走 PowerShell 批处理，单批超时 30s），冷启动最慢的正是这一段。
// 任一缺席，窗口就永久停在 hide——除了"关掉再打开 Dock"没有任何重试路径，
// 真机表现就是"开机后 Dock 不显示，去设置里取消再勾选才出来"。所以补三层：
//   1) native：ready-to-show 或 did-finish-load，任一到达即算就绪（与 viz 窗一致）；
//   2) content：页面跨过两次绘制回调后发 dock:paint-ready；
//   3) 兜底：READY_TIMEOUT_MS 到点强制放行——宁可先露出半帧空白，
//      也不能整窗永久不可见（内容侧真出问题时，这是唯一的自救路径）。
const READY_TIMEOUT_MS = 2500;

function prepareDockStartup(win, ipcMain, show, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : READY_TIMEOUT_MS;
  const log = typeof options.log === 'function' ? options.log : () => {};
  let nativeReady = false;
  let contentReady = false;
  let released = false;
  let timer = null;
  win.__dockPaintReady = false;

  const cleanup = () => {
    ipcMain.removeListener('dock:paint-ready', onPaint);
    if (timer) { clearTimeout(timer); timer = null; }
  };

  // reason 只进诊断日志（both / timeout），不参与任何决策
  const release = (reason) => {
    if (released || win.isDestroyed()) return;
    released = true;
    cleanup();
    win.__dockPaintReady = true;
    win.__dockReadyReason = reason;
    log(`ready(${reason}) native=${nativeReady} content=${contentReady}`);
    try {
      show();
    } catch (_) {
      /* 窗口刚被销毁：这一次不显示，调用方下次 showDockWhenReady 还会走 */
    }
  };

  const onPaint = (event) => {
    if (event.sender !== win.webContents) return;
    contentReady = true;
    log('content paint ready');
    if (nativeReady) release('both');
  };

  // 两个原生信号合成一个：谁先到用谁，后到的直接忽略
  const onNative = (source) => {
    if (nativeReady) return;
    nativeReady = true;
    log(`native ready(${source})`);
    if (contentReady) release('both');
  };

  ipcMain.on('dock:paint-ready', onPaint);
  win.once('ready-to-show', () => onNative('ready-to-show'));
  // show:false 的透明窗口上 ready-to-show 并非必然触发；did-finish-load 至少保证
  // 页面与首帧资源都已加载完，作为"原生已就绪"的等价信号足够
  try {
    win.webContents.once('did-finish-load', () => onNative('did-finish-load'));
  } catch (_) {
    /* 没有 webContents（测试夹具/极端情况）：只靠 ready-to-show 与超时 */
  }

  timer = setTimeout(() => {
    timer = null;
    if (nativeReady && contentReady) return;
    log(`ready timeout ${timeoutMs}ms（native=${nativeReady} content=${contentReady}）→ 强制放行`);
    release('timeout');
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  win.once('closed', cleanup);
}

function showDockWhenReady(win) {
  if (!win || win.isDestroyed() || !win.__dockPaintReady) return false;
  win.showInactive();
  // 调用成功不等于真的可见：Windows 上 focusable:false + transparent 的窗口在登录
  // 冷启动那一刻偶尔会被 DWM 忽略（不抛错，isVisible() 仍是 false）。校验一次，
  // 没成就补一次 show()——这是"开机后 Dock 不显示"的第二道来源。
  if (typeof win.isVisible === 'function' && !win.isVisible()) {
    try {
      win.show();
    } catch (_) {
      /* 已销毁：忽略 */
    }
  }
  return true;
}

module.exports = { prepareDockStartup, showDockWhenReady, READY_TIMEOUT_MS };
