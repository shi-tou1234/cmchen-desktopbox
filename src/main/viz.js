'use strict';

// 音乐律动频谱（主进程侧）。
//
// 从 main.js 拆出来的：这块自成一套（绘制窗 + 抓取窗 + 一条 IPC 链），只依赖外部几个能力，
// 用 createVizController 注入即可。main.js 里只剩「建控制器 / 三处调用 / 注册一次 IPC」。
//
// 需求与约束（都是真机反馈改出来的）：
//   · **跟 Dock 一样待在桌面层**——不是置顶小窗。桌面露出来时它在，任何应用窗口都能盖住它；
//   · **只在真的在出声时才画**——静音时画布全空，桌面上不留空条/虚线；
//   · 位置/宽度/造型/配色全部走设置（viz_*），改完立即生效。
//
// 信号源：Chromium **系统音频环回（loopback）**——用 desktopCapturer 拿屏幕源，getUserMedia 以
// chromeMediaSource:'desktop' 取到的是**整机外放**（任何程序出声都算），喂 Web Audio AnalyserNode
// 做真·逐频段 FFT。抓取窗隐藏、独立 session 分区，只在静默取流失败时显出一个可点的"授权"面板。
//
// 两扇窗都看不见（一个透明压桌面层、一个在屏幕外），所以这里额外维护 userData/viz.log：
// 出问题时先看这份日志，比猜快得多（真机排查过一次"卡死"，就是靠它定位到 page hidden）。

const path = require('node:path');
const fs = require('node:fs');
const { app, desktopCapturer, ipcMain } = require('electron');
const dockmodel = require('./dockmodel');
const windowLayer = require('./windowLayer');

// 宽度档位；实际还会被屏幕宽度夹住。高度 = 柱区 + 倒影区。
const VIZ_WIDTH_PRESETS = { narrow: 680, medium: 960, wide: 1240 };
const VIZ_HEIGHT = 130;
// 窗口内"柱子落地线"的 y（= 渲染层 TOP_PAD 8 + BAR_MAX_H 86）。改渲染层的高度要一起改这里。
const VIZ_BASELINE_Y = 94;
const VIZ_EDGE_GAP = 40;   // 离屏幕边缘至少留这么多（贴边/限宽共用）
const VIZ_DOCK_GAP = 12;   // 柱子落地线与 Dock **图标行**上沿之间的缝隙
const VIZ_BAND_COUNT = 64; // FFT 分给绘制层的频段柱数
const VIZ_CAP_W = 320;     // 授权面板尺寸
const VIZ_CAP_H = 96;

