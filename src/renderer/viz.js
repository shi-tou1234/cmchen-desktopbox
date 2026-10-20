'use strict';

// 音乐律动频谱（绘制窗）—— 主循环与数据，画法在 viz-painters.js，配色在 viz-theme.js。
//
// 只画不采：真实频谱来自隔壁抓取窗的 Chromium 系统音频环回（见 viz-capture.js / src/main/viz.js）。
// 抓取窗每 40ms 把 64 段 FFT 能量（0..255）推过来，这里做涨/落平滑后交给画法去画。
//
// 几条硬约束（都是真机反馈改出来的）：
//   · 不画底板：底色交给壁纸，柱子/波形直接立在一条看不见的基线上，两端渐隐；
//   · 静音时什么都不画：窗口常驻桌面层，但画布是全空的，桌上不留空条/虚线；
//   · 帧循环是 rAF + 定时器兜底：rAF 负责真正上屏，被系统掐掉时定时器维持画布内容；
//     再加上主进程关掉了 Windows 的窗口遮挡计算，桌面层窗口也不会被判成"不可见"。
//
// 可调项来自设置（viz_style / viz_theme / viz_reflect），主进程经 state:changed 广播。

const api = window.deskbasket;

const BAND_COUNT = 64;
const STALE_MS = 600;        // 超过这么久没新帧 → 当静音
const ATTACK = 0.72;         // 涨的跟随系数（大＝起得快，鼓点才"打"得出来）
const DECAY = 0.13;          // 落的跟随系数（小＝掉得慢，有余韵）
const PEAK_FALL = 0.05;      // 峰值帽下落速度
const QUIET_HOLD = 500;      // 整条安静这么久之后才开始淡出（别在鼓点间隙里闪）
const FADE_OUT_MS = 300;     // 淡出用多久

// 版式（CSS px，窗口坐标）。主进程的 VIZ_BASELINE_Y 必须等于 TOP_PAD + BAR_MAX_H
const PAD_X = 26;             // 左右留白（给两端淡出）
const TOP_PAD = 8;
const BAR_MAX_H = 86;         // 柱子最高能长多高
const GAP = 4;                // 柱子间距
const REFLECT_H = 30;         // 倒影区高度
const REFLECT_SCALE = 0.40;   // 倒影是柱高的百分之多少
const CAP_H = 2;              // 柱顶亮帽厚度
const BAR_RADIUS_RATIO = 0.5; // 柱顶圆角 = 柱宽 × 这个比例（0.5 = 半圆头）
const BLOCK_COUNT = 7;        // 电平块每一列分几段

const canvas = document.getElementById('viz');
const ctx = canvas.getContext('2d');

let bands = new Array(BAND_COUNT).fill(0);   // 最近一帧真实频谱
let bars = new Array(BAND_COUNT).fill(0);    // 平滑后的柱高（0..1）
let peaks = new Array(BAND_COUNT).fill(0);   // 峰值帽（落得比柱子慢）
let lastAt = 0;                              // 最近一帧到达时间
let revealAt = 0;                            // 淡入起点
let quietSince = 0;                          // 整条开始"安静"的时间（0 = 还在跳）
let beat = 0;                                // 低频重拍脉冲（1 → 0），给发光加一下"呼吸"
let bassAvg = 0;                             // 低频能量的慢速均值（判"这一下是不是重拍"）

// 设置项（主进程广播过来）
let config = { style: 'bars', theme: 'aurora', reflect: true };

let palette = null;
let box = null;
let gradients = null;
let loggedSize = false;
let loggedBands = false;

// 绘制窗也是"看不见"的（透明、常驻桌面层），异常时留一行日志（主进程写 viz.log）
function note(text) {
  if (api && typeof api.vizLog === 'function') api.vizLog(text);
}

// ------------------------------------------------------------------ 版式

function layout() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const innerW = Math.max(0, w - PAD_X * 2);
  const baseY = TOP_PAD + BAR_MAX_H;
  return {
    w,
    h,
    padX: PAD_X,
    gap: GAP,
    barW: Math.max(2, (innerW - GAP * (BAND_COUNT - 1)) / BAND_COUNT),
    baseY,
    maxH: BAR_MAX_H,
    centerY: TOP_PAD + BAR_MAX_H / 2,  // 对称造型的中轴
    segH: BAR_MAX_H / BLOCK_COUNT,     // 电平块每段的高度（含缝隙）
    blockCount: BLOCK_COUNT,
    capH: CAP_H,
    radiusRatio: BAR_RADIUS_RATIO,
    reflectScale: REFLECT_SCALE
  };
}

