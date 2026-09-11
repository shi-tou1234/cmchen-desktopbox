'use strict';

// Dock 的纯逻辑：热区、全屏判定、显隐决策、位置计算、收录与排序。
// 与 Python 版 dockmodel.py 同语义，不依赖 Electron，可直接 node --test。
//
// 坐标一律用「屏幕逻辑像素」的 {x, y, width, height}。

const { normalizePath, pathKey } = require('./store');

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

function dockLayout(itemCount, iconSize, screenWidth, padding = 8) {
  const count = Math.max(1, itemCount);
  const cell = iconSize + DOCK_CELL_GAP;
  const maxW = Math.max(240, Math.floor(screenWidth * DOCK_WIDTH_RATIO));
  const perRow = Math.max(1, Math.floor((maxW - padding * 2) / cell));
  const rows = Math.max(1, Math.ceil(count / perRow));
  const inRow = Math.min(count, perRow);
  const width = padding * 2 + inRow * cell;
  const height =
    Math.ceil(iconSize * DOCK_HEADROOM) + rows * (iconSize + DOCK_ROW_PITCH) + padding;
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

function findIndex(items, rawPath) {
  const key = pathKey(rawPath || '');
  return items.findIndex((item) => pathKey(item) === key);
}

module.exports = {
  ACTION_HIDE,
  ACTION_NONE,
  ACTION_SHOW,
  COLLECT_SUFFIXES,
  DOCK_CELL_GAP,
  DOCK_HEADROOM,
  DOCK_ROW_PITCH,
  DOCK_WIDTH_RATIO,
  EDGE_BOTTOM,
  HIDE_DELAY_MS,
  HOT_ZONE_THICKNESS,
  SHELL_WINDOW_CLASSES,
  addItem,
  dockLayout,
  findIndex,
  foregroundBlocksDock,
  hiddenGeometry,
  isCollectable,
  isFullscreen,
  isHotZone,
  isShellWindow,
  monitorGeometry,
  moveItem,
  pointNearBounds,
  popupGeometry,
  removeItem,
  revealedGeometry,
  shouldHide,
  shouldReveal,
  syncDesktopShortcuts
};