// 依赖由 main.js 注入：
//   getSettings()       读当前设置（settings 是 let，必须现取）
//   dockTargetGeometry   Dock 完全滑出后的落点
//   activeDisplay()      当前 Dock 所在那块屏（含 workArea）
//   winFactory / attachDiagnostics / guardHandle / appName
function createVizController(deps) {
  const { getSettings, dockTargetGeometry, activeDisplay, winFactory, attachDiagnostics, appName, guardHandle } = deps;

  let vizWindow = null;
  let vizCaptureWindow = null;
  let vizFirstBand = false;
  let vizBandCount = 0;

  // 一份小日志（上限 128KB）：apply / show / 桌面层放置 / 取流状态 / 首帧与每 250 帧的峰值。
  function vizLog(text) {
    try {
      const file = path.join(app.getPath('userData'), 'viz.log');
      try {
        if (fs.statSync(file).size > 128 * 1024) fs.writeFileSync(file, '');
      } catch (_) {
        /* 还没有日志文件 */
      }
      fs.appendFileSync(file, `${new Date().toTimeString().slice(0, 8)} ${text}\n`);
    } catch (_) {
      /* 写日志失败不影响功能 */
    }
  }

  function vizEnabled() {
    const settings = getSettings();
    return Boolean(settings && settings.music_viz) && !settings.reduce_motion;
  }

  function vizGeometry() {
    // 位置由设置决定（viz_position / viz_align），默认贴 Dock 图标行正上方。
    //
    // 贴 Dock 时有两个关键点：
    //   ① 用 dockTargetGeometry().y 加上 dockHeadroom，把 Dock 窗口顶部那条放大余量的空白带
    //      刨掉再当锚。直接拿窗口上沿（dock.y）来贴，条子会飘到图标上方一百来像素的空中；
    //   ② 锚的是**柱子落地线**，不是窗口下沿——窗口下沿下面还有 36px 的倒影区，
    //      拿窗口下沿去贴会凭空多出一大截空白（真机反馈"还是有点偏高"就是这么来的）。
    // dockTargetGeometry 给的是「Dock 完全滑出的落点」，所以 Dock 自动收起时条子也不会跟着溜走。
    const settings = getSettings();
    const dock = dockTargetGeometry();
    const area = activeDisplay().workArea;
    const rowTop = dock.y + dockmodel.dockHeadroom(settings.dock_icon_size, settings.dock_magnify);
    const want = VIZ_WIDTH_PRESETS[settings.viz_width] || VIZ_WIDTH_PRESETS.medium;
    const width = Math.min(want, area.width - VIZ_EDGE_GAP * 2);

    // 水平：居中时贴 Dock 中心（其它位置贴屏幕中心），左右贴边
    const position = settings.viz_position || 'dock';
    const align = settings.viz_align || 'center';
    const centerX = position === 'dock' ? dock.x + dock.width / 2 : area.x + area.width / 2;
    let x;
    if (align === 'left') x = area.x + VIZ_EDGE_GAP;
    else if (align === 'right') x = area.x + area.width - width - VIZ_EDGE_GAP;
    else x = Math.round(centerX - width / 2);
    x = Math.max(area.x + VIZ_EDGE_GAP, Math.min(x, area.x + area.width - width - VIZ_EDGE_GAP));

    // 垂直：dock=落地线贴图标行；其余按窗口边缘贴边
    let y;
    if (position === 'top') y = area.y + VIZ_EDGE_GAP;
    else if (position === 'center') y = Math.round(area.y + (area.height - VIZ_HEIGHT) / 2);
    else if (position === 'bottom') y = area.y + area.height - VIZ_EDGE_GAP - VIZ_HEIGHT;
    else y = Math.round(rowTop - VIZ_DOCK_GAP - VIZ_BASELINE_Y);
    y = Math.max(area.y + 8, y);
    y = Math.min(y, area.y + area.height - VIZ_HEIGHT - 4);
    return { x, y, width, height: VIZ_HEIGHT };
  }

  // 抓取窗平时 1×1 摆在屏幕外；要显授权面板时才挪到屏幕正中底部、撑到面板大小。
  function vizCaptureGeometry(visible) {
    if (!visible) return { x: -16000, y: -16000, width: 1, height: 1 };
    const area = activeDisplay().workArea;
    return {
      x: Math.round(area.x + (area.width - VIZ_CAP_W) / 2),
      y: Math.round(area.y + area.height - VIZ_CAP_H - 24),
      width: VIZ_CAP_W,
      height: VIZ_CAP_H
    };
  }

  function sendToDraw(channel, payload) {
    if (vizWindow && !vizWindow.isDestroyed() && vizWindow.webContents && !vizWindow.webContents.isDestroyed()) {
      vizWindow.webContents.send(channel, payload);
    }
  }

  function ensureVizWindow() {
    if (vizWindow && !vizWindow.isDestroyed()) return vizWindow;
    const spot = vizGeometry();
    const win = winFactory.createVizWindow({ ...spot, title: `${appName} 律动` });
    vizWindow = win;
    // 鼠标穿透：压在桌面之上也不能吃掉任何点击，否则就挡住了用户操作
    win.setIgnoreMouseEvents(true);
    attachDiagnostics(win, 'viz');
    winFactory.loadPage(win, 'viz.html');
    win.webContents.on('render-process-gone', (_event, details) => {
      vizLog(`draw renderer gone: ${(details && details.reason) || 'unknown'}`);
      if (vizWindow !== win) return;
      vizWindow = null;
      try { win.destroy(); } catch (_) { /* 可能已经没了 */ }
      setTimeout(() => {
        if (vizEnabled() && !vizWindow) ensureVizWindow();
      }, 1500);
    });
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      win.__vizReady = true;   // 页面画好了才允许 showInactive，否则会闪一下白底
      revealVizWindow(win);
    });
    // 兜底：极少数机器上 show:false 的窗口不发 ready-to-show，只挂那一个事件会让条子永远不出现
    win.webContents.on('did-finish-load', () => {
      if (win.isDestroyed()) return;
      win.__vizReady = true;
      revealVizWindow(win);
    });
    win.on('closed', () => {
      if (vizWindow === win) vizWindow = null;
    });
    return win;
  }

  // 把绘制窗"摆到桌面上"：showInactive 之后它会临时浮到普通窗口最前，所以再往下压到
  // 紧贴桌面层（与「常驻 Dock」同一个道理：桌面露出来时在、任何应用窗口都能盖住它）。
  // 每扇窗只做一次；失败（被别的窗口拒绝跨越）就维持普通窗口，行为也还是"会被应用窗口盖住"。
  function revealVizWindow(win) {
    if (!win || win.isDestroyed() || win.__vizPlaced) return;
    win.__vizPlaced = true;
    win.showInactive();
    vizLog(`draw show visible=${win.isVisible()} bounds=${JSON.stringify(win.getBounds())}`);
    windowLayer
      .placeOnDesktopLayer(win)
      .then((result) => {
        if (win.isDestroyed()) return;
        vizLog(`draw layer ${result || 'none'}`);
        console.log(`[viz] 桌面层放置：${result || '（没做成，按普通窗口）'}`);
        // 万一下沉过头（比桌面层还低 = 看不见）：重新 show 一次拉回普通窗口层。
        // 宁可"被应用窗口盖住"，也不能"根本看不见"。
        if (result.startsWith('AT_BOTTOM')) {
          win.hide();
          win.showInactive();
        }
      })
      .catch(() => {});
  }

  // 抓取窗：只做"取系统音频 + FFT"，把结果推给绘制窗。用独立 session 分区，只给它放行 media 权限。
  function ensureVizCaptureWindow() {
    if (vizCaptureWindow && !vizCaptureWindow.isDestroyed()) return vizCaptureWindow;
    const win = winFactory.createVizCaptureWindow({
      ...vizCaptureGeometry(false),
      title: `${appName} 律动授权`
    });
    vizCaptureWindow = win;
    // 权限：只认这一扇抓取窗自己发起的 media（桌面音频）请求，其余一律拒。分区是它专属的，
    // 不会影响默认 session，也就不会把"共享音频"的口子开给任何别的窗口。
    try {
      win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
        callback(permission === 'media');
      });
    } catch (error) {
      console.log(`[viz] 授权处理器挂不上：${String((error && error.message) || error)}`);
    }
    attachDiagnostics(win, 'vizcap');
    vizFirstBand = false;
    vizBandCount = 0;
    winFactory.loadPage(win, 'viz-capture.html');
    // 抓取窗的渲染进程要是挂了（音频设备切换、驱动崩溃），整条频谱就永远没数据了。
    // 它藏在屏幕外没人会发现——这里自己重建一个。
    win.webContents.on('render-process-gone', (_event, details) => {
      vizLog(`cap renderer gone: ${(details && details.reason) || 'unknown'}`);
      if (vizCaptureWindow !== win) return;
      vizCaptureWindow = null;
      try { win.destroy(); } catch (_) { /* 可能已经没了 */ }
      setTimeout(() => {
        if (vizEnabled() && !vizCaptureWindow) ensureVizCaptureWindow();
      }, 1500);
    });
    win.on('closed', () => {
      if (vizCaptureWindow === win) vizCaptureWindow = null;
    });
    return win;
  }

  // 按当前设置把频谱条开到位或彻底关掉（bootstrap、设置变更、减弱动画切换都走这里）。
  // 窗口是常驻的（和 Dock 一样待在桌面层），"有没有声"只决定画不画，不再收放窗口——
  // 反复 hide/show 会把窗口顶到普通窗口最前面，正是"一直浮在最上面"的来源。
  function applySetting() {
    const settings = getSettings();
    vizLog(`apply enabled=${vizEnabled()} width=${settings.viz_width} pos=${settings.viz_position} align=${settings.viz_align}`);
    if (vizEnabled()) {
      const win = ensureVizWindow();
      win.setBounds(vizGeometry());
      ensureVizCaptureWindow();   // 抓取窗常驻后台，平时不显
    } else {
      if (vizCaptureWindow && !vizCaptureWindow.isDestroyed()) vizCaptureWindow.destroy();
      vizCaptureWindow = null;
      if (vizWindow && !vizWindow.isDestroyed()) vizWindow.destroy();
      vizWindow = null;
    }
  }

  function position() {
    if (vizWindow && !vizWindow.isDestroyed()) vizWindow.setBounds(vizGeometry());
    if (vizCaptureWindow && !vizCaptureWindow.isDestroyed() && vizCaptureWindow.isVisible()) {
      vizCaptureWindow.setBounds(vizCaptureGeometry(true));
    }
  }

  function registerIpc() {
    // 屏幕源清单：抓取窗据此挑一个 screen 源做环回。拿不到就回空数组，抓取窗会显示授权面板兜底。
    guardHandle('viz:sources', async () => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1, height: 1 }
        });
        return sources.map((source) => ({ id: source.id, name: source.name }));
      } catch (error) {
        console.log(`[viz] 取屏幕源失败：${String((error && error.message) || error)}`);
        return [];
      }
    });

    // 抓取窗把 64 段 FFT 能量推来 → 只认抓取窗自己发的 → 转手广播给绘制窗画。
    ipcMain.on('viz:bands', (event, payload) => {
      if (!vizCaptureWindow || vizCaptureWindow.isDestroyed() || event.sender !== vizCaptureWindow.webContents) return;
      const bands = payload && Array.isArray(payload.bands)
        ? payload.bands.slice(0, VIZ_BAND_COUNT).map((v) => Math.max(0, Math.min(255, Number(v) || 0)))
        : [];
      if (bands.length !== VIZ_BAND_COUNT) return;
      let peak = 0;
      for (const value of bands) if (value > peak) peak = value;
      if (!vizFirstBand) {
        vizFirstBand = true;
        vizLog(`bands first peak=${peak}`);
      } else if (++vizBandCount % 250 === 0) {
        vizLog(`bands #${vizBandCount} peak=${peak}`);
      }
      sendToDraw('viz:bands', bands);
    });

    // 抓取窗/绘制窗的诊断行（走 preload 的 vizLog），只认这两扇窗自己发的
    ipcMain.on('viz:log', (event, payload) => {
      const fromCap = vizCaptureWindow && !vizCaptureWindow.isDestroyed() && event.sender === vizCaptureWindow.webContents;
      const fromDraw = vizWindow && !vizWindow.isDestroyed() && event.sender === vizWindow.webContents;
      if (!fromCap && !fromDraw) return;
      vizLog(`${fromCap ? 'cap' : 'draw'} ${String((payload && payload.text) || '').slice(0, 200)}`);
    });

    // 抓取窗上报当前模式（正在启动 / 取流失败…）→ 转发给绘制窗留作诊断。
    // 卡在哪一步由抓取窗自己的授权面板告诉用户（见 viz:grant-state），条子上不再写字。
    ipcMain.on('viz:status', (event, payload) => {
      if (!vizCaptureWindow || vizCaptureWindow.isDestroyed() || event.sender !== vizCaptureWindow.webContents) return;
      const text = String((payload && payload.status) || '');
      if (text) vizLog(`cap status: ${text}`);
      sendToDraw('viz:status', text);
    });

    // 抓取窗要求显出/收起"授权"面板（环回取流失败时，需要用户亲手点一次挑屏幕+勾共享声音）。
    ipcMain.on('viz:grant-state', (event, payload) => {
      if (!vizCaptureWindow || vizCaptureWindow.isDestroyed() || event.sender !== vizCaptureWindow.webContents) return;
      if (payload && payload.show) {
        // 以前用 showInactive + 不置顶：面板常常躲在别的窗口后面，用户根本不知道要授权，
        // 表现出来就是"重启后频谱再也不出现"。这一步必须让人看见，所以抬到最前并给焦点。
        vizLog('cap ask shown');
        vizCaptureWindow.setBounds(vizCaptureGeometry(true));
        vizCaptureWindow.setAlwaysOnTop(true, 'floating');
        vizCaptureWindow.show();
        vizCaptureWindow.focus();
      } else if (!vizCaptureWindow.isDestroyed()) {
        vizCaptureWindow.setAlwaysOnTop(false);
        vizCaptureWindow.setBounds(vizCaptureGeometry(false));
        vizCaptureWindow.hide();
      }
    });
  }

  return { applySetting, position, registerIpc, log: vizLog };
}

module.exports = { createVizController, VIZ_BAND_COUNT };
