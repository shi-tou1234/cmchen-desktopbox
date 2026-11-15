'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { prepareDockStartup, showDockWhenReady } = require('../src/main/dockStartup');

function fixture() {
  const win = new EventEmitter(), ipc = new EventEmitter();
  let destroyed = false, shown = 0, allowed = true;
  win.webContents = {};
  win.isDestroyed = () => destroyed;
  win.showInactive = () => shown++;
  prepareDockStartup(win, ipc, () => { if (allowed) showDockWhenReady(win); });
  return { win, ipc, shown: () => shown, allow: value => { allowed = value; },
    paint: () => ipc.emit('dock:paint-ready', { sender: win.webContents }),
    destroy: () => { destroyed = true; win.emit('closed'); } };
}

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

test('首帧未完成就关闭：清理监听，不显示已销毁窗口', () => {
  const f = fixture(); f.destroy(); f.paint(); f.win.emit('ready-to-show');
  assert.equal(f.shown(), 0); assert.equal(f.ipc.listenerCount('dock:paint-ready'), 0);
  assert.equal(showDockWhenReady(f.win), false); assert.equal(showDockWhenReady(null), false);
});
