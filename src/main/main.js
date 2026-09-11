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
const { execFileSync } = require('node:child_process');

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
const theme = require('./theme');

const APP_NAME = 'DeskBasket';
const DOCK_PADDING = 8;

// 文件夹弹窗：位置在 Dock 上方；大小由设置 popup_width/height 决定（可在右下角拖着改，见 persistPopupSize）
const POPUP_EDGE_GAP = 8;    // 弹窗与屏幕左右/上边的最小距离
const POPUP_DOCK_GAP = 10;   // 弹窗与 Dock 上沿的间距
// 拖完右下角之后的落盘防抖：拖边时每帧都发 resize，攒一下再写设置
const POPUP_RESIZE_SAVE_MS = 350;
const POPUP_BLUR_CLOSE_MS = 220; // 失焦后多久关（留出"点击 Dock 图标切换"的时间）
const POPUP_CLOSE_ANIM_MS = 210; // 收起动画时长：先让渲染层缩回去，再隐藏窗口
// 磨砂模式的收起更短：内容淡掉就可以收，别让一块空的材质底多晾着（那看着就是"闪一下"）
const POPUP_CLOSE_ANIM_GLASS_MS = 170;
// 打开/收起的淡入淡出全部由页面自己用 CSS 做（见 popup.html）。
// **不要用 setOpacity 去淡窗口**：挂系统材质（磨砂）的窗口改不透明度时，
// 材质底会先闪一下再跟上，开着和关着都能看见"闪一闪"。
// 鼠标离开自动关：弹窗显示不抢焦点（showInactive），拿不到系统失焦事件，
// 由主进程轮询鼠标位置——不在弹窗 ∪ Dock 的附近区域连续一段时间就关。
const POPUP_HOVER_CHECK_MS = 250;
const POPUP_AWAY_CLOSE_MS = 900;

let settings = null;
let resolvedTheme = 'dark';    // theme_mode=auto 时按壁纸亮度算出来的实际深浅色（dark/light），广播给各页
let wallpaperCache = { key: '', luminance: null };  // 壁纸路径:修改时间 → 亮度（避免每次 tick 都重读+解码）
let tray = null;
let dockWindow = null;
let settingsWindow = null;
let renameWindow = null;       // 改名输入窗（钉在 Dock 上方）
let renameTarget = null;       // { kind:'basket', id } | { kind:'shortcut', path }

let popupWindow = null;        // 当前文件夹弹窗（收起时隐藏、不销毁，下次复用）
let popupKey = null;           // 'basket:b1' 或 'dir:C:\\xx'，用于点同一个文件夹时切换关闭
let popupPayload = null;        // 弹窗渲染层就绪时取走的数据
let popupGlass = null;         // 这个弹窗窗口是用哪种材质建的（材质建窗时锁定，模式变了只能重建）
let popupPageReady = false;    // 弹窗页面是否已完成首次加载（复用的前提）
let popupSource = null;        // { kind, payload }：重新取内容（比如往筐里加了东西）时要用
let popupHideTimer = null;     // 收起动画放完后的"隐藏"定时器
let popupOpenedAt = 0;         // 这次打开是什么时候发起的（量"点击到显示"的耗时）
let popupPainted = false;      // 页面是否已经画出第一帧（没画出来就显示会闪一下空白材质）
let popupOpenMode = '';        // '新建窗口' | '复用热窗口'，只用于日志
let popupBlurTimer = null;
let popupHoverTimer = null;    // 鼠标离开自动关的轮询
let menuOpen = false;          // 自绘右键菜单开着：期间弹窗不许"失焦即关"

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

// 渲染层来源页（日志里用来指出"谁干的"）：dock.html / settings.html / popup.html
function pageTag(event) {
  try {
    const url = event && event.sender ? String(event.sender.getURL() || '') : '';
    const file = url.split('/').pop() || '';
    return file.split('?')[0] || 'unknown';
  } catch (_) {
    return 'unknown';
  }
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
  const payload = { settings, theme: resolvedTheme, displays: displaySummaries() };
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

// ------------------------------------------------------------------ 深浅色主题（#1）
//
// 页面配色按深色主题写；完全透明模式下，浅色壁纸上压浅色字会看不清。
// theme_mode=auto 时读桌面壁纸算平均亮度来决定深浅；也可在设置里手动固定 dark/light。
//
// 只读取，绝不写：壁纸路径从注册表读，用 nativeImage 解码后缩到很小算亮度，缓存到
// 路径+修改时间，避免每次轮询都重新解码。取不到壁纸就退回深色（与历史行为一致）。

// Windows 壁纸文件路径。slideshow（多张）会带多个 NUL 分隔，只取第一张；非 Windows 返回 null。
// reg.exe 的输出编码跟着控制台代码页走（zh-CN 是 GBK），直接按 utf8 解会把中文路径读成乱码——
// 所以两种解码都试，取**文件真的存在**的那一份：乱码解出来的路径必然 existsSync 失败，不会误伤。
function wallpaperPath() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'Wallpaper'],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const texts = [];
    try {
      texts.push(out.toString('utf8'));
    } catch (_) {
      /* 解码失败：跳过这一种 */
    }
    try {
      texts.push(new TextDecoder('gbk').decode(out));
    } catch (_) {
      /* 没有 GBK 支持（非中文机器/精简 ICU）：跳过 */
    }
    for (const text of texts) {
      const match = /Wallpaper\s+REG_SZ\s+(.+?)(?:\r?\n|$)/i.exec(text);
      if (!match) continue;
      const first = match[1].split('\0')[0].trim();
      if (first && fs.existsSync(first)) return first;
    }
    return null;
  } catch (_) {
    return null;
  }
}

