'use strict';

// Dock 的纯逻辑：热区、全屏判定、显隐决策、位置计算、收录与排序。
// 不依赖 Electron，可直接 node --test。
//
// 坐标一律用「屏幕逻辑像素」的 {x, y, width, height}。

const { normalizePath, pathKey } = require('./store');
const path = require('node:path');

const EDGE_BOTTOM = 'bottom';
const HOT_ZONE_THICKNESS = 3;
const HIDE_DELAY_MS = 400;

const ACTION_SHOW = 'show';
const ACTION_HIDE = 'hide';
const ACTION_NONE = 'none';

const COLLECT_SUFFIXES = ['.lnk', '.url', '.exe'];

// 桌面外壳窗口不算「全屏程序」：桌面本身就铺满屏幕，不排除的话对着桌面永远弹不出来
const SHELL_WINDOW_CLASSES = new Set([
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'SysListView32'
]);

function rectBottom(rect) {
  return rect.y + rect.height;
}

function isHotZone(point, screen, edge = EDGE_BOTTOM, thickness = HOT_ZONE_THICKNESS) {
  if (!point || !screen) return false;
  if (point.x < screen.x || point.x >= screen.x + screen.width) return false;
  if (edge === EDGE_BOTTOM) {
    const bottom = rectBottom(screen);
    return point.y >= bottom - thickness && point.y < bottom;
  }
  return false;
}

function isFullscreen(foreground, screen, tolerance = 2) {
  if (!foreground || !screen) return false;
  return (
    foreground.x <= screen.x + tolerance &&
    foreground.y <= screen.y + tolerance &&
    foreground.x + foreground.width >= screen.x + screen.width - tolerance &&
    foreground.y + foreground.height >= rectBottom(screen) - tolerance
  );
}

function isShellWindow(className) {
  return Boolean(className) && SHELL_WINDOW_CLASSES.has(className);
}

// 最大化窗口不拦 Dock：Windows 最大化窗口的矩形含 DWM 阴影边框，会比屏幕还大，
// 只看矩形会把「任何最大化窗口」误判成全屏，Dock 就再也弹不出来。
function foregroundBlocksDock(foreground, screen, className, maximized = false) {
  if (isShellWindow(className)) return false;
  if (maximized) return false;
  return isFullscreen(foreground, screen);
}

function shouldReveal(mouseInHotZone, foregroundFullscreen, locked, alreadyRevealed) {
  if (locked) return ACTION_NONE;
  if (foregroundFullscreen) return alreadyRevealed ? ACTION_HIDE : ACTION_NONE;
  if (alreadyRevealed) return ACTION_NONE;
  return mouseInHotZone ? ACTION_SHOW : ACTION_NONE;
}

function shouldHide(
  mouseInDockArea,
  foregroundFullscreen,
  locked,
  elapsedMs,
  hideDelayMs = HIDE_DELAY_MS
) {
  if (locked || mouseInDockArea) return false;
  if (foregroundFullscreen) return true;
  return elapsedMs >= hideDelayMs;
}

function monitorGeometry(displays, preferred = 'primary') {
  if (!Array.isArray(displays) || displays.length === 0) return null;
  if (Number.isInteger(preferred) && preferred >= 0 && preferred < displays.length) {
    return displays[preferred].bounds;
  }
  const primary = displays.find((display) => display.primary);
  return primary ? primary.bounds : displays[0].bounds;
}

// Dock（以及锚在它上面的弹窗 / 改名窗）该落在哪块屏。displays 每项形如
// { bounds, primary }（与 winFactory.listDisplays() 一致）。
//   mode='mouse'   → 光标所在的那块屏；光标不在任何屏内（罕见）退回主屏
//   mode=非负整数  → 按下标取那块屏；越界退回主屏
//   其它（primary）→ 主屏，没有主屏就取第一块
// 单显示器机器上三种结果一样，所以默认 primary 与旧行为完全一致。
function pickDisplay(displays, mode, cursorPoint) {
  if (!Array.isArray(displays) || displays.length === 0) return null;
  const primary = displays.find((display) => display.primary) || displays[0];
  if (mode === 'mouse' && cursorPoint) {
    const hit = displays.find((display) => pointNearBounds(cursorPoint, display.bounds, 0));
    if (hit) return hit;
  }
  if (typeof mode === 'number' && Number.isInteger(mode) && mode >= 0 && mode < displays.length) {
    return displays[mode];
  }
  return primary;
}

