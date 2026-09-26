'use strict';

// 一键整理桌面（1.4.0）：分类 → 规划 →（执行在 main.js）→ 可回滚。
//
// 分类是纯扩展名规则（六类，对标 DeskBox 的分类器：快捷方式/文档/图片/媒体/压缩包，其余进其他）。
// 规划只产出「类 → 动作」的清单，绝不碰磁盘——磁盘操作全部在 main.js 的执行层走
// basketfiles.moveInto 的既有管线（保护集、跨卷回退都在那边）。这样整个决策面都能 node --test。
//
// 规划的三条产品规则（学 DeskBox 的克制）：
//   1. 一类至少凑够 2 项才值得单独建筐；
//   2. 够格的类最多新建 4 个筐（按数量从多到少取），落选的和零散项并进「其他」；
//   3. 「其他」也要够 2 项才建筐；哪里都凑不够 2 项就报告「没什么可整理」。
// 已有同名筐直接复用（往里加），不重复建。
//
// 回滚：执行层每成功移一个文件就记一条 { from, to }；undoPlan 按当前盘面算出
// 哪些还能原路搬回去（to 还在、from 位置空着）——纯函数，方便单测。

const baskets = require('./baskets');

const CATEGORIES = [
  { id: 'shortcut', name: '快捷方式', exts: ['.lnk', '.url', '.appref-ms', '.deskbasketlink'] },
  { id: 'doc', name: '文档', exts: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.csv', '.rtf', '.epub'] },
  { id: 'image', name: '图片', exts: ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico', '.psd', '.heic'] },
  { id: 'media', name: '媒体', exts: ['.mp3', '.wav', '.flac', '.m4a', '.ape', '.ogg', '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv'] },
  { id: 'archive', name: '程序与安装包', exts: ['.zip', '.rar', '.7z', '.tar', '.gz', '.exe', '.msi', '.apk', '.iso', '.torrent'] }
];
const OTHER_ID = 'other';
const OTHER_NAME = '其他';
const OTHER = { id: OTHER_ID, name: OTHER_NAME, exts: [] };

const MIN_GROUP = 2;    // 一类少于这个数不单独建筐
const MAX_NEW = 4;      // 一次整理最多新建几个筐

const CATEGORY_BY_ID = new Map([...CATEGORIES, OTHER].map((c) => [c.id, c]));

// 按文件名分类（大小写不敏感；没有扩展名/认不出的进「其他」）。目录不归这里管，
// 调用方在扫描阶段就该把目录摘出去（桌面上的文件夹保持原位）。
function classifyName(name) {
  const lowered = String(name || '').toLowerCase();
  const dot = lowered.lastIndexOf('.');
  if (dot <= 0) return OTHER_ID;             // 无扩展名（或 .gitignore 这类点开头文件）
  const ext = lowered.slice(dot);
  for (const category of CATEGORIES) {
    if (category.exts.includes(ext)) return category.id;
  }
  return OTHER_ID;
}

// entries: [{ path, name, isDir, missing, reason? }]——main 扫描桌面后逐个给判定标记，
// 规划器只信标记不碰磁盘：
//   isDir        → 桌面上的文件夹保持原位（skip: 'dir'）
//   missing      → 登记悬空/文件不可达（skip: 'missing'）
//   registered   → 已经是 Dock 条目或别的筐的成员（skip: 'registered'，动了会弄坏那边的登记）
//   hidden       → 隐藏/系统文件（skip: 'hidden'）
// 返回 { groups, skipped }：
//   groups: [{ id, name, count, items: [entry], action: 'create'|'reuse', basketId? }]
//           （count >= MIN_GROUP 的才出现；other 同理）
//   skipped: [{ path, name, reason }]——预览窗要给「为什么没动我的文件」一个交代
function planOrganization(entries, existingBaskets = []) {
  const grouped = new Map(CATEGORIES.map((c) => [c.id, []]));
  grouped.set(OTHER_ID, []);
  const skipped = [];
  for (const entry of entries || []) {
    if (entry.isDir) { skipped.push({ ...entry, reason: 'dir' }); continue; }
    if (entry.missing) { skipped.push({ ...entry, reason: 'missing' }); continue; }
    if (entry.registered) { skipped.push({ ...entry, reason: 'registered' }); continue; }
    if (entry.hidden) { skipped.push({ ...entry, reason: 'hidden' }); continue; }
    grouped.get(classifyName(entry.name)).push(entry);
  }

  // 够格的类按数量从多到少排，取前 MAX_NEW 个单独建筐；其余全部并进「其他」池
  const eligible = CATEGORIES
    .map((c) => ({ category: c, items: grouped.get(c.id) }))
    .filter((g) => g.items.length >= MIN_GROUP)
    .sort((a, b) => b.items.length - a.items.length || a.category.name.localeCompare(b.category.name, 'zh-Hans-CN'));
  const own = eligible.slice(0, MAX_NEW);
  const cappedIds = new Set(own.map((g) => g.category.id));
  // 没排上自家筐的类（不够 2 项的 + 排位在 MAX_NEW 之后的）全部并进「其他」
  const rest = CATEGORIES
    .filter((c) => !cappedIds.has(c.id))
    .reduce((acc, c) => acc.concat(grouped.get(c.id)), []);
  const otherItems = [...rest, ...grouped.get(OTHER_ID)];

  const taken = new Set((existingBaskets || []).map((b) => b.name));
  const byName = new Map((existingBaskets || []).map((b) => [b.name, b]));
  const groups = [];

  for (const { category, items } of own) {
    groups.push(makeGroup(category, items, byName, taken));
  }
  if (otherItems.length >= MIN_GROUP) {
    groups.push(makeGroup(OTHER, otherItems, byName, taken));
  }
  return { groups, skipped };
}

function makeGroup(category, items, byName, taken) {
  const existing = byName.get(category.name);
  if (existing) {
    return { id: category.id, name: category.name, count: items.length, items, action: 'reuse', basketId: existing.id };
  }
  // 建新筐：名字就是类名；若类名被别的筐占了（理论上不会——taken 来自同名复用检查）
  // 就让 createBasket 在 main 执行层去重，这里只标记意图
  taken.add(category.name);
  return { id: category.id, name: category.name, count: items.length, items, action: 'create' };
}

// 撤销计划：records 是执行时记下的 [{ from, to }]。现在还能不能原路搬回去，
// 逐条问注入的 exists：to 还在才搬得回来；from 已被别的文件占位就不搬（避免覆盖）。
// 返回可行的撤销步骤；main 执行时逐条 moveInto(from 方向)。
function undoPlan(records, exists) {
  const steps = [];
  for (const record of records || []) {
    if (!record || !record.from || !record.to) continue;
    if (!exists(record.to)) continue;        // 目标没了（用户又动过）——这条放弃
    if (exists(record.from)) continue;       // 原位已被占用——不敢覆盖
    steps.push({ from: record.to, to: record.from });
  }
  return steps;
}

module.exports = {
  CATEGORIES,
  OTHER,
  OTHER_ID,
  MIN_GROUP,
  MAX_NEW,
  classifyName,
  planOrganization,
  undoPlan,
  assignColorForTests: baskets.assignColor
};
