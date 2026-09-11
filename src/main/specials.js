'use strict';

// Dock 上的系统虚拟项：此电脑、回收站。
//
// 它们没有磁盘路径，所以单独用一个 id 列表存在配置里（dock_specials），
// 不混进按路径存/校验的 dock_items：
//   - 图标：靠 shell 解析名换成 PIDL 再去问 shell。
//     注意 SHGetFileInfo 不认 `::{CLSID}` 字符串，必须走 SHParseDisplayName；
//   - 打开：交给 ShellExecute 的 shell: URI。
//
// 与 store / dockmodel 互不依赖，避免出现 require 环。

const DOCK_SPECIALS = [
  {
    id: 'thispc',
    label: '此电脑',
    parsingName: '::{20D04FE0-3AEA-1069-A2D8-08002B30309D}',
    openUri: 'shell:MyComputerFolder'
  },
  {
    id: 'recyclebin',
    label: '回收站',
    parsingName: '::{645FF040-5081-101B-9F08-00AA002F954E}',
    openUri: 'shell:RecycleBinFolder'
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

module.exports = { DOCK_SPECIALS, SPECIAL_IDS, findSpecial, normalizeSpecials };