// 滑入用的一点回弹（easeOutBack）：末段先冲过目标再收回来，做出"啪地弹到位"的手感。
// 只在 Dock 往外滑出时用；收起方向不弹（弹一下反而拖沓）。c1/c3 是常见的 overshoot 常量。
const OVERSHOOT = 1.70158;
function easeOutBack(t) {
  // 端点钉死：动画第 0 帧必须在起点、最后一帧必须精确落在终点（浮点算式会差 1e-16 级别，
  // 用在逐帧位移上就是最后一帧停不到目标位的 bug）
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const x = t - 1;
  return 1 + x * x * ((OVERSHOOT + 1) * x + OVERSHOOT);
}

function revealedGeometry(screen, dockSize, edge = EDGE_BOTTOM, margin = 0, anchor = null) {
  const x = screen.x + Math.max(0, Math.floor((screen.width - dockSize.width) / 2));
  if (edge === EDGE_BOTTOM) {
    const base = anchor === null || anchor === undefined ? rectBottom(screen) : anchor;
    return { x, y: base - dockSize.height - margin, width: dockSize.width, height: dockSize.height };
  }
  return { x, y: screen.y + margin, width: dockSize.width, height: dockSize.height };
}

// 多行布局：条目放不进一行时按行折返，保证全部可见。
// 返回 { width, height, rows, perRow }，尺寸已含内边距与顶部余量
// （顶部余量给放大后的图标向上生长用，靠上的行会被悬停图标盖住，这是 Nexus 同款行为）。
const DOCK_CELL_GAP = 12;      // 单元间距（含图标间隙）
const DOCK_ROW_PITCH = 16;     // 行距：图标尺寸 + 每行余量
const DOCK_HEADROOM = 0.55;    // 顶部余量 = 图标尺寸 × 系数
const DOCK_WIDTH_RATIO = 0.96; // 最大占屏宽
// 图标下面那行小名字的高度（只有文件夹筐会写名字）。所有条目都留出这一格，
// 否则带名字的条目会把它的图标顶高、和邻居对不齐。dock.html 里的 CSS 必须与之对齐。
const DOCK_CAPTION_H = 15;

function dockLayout(itemCount, iconSize, screenWidth, padding = 8) {
  const count = Math.max(1, itemCount);
  const cell = iconSize + DOCK_CELL_GAP;
  const maxW = Math.max(240, Math.floor(screenWidth * DOCK_WIDTH_RATIO));
  const perRow = Math.max(1, Math.floor((maxW - padding * 2) / cell));
  const rows = Math.max(1, Math.ceil(count / perRow));
  const inRow = Math.min(count, perRow);
  const width = padding * 2 + inRow * cell;
  const height =
    Math.ceil(iconSize * DOCK_HEADROOM) +
    rows * (iconSize + DOCK_CAPTION_H + DOCK_ROW_PITCH) +
    padding;
  return { width, height, rows, perRow };
}

// 文件夹弹窗的位置：锚在 Dock 图标中心上方，左右不出屏，顶部至少留边。
// dockBounds 为空时（Dock 不在）退化为工作区底部居中。
function popupGeometry(area, dockBounds, anchorCenterX, popupSize, edgeGap = 8, dockGap = 10) {
  if (!area || !popupSize) return null;
  const centerX = dockBounds ? dockBounds.x + anchorCenterX : area.x + area.width / 2;
  const dockTop = dockBounds ? dockBounds.y : area.y + area.height;
  let x = Math.round(centerX - popupSize.width / 2);
  x = Math.max(area.x + edgeGap, Math.min(x, area.x + area.width - popupSize.width - edgeGap));
  let y = Math.round(dockTop - popupSize.height - dockGap);
  if (y < area.y + edgeGap) y = area.y + edgeGap;
  return { x, y, width: popupSize.width, height: popupSize.height };
}

// 鼠标是否落在 bounds（含 pad 余量）内——弹窗「离开即关」的判定基础
function pointNearBounds(point, bounds, pad = 0) {
  if (!bounds || !point) return false;
  return (
    point.x >= bounds.x - pad &&
    point.x <= bounds.x + bounds.width + pad &&
    point.y >= bounds.y - pad &&
    point.y <= bounds.y + bounds.height + pad
  );
}