function wallpaperLuminance() {
  const file = wallpaperPath();
  if (!file) return null;
  let stamp = '';
  try {
    stamp = String(fs.statSync(file).mtimeMs);
  } catch (_) {
    return null;
  }
  const cacheKey = `${file}|${stamp}`;
  if (wallpaperCache.key === cacheKey) return wallpaperCache.luminance;
  let luminance = null;
  try {
    const image = nativeImage.createFromPath(file);
    if (!image.isEmpty()) {
      const small = image.resize({ width: 32, height: 32 });   // 缩到 32×32 足够估平均亮度
      const size = small.getSize();
      luminance = theme.luminanceFromRgba(small.toBitmap(), size.width, size.height);
    }
  } catch (_) {
    luminance = null;
  }
  wallpaperCache = { key: cacheKey, luminance };
  return luminance;
}

// 解析并应用主题：设置 nativeTheme.themeSource（让系统材质/滚动条/原生菜单跟着变），
// 更新 resolvedTheme。返回是否发生变化（变了才需要广播）。
function applyTheme() {
  const next = theme.resolveTheme(settings.theme_mode, wallpaperLuminance());
  if (nativeTheme.themeSource !== next) {
    try {
      nativeTheme.themeSource = next;
    } catch (_) {
      /* 个别平台/版本不支持：resolvedTheme 仍会广播，页面配色不受影响 */
    }
  }
  const changed = resolvedTheme !== next;
  resolvedTheme = next;
  return changed;
}

// ------------------------------------------------------------------ 多显示器（#9）
//
// 默认 primary：Dock/弹窗/改名窗都落在主屏（与旧行为一致）。
// 可设 mouse（光标所在屏）或按 getAllDisplays 下标的整数。单屏机器上三者等价。

function displaySummaries() {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display, index) => ({
    index,
    id: display.id,
    bounds: display.bounds,
    label: `${display.bounds.width}×${display.bounds.height}`,
    primary: display.id === primaryId
  }));
}

// 当前 Dock 该用的那块屏（一个真实 Electron Display 对象，含 bounds/workArea）。
function activeDisplay() {
  const primaryId = screen.getPrimaryDisplay().id;
  const list = screen.getAllDisplays().map((display) => ({
    ...display,
    primary: display.id === primaryId
  }));
  const chosen = dockmodel.pickDisplay(list, settings.dock_display, screen.getCursorScreenPoint());
  return chosen || screen.getPrimaryDisplay();
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
  const display = activeDisplay();
  // Dock 条目 = 系统虚拟项（此电脑/回收站）＋筐（文件夹）＋快捷方式
  const count =
    settings.dock_items.length +
    settings.dock_specials.length +
    Math.max(1, settings.baskets.length);
  const layout = dockmodel.dockLayout(count, settings.dock_icon_size, display.bounds.width, DOCK_PADDING);
  return { width: layout.width, height: layout.height };
}

function dockTargetGeometry() {
  const display = activeDisplay();
  const size = dockSize();
  // 贴任务栏上沿，再往上抬 dock_bottom_gap：贴死底边时自动隐藏的任务栏一冒头就盖住图标
  const anchor = dockmodel.bottomAnchor(
    display.workArea,
    display.bounds,
    settings.dock_bottom_gap
  );
  return dockmodel.revealedGeometry(display.bounds, size, dockmodel.EDGE_BOTTOM, 0, anchor);
}

function applyDockGeometry() {
  if (!dockWindow || dockWindow.isDestroyed()) return;
  // 收起状态下别把它拽回底边（比如改了图标大小触发几何重算时）
  const target =
    !settings.dock_auto_hide || dockRevealed ? dockTargetGeometry() : dockHiddenGeometry();
  // 走滑动而不是瞬移：改图标大小/离底边距离时看得见它是"挪"过去的
  slideDockTo(target);
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
  const display = activeDisplay();
  return dockmodel.hiddenGeometry(display.bounds, dockSize(), dockmodel.EDGE_BOTTOM, DOCK_PEEK_PX);
}

// 平滑滑动到目标位置（逐帧改窗口 y，做出"滑出/收起"的手感）
//
// 滑出（往屏内、y 变小）用 easeOutBack：中段它会大于 1，位置先冲过目标一点点再收回，
// "啪"地弹到位。但 easeOutBack 的标准过冲约是距离的 10%——Dock 滑出距离 130~200px，
// 就是 13~20px，太夸张；所以按 REVEAL_OVERSHOOT_DAMP 打折，只留 ~4%（5~8px）的一下。
// 收起（往屏外）仍用纯缓出：收尾干脆，不弹。reduce_motion 开着直接一步到位。
const DOCK_SLIDE_STEPS_BACK = 12;       // 带过冲要多给几帧才看得出"冲过头再收回"
const REVEAL_OVERSHOOT_DAMP = 0.4;      // 过冲幅度打折：eased 超过 1 的那部分 × 0.4

