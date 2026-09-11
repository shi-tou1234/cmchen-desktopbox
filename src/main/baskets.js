'use strict';

// 筐数据模型：只登记路径，绝不移动/删除/改名/改属性磁盘上的文件。纯函数、可单测。

const { normalizePath, pathKey } = require('./store');

const BASKET_NAME_MAX = 24;
const NAME_FALLBACK = '新筐';
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
  const existing = new Set((baskets || []).map((basket) => basket.id));
  let index = 1;
  while (existing.has(`b${index}`)) index += 1;
  const basket = normalizeBasket({
    id: `b${index}`,
    name: name || `文件筐 ${index}`,
    x,
    y
  });
  return { baskets: [...(baskets || []), basket], basket };
}

function dropBasket(baskets, id) {
  return (baskets || []).filter((basket) => basket.id !== id);
}

module.exports = {
  BASKET_NAME_MAX,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  ITEM_MISSING,
  ITEM_OK,
  MAX_DIMENSION,
  MIN_HEIGHT,
  MIN_WIDTH,
  NAME_FALLBACK,
  addItem,
  createBasket,
  dropBasket,
  findBasket,
  normalizeBasket,
  normalizeBaskets,
  normalizeName,
  removeItem,
  updateItems
};
