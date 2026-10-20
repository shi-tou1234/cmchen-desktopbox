'use strict';

// 频谱配色：五套主题 + 深浅色适配。从 viz.js 拆出来的，纯函数、不碰画布状态。
//
// 每套主题给三个渐变停靠色（下 → 上）和一段 rgb 字符串（拼发光/倒影的 rgba 用）。
// 亮壁纸下统一压暗一档：浅色柱压在浅底上会糊成一片。

(function () {
  const THEMES = {
    aurora: { bar: ['#2f6bff', '#7a5cff', '#d18cff'], rgb: '120, 130, 255' },
    ocean: { bar: ['#1060e0', '#1f9dff', '#7fe6ff'], rgb: '60, 165, 255' },
    sunset: { bar: ['#ff7a3d', '#ff4f8b', '#b96bff'], rgb: '255, 105, 140' },
    mint: { bar: ['#0fbf88', '#23d3c0', '#8bf0d8'], rgb: '45, 210, 175' },
    mono: { bar: ['#dfe6ff', '#ffffff', '#b9c6ff'], rgb: '210, 220, 255' }
  };

  function withAlpha(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  // 压暗：返回 hex，withAlpha() 才能继续用
  function shade(hex, k) {
    const n = parseInt(hex.slice(1), 16);
    const parts = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
      Math.max(0, Math.min(255, Math.round(v * k))).toString(16).padStart(2, '0')
    );
    return '#' + parts.join('');
  }

  function palette(light, themeKey) {
    const theme = THEMES[themeKey] || THEMES.aurora;
    return {
      bar: light ? theme.bar.map((c) => shade(c, 0.72)) : theme.bar,
      glow: `rgba(${theme.rgb}, ${light ? 0.26 : 0.45})`,
      cap: light ? 'rgba(24, 38, 80, 0.40)' : 'rgba(255, 255, 255, 0.45)',
      stem: `rgba(${theme.rgb}, ${light ? 0.16 : 0.20})`,
      blockOff: light ? 'rgba(24, 36, 66, 0.04)' : 'rgba(255, 255, 255, 0.028)',
      reflect: [
        `rgba(${theme.rgb}, ${light ? 0.14 : 0.16})`,
        `rgba(${theme.rgb}, 0)`
      ]
    };
  }

  window.VizTheme = { THEMES, palette, withAlpha, shade };
})();
