'use strict';

// 筐数据模型：只登记路径，绝不移动/删除/改名/改属性磁盘上的文件。纯函数、可单测。

const { normalizePath, pathKey } = require('./store');

const BASKET_NAME_MAX = 24;
const NAME_FALLBACK = '新筐';

// 每个筐一个主色：Dock 上多个文件夹筐共用同一张文件夹图时一眼分不清是谁，
// 给图标渐变和下面的筐名都染上这个颜色就能区分。按 id 稳定分配（见 assignColor），
// 删掉一个筐不会让其它筐的颜色跟着变。
const BASKET_PALETTE = [
  '#e8973a', // 琥珀（默认，最接近原来那张金色文件夹）
  '#4c8dff', // 蓝
  '#38b48b', // 青绿
  '#d05c7a', // 玫红
  '#9b6cd6', // 紫
  '#c9a227', // 金
  '#4bb0c4', // 天青
  '#e0714f'  // 珊瑚
];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// 64 位 FNV-1a 风格散列（够用即可，只为把 id 均匀映射到色板下标）。
function hashId(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// 给定 id 和「这一批里已经用掉的颜色」，选一个：散列命中就用它，撞色就顺延到色板里第一个没用的。
// 纯函数，不依赖 id 顺序以外的东西，所以删筐不会改变留下来的筐的颜色。
function assignColor(id, taken) {
  const list = BASKET_PALETTE;
  const start = hashId(String(id)) % list.length;
  if (!taken.has(list[start])) return list[start];
  for (let step = 1; step < list.length; step += 1) {
    const candidate = list[(start + step) % list.length];
    if (!taken.has(candidate)) return candidate;
  }
  return list[start];
}

function isValidColor(raw) {
  return typeof raw === 'string' && COLOR_RE.test(raw) ? raw.toLowerCase() : null;
}

const DEFAULT_WIDTH = 420;
const DEFAULT_HEIGHT = 300;
const MIN_WIDTH = 200;
const MIN_HEIGHT = 140;
const MAX_DIMENSION = 4000;

const ITEM_OK = 'ok';
const ITEM_MISSING = 'missing';

function coerceDimension(value, fallback, minimum) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  if (value < minimum) return minimum;
  if (value > MAX_DIMENSION) return MAX_DIMENSION;
  return value;
}

function coerceCoord(value, fallback) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  if (Math.abs(value) > MAX_DIMENSION * 8) return fallback;
  return value;
}

function normalizeName(raw, fallback = NAME_FALLBACK) {
  if (typeof raw !== 'string') return fallback;
  const text = raw.trim();
  if (!text) return fallback;
  return text.slice(0, BASKET_NAME_MAX);
}

function normalizeBasket(raw, fallbackId = 'b1') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let id = typeof raw.id === 'string' && raw.id.trim() ? raw.id : fallbackId;
  const items = [];
  const seen = new Set();
  if (Array.isArray(raw.items)) {
    for (const entry of raw.items) {
      const value = normalizePath(entry);
      if (!value) continue;
      const key = pathKey(value);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(value);
    }
  }
  return {
    id,
    name: normalizeName(raw.name),
    x: coerceCoord(raw.x, 80),
    y: coerceCoord(raw.y, 80),
    w: coerceDimension(raw.w, DEFAULT_WIDTH, MIN_WIDTH),
    h: coerceDimension(raw.h, DEFAULT_HEIGHT, MIN_HEIGHT),
    visible: typeof raw.visible === 'boolean' ? raw.visible : true,
    // 颜色先保留用户已有的合法值；缺失/非法时置 null，交给 normalizeBaskets 统一分配
    color: isValidColor(raw.color),
    items
  };
}

function normalizeBaskets(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const used = new Set();
  raw.forEach((entry, index) => {
    const basket = normalizeBasket(entry, `b${index + 1}`);
    if (!basket) return;
    let candidate = basket.id;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${basket.id}-${suffix}`;
      suffix += 1;
    }
    basket.id = candidate;
    used.add(candidate);
    out.push(basket);
  });
  // 补齐颜色：已有的合法颜色不动（保住用户看到的稳定色），缺色的按 id 从色板取一个没被占用的。
  // 先扫一遍收集已用色，保证同一批里不重色。
  const taken = new Set(out.map((basket) => basket.color).filter(Boolean));
  for (const basket of out) {
    if (basket.color) continue;
    basket.color = assignColor(basket.id, taken);
    taken.add(basket.color);
  }
  return out;
}

function findBasket(baskets, id) {
  return (baskets || []).find((basket) => basket.id === id) || null;
}

// 结果："added" / "duplicate" / "invalid"
function addItem(basket, rawPath) {
  const value = normalizePath(rawPath);
  if (!value) return { basket, result: 'invalid' };
  const key = pathKey(value);
  const items = basket.items || [];
  if (items.some((item) => pathKey(item) === key)) return { basket, result: 'duplicate' };
  return { basket: { ...basket, items: [...items, value] }, result: 'added' };
}

function removeItem(basket, rawPath) {
  const key = pathKey(rawPath || '');
  return {
    ...basket,
    items: (basket.items || []).filter((item) => pathKey(item) !== key)
  };
}

function updateItems(basket, items) {
  return { ...basket, items: [...items] };
}

function createBasket(baskets, name, x = 80, y = 80) {
  const list = baskets || [];
  const existing = new Set(list.map((basket) => basket.id));
  let index = 1;
  while (existing.has(`b${index}`)) index += 1;
  const taken = new Set(list.map((basket) => basket.color).filter(Boolean));
  const basket = normalizeBasket({
    id: `b${index}`,
    name: name || `文件筐 ${index}`,
    x,
    y
  });
  basket.color = assignColor(basket.id, taken);
  return { baskets: [...list, basket], basket };
}

function dropBasket(baskets, id) {
  return (baskets || []).filter((basket) => basket.id !== id);
}

module.exports = {
  BASKET_NAME_MAX,
  BASKET_PALETTE,
  COLOR_RE,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  ITEM_MISSING,
  ITEM_OK,
  MAX_DIMENSION,
  MIN_HEIGHT,
  MIN_WIDTH,
  NAME_FALLBACK,
  addItem,
  assignColor,
  createBasket,
  dropBasket,
  findBasket,
  isValidColor,
  normalizeBasket,
  normalizeBaskets,
  normalizeName,
  removeItem,
  updateItems
};
