'use strict';

// 天气图形：主进程给的天气代码 → 一张小 SVG。
// 两个页面共用：Dock（真图标取不到时的兜底方块）与悬浮的预报卡片（每天一行的小图形）。
// 为什么自绘：卡片只有 24px 的位置放图形，用系统图标既拿不到、也没法按天气代码挑；
// 而 Dock 上的天气图标优先用 Windows 天气应用的真图标（见 dock.js 的 getSpecialIcon）。

window.weatherIcons = (() => {
  const SUN = '#ffc83d';
  const SUN_DEEP = '#f39c12';
  const CLOUD_LIGHT = '#f4f6fb';
  const CLOUD = '#d5dbe7';
  const CLOUD_DARK = '#aab2c4';
  const RAIN = '#5fb0ff';
  const SNOW = '#d6ecff';
  const BOLT = '#ffd23f';
  const MOON = '#e9eefb';

  // Feather 那朵云的轮廓：填充出来就是一朵正经的云（y 约 5~19）
  const CLOUD_PATH = 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z';

  function cloud(fill, transform) {
    const open = transform ? `<g transform="${transform}">` : '<g>';
    return `${open}<path d="${CLOUD_PATH}" fill="${fill}"/></g>`;
  }

  // 云整体上移一点，给下面的雨/雪/雷让出位置
  function cloudUp(fill, transform) {
    const t = `translate(0,-2.2)${transform ? ' ' + transform : ''}`;
    return cloud(fill, t);
  }

  function svg(body) {
    return (
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}</svg>`
      )
    );
  }

  const GLYPHS = {
    // 晴：一个太阳
    clear:
      `<circle cx="12" cy="12" r="4.3" fill="${SUN}"/>` +
      `<g stroke="${SUN}" stroke-width="1.7" stroke-linecap="round">` +
      '<path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2' +
      'M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/></g>',
    // 晴（夜）：月亮
    'clear-night': `<path d="M20.3 14.9A8.6 8.6 0 0 1 9.1 3.7 8.6 8.6 0 1 0 20.3 14.9z" fill="${MOON}"/>`,
    // 晴间多云：小太阳 ＋ 一朵云
    'mostly-clear':
      `<circle cx="8.6" cy="7.6" r="3.6" fill="${SUN}"/>` +
      `<g stroke="${SUN}" stroke-width="1.4" stroke-linecap="round">` +
      '<path d="M8.6 2.2v1.5M3.2 7.6h1.5M5.2 4.2l1.1 1.1M12 4.2l-1.1 1.1"/></g>' +
      cloud(CLOUD_LIGHT, 'translate(2.6,4.4) scale(0.82)'),
    'mostly-clear-night':
      `<path d="M13.4 8.2A5.6 5.6 0 0 1 6.1 1 5.6 5.6 0 1 0 13.4 8.2z" fill="${MOON}"/>` +
      cloud(CLOUD, 'translate(2.6,4.4) scale(0.82)'),
    // 多云：太阳被云挡掉一半
    'partly-cloudy':
      `<circle cx="9" cy="8" r="4" fill="${SUN}"/>` +
      cloud(CLOUD_LIGHT, 'translate(1.4,3.2) scale(0.88)'),
    // 阴：两朵云叠着
    overcast:
      cloud(CLOUD_DARK, 'translate(3.4,-2.8) scale(0.78)') + cloud(CLOUD, 'translate(0,1.6)'),
    // 有雾：云 ＋ 两道横线
    fog:
      `<g transform="translate(0,-3.4)"><path d="${CLOUD_PATH}" fill="${CLOUD}"/></g>` +
      `<g stroke="${CLOUD_DARK}" stroke-width="1.8" stroke-linecap="round">` +
      '<path d="M4 19.4h16M6.6 22.4h10.8"/></g>',
    // 毛毛雨：云 ＋ 三个点
    drizzle:
      cloudUp(CLOUD) +
      `<g fill="${RAIN}"><circle cx="9" cy="20" r="1.15"/><circle cx="13" cy="21.4" r="1.15"/>` +
      '<circle cx="17" cy="20" r="1.15"/></g>',
    // 雨：云 ＋ 三根短斜线
    rain:
      cloudUp(CLOUD) +
      `<g stroke="${RAIN}" stroke-width="1.8" stroke-linecap="round">` +
      '<path d="M9 18.8l-.9 2.6M13 18.8l-.9 2.6M17 18.8l-.9 2.6"/></g>',
    // 阵雨：斜得更厉害的雨
    showers:
      cloudUp(CLOUD) +
      `<g stroke="${RAIN}" stroke-width="1.8" stroke-linecap="round">` +
      '<path d="M9 18.4l-1.5 3M13.4 18.4l-1.5 3M17.8 18.4l-1.5 3"/></g>',
    // 雪：云 ＋ 三片雪花
    snow:
      cloudUp(CLOUD) +
      `<g stroke="${SNOW}" stroke-width="1.5" stroke-linecap="round">` +
      '<path d="M9 18.6v2.6M7.8 19.9h2.4M13 19.6v2.4M11.8 20.8h2.4M17 18.6v2.6M15.8 19.9h2.4"/></g>',
    // 阵雪：雪花 ＋ 深一点的云
    'snow-showers':
      cloudUp(CLOUD_DARK) +
      `<g stroke="${SNOW}" stroke-width="1.5" stroke-linecap="round">` +
      '<path d="M9 18.6v2.6M7.8 19.9h2.4M13 19.6v2.4M11.8 20.8h2.4M17 18.6v2.6M15.8 19.9h2.4"/></g>',
    // 雷阵雨：云 ＋ 闪电
    thunder:
      cloudUp(CLOUD_DARK) +
      `<path d="M13.4 17.6l-4.2 4.2h2.6l-1.4 3.2 4.6-4.6h-2.6z" fill="${BOLT}"/>`,
    // 认不出的代码：一朵云（不留空白，也不显示破图）
    unknown: cloud(CLOUD, 'translate(0,1.6)')
  };

  function glyph(kind) {
    const body = GLYPHS[kind] || GLYPHS.unknown;
    return svg(body);
  }

  // Dock 上的兜底方块：Windows 天气应用的真图标取不到时用它顶上
  // （橙色圆角方块 ＋ 太阳 ＋ 白云，与系统的天气应用图标同一种观感）
  function tile() {
    return svg(
      '<defs><linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">' +
        `<stop offset="0" stop-color="#ffc741"/><stop offset="1" stop-color="#ee8a15"/></linearGradient></defs>` +
        '<rect x="2" y="2" width="44" height="44" rx="11" fill="url(#tile)"/>' +
        '<circle cx="25" cy="21" r="9.5" fill="#fff0bd"/>' +
        '<path d="M31 39H18.5a7.2 7.2 0 1 1 6.9-9.3h1.8a4.6 4.6 0 1 1 0 9.3z" fill="#fdfdff"/>' +
        `<path d="M12 6.5l1.4 2.6 2.6 1.4-2.6 1.4L12 14.5l-1.4-2.6L8 10.5l2.6-1.4z" fill="${SUN_DEEP}" opacity="0.55"/>`
    );
  }

  // Dock 图标下面那行小字：'26°' ／ '26° 多云'（没数据就回空串，让位给留白）
  function caption(snapshot) {
    const current = snapshot && snapshot.current;
    if (!current || current.temperature === null || current.temperature === undefined) return '';
    const degree = Math.round(current.temperature) + '°';
    const text = String(current.text || '').trim();
    return text ? degree + ' ' + text : degree;
  }

  // 卡片里的温度：统一取整，正数不写 '+'，负数照常
  function temp(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '--';
    return String(Math.round(Number(value)));
  }

  return { caption, glyph, temp, tile };
})();
