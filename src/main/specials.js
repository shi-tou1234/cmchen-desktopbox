'use strict';

// Dock 上的系统虚拟项：此电脑、回收站、天气。
//
// 它们没有磁盘路径，所以单独用一个 id 列表存在配置里（dock_specials），
// 不混进按路径存/校验的 dock_items：
//   - 图标：靠 shell 解析名换成 PIDL 再去问 shell。
//     注意 SHGetFileInfo 不认 `::{CLSID}` 字符串，必须走 SHParseDisplayName；
//   - 打开：交给 ShellExecute 的 shell: URI。
//
// 「天气」是 Windows 自带的天气应用（UWP），它的图标和打开落点都用
// `shell:AppsFolder\<AUMID>`——实测 SHParseDisplayName 认这个名字并给出真图标，
// 所以它跟另外两项走同一条链路，只是 kind 是 weather：渲染层要额外贴气温、
// 悬停要出预报卡片（见 main.js 的天气服务与 dock.js）。
//
// 与 store / dockmodel 互不依赖，避免出现 require 环。

const WINDOWS_ID = 'windows';   // Windows 开始菜单：图标内置 SVG，打开靠模拟 Win 键
const WEATHER_ID = 'weather';
const WEATHER_APP_URI = 'shell:AppsFolder\\Microsoft.BingWeather_8wekyb3d8bbwe!App';
// 天气应用装不上/被卸掉时的兜底：MSN 天气网页（同样能看当前天气与未来几天）
const WEATHER_WEB_FALLBACK = 'https://www.msn.com/zh-cn/weather';

const DOCK_SPECIALS = [
  {
    id: WINDOWS_ID,
    label: '开始菜单',
    kind: 'start',
    parsingName: '',   // 没有 shell 解析名：图标走 special:icon 的内置 SVG，打开走键盘模拟
    openUri: ''
  },
  {
    id: 'thispc',
    label: '此电脑',
    kind: 'shell',
    parsingName: '::{20D04FE0-3AEA-1069-A2D8-08002B30309D}',
    openUri: 'shell:MyComputerFolder'
  },
  {
    id: 'recyclebin',
    label: '回收站',
    kind: 'shell',
    parsingName: '::{645FF040-5081-101B-9F08-00AA002F954E}',
    openUri: 'shell:RecycleBinFolder'
  },
  {
    id: WEATHER_ID,
    label: '天气',
    kind: 'weather',
    parsingName: WEATHER_APP_URI,
    openUri: WEATHER_APP_URI,
    webFallback: WEATHER_WEB_FALLBACK
  }
];

const SPECIAL_IDS = new Set(DOCK_SPECIALS.map((item) => item.id));

function findSpecial(id) {
  return DOCK_SPECIALS.find((item) => item.id === id) || null;
}

// 只保留认识的 id、去重、保持原顺序
function normalizeSpecials(raw) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    const id = typeof entry === 'string' ? entry : '';
    if (!SPECIAL_IDS.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

module.exports = {
  DOCK_SPECIALS,
  SPECIAL_IDS,
  WINDOWS_ID,
  WEATHER_APP_URI,
  WEATHER_ID,
  WEATHER_WEB_FALLBACK,
  findSpecial,
  normalizeSpecials
};
