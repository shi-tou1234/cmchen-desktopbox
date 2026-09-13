'use strict';

// 配置持久化：%APPDATA%\DeskBasket\settings.json
// 不认识的字段原样保留，读写往返不丢东西。

const fs = require('node:fs');
const os = require('node:os');

const path = require('node:path');
const specials = require('./specials');
const weather = require('./weather');
const basketfiles = require('./basketfiles');

const SETTINGS_FILENAME = 'settings.json';
const SETTINGS_BACKUP_SUFFIX = '.bak';
const APP_DIR_NAME = 'DeskBasket';

const DEFAULTS = {
  accent_mode: 'off',          // off=完全透明（默认，领导指定）／acrylic=系统磨砂玻璃／blur=轻量模糊
  theme_mode: 'auto',          // auto=按壁纸亮度切深浅色／dark／light（见 theme.js）
  reduce_motion: false,        // 减弱动画：关掉入场/翻页/弹跳等装饰动画（保留悬停放大——它用 dock_magnify 单独控制）
  autostart: false,
  icon_size: 48,
  baskets: [],
  shortcuts_dir: '',           // 收录来源目录（Dock 自动收录、候选清单、文件对话框默认落点）；空 = 系统桌面
  basket_dir: basketfiles.DEFAULT_DIR,   // 筐的文件目录：每个筐在它下面有一个真实文件夹（见 basketfiles）
  dock_enabled: true,
  dock_auto_hide: true,        // 鼠标离开就收起（贴底边才滑出），这样不会挡着别的窗口
  dock_icon_size: 48,
  dock_magnify: 50,            // 鼠标靠近时图标放大程度（百分比，0=不放大）
  dock_hide_delay_ms: 400,
  dock_bottom_gap: 48,         // Dock 底边离屏幕底边的距离（px）：高过自动隐藏的任务栏，不被它盖住
  dock_display: 'primary',     // Dock 在哪块屏：'primary'／'mouse'（光标所在屏）／非负整数（按 getAllDisplays 下标）
  popup_width: 480,            // 文件夹弹窗的尺寸：可在弹窗右下角拖着改，拖完记住
  popup_height: 460,
  dock_items: [],
  dock_aliases: {},            // 快捷方式在 Dock 上的显示名：只存设置，绝不动磁盘上的文件名
  dock_specials: ['windows', 'thispc', 'recyclebin', 'weather'],   // windows = 开始菜单（最左）  // 系统虚拟项：此电脑、回收站、天气
  dock_removed: [],
  // 天气城市：只存一个名字，经纬度每次启动重新查（一次地理编码请求，代价极低，
  // 省得设置里留一堆坐标字段要去校验）。空 = 用 weather.DEFAULT_CITY。
  weather_city: ''
};

// 已经退休、不再有任何代码读取的字段：读到旧配置时顺手删掉，别让配置里留着"看着能调其实无效"的项
const RETIRED_KEYS = ['basket_behavior', 'dock_behavior', 'dock_always_visible'];

const ACCENT_MODES = ['off', 'acrylic', 'blur'];
// 与 token 监测一致：它也有「磨砂」和「完全透明」两种模式，这里一一对应
const ACCENT_LABELS = {
  off: '完全透明（桌面完全透出来）',
  acrylic: '磨砂玻璃（Win11 系统材质，背景被糊开）',
  blur: '轻量模糊（老 API，部分系统偏暗）'
};
const ICON_SIZE_MIN = 24;
const ICON_SIZE_MAX = 128;
const DOCK_MAGNIFY_MIN = 0;    // 不放大
const DOCK_MAGNIFY_MAX = 100;  // 最大放大一倍
const DOCK_HIDE_DELAY_MIN = 100;
const DOCK_HIDE_DELAY_MAX = 3000;
const DOCK_BOTTOM_GAP_MIN = 0;
const DOCK_BOTTOM_GAP_MAX = 200;
// 文件夹弹窗尺寸的可拖范围（像素）。下限保证标题栏＋至少一行图标，上限不至于盖满整屏。
const POPUP_WIDTH_MIN = 260;
const POPUP_WIDTH_MAX = 900;
const POPUP_HEIGHT_MIN = 200;
const POPUP_HEIGHT_MAX = 900;

// 存储根目录。生产环境固定为 %APPDATA%\DeskBasket —— **对外 API 不接受任何路径参数**，
// 从结构上就没有路径穿越入口。测试用 __setRootForTests 注入临时目录（同样做绝对路径校验）。
let injectedRoot = null;

function settingsDir() {
  if (injectedRoot) return injectedRoot;
  return path.join(process.env.APPDATA || os.homedir(), APP_DIR_NAME);
}

function __setRootForTests(dir) {
  if (!dir) {
    injectedRoot = null;
    return null;
  }
  const resolved = path.resolve(String(dir));
  if (!path.isAbsolute(resolved)) throw new Error('测试目录必须是绝对路径');
  injectedRoot = resolved;
  return injectedRoot;
}