function buildGradients() {
  if (!box || !palette) return null;
  const bar = ctx.createLinearGradient(0, box.baseY, 0, box.baseY - box.maxH);
  palette.bar.forEach((color, i) => bar.addColorStop(i / (palette.bar.length - 1), color));
  // 对称柱：中轴是"根"，上下两端是"梢"——根深、梢亮，看着才像从中间长出去
  const mirror = ctx.createLinearGradient(0, box.centerY - box.maxH / 2, 0, box.centerY + box.maxH / 2);
  mirror.addColorStop(0, palette.bar[2]);
  mirror.addColorStop(0.5, palette.bar[0]);
  mirror.addColorStop(1, palette.bar[2]);
  const reflect = ctx.createLinearGradient(0, box.baseY, 0, box.baseY + REFLECT_H);
  reflect.addColorStop(0, palette.reflect[0]);
  reflect.addColorStop(1, palette.reflect[1]);
  // 两端淡出：0 → 6% 渐入，94% → 100% 渐出
  const fade = ctx.createLinearGradient(0, 0, box.w, 0);
  fade.addColorStop(0, 'rgba(0, 0, 0, 0)');
  fade.addColorStop(0.06, 'rgba(0, 0, 0, 1)');
  fade.addColorStop(0.94, 'rgba(0, 0, 0, 1)');
  fade.addColorStop(1, 'rgba(0, 0, 0, 0)');
  return { bar, mirror, reflect, fade };
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  box = layout();
  canvas.width = Math.max(1, Math.round(box.w * dpr));
  canvas.height = Math.max(1, Math.round(box.h * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // 之后一律按 CSS px 画
  gradients = buildGradients();
  if (!loggedSize) {
    loggedSize = true;
    note(`canvas ${box.w}x${box.h} dpr=${dpr}`);
  }
}

// ------------------------------------------------------------------ 数据 / 设置

if (api && typeof api.onVizBands === 'function') {
  api.onVizBands((payload) => {
    if (!Array.isArray(payload) || payload.length === 0) return;
    if (lastAt === 0) revealAt = Date.now();   // 停过一阵子后的第一帧：整条淡入
    if (!loggedBands) {
      loggedBands = true;
      let m = 0;
      for (const v of payload) if (v > m) m = v;
      note(`first bands max=${m} len=${payload.length}`);
    }
    bands = payload;
    lastAt = Date.now();
  });
}

function applyConfig(next) {
  if (!next) return;
  const changed =
    next.style !== config.style || next.theme !== config.theme || next.reflect !== config.reflect;
  config = { ...config, ...next };
  if (!changed) return;
  note(`config style=${config.style} theme=${config.theme} reflect=${config.reflect}`);
  palette = VizTheme.palette(themeQuery.matches, config.theme);
  gradients = buildGradients();
}

function configFromState(state) {
  const s = state && state.settings;
  if (!s) return;
  applyConfig({ style: s.viz_style, theme: s.viz_theme, reflect: s.viz_reflect });
}

if (api) {
  if (typeof api.getState === 'function') {
    api.getState().then(configFromState).catch(() => {});
  }
  if (typeof api.onStateChanged === 'function') {
    api.onStateChanged(configFromState);
  }
}

// ------------------------------------------------------------------ 每帧

// 高频斜率补偿：音乐的能量随频率往下掉，不做这一下右半边会一直是平的。
// 只补 30%：补太多会让整排变成一样高的"栅栏"，反而看不出旋律
function tiltOf(i) {
  return 1 + 0.3 * (i / (BAND_COUNT - 1));
}

function step(now, dt) {
  const live = lastAt > 0 && now - lastAt <= STALE_MS;
  const scale = dt / 16.7;   // 按 60fps 归一，144Hz 屏上不会掉得飞快
  let top = 0;
  for (let i = 0; i < BAND_COUNT; i++) {
    // 0..255 本来就已是"分贝线性"（getByteFrequencyData 的 -100..-30dB），所以指数取接近 1：
    // 压得太狠（0.65 那种）会把 60 分的频段抬到 80 分，整排看起来一样高，旋律感全没了
    const raw = live ? (bands[i] || 0) / 255 : 0;
    const target = live ? Math.min(1, Math.pow(raw, 0.95) * tiltOf(i)) : 0;
    const k = 1 - Math.pow(1 - (target > bars[i] ? ATTACK : DECAY), scale);
    bars[i] += (target - bars[i]) * k;
    if (bars[i] < 0.004) bars[i] = 0;
    peaks[i] = Math.max(bars[i], peaks[i] - PEAK_FALL * scale);
    if (peaks[i] < 0.01) peaks[i] = 0;
    if (bars[i] > top) top = bars[i];
  }

  // 重拍检测：低频（前 8 段）突然高于自己的慢速均值 → 打一下脉冲。
  // 只影响发光强度，不改柱高——高度跟着真实频谱走，才不会被"假拍"带跑。
  let bass = 0;
  for (let i = 0; i < 8; i++) bass += bands[i] || 0;
  bass = live ? bass / 8 / 255 : 0;
  bassAvg += (bass - bassAvg) * 0.06;
  if (live && bass > 0.28 && bass > bassAvg * 1.28) beat = 1;
  beat *= Math.pow(0.9, scale);

  // 整排都趴下（或干脆没帧了）→ 记一个起点，够久就淡出，别让一条空基线留在桌面上
  if (!live || top < 0.035) {
    if (!quietSince) quietSince = now;
  } else {
    quietSince = 0;
  }
}

function paint() {
  const { w, h } = box;
  ctx.clearRect(0, 0, w, h);
  if (w < 80 || h < 40) return;

  // 安静下来 / 刚出现时的淡入淡出
  const now = Date.now();
  let alpha = revealAt ? Math.min(1, (now - revealAt) / 200) : 1;
  if (quietSince) {
    const quietFor = now - quietSince;
    if (quietFor > QUIET_HOLD) alpha *= Math.max(0, 1 - (quietFor - QUIET_HOLD) / FADE_OUT_MS);
  }
  if (alpha <= 0.002) return;

  ctx.save();
  ctx.globalAlpha = alpha;

  const view = { ctx, box, bars, peaks, palette, gradients, config, beat };
  if (config.style === 'mirror') VizPainters.bars(view, true);
  else if (config.style === 'dots') VizPainters.dots(view);
  else if (config.style === 'blocks') VizPainters.blocks(view);
  else if (config.style === 'line') VizPainters.line(view, VizTheme.withAlpha);
  else VizPainters.bars(view, false);

  // 两端淡出：destination-in 用横向渐变当遮罩，连发光一起收干净
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = gradients.fade;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';

  ctx.restore();
}

let prevAt = 0;
function tick() {
  const ts = performance.now();
  const dt = prevAt ? Math.min(48, ts - prevAt) : 16.7;
  prevAt = ts;
  step(Date.now(), dt);
  paint();
}

// rAF 主导：只有它能稳定拿到合成帧（画面真的刷到屏幕上）。
// 但窗口被应用盖住时 Chromium 可能把 rAF 停掉，所以再挂一个定时器兜底——
// 超过 400ms 没出过帧就自己 tick 一次，保证画布内容不会烂在几秒前。
let lastRafAt = 0;
function frame() {
  lastRafAt = performance.now();
  tick();
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ 启动

document.addEventListener('visibilitychange', () => {
  // 窗口被重新显示（桌面露出来）时重设淡入起点，不然会把"藏着时跑完的淡入"直接硬切出来
  if (!document.hidden) revealAt = Date.now();
  note(`page ${document.hidden ? 'hidden' : 'visible'}`);
});

const themeQuery = window.matchMedia('(prefers-color-scheme: light)');
function syncTheme() {
  palette = VizTheme.palette(themeQuery.matches, config.theme);
  gradients = buildGradients();
}
themeQuery.addEventListener('change', syncTheme);

syncTheme();
window.addEventListener('resize', resize);
resize();
requestAnimationFrame(frame);
setInterval(() => {
  if (performance.now() - lastRafAt < 400) return;   // rAF 还活着：交给它，别抢帧
  tick();
}, 250);
