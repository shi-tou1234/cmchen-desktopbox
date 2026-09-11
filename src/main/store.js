'use strict';

// 配置持久化：%APPDATA%\DeskBasket\settings.json
// 与 Python 版保持同一份 schema，所以已有的配置能直接读；
// 不认识的字段原样保留，读写往返不丢东西。

const fs = require('node:fs');
const os = require('node:os');

const behavior = require('./windowBehavior');
const path = require('node:path');

const SETTINGS_FILENAME = 'settings.json';
const APP_DIR_NAME = 'DeskBasket';

const DEFAULTS = {
  accent_mode: 'off',          // off=完全透明（默认，领导指定）／acrylic=系统磨砂玻璃／blur=轻量模糊
  autostart: false,
  icon_size: 48,
  baskets: [],
  dock_enabled: true,
  dock_always_visible: true,   // 常驻显示：鼠标移开也不收起
  dock_icon_size: 48,
  dock_hide_delay_ms: 400,
  dock_items: [],
  dock_removed: [],
  // 窗口行为，与 token 的 windowBehavior 同一套：floating / normal / desktop
  basket_behavior: 'normal'    // 文件筐＝普通窗口；Dock 固定于桌面 + 常驻可见由开关决定
};

const ACCENT_MODES = ['off', 'acrylic', 'blur'];
// 与 token 监测一致：它也有「磨砂」和「完全透明」两种模式，这里一一对应
const ACCENT_LABELS = {
  off: '完全透明（桌面完全透出来）',
  acrylic: '磨砂玻璃（Win11 系统材质，背景被糊开）',
  blur: '轻量模糊（老 API，部分系统偏暗）'
};
const ICON_SIZE_MIN = 24;
const ICON_SIZE_MAX = 128;
const DOCK_HIDE_DELAY_MIN = 100;
const DOCK_HIDE_DELAY_MAX = 3000;

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

function clampInt(value, fallback, low, high) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  if (value < low || value > high) return fallback;
  return value;
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
  out.autostart = typeof raw.autostart === 'boolean' ? raw.autostart : DEFAULTS.autostart;
  out.icon_size = clampInt(raw.icon_size, DEFAULTS.icon_size, ICON_SIZE_MIN, ICON_SIZE_MAX);
  out.baskets = require('./baskets').normalizeBaskets(raw.baskets);
  out.dock_enabled =
    typeof raw.dock_enabled === 'boolean' ? raw.dock_enabled : DEFAULTS.dock_enabled;
  out.dock_always_visible =
    typeof raw.dock_always_visible === 'boolean'
      ? raw.dock_always_visible
      : DEFAULTS.dock_always_visible;
  out.dock_icon_size = clampInt(
    raw.dock_icon_size, DEFAULTS.dock_icon_size, ICON_SIZE_MIN, ICON_SIZE_MAX
  );
  out.dock_hide_delay_ms = clampInt(
    raw.dock_hide_delay_ms,
    DEFAULTS.dock_hide_delay_ms,
    DOCK_HIDE_DELAY_MIN,
    DOCK_HIDE_DELAY_MAX
  );
  out.dock_items = normalizePathList(raw.dock_items);
  out.dock_removed = normalizePathList(raw.dock_removed);
  out.basket_behavior = behavior.normalizeWindowBehavior(raw.basket_behavior, 'normal');
  return out;
}

function loadSettings() {
  try {
    const text = fs.readFileSync(settingsPath(), 'utf8');
    return mergedSettings(JSON.parse(text));
  } catch (_) {
    return { ...DEFAULTS };
  }
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
  fs.renameSync(tmp, target);
  return merged;
}

module.exports = {
  __setRootForTests,
  ACCENT_LABELS,
  ACCENT_MODES,
  DEFAULTS,
  DOCK_HIDE_DELAY_MAX,
  DOCK_HIDE_DELAY_MIN,
  ICON_SIZE_MAX,
  ICON_SIZE_MIN,
  loadSettings,
  mergedSettings,
  normalizePath,
  normalizePathList,
  pathKey,
  saveSettings,
  settingsDir,
  settingsPath
};