// 设置文件绝对路径：文件名是常量，且必须恰好落在存储根目录内
function settingsPath() {
  const root = settingsDir();
  const target = path.resolve(root, SETTINGS_FILENAME);
  if (path.dirname(target) !== root) throw new Error('设置文件路径越界');
  return target;
}


function normalizePath(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/^"|"$/g, '');
  if (!text || text.includes('\0')) return null;
  return path.normalize(path.resolve(text));
}

function pathKey(value) {
  if (typeof value !== 'string') return '';
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

// 去重 + 绝对化，保持原顺序
function normalizePathList(raw) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    const value = normalizePath(entry);
    if (!value) continue;
    const key = pathKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

// Dock 快捷方式的「别名」：显示用的另一个名字。
// 项目承诺不动桌面上任何文件，所以改名不改磁盘上的 .lnk，只在这里存一个显示名。
// 键是规范化后的绝对路径（与 dock_items 同一种写法），这样能按路径直接取到。
const ALIAS_MAX = 24;

function normalizeAlias(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, ALIAS_MAX);
}

function normalizeAliases(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const target = normalizePath(key);
    const alias = normalizeAlias(value);
    if (!target || !alias) continue;
    out[target] = alias;
  }
  return out;
}

function clampInt(value, fallback, low, high) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  if (value < low || value > high) return fallback;
  return value;
}

// 弹窗尺寸：非法值（非整数/越界）回落到默认；合法值原样保留（含 0 之外的正常整数）。
function clampOr(value, fallback, low, high) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

// Dock 在哪块屏：'primary' / 'mouse' 直接认，非负整数（按显示器下标）也认，其余回 primary。
function normalizeDockDisplay(raw) {
  if (raw === 'primary' || raw === 'mouse') return raw;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return raw;
  return 'primary';
}

// 收录来源目录：只认「写出来就是绝对路径」的字符串。相对路径 resolve 之后会落在
// 进程当前目录下的某个意外位置，一律回退空串（= 系统桌面）。
// 筐的文件目录：必须是绝对路径，坏的/空的回默认（E:\文件筐），不让它变成"当前工作目录下的文件夹"
function normalizeBasketDir(raw) {
  if (typeof raw !== 'string') return DEFAULTS.basket_dir;
  const text = raw.trim();
  if (!text || !path.isAbsolute(text)) return DEFAULTS.basket_dir;
  return normalizePath(text) || DEFAULTS.basket_dir;
}

function normalizeSourceDir(raw) {
  if (typeof raw !== 'string') return '';
  const text = raw.trim();
  if (!text || !path.isAbsolute(text)) return '';
  return normalizePath(text) || '';
}

// 天气城市：压缩空白、限长（地理编码接口按名字查，太长的串只会白跑一趟）；
// 非字符串回空串，等于用 weather.DEFAULT_CITY。
function normalizeCity(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, weather.CITY_MAX);
}

function mergedSettings(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  // 未知字段先原样搬过来，保证版本间往返不丢
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in DEFAULTS)) out[key] = value;
  }
  out.accent_mode = ACCENT_MODES.includes(raw.accent_mode)
    ? raw.accent_mode
    : DEFAULTS.accent_mode;
  out.theme_mode = require('./theme').THEME_MODES.includes(raw.theme_mode)
    ? raw.theme_mode
    : DEFAULTS.theme_mode;
  out.reduce_motion =
    typeof raw.reduce_motion === 'boolean' ? raw.reduce_motion : DEFAULTS.reduce_motion;
  out.autostart = typeof raw.autostart === 'boolean' ? raw.autostart : DEFAULTS.autostart;
  out.icon_size = clampInt(raw.icon_size, DEFAULTS.icon_size, ICON_SIZE_MIN, ICON_SIZE_MAX);
  out.baskets = require('./baskets').normalizeBaskets(raw.baskets);
  out.dock_enabled =
    typeof raw.dock_enabled === 'boolean' ? raw.dock_enabled : DEFAULTS.dock_enabled;
  out.dock_auto_hide =
    typeof raw.dock_auto_hide === 'boolean' ? raw.dock_auto_hide : DEFAULTS.dock_auto_hide;
  out.dock_icon_size = clampInt(
    raw.dock_icon_size, DEFAULTS.dock_icon_size, ICON_SIZE_MIN, ICON_SIZE_MAX
  );
  out.dock_magnify = clampInt(
    raw.dock_magnify, DEFAULTS.dock_magnify, DOCK_MAGNIFY_MIN, DOCK_MAGNIFY_MAX
  );
  out.dock_hide_delay_ms = clampInt(
    raw.dock_hide_delay_ms,
    DEFAULTS.dock_hide_delay_ms,
    DOCK_HIDE_DELAY_MIN,
    DOCK_HIDE_DELAY_MAX
  );
  out.dock_items = normalizePathList(raw.dock_items);
  out.shortcuts_dir = normalizeSourceDir(raw.shortcuts_dir);
  out.basket_dir = normalizeBasketDir(raw.basket_dir);
  out.dock_bottom_gap = clampInt(
    raw.dock_bottom_gap,
    DEFAULTS.dock_bottom_gap,
    DOCK_BOTTOM_GAP_MIN,
    DOCK_BOTTOM_GAP_MAX
  );
  out.dock_display = normalizeDockDisplay(raw.dock_display);
  out.popup_width = clampOr(
    raw.popup_width,
    DEFAULTS.popup_width,
    POPUP_WIDTH_MIN,
    POPUP_WIDTH_MAX
  );
  out.popup_height = clampOr(
    raw.popup_height,
    DEFAULTS.popup_height,
    POPUP_HEIGHT_MIN,
    POPUP_HEIGHT_MAX
  );
  out.dock_aliases = normalizeAliases(raw.dock_aliases);
  out.dock_specials = specials.normalizeSpecials(
    'dock_specials' in raw ? raw.dock_specials : DEFAULTS.dock_specials
  );
  out.dock_removed = normalizePathList(raw.dock_removed);
  out.weather_city = normalizeCity(raw.weather_city);
  for (const key of RETIRED_KEYS) delete out[key];
  return out;
}

