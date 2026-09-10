'use strict';

// 窗口行为模式：与 token 监测的 src/electron/windowBehavior.js 保持同一套语义。
//
// | 模式     | 置顶 | 可拖动 | 可缩放 | 说明                        |
// |----------|------|--------|--------|-----------------------------|
// | floating | 是   | 是     | 是     | 浮在其他窗口上方            |
// | normal   | 否   | 是     | 是     | 普通窗口（文件筐用这个）    |
// | desktop  | 否   | 否     | 否     | 固定于桌面（Dock 用这个）   |
//
// 注意 desktop 模式在这套实现里**不是置顶**、也不用 Win32 的 z 序技巧，就是
// 「不置顶 + 不能拖 + 不能缩放 + 带一个 desktop-mode 类」，这与 token 一致。

const WINDOW_BEHAVIORS = new Set(['floating', 'normal', 'desktop']);

const WINDOW_BEHAVIOR_PROFILES = {
  floating: {
    mode: 'floating',
    alwaysOnTop: true,
    draggable: true,
    resizable: true,
    focusable: true,
    cssClass: ''
  },
  normal: {
    mode: 'normal',
    alwaysOnTop: false,
    draggable: true,
    resizable: true,
    focusable: true,
    cssClass: ''
  },
  desktop: {
    mode: 'desktop',
    alwaysOnTop: false,
    draggable: false,
    resizable: false,
    focusable: true,
    cssClass: 'desktop-mode'
  }
};

const WINDOW_BEHAVIOR_LABELS = {
  floating: '浮动置顶（浮在其他窗口上方）',
  normal: '普通窗口（可拖动、可缩放）',
  desktop: '固定于桌面（不可拖动、不置顶）'
};

function normalizeWindowBehavior(value, fallback = 'normal') {
  const normalized = String(value || '').trim().toLowerCase();
  if (WINDOW_BEHAVIORS.has(normalized)) return normalized;
  const fallbackMode = String(fallback || '').trim().toLowerCase();
  return WINDOW_BEHAVIORS.has(fallbackMode) ? fallbackMode : 'normal';
}

// 兼容旧字段 alwaysOnTop：true→floating，false→normal
function modeFromSettings(settings = {}, fallback = 'normal') {
  if (Object.prototype.hasOwnProperty.call(settings, 'windowBehavior')) {
    return normalizeWindowBehavior(settings.windowBehavior, fallback);
  }
  if (Object.prototype.hasOwnProperty.call(settings, 'alwaysOnTop')) {
    return settings.alwaysOnTop ? 'floating' : 'normal';
  }
  return normalizeWindowBehavior(fallback);
}

function describeWindowBehavior(settings = {}, fallback = 'normal') {
  return { ...WINDOW_BEHAVIOR_PROFILES[modeFromSettings(settings, fallback)] };
}

module.exports = {
  WINDOW_BEHAVIOR_LABELS,
  WINDOW_BEHAVIOR_PROFILES,
  WINDOW_BEHAVIORS,
  describeWindowBehavior,
  modeFromSettings,
  normalizeWindowBehavior
};