function slideDockTo(target) {
  if (!dockWindow || dockWindow.isDestroyed()) return;
  clearInterval(dockSlideTimer);
  dockSlideTimer = null;
  const from = dockWindow.getBounds();
  if (from.y === target.y && from.x === target.x) return;
  if (settings.reduce_motion) {
    dockWindow.setBounds(target);
    return;
  }
  const revealing = target.y < from.y;   // 从屏幕外往回滑出
  const steps = revealing ? DOCK_SLIDE_STEPS_BACK : DOCK_SLIDE_STEPS;
  let step = 0;
  dockSlideTimer = setInterval(() => {
    if (!dockWindow || dockWindow.isDestroyed()) {
      clearInterval(dockSlideTimer);
      dockSlideTimer = null;
      return;
    }
    step += 1;
    const t = Math.min(1, step / steps);
    let eased;
    if (revealing) {
      const raw = dockmodel.easeOutBack(t);
      eased = raw > 1 ? 1 + (raw - 1) * REVEAL_OVERSHOOT_DAMP : raw;
    } else {
      eased = 1 - Math.pow(1 - t, 3);   // 缓出：收尾干脆
    }
    const y = t >= 1 ? target.y : from.y + (target.y - from.y) * eased;   // 末态必须精确落在目标上
    dockWindow.setBounds({
      x: target.x,
      y: Math.round(y),
      width: target.width,
      height: target.height
    });
    if (step >= steps) {
      clearInterval(dockSlideTimer);
      dockSlideTimer = null;
    }
  }, DOCK_SLIDE_STEP_MS);
}

