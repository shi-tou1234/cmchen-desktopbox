'use strict';

// 弹窗里「文件夹」的外观（Kimicon 图标包）：12 张插画 = 6 个造型 × 2 个版本（宽版 / 方版）。
//
// 一条规矩：同一个弹窗里不出现两个同造型的文件夹。并排摆着时一眼能分清谁是谁，
// 否则两个一模一样的图标只会让人以为"这两个是同一类/同一个"。
// 造型用完了（一个筐里超过 6 个文件夹）才回头用同造型的另一个版本，再不够才允许完全重复。
//
// 分配结果记进配置（settings.folder_skins：绝对路径 → 皮肤下标），定了就不再变：
// 往筐里加一个新文件夹，不会把别的文件夹的图标洗牌——图标是用户拿来认路的，不能乱动。

const path = require('node:path');

const SKINS = [
  { id: 'kimi-01', family: 'jelly', label: '蓝果冻·宽' },
  { id: 'kimi-02', family: 'jelly', label: '蓝果冻·方' },
  { id: 'kimi-03', family: 'case', label: '透明收纳盒·宽' },
  { id: 'kimi-04', family: 'case', label: '透明收纳盒·方' },
  { id: 'kimi-05', family: 'handheld', label: 'KIMI 掌机·宽' },
  { id: 'kimi-06', family: 'handheld', label: 'KIMI 掌机·方' },
  { id: 'kimi-07', family: 'water', label: '水袋文件夹·宽' },
  { id: 'kimi-08', family: 'water', label: '水袋文件夹·方' },
  { id: 'kimi-09', family: 'note', label: 'KIMI NOTE·宽' },
  { id: 'kimi-10', family: 'note', label: 'KIMI NOTE·方' },
  { id: 'kimi-11', family: 'outline', label: 'KIMI 线框·宽' },
  { id: 'kimi-12', family: 'outline', label: 'KIMI 线框·方' }
];

const SKIN_COUNT = SKINS.length;

// 路径键：规范化 + 折小写（与 store 的 pathKey 同一套口径；不 require store 是为了
// 让 store 能反过来校验 folder_skins，别绕成环）
function pathKey(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text) return '';
  return path.normalize(text).toLowerCase();
}

// 下标合法才认（配置被手改坏 / 以后图标包瘦身过，都不至于画出个空图标）
function skinAt(index) {
  return Number.isInteger(index) && index >= 0 && index < SKIN_COUNT ? SKINS[index] : null;
}

// 名字散列：决定这个文件夹从哪个造型开始找。不直接用下标是怕"每个筐的第一个文件夹
// 永远是蓝果冻"——各筐的开头岔开，看起来才像一个图标包。
function startIndex(key) {
  let h = 5381;
  for (let i = 0; i < key.length; i += 1) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  return h % SKIN_COUNT;
}

// 挑一个还没被这个窗口里的别的文件夹占用的造型：
//   1) 造型没用过，且这一版（宽/方）也没用过 —— 最理想
//   2) 造型没用过（这一版被占了，用同造型的另一版）
//   3) 造型都用过了，那就挑这一版没被用过的（宁可重复造型，也别一模一样）
//   4) 全用过了：随便一个（只有在同一个文件夹里塞 12 个以上时才走到）
function pickIndex(start, usedFamilies, usedIndices) {
  for (let step = 0; step < SKIN_COUNT; step += 1) {
    const index = (start + step) % SKIN_COUNT;
    if (!usedFamilies.has(SKINS[index].family) && !usedIndices.has(index)) return index;
  }
  for (let step = 0; step < SKIN_COUNT; step += 1) {
    const index = (start + step) % SKIN_COUNT;
    if (!usedFamilies.has(SKINS[index].family)) return index;
  }
  for (let step = 0; step < SKIN_COUNT; step += 1) {
    const index = (start + step) % SKIN_COUNT;
    if (!usedIndices.has(index)) return index;
  }
  return start;
}

// 给一个视图里的文件夹分配外观。
//   saved  配置里已经存下的映射 { 绝对路径: 下标 }（可以不合法，这里会过滤）
//   paths  当前视图里所有文件夹的绝对路径
// 返回：
//   byKey   路径键 → 下标（渲染层按它取图，含这次新分配的）
//   skins   合并后的映射（有 changed 时写回配置）
//   changed 这次是否新分配了（调用方据此落盘）
function assign(saved, paths) {
  const skins = { ...(saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}) };
  const known = new Map();
  for (const [raw, index] of Object.entries(skins)) {
    const key = pathKey(raw);
    if (!key || !skinAt(index)) continue;
    known.set(key, index);
  }

  const list = [];
  const seen = new Set();
  for (const target of paths || []) {
    const key = pathKey(target);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    list.push({ path: String(target), key });
  }

  // 先把这个窗口里已经占住的造型数出来（已经分配过的文件夹保持原样）
  const usedFamilies = new Set();
  const usedIndices = new Set();
  for (const item of list) {
    const index = known.get(item.key);
    if (index === undefined) continue;
    usedIndices.add(index);
    usedFamilies.add(SKINS[index].family);
  }

  let changed = false;
  for (const item of list) {
    if (known.has(item.key)) continue;
    const index = pickIndex(startIndex(item.key), usedFamilies, usedIndices);
    usedIndices.add(index);
    usedFamilies.add(SKINS[index].family);
    known.set(item.key, index);
    skins[item.path] = index;
    changed = true;
  }

  return { byKey: known, skins, changed };
}

// 渲染层要的 id（'kimi-07'）：载荷里只传这个短名字，图片路径由页面自己拼
function idAt(index) {
  const skin = skinAt(index);
  return skin ? skin.id : '';
}

module.exports = {
  SKINS,
  SKIN_COUNT,
  assign,
  idAt,
  pathKey,
  skinAt,
  startIndex
};