// Dock 底边贴在哪条线上：
//   - 任务栏占位（没自动隐藏）时贴它的上沿，也就是工作区底边；
//   - 但离屏幕底边至少留 gap —— 自动隐藏的任务栏冒出来约 40px 高，不留缝就会盖住图标。
// 取两者里更高的那条（y 越小越靠上），所以 gap 小于任务栏高度时不会白留一道缝。
function bottomAnchor(workArea, screenRect, gap = 0) {
  const workBottom = workArea
    ? workArea.y + workArea.height
    : rectBottom(screenRect);
  const limit = rectBottom(screenRect) - Math.max(0, Number(gap) || 0);
  return Math.min(workBottom, limit);
}

function hiddenGeometry(screen, dockSize, edge = EDGE_BOTTOM, peek = 0) {
  const x = screen.x + Math.max(0, Math.floor((screen.width - dockSize.width) / 2));
  if (edge === EDGE_BOTTOM) {
    return { x, y: rectBottom(screen) - peek, width: dockSize.width, height: dockSize.height };
  }
  return { x, y: screen.y - dockSize.height + peek, width: dockSize.width, height: dockSize.height };
}

function isCollectable(rawPath) {
  const value = normalizePath(rawPath);
  if (!value) return false;
  const lowered = value.toLowerCase();
  return COLLECT_SUFFIXES.some((suffix) => lowered.endsWith(suffix));
}

function addItem(items, rawPath) {
  const value = normalizePath(rawPath);
  if (!value) return { items: [...items], result: 'invalid' };
  const key = pathKey(value);
  if (items.some((item) => pathKey(item) === key)) {
    return { items: [...items], result: 'duplicate' };
  }
  return { items: [...items, value], result: 'added' };
}

function removeItem(items, rawPath) {
  const key = pathKey(rawPath || '');
  return items.filter((item) => pathKey(item) !== key);
}

function moveItem(items, fromIndex, toIndex) {
  const result = [...items];
  if (!result.length) return result;
  if (fromIndex < 0 || fromIndex >= result.length) return result;
  if (toIndex < 0 || toIndex >= result.length) return result;
  if (fromIndex === toIndex) return result;
  const [moved] = result.splice(fromIndex, 1);
  result.splice(toIndex, 0, moved);
  return result;
}

// 把桌面上新出现的快捷方式补进 Dock；用户手动移除过的永不自动加回
function syncDesktopShortcuts(items, removed, desktopPaths) {
  const result = [...items];
  const present = new Set(result.map(pathKey));
  const blocked = new Set((removed || []).map(pathKey));
  for (const raw of desktopPaths || []) {
    const value = normalizePath(raw);
    if (!value || !isCollectable(value)) continue;
    const key = pathKey(value);
    if (present.has(key) || blocked.has(key)) continue;
    present.add(key);
    result.push(value);
  }
  return result;
}

// 收录来源换了目录时迁移黑名单：黑名单记的是「这类东西别自动收录」的意愿，
// 路径变了意愿没变——旧条目原样保留（文件挪回去时语义仍在），新目录里同名
// 文件对应的路径补进黑名单，syncDesktopShortcuts 就不会把它们当新面孔收回来。
function migrateRemoved(removed, newDirPaths) {
  const result = [...(removed || [])];
  const present = new Set(result.map(pathKey));
  const byBase = new Map();
  for (const raw of newDirPaths || []) {
    const value = normalizePath(raw);
    if (!value) continue;
    byBase.set(path.basename(value).toLowerCase(), value);
  }
  for (const raw of removed || []) {
    const base = path.basename(String(raw || '')).toLowerCase();
    const hit = byBase.get(base);
    if (!hit) continue;
    const key = pathKey(hit);
    if (present.has(key)) continue;
    present.add(key);
    result.push(hit);
  }
  return result;
}

// 把 items 里落在 removeList（黑名单）里的条目请出去，其余顺序不变。
function removeItems(items, removeList) {
  const blocked = new Set((removeList || []).map(pathKey));
  return (items || []).filter((item) => !blocked.has(pathKey(item)));
}

