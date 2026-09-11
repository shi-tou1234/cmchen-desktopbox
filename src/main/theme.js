'use strict';

// 深浅色主题的纯逻辑：把「壁纸亮度」这个输入换算成该用深色还是浅色配色。
// 不依赖 Electron / 文件系统——壁纸像素由主进程取好后传进来，这里只做判断，可直接单测。
//
// 背景：页面原本写死浅色字（#f2f2f6）配深色底。完全透明模式下，如果桌面壁纸本身很亮，
// 浅色字压在浅色壁纸上就几乎看不清。所以按壁纸亮度在深/浅两套配色之间切，
// 也允许用户在设置里手动固定。

const THEME_MODES = ['auto', 'dark', 'light'];

// 亮度阈值：0..255 的平均感知亮度超过这条线就算「浅色壁纸」。
// 140 大致对应中偏亮的灰白；实测壁纸多在 60（深色夜景）与 200（浅色纯色）两端，落在中间不常见。
const LIGHT_THRESHOLD = 140;

// 从 RGBA 像素缓冲算平均感知亮度（BT.709 权重）。非 RGBA 输入给 null，让调用方退回默认。
function luminanceFromRgba(buffer, width, height) {
  if (!buffer || !width || !height) return null;
  const pixels = width * height;
  if (pixels <= 0 || buffer.length < pixels * 4) return null;
  let sum = 0;
  for (let i = 0; i < pixels; i += 1) {
    const offset = i * 4;
    const r = buffer[offset];
    const g = buffer[offset + 1];
    const b = buffer[offset + 2];
    sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  return sum / pixels;
}

// 主题决策：auto 按亮度切（拿不到亮度就退回深色，与历史行为一致）；dark/light 强制。
function resolveTheme(mode, luminance) {
  if (mode === 'light') return 'light';
  if (mode === 'dark') return 'dark';
  // auto
  if (typeof luminance !== 'number' || !Number.isFinite(luminance)) return 'dark';
  return luminance >= LIGHT_THRESHOLD ? 'light' : 'dark';
}

module.exports = {
  LIGHT_THRESHOLD,
  THEME_MODES,
  luminanceFromRgba,
  resolveTheme
};