function cursorNearDock() {
  if (!dockWindow || dockWindow.isDestroyed()) return false;
  const display = activeDisplay();
  const point = screen.getCursorScreenPoint();
  // 抬起来之后，Dock 底边与屏幕底边之间那条缝也算"在附近"：鼠标从底边往上移过去时
  // 不能中途判定成"离开"而收起来
  const pad = 6 + Math.max(0, settings.dock_bottom_gap || 0);
  return (
    dockmodel.pointNearBounds(point, dockWindow.getBounds(), pad) ||
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
function addDockPaths(paths, from = '?') {
  let items = settings.dock_items;
  for (const item of paths || []) {
    const result = dockmodel.addItem(items, item);
    items = result.items;
    settings.dock_removed = dockmodel.removeItem(settings.dock_removed, item);
  }
  settings.dock_items = items;
  console.log(`[dock] 加入 ${(paths || []).length} 条（来源 ${from}）→ 现有 ${items.length} 条`);
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

// 预热所有筐里条目的图标：这样第一次打开某个筐的弹窗时图标已经在缓存里，
// 窗口一出来就是齐的（不然图标会在展开动画播到一半时才开始解码，看着一顿一顿）。
// 与 Dock 那批一样一次性批量发起，命中缓存时等于空操作。
function prewarmBasketIcons() {
  const size = settings.icon_size;
  const jobs = [];
  const seen = new Set();
  for (const basket of settings.baskets) {
    for (const item of basket.items || []) {
      const key = `${size}:${store.pathKey(item)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push(shellIcons.iconDataUrl(item, size));
    }
  }
  if (jobs.length) Promise.all(jobs).catch(() => {});
}

// 给弹窗载荷补上图标（dataURL）：渲染层拿到就直接塞进 img，不再逐格 IPC。
// 超过 POPUP_ICON_WAIT_MS 就先开窗，剩下的由渲染层自己补（走同一条缓存链路）。
const POPUP_ICON_WAIT_MS = 400;
// 翻目录时等图标的时间要短得多：先出内容、图标随后补上（后台已经预热过）
const POPUP_NAVIGATE_ICON_WAIT_MS = 120;

async function withEntryIcons(payload, waitMs = POPUP_ICON_WAIT_MS) {
  const entries = (payload && payload.entries) || [];
  if (!entries.length) return payload;
  const size = payload.iconSize || settings.icon_size;
  const jobs = entries.map((entry) =>
    shellIcons.iconDataUrl(entry.path, size).then(
      (url) => [entry.path, url || ''],
      () => [entry.path, '']
    )
  );
  const icons = await Promise.race([
    Promise.all(jobs).then((pairs) => new Map(pairs)),
    new Promise((resolve) => setTimeout(() => resolve(null), waitMs))
  ]);
  if (!icons) return payload;
  return {
    ...payload,
    entries: entries.map((entry) => ({ ...entry, iconUrl: icons.get(entry.path) || '' }))
  };
}

// 目录里的图标只做后台预热：缓存热了，翻第二次就是秒开
function warmEntryIcons(entries, size) {
  for (const entry of entries || []) {
    shellIcons.iconDataUrl(entry.path, size).catch(() => {});
  }
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

// 重新取一份当前弹窗的内容：往筐里加了东西之后，页面会用 popupReady 再来要一次数据
function rebuildPopupPayload() {
  if (!popupSource || !popupPayload) return popupPayload;
  const fresh = popupDataFor(popupSource.kind, popupSource.payload);
  if (fresh) popupPayload = { ...popupPayload, ...fresh };
  return popupPayload;
}

// 关文件夹弹窗：先通知渲染层播"收回"动画，动画放完再隐藏窗口。
// 立刻隐藏会看到窗口"啪"地消失，和打开时的抽出动画对不上。
function closeFolderPopup() {
  clearTimeout(popupBlurTimer);
  popupBlurTimer = null;
  stopPopupAwayWatch();
  popupPayload = null;
  popupKey = null;
  if (!popupWindow || popupWindow.isDestroyed()) return;
  const win = popupWindow;
  try {
    win.webContents.send('popup:closing');
  } catch (_) {
    /* 页面可能还没就绪：直接隐藏即可 */
  }
  // 收起动画（内容缩小/淡出）放完就**隐藏**，不销毁：下次打开直接复用这个热窗口——
  // 不用再起一个渲染进程、不用重新加载页面、图标也在解码缓存里。
  // 窗口自己不做透明度动画：材质底跟着 setOpacity 会闪（见文件头的说明）。
  const closeMs = popupGlass ? POPUP_CLOSE_ANIM_GLASS_MS : POPUP_CLOSE_ANIM_MS;
  clearTimeout(popupHideTimer);
  popupHideTimer = setTimeout(() => {
    popupHideTimer = null;
    if (popupWindow !== win || win.isDestroyed()) return;
    win.hide();
  }, closeMs);
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
    // Dock 四周多让一点：上方给图标的放大动画，下方把"Dock 与屏幕底边之间的那条缝"也包进来
    // （Dock 抬起来之后鼠标从底边往上移到图标要经过那条缝，不能算离开）
    const dockPad = 16 + Math.max(0, settings.dock_bottom_gap || 0);
    const near =
      dockmodel.pointNearBounds(point, popupBounds, 16) ||
      dockmodel.pointNearBounds(point, dockBounds, dockPad);
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

// 弹窗尺寸持久化（#3）：用户拖右下角改大小 → 防抖落盘到 popup_width/height。
// 主进程自己 setBounds（锚位、复用换尺寸）不算用户操作：用一次性标志跳过，
// 而且落盘前比对当前值，漏网的程序性 resize 也只会写成和设置一样的值。
let popupProgrammaticResize = false;
let popupResizeSaveTimer = null;

function setPopupBounds(win, rect) {
  popupProgrammaticResize = true;
  win.setBounds(rect);
  setTimeout(() => {
    popupProgrammaticResize = false;
  }, 120);
}

function onPopupResized() {
  if (popupProgrammaticResize) return;
  if (!popupWindow || popupWindow.isDestroyed()) return;
  const [width, height] = popupWindow.getContentSize();
  if (width === settings.popup_width && height === settings.popup_height) return;
  clearTimeout(popupResizeSaveTimer);
  popupResizeSaveTimer = setTimeout(() => {
    if (!popupWindow || popupWindow.isDestroyed()) return;
    const [w, h] = popupWindow.getContentSize();
    settings.popup_width = w;
    settings.popup_height = h;
    persist();   // mergedSettings 会夹到合法范围，广播让设置面板与下次开窗都用新尺寸
    console.log(`[popup] 尺寸记住为 ${w}×${h}`);
  }, POPUP_RESIZE_SAVE_MS);
}

function cancelPopupBlurClose() {
  clearTimeout(popupBlurTimer);
  popupBlurTimer = null;
}

// anchor: { centerX } —— Dock 窗口坐标里的图标中心 x（主进程换算到屏幕坐标）
async function openFolderPopup(kind, payload, anchorXInDock) {
  const t0 = Date.now();
  const data = popupDataFor(kind, payload);
  if (!data) return null;

  // 先关旧弹窗：一是不叠窗，二是它不能出现在磨砂背景的截屏里
  closeFolderPopup();

  const dockBounds = dockWindow && !dockWindow.isDestroyed() ? dockWindow.getContentBounds() : null;
  const display = activeDisplay();
  const popupSize = { width: settings.popup_width, height: settings.popup_height };
  const rect = dockmodel.popupGeometry(
    display.workArea,
    dockBounds,
    anchorXInDock || 0,
    popupSize,
    POPUP_EDGE_GAP,
    POPUP_DOCK_GAP
  );

  popupKey = popupKeyFor(kind, payload);
  popupSource = { kind, payload };
  // 动画原点：被点开的 Dock 图标中心在弹窗里的横向比例（配合底边原点 = 从图标抽出来）
  const anchorScreenX = (dockBounds ? dockBounds.x : rect.x + rect.width / 2) + (anchorXInDock || 0);
  const originX = Math.max(0, Math.min(1, (anchorScreenX - rect.x) / rect.width));
  popupPayload = {
    ...data,
    originX,
    iconSize: settings.icon_size,
    // 页面按这个挑动画：磨砂模式窗口底是整块材质，内容不能缩得太小（见 popup.html）
    glass: winFactory.glassEnabled(settings),
    // 主题与减弱动画开关也塞进载荷：弹窗打开这一帧就要用，不等 state:changed
    theme: resolvedTheme,
    reduceMotion: Boolean(settings.reduce_motion)
  };

  // 复用上一个热窗口：渲染进程、页面、图片解码缓存都是现成的，展开动画从第一帧就顺。
  // 只有材质变了（完全透明 ⇄ 磨砂，材质建窗时锁定）或页面没就绪时才重建。
  const glass = winFactory.glassEnabled(settings);
  if (popupWindow && !popupWindow.isDestroyed() && popupPageReady && popupGlass === glass) {
    clearTimeout(popupHideTimer);
    popupHideTimer = null;
    const win = popupWindow;
    win.setTitle(`${APP_NAME} · ${data.name}`);
    setPopupBounds(win, rect);
    popupOpenedAt = t0;
    popupOpenMode = '复用热窗口';
    withEntryIcons(popupPayload).then((full) => {
      if (popupWindow !== win || win.isDestroyed()) return;
      win.webContents.send('popup:data', full);
    });
    return win;
  }

  // 需要重建（材质变了，或页面没就绪）：先把旧的收掉，别留一个隐形的窗口在后台
  if (popupWindow && !popupWindow.isDestroyed()) {
    clearTimeout(popupHideTimer);
    popupHideTimer = null;
    const old = popupWindow;
    popupWindow = null;
    old.destroy();
  }

  const win = winFactory.createPopupWindow({
    ...rect,
    // 跟随「磨砂模式」：完全透明就全透，磨砂就挂系统材质
    glass,
    title: `${APP_NAME} · ${data.name}`
  });
  attachDiagnostics(win, 'popup');
  popupWindow = win;
  popupGlass = glass;
  popupPageReady = false;
  popupPainted = false;
  win.once('ready-to-show', () => {
    popupPainted = true;
  });
  popupOpenedAt = t0;
  popupOpenMode = '新建窗口';
  win.on('closed', () => {
    if (popupWindow === win) {
      popupWindow = null;
      popupPayload = null;
      popupKey = null;
      popupSource = null;
      popupGlass = null;
      popupPageReady = false;
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
  win.on('resized', () => onPopupResized());
  // 「鼠标离开就关」的轮询放到窗口真的显示出来之后（popup:present）再开：
  // 弹窗要等图标算好才开始显示，趁它还没露面就计时会让它刚出来就被收掉。
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

// ------------------------------------------------------------------ 窗口：右键菜单
//
// 以前用系统原生菜单（Menu.popup）。它确实不会被小窗口裁掉，但**挂在一个不聚焦的
// Dock 窗口上时，点别的窗口/桌面经常关不掉**（领导报的就是这个），而且收不到键盘。
// 现在自绘：一个尺寸刚好的可聚焦小窗，失焦即关（点别处左键就消失了）、方向键+回车
// 可选、Esc 取消，还能做淡入动画。

const MENU_GAP = 6;          // 菜单与鼠标点击处的间距
const MENU_EDGE_PAD = 4;     // 菜单与工作区边缘的最小距离

let menuWindow = null;
let menuItems = [];
let menuResolve = null;
let menuFocused = false;     // 已经拿到过焦点才认「失焦即关」，否则刚开就被自己的 blur 关掉

function menuPosition(ownerBounds, clickX, clickY, size) {
  // 菜单贴着点击它的窗口/图标，锚定在 Dock 所在的那块屏（#9）
  const area = activeDisplay().workArea;
  const baseX = ownerBounds ? ownerBounds.x : area.x;
  const baseY = ownerBounds ? ownerBounds.y : area.y;
  const pointX = baseX + (Number.isFinite(clickX) ? clickX : 0);
  const pointY = baseY + (Number.isFinite(clickY) ? clickY : 0);
  // 默认往下展开；下面放不下就翻到点击处上方（Dock 贴底，实际总是向上翻）
  let y =
    pointY + size.height + MENU_GAP > area.y + area.height - MENU_EDGE_PAD
      ? pointY - size.height - MENU_GAP
      : pointY + MENU_GAP;
  let x = pointX;
  x = Math.max(area.x + MENU_EDGE_PAD, Math.min(x, area.x + area.width - size.width - MENU_EDGE_PAD));
  y = Math.max(area.y + MENU_EDGE_PAD, y);
  return { x: Math.round(x), y: Math.round(y) };
}

function closeMenuWindow(picked = null) {
  const resolve = menuResolve;
  menuResolve = null;
  menuOpen = false;
  menuFocused = false;
  const win = menuWindow;
  menuWindow = null;
  if (win && !win.isDestroyed()) win.destroy();
  if (resolve) resolve(picked);
}

function openMenuWindow(event, payload = {}) {
  const raw = Array.isArray(payload.items) ? payload.items : [];
  const items = raw
    .filter((item) => item && (item.separator || item.key))
    .map((item) =>
      item.separator
        ? { separator: true }
        : { key: String(item.key), label: String(item.label || '').slice(0, 60) }
    );
  if (!items.some((item) => !item.separator)) return Promise.resolve(null);

  closeMenuWindow(null);            // 连点两次右键：先收掉上一个（顺带把上一个等的人放掉）
  const owner = BrowserWindow.fromWebContents(event.sender);
  const ownerBounds = owner && !owner.isDestroyed() ? owner.getContentBounds() : null;
  const size = dockmodel.menuLayout(items);
  const spot = menuPosition(ownerBounds, Number(payload.x), Number(payload.y), size);

  menuItems = items;
  menuOpen = true;                  // 菜单开着时，文件夹弹窗不许"失焦即关"
  return new Promise((resolve) => {
    menuResolve = resolve;
    menuFocused = false;
    const win = winFactory.createMenuWindow({
      ...spot,
      ...size,
      title: APP_NAME
    });
    menuWindow = win;
    attachDiagnostics(win, 'menu');
    winFactory.loadPage(win, 'menu.html', settings.reduce_motion ? { rm: 1 } : undefined);
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      win.show();
      win.focus();
    });
    win.on('focus', () => {
      menuFocused = true;
    });
    // 点别处 → 窗口失焦 → 关掉。这就是"右键后点其他地方菜单不消失"的修法。
    win.on('blur', () => {
      if (menuFocused) closeMenuWindow(null);
    });
    win.on('closed', () => {
      if (menuWindow === win) menuWindow = null;
      const pending = menuResolve;
      menuResolve = null;
      menuOpen = false;
      menuFocused = false;
      if (pending) pending(null);
    });
  });
}

// ------------------------------------------------------------------ 窗口：设置

// 打开设置窗口
function openSettings() {
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
  return settingsWindow;
}

// ------------------------------------------------------------------ 窗口：改名

// Electron 里没有 window.prompt（调用直接抛异常，渲染进程看着就像卡死），Dock 窗口又
// 不可聚焦、收不到键盘。所以改名单独开一个可聚焦的小输入窗，钉在 Dock 上方。
// 快捷方式改的是「别名」：只写进设置，磁盘上的 .lnk 一个字都不动（项目对桌面的承诺）。
const RENAME_WIDTH = 320;
const RENAME_HEIGHT = 132;
const RENAME_DOCK_GAP = 12;

function renamePosition(anchorScreenX) {
  const area = activeDisplay().workArea;   // 改名窗钉在 Dock 上方，跟着 Dock 那块屏（#9）
  const dockTop = dockTargetGeometry().y;
  const wanted = Number.isFinite(anchorScreenX)
    ? Math.round(anchorScreenX - RENAME_WIDTH / 2)
    : Math.round(area.x + (area.width - RENAME_WIDTH) / 2);
  const x = Math.min(
    Math.max(wanted, area.x + POPUP_EDGE_GAP),
    area.x + area.width - RENAME_WIDTH - POPUP_EDGE_GAP
  );
  const y = Math.max(area.y + POPUP_EDGE_GAP, Math.round(dockTop - RENAME_HEIGHT - RENAME_DOCK_GAP));
  return { x, y };
}

function closeRenameWindow() {
  if (renameWindow && !renameWindow.isDestroyed()) renameWindow.destroy();
  renameWindow = null;
  renameTarget = null;
}

function openRenameWindow(event, payload = {}) {
  let pending = null;
  let current = '';
  if (payload.kind === 'basket') {
    const basket = findBasket(payload.id);
    if (!basket) return false;
    pending = { kind: 'basket', id: basket.id };
    current = basket.name;
  } else {
    const target = store.normalizePath(payload.path);
    if (!target) return false;
    pending = { kind: 'shortcut', path: target };
    current = dockmodel.displayName(target, settings.dock_aliases);
  }
  closeRenameWindow();     // 连点两次右键时，先收掉上一个
  renameTarget = pending;
  // 渲染层给的是**窗口内坐标**（右键那个图标的中心），先换算到屏幕坐标，
  // 否则从 Dock 里改名时窗口会跑到屏幕最左边（Dock 窗口本身不在 x=0）
  const owner = event && event.sender ? BrowserWindow.fromWebContents(event.sender) : null;
  const ownerBounds = owner && !owner.isDestroyed() ? owner.getContentBounds() : null;
  const localX = Number(payload.anchorX);
  const anchorScreenX = Number.isFinite(localX) ? (ownerBounds ? ownerBounds.x : 0) + localX : NaN;
  const spot = renamePosition(anchorScreenX);
  renameWindow = winFactory.createRenameWindow({
    ...spot,
    glass: winFactory.glassEnabled(settings),
    title: `${APP_NAME} 改名`
  });
  attachDiagnostics(renameWindow, 'rename');
  winFactory.loadPage(renameWindow, 'rename.html', { value: current, kind: pending.kind });
  const win = renameWindow;
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.show();
    win.focus();
  });
  // 只有"当前这个窗口"关闭时才清状态：连点两次右键时，旧窗口的 closed 不能把新目标抹掉
  win.on('closed', () => {
    if (renameWindow !== win) return;
    renameWindow = null;
    renameTarget = null;
  });
  return true;
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
  ipcMain.handle('state:get', () => ({
    settings,
    desktop: desktopDir(),
    theme: resolvedTheme,
    displays: displaySummaries()
  }));

  ipcMain.handle('basket:get', (_event, { basketId } = {}) => basketView(findBasket(basketId)));

  // 往筐里登记文件。三条入口共用：拖到 Dock 的文件夹图标上、拖进文件夹弹窗、
  // 弹窗/设置面板里的「添加文件…」。返回 { added, total } 让渲染层能给出"＋N"的回执。
  ipcMain.handle('basket:add', (event, { basketId, paths } = {}) => {
    const basket = findBasket(basketId);
    if (!basket) return null;
    let next = basket;
    let added = 0;
    for (const item of paths || []) {
      const result = basketModel.addItem(next, item);
      if (result.result === 'added') {
        next = result.basket;
        added += 1;
      }
    }
    const saved = replaceBasket(next);
    console.log(`[basket] 加入 ${added} 条（来源 ${pageTag(event)}）→ 现有 ${saved.items.length} 条`);
    syncDock();
    prewarmBasketIcons();
    return { added, total: saved.items.length };
  });

  // 设置面板：往选中的筐里批量勾选（桌面上的条目，勾上就加进去、取消就移出）。
  // 这是"一次加一堆"最省事的入口——不用一层层翻文件对话框。
  ipcMain.handle('basket:candidates', (_event, { basketId } = {}) => {
    const basket = findBasket(basketId);
    if (!basket) return [];
    return dockmodel.basketCandidates(desktopItems(), basket.items);
  });

  // 「添加文件…」/「添加文件夹…」：选完直接登记进筐。
  // 注意 Windows 上 openFile 与 openDirectory **不能同时传**——同时传时对话框只剩选文件夹
  // （标签都变成「文件夹:」），那就没法加文件了。所以分成两个入口。
  ipcMain.handle('basket:pick-add', async (_event, { basketId, mode } = {}) => {
    const basket = findBasket(basketId);
    if (!basket) return null;
    const wantsDirs = mode === 'dirs';
    const picked = await dialog.showOpenDialog({
      title: (wantsDirs ? '往「' : '把文件加进「') + basket.name + '」',
      buttonLabel: '添加',
      // 默认停在桌面：这个程序整理的就是桌面上的东西，省得每次从头翻目录
      defaultPath: desktopDir(),
      properties: wantsDirs ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections']
    });
    if (picked.canceled || !picked.filePaths.length) return { added: 0, total: basket.items.length };
    let next = basket;
    let added = 0;
    for (const item of picked.filePaths) {
      const result = basketModel.addItem(next, item);
      if (result.result === 'added') {
        next = result.basket;
        added += 1;
      }
    }
    const saved = replaceBasket(next);
    console.log(`[basket] 从对话框加入 ${added} 条（${wantsDirs ? '文件夹' : '文件'}）→ 现有 ${saved.items.length} 条`);
    syncDock();
    prewarmBasketIcons();
    return { added, total: saved.items.length };
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
    // 改名与显隐都会影响 Dock：名字变了要刷新标签，visible 变了要重算窗口尺寸
    syncDock();
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
  // 快捷方式的名字在这里就定好（别名优先），渲染层只管画
  ipcMain.handle('dock:get', () => ({
    specials: settings.dock_specials
      .map((id) => specials.findSpecial(id))
      .filter(Boolean)
      .map((item) => ({ id: item.id, label: item.label })),
    baskets: settings.baskets
      .filter((basket) => basket.visible !== false)
      .map((basket) => ({ id: basket.id, name: basket.name, color: basket.color })),
    shortcuts: settings.dock_items.map((item) => ({
      path: item,
      name: dockmodel.displayName(item, settings.dock_aliases)
    }))
  }));

  ipcMain.handle('special:icon', (_event, { id }) => specialIconFor(id));

  ipcMain.handle('special:open', (_event, { id }) => openSpecial(id));

  ipcMain.handle('dock:remove-special', (_event, { id }) => {
    settings.dock_specials = settings.dock_specials.filter((item) => item !== id);
    persist();
    syncDock();
    return settings.dock_specials;
  });

  ipcMain.handle('dock:add', (event, { paths }) => addDockPaths(paths, pageTag(event)));

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

  ipcMain.handle('dock:remove', (event, { itemPath }) => {
    settings.dock_items = dockmodel.removeItem(settings.dock_items, itemPath);
    const blocked = dockmodel.addItem(settings.dock_removed, itemPath);
    settings.dock_removed = blocked.items;
    // 别名跟着条目一起清掉，不然配置里会留一条指向"已不在 Dock 上"的路径的名字
    const key = store.pathKey(itemPath || '');
    const kept = {};
    for (const [target, alias] of Object.entries(settings.dock_aliases || {})) {
      if (store.pathKey(target) !== key) kept[target] = alias;
    }
    settings.dock_aliases = kept;
    // 记录来源页：条目被"莫名移除"时，这条日志能指出是谁干的
    console.log(
      `[dock] 移除条目（来源 ${pageTag(event)}）${path.basename(String(itemPath || ''))} → 现有 ${settings.dock_items.length} 条`
    );
    persist();
    syncDock();
    return settings.dock_items;
  });

  ipcMain.handle('dock:reorder', (event, { items }) => {
    const next = store.normalizePathList(items);
    if (next.length !== settings.dock_items.length) {
      // 重排不该改变条目数量：数量变了说明渲染层传错了，记下来（这条曾经导致条目被清空）
      console.log(
        `[dock] 重排把条目数从 ${settings.dock_items.length} 改成 ${next.length}（来源 ${pageTag(event)}）`
      );
    }
    settings.dock_items = next;
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

  // 右键菜单：自绘菜单窗（见 openMenuWindow）。返回被选中的 key，取消返回 null。
  ipcMain.handle('menu:open', (event, payload = {}) => openMenuWindow(event, payload));

  // 菜单窗加载完来取要画哪些项
  ipcMain.handle('menu:items', () => menuItems);

  ipcMain.handle('menu:pick', (_event, { key } = {}) => {
    closeMenuWindow(key === undefined ? null : String(key));
    return true;
  });

  ipcMain.handle('menu:dismiss', () => {
    closeMenuWindow(null);
    return true;
  });

  ipcMain.handle('popup:ready', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win !== popupWindow || !popupPayload) return null;
    popupPageReady = true;      // 页面已就绪，这个窗口之后可以复用
    return withEntryIcons(rebuildPopupPayload());
  });

  ipcMain.handle('popup:present', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    // showInactive：显示但不抢用户当前应用的焦点（Dock 本身也不抢焦点，体验一致）
    if (win !== popupWindow || win.isDestroyed()) return false;
    // 等页面画出第一帧再显示：不然窗口先亮起来、内容后到，磨砂模式会闪一下空白矩形
    // （看起来就是"弹出来一顿"）。复用热窗口时早就画好了，这里不会等。
    if (!popupPainted) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 150);
        win.once('ready-to-show', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      popupPainted = true;
    }
    if (win.isDestroyed() || win !== popupWindow) return false;
    // 从"点下去"到"真的看见"花了多久——量弹窗手感的：第一次要起渲染进程，
    // 之后复用热窗口应该只有几毫秒
    if (popupOpenedAt) {
      console.log(`[popup] ${popupOpenMode}：从点击到显示 ${Date.now() - popupOpenedAt}ms`);
      popupOpenedAt = 0;
      popupOpenMode = '';
    }
    win.showInactive();
    startPopupAwayWatch();
    return true;
  });

  ipcMain.handle('popup:close', () => {
    closeFolderPopup();
    return true;
  });

  // 弹窗内导航：进入子目录 / 返回上级。窗口不动，磨砂背景也不变。
  // 图标只等很短一下（热缓存是立刻的），剩下的由渲染层自己补——翻目录要立刻出内容。
  ipcMain.handle('popup:navigate', async (event, { path: target }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win !== popupWindow || !target) return null;
    const listing = filebrowse.listEntries(target);
    const entries = listing.entries || [];
    warmEntryIcons(entries, settings.icon_size);
    return withEntryIcons(
      {
        kind: 'dir',
        name: path.basename(target) || target,
        path: target,
        parent: filebrowse.parentOf(target),
        entries,
        error: listing.error,
        iconSize: settings.icon_size
      },
      POPUP_NAVIGATE_ICON_WAIT_MS
    );
  });

  // 拖右下角把手改弹窗尺寸（#3）：夹到合法范围与所在屏工作区内，再 setBounds，
  // 触发的 resized 会被防抖落盘。返回 false 表示这个窗口已经不算数了（被顶掉/销毁）。
  ipcMain.handle('popup:resize', (event, { width, height } = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win !== popupWindow || !win || win.isDestroyed()) return false;
    let w = Math.round(Number(width));
    let h = Math.round(Number(height));
    if (!Number.isFinite(w) || !Number.isFinite(h)) return false;
    w = Math.max(store.POPUP_WIDTH_MIN, Math.min(store.POPUP_WIDTH_MAX, w));
    h = Math.max(store.POPUP_HEIGHT_MIN, Math.min(store.POPUP_HEIGHT_MAX, h));
    const area = activeDisplay().workArea;
    w = Math.min(w, area.width - POPUP_EDGE_GAP * 2);
    h = Math.min(h, area.height - POPUP_EDGE_GAP * 2);
    const bounds = win.getBounds();
    win.setBounds({ x: bounds.x, y: bounds.y, width: w, height: h });
    return true;
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

  ipcMain.handle('window:settings', () => {
    openSettings();
    return true;
  });

  // 改名：Dock 右键「改名…」与设置面板里的「改名」都走这里
  ipcMain.handle('rename:open', (event, payload = {}) => openRenameWindow(event, payload));

  ipcMain.handle('rename:commit', (_event, payload = {}) => {
    const target = renameTarget;
    if (!target) return false;
    const alias = store.normalizeAlias(payload.value);
    if (target.kind === 'basket') {
      const basket = findBasket(target.id);
      closeRenameWindow();
      if (!basket || !alias || alias === basket.name) return false;
      replaceBasket({ ...basket, name: alias });
    } else {
      const next = { ...settings.dock_aliases };
      // 输入的就是文件名本身 → 等于没改名，把别名删掉，免得配置里留一条无意义的记录
      if (!alias || alias === dockmodel.displayName(target.path, {})) delete next[target.path];
      else next[target.path] = alias;
      settings.dock_aliases = next;
      closeRenameWindow();
      persist();
    }
    syncDock();
    broadcastState();
    return true;
  });

  ipcMain.handle('rename:cancel', () => {
    closeRenameWindow();
    return true;
  });

  ipcMain.handle('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
    return true;
  });

  // 渲染层要提示用户时走这里：由主进程弹，不阻塞页面。
  // （Dock 窗口 focusable:false，页内的 alert 会把渲染进程卡住，跟 window.prompt 一个坑）
  ipcMain.handle('ui:alert', async (_event, payload = {}) => {
    const message = String(payload.text || '').slice(0, 500);
    if (!message) return false;
    await dialog.showMessageBox({
      type: 'warning',
      title: APP_NAME,
      message,
      buttons: ['好']
    });
    return true;
  });

  ipcMain.handle('settings:update', (_event, { patch }) => {
    const before = {
      dock_enabled: settings.dock_enabled,
      dock_auto_hide: settings.dock_auto_hide,
      dock_icon_size: settings.dock_icon_size,
      dock_magnify: settings.dock_magnify,
      dock_bottom_gap: settings.dock_bottom_gap,
      dock_display: settings.dock_display,
      theme_mode: settings.theme_mode,
      basket_count: settings.baskets.length
    };
    settings = store.mergedSettings({ ...settings, ...(patch || {}) });
    // 主题要在 persist（=广播）之前解析好，payload 里才带得出新深浅色
    if (settings.theme_mode !== before.theme_mode) applyTheme();
    persist();
    if (settings.dock_enabled !== before.dock_enabled) syncDock();
    else if (settings.dock_auto_hide !== before.dock_auto_hide) {
      // 常驻 ⇄ 自动收起：切换置顶，常驻时重新放到桌面层
      applyDockLayerMode();
    } else if (
      settings.dock_icon_size !== before.dock_icon_size ||
      settings.dock_bottom_gap !== before.dock_bottom_gap ||
      settings.dock_display !== before.dock_display ||
      settings.baskets.length !== before.basket_count
    ) {
      // 换屏（primary ⇄ mouse ⇄ 下标）要重算底边锚点与居中，跟改尺寸/抬起同一套处理
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
  // 启动时落一次盘：把 normalizeBaskets 给缺色筐补出来的主色固定下来。
  // 颜色本就按 id 稳定分配，但存一次能保证即使日后色板扩容或删筐，老筐的颜色也不会漂。
  persist();
  applyTheme();   // 解析深浅色（theme_mode + 壁纸亮度），设 nativeTheme，更新 resolvedTheme
  syncDockItems();
  syncDock();
  installTray();
  startDockAutoHide();
  // 后台把筐里条目的图标热进缓存：启动后第一次点开文件夹弹窗不该等图标
  prewarmBasketIcons();
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
    // 深浅色在 bootstrap 里按 theme_mode + 壁纸亮度解析（applyTheme 会设 nativeTheme.themeSource，
    // 让系统材质/滚动条/原生菜单与页面配色一致）。先兜个深色，万一主题解析出问题页面也不至于白底。
    nativeTheme.themeSource = 'dark';
    registerIpc();
    bootstrap();
    screen.on('display-metrics-changed', () => {
      applyDockGeometry();
      // 显示器增减：下拉列表（displays）与选屏结果都可能变，重解析并广播
      applyTheme();
      broadcastState();
    });
  });

  app.on('window-all-closed', () => {
    // 托盘常驻：窗口关光了也不退出
  });
}

module.exports = { bootstrap, dockTargetGeometry, dockSize };
