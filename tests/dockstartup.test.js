'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { prepareDockStartup, showDockWhenReady, READY_TIMEOUT_MS } = require('../src/main/dockStartup');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(options = {}) {
  const win = new EventEmitter(), ipc = new EventEmitter();
  let destroyed = false, shownInactive = 0, shown = 0, visible = false, allowed = true;
  win.webContents = new EventEmitter();
  win.isDestroyed = () => destroyed;
  win.showInactive = () => { shownInactive++; if (!options.ignoreShowInactive) visible = true; };
  win.show = () => { shown++; visible = true; };
  win.isVisible = () => visible;
  prepareDockStartup(win, ipc, () => { if (allowed) showDockWhenReady(win); }, options);
  return {
    win, ipc,
    shown: () => shownInactive,
    forced: () => shown,
    allow: (value) => { allowed = value; },
    paint: () => ipc.emit('dock:paint-ready', { sender: win.webContents }),
    loaded: () => win.webContents.emit('did-finish-load'),
    destroy: () => { destroyed = true; win.emit('closed'); }
  };
}

test('默认兜底时长 2500ms（真机冷启动里图标抽取最慢的一段都在它以内）', () => {
  assert.equal(READY_TIMEOUT_MS, 2500);
});

for (const first of ['native', 'content']) test('两端就绪才显示：' + first + ' 先到', () => {
  const f = fixture();
  assert.equal(showDockWhenReady(f.win), false);
  if (first === 'native') f.win.emit('ready-to-show'); else f.paint();
  assert.equal(f.shown(), 0);
  if (first === 'native') f.paint(); else f.win.emit('ready-to-show');
  assert.equal(f.shown(), 1);
  f.paint(); f.win.emit('ready-to-show');
  assert.equal(f.shown(), 1);
  assert.equal(f.ipc.listenerCount('dock:paint-ready'), 0);
});

test('ready-to-show 缺席时 did-finish-load 兜底原生就绪', () => {
  const f = fixture();
  f.loaded();
  assert.equal(f.shown(), 0);          // 只有原生侧就绪，内容还没到
  assert.equal(f.win.__dockPaintReady, false);
  f.paint();
  assert.equal(f.shown(), 1);
  assert.equal(f.win.__dockReadyReason, 'both');
});

test('内容迟迟不就绪：超时强制放行，不留永久隐藏的窗口', async () => {
  const f = fixture({ timeoutMs: 20 });
  f.win.emit('ready-to-show');         // 原生就绪、内容永远不到
  assert.equal(f.shown(), 0);
  await sleep(60);
  assert.equal(f.win.__dockPaintReady, true);
  assert.equal(f.win.__dockReadyReason, 'timeout');
  assert.equal(f.shown(), 1);
  assert.equal(f.ipc.listenerCount('dock:paint-ready'), 0);
  // 迟到的内容信号不应再触发第二次显示
  f.paint();
  assert.equal(f.shown(), 1);
});

test('两端都没到也超时放行（登录冷启动两个信号一起丢的极端情况）', async () => {
  const f = fixture({ timeoutMs: 20 });
  await sleep(60);
  assert.equal(f.win.__dockPaintReady, true);
  assert.equal(f.shown(), 1);
});

test('showInactive 落空时补一次 show()（DWM 忽略冷启动窗的真实表现）', () => {
  const f = fixture({ ignoreShowInactive: true });
  f.paint(); f.win.emit('ready-to-show');
  assert.equal(f.shown(), 1);          // showInactive 数过
  assert.equal(f.forced(), 1);         // 但没真可见 → 补 show()
  assert.equal(f.win.isVisible(), true);
});

test('正常可见时不做多余的 show()（避免多抢一次合成层）', () => {
  const f = fixture();
  f.paint(); f.win.emit('ready-to-show');
  assert.equal(f.shown(), 1);
  assert.equal(f.forced(), 0);
});

test('其他窗口不能放行 Dock 首帧', () => {
  const f = fixture(); f.win.emit('ready-to-show');
  f.ipc.emit('dock:paint-ready', { sender: {} });
  assert.equal(f.shown(), 0); f.paint(); assert.equal(f.shown(), 1);
});

test('专注/手动隐藏期间就绪不显示，之后可正常唤出', () => {
  const f = fixture(); f.allow(false); f.paint(); f.win.emit('ready-to-show');
  assert.equal(f.shown(), 0); assert.equal(f.win.__dockPaintReady, true);
  f.allow(true); assert.equal(showDockWhenReady(f.win), true); assert.equal(f.shown(), 1);
});

test('首帧未完成就关闭：清理监听与超时定时器，不显示已销毁窗口', () => {
  const f = fixture({ timeoutMs: 20 }); f.destroy(); f.paint(); f.win.emit('ready-to-show');
  assert.equal(f.shown(), 0); assert.equal(f.ipc.listenerCount('dock:paint-ready'), 0);
  assert.equal(showDockWhenReady(f.win), false); assert.equal(showDockWhenReady(null), false);
});