// 右键菜单窗口的尺寸。自绘菜单要用一个尺寸刚好的窗口装它（原生菜单没有这个问题，
// 但它挂在不聚焦的 Dock 窗口上时点别处关不掉）。宽度按最长一条标签估算：
// 中日韩字符按 13px、其余按 7px，再加图标/内边距的余量。
const MENU_ITEM_H = 30;
const MENU_SEPARATOR_H = 9;
const MENU_PADDING_Y = 8;
const MENU_MIN_W = 180;
const MENU_MAX_W = 320;
const CJK_CHAR = /[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/;

function menuLayout(items) {
  const list = Array.isArray(items) ? items : [];
  let width = MENU_MIN_W;
  let height = MENU_PADDING_Y * 2;
  for (const item of list) {
    if (item && item.separator) {
      height += MENU_SEPARATOR_H;
      continue;
    }
    height += MENU_ITEM_H;
    const label = String((item && item.label) || '');
    let textWidth = 0;
    for (const ch of label) textWidth += CJK_CHAR.test(ch) ? 13 : 7;
    width = Math.max(width, Math.min(MENU_MAX_W, Math.ceil(textWidth) + 48));
  }
  return {
    width: Math.max(MENU_MIN_W, Math.min(MENU_MAX_W, width)),
    height: Math.max(MENU_ITEM_H + MENU_PADDING_Y * 2, height)
  };
}

function findIndex(items, rawPath) {
  const key = pathKey(rawPath || '');
  return items.findIndex((item) => pathKey(item) === key);
}

// Dock 上显示的名字：有别名用别名，没有就用文件名（去掉 .lnk / .url / .exe 后缀）。
// 别名只存在设置里——改显示名不动磁盘上的文件（项目对桌面的承诺）。
function displayName(rawPath, aliases) {
  const value = normalizePath(rawPath);
  if (!value) return '';
  const key = pathKey(value);
  for (const [target, alias] of Object.entries(aliases || {})) {
    if (pathKey(target) === key) {
      const text = typeof alias === 'string' ? alias.trim() : '';
      if (text) return text;
    }
  }
  const base = path.basename(value);
  return base.replace(/\.(lnk|url|exe)$/i, '');
}

// 设置面板里"逐个添加"用的候选清单：桌面上可收录的条目 ＋ 是否已经在 Dock 上。
// 排序按名称（中文按拼音顺序），返回 [{ path, name, onDock }]。
function shortcutCandidates(desktopPaths, items) {
  const onDock = new Set((items || []).map(pathKey));
  const rows = [];
  const seen = new Set();
  for (const raw of desktopPaths || []) {
    const value = normalizePath(raw);
    if (!value || !isCollectable(value)) continue;
    const key = pathKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ path: value, name: path.basename(value), onDock: onDock.has(key) });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return rows;
}

// 设置面板里"往筐里批量勾选"的候选清单：桌面上**所有**条目（不筛后缀——筐里可以放
// 任何东西，不像 Dock 只收快捷方式）。返回 [{ path, name, inBasket }]，按名称排序。
function basketCandidates(desktopPaths, basketItems) {
  const inBasket = new Set((basketItems || []).map(pathKey));
  const rows = [];
  const seen = new Set();
  for (const raw of desktopPaths || []) {
    const value = normalizePath(raw);
    if (!value) continue;
    const key = pathKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ path: value, name: path.basename(value), inBasket: inBasket.has(key) });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return rows;
}

module.exports = {
  ACTION_HIDE,
  ACTION_NONE,
  ACTION_SHOW,
  COLLECT_SUFFIXES,
  DOCK_CAPTION_H,
  DOCK_CELL_GAP,
  DOCK_HEADROOM,
  DOCK_ROW_PITCH,
  DOCK_WIDTH_RATIO,
  EDGE_BOTTOM,
  HIDE_DELAY_MS,
  HOT_ZONE_THICKNESS,
  MENU_ITEM_H,
  MENU_PADDING_Y,
  MENU_SEPARATOR_H,
  OVERSHOOT,
  SHELL_WINDOW_CLASSES,
  addItem,
  basketCandidates,
  bottomAnchor,
  dockLayout,
  displayName,
  easeOutBack,
  findIndex,
  foregroundBlocksDock,
  hiddenGeometry,
  isCollectable,
  isFullscreen,
  isHotZone,
  isShellWindow,
  menuLayout,
  migrateRemoved,
  monitorGeometry,
  moveItem,
  pickDisplay,
  pointNearBounds,
  popupGeometry,
  removeItem,
  removeItems,
  revealedGeometry,
  shouldHide,
  shouldReveal,
  shortcutCandidates,
  syncDesktopShortcuts
};