// 备份文件路径：与设置文件同目录、后缀是常量，同样做越界校验。
// 它存的是「上一次成功保存」的配置。设置全在 %APPDATA%，坏掉等于所有筐与别名丢失，
// 代价高、防护便宜——所以每次成功保存前，先把当前这份好文件留一个 .bak。
function backupPath() {
  const root = settingsDir();
  const target = path.resolve(root, SETTINGS_FILENAME + SETTINGS_BACKUP_SUFFIX);
  if (path.dirname(target) !== root) throw new Error('备份文件路径越界');
  return target;
}

// 读一份并解析成合法配置；文件缺失/坏 JSON/解析异常都返回 null（不是默认值，交给调用方决定回退哪一层）
function tryLoadFile(file) {
  try {
    return mergedSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (_) {
    return null;
  }
}

function loadSettings() {
  const primary = tryLoadFile(settingsPath());
  if (primary) return primary;
  // 主文件坏了（磁盘异常、手改坏 JSON、写一半断电）：回退到上一次成功保存的备份。
  // 备份也读不出来（没有、或同样坏）才退回默认——绝不拿默认值覆盖磁盘，交给下次 saveSettings 重写。
  const backup = tryLoadFile(backupPath());
  if (backup) return backup;
  return { ...DEFAULTS };
}

function saveSettings(settings) {
  const merged = mergedSettings(settings);
  const target = settingsPath();
  const root = path.dirname(target);
  fs.mkdirSync(root, { recursive: true });
  // 原子写：先写同目录临时文件再改名，避免中断留下半个文件。
  // 临时文件名是常量，且解析后必须仍在同一目录内。
  const tmp = path.resolve(root, `.settings-${process.pid}.tmp`);
  if (path.dirname(tmp) !== root) throw new Error('临时文件路径越界');
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
  // 覆盖主文件之前，把「当前这份还能读出来的主文件」留一份 .bak（loadSettings 认的就是这份好文件）。
  // 备份失败不影响主写入——它只是多加一道保险，主文件已经原子落盘了。
  const backup = backupPath();
  const currentGood = tryLoadFile(target);
  if (currentGood) {
    try {
      fs.writeFileSync(backup, fs.readFileSync(target, 'utf8'), 'utf8');
    } catch (_) {
      /* 备份写不下去（磁盘满等）：不阻断主保存 */
    }
  }
  fs.renameSync(tmp, target);
  return merged;
}

module.exports = {
  __setRootForTests,
  ACCENT_LABELS,
  ACCENT_MODES,
  ALIAS_MAX,
  DEFAULTS,
  DOCK_BOTTOM_GAP_MAX,
  DOCK_BOTTOM_GAP_MIN,
  DOCK_HIDE_DELAY_MAX,
  DOCK_HIDE_DELAY_MIN,
  DOCK_MAGNIFY_MAX,
  DOCK_MAGNIFY_MIN,
  ICON_SIZE_MAX,
  ICON_SIZE_MIN,
  POPUP_WIDTH_MIN,
  POPUP_WIDTH_MAX,
  POPUP_HEIGHT_MIN,
  POPUP_HEIGHT_MAX,
  SETTINGS_BACKUP_SUFFIX,
  backupPath,
  loadSettings,
  normalizeDockDisplay,
  mergedSettings,
  normalizeAlias,
  normalizeAliases,
  normalizeCity,
  normalizePath,
  normalizePathList,
  normalizeSourceDir,
  pathKey,
  saveSettings,
  settingsDir,
  settingsPath
};
