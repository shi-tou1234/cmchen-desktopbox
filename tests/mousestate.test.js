'use strict';

// 全局鼠标状态（拖拽判定）的纯逻辑单测：只测协议解析与"问不到时的兜底"，
// PowerShell 那段循环属于真机行为（见 PROGRESS 里的拖拽复现记录）。

const test = require('node:test');
const assert = require('node:assert');

const mouseState = require('../src/main/mouseState');

test('报数行解析：按下位图与桌面标记', () => {
  assert.deepStrictEqual(mouseState.parseReport('0:0'), { held: false, overDesktop: false });
  assert.deepStrictEqual(mouseState.parseReport('1:0'), { held: true, overDesktop: false });
  assert.deepStrictEqual(mouseState.parseReport('2:0'), { held: true, overDesktop: false });
  assert.deepStrictEqual(mouseState.parseReport('3:1'), { held: true, overDesktop: true });
});

test('报数行解析：容忍空白与 CRLF，不认识的行返回 null', () => {
  assert.deepStrictEqual(mouseState.parseReport('  0:1 \r'), { held: false, overDesktop: true });
  assert.strictEqual(mouseState.parseReport(''), null);
  assert.strictEqual(mouseState.parseReport(undefined), null);
  assert.strictEqual(mouseState.parseReport('1'), null);
  assert.strictEqual(mouseState.parseReport('1:2'), null);
  assert.strictEqual(mouseState.parseReport('abc:0'), null);
});

test('问不到状态时（没起进程）一律退回"没有拖拽"，不改变老行为', () => {
  mouseState.stop();
  const state = mouseState.poll();
  assert.strictEqual(state.known, false);
  assert.strictEqual(state.held, false);
  assert.strictEqual(state.overDesktop, false);
  assert.strictEqual(state.grace, false);
});

test('stop 可以重复调用', () => {
  mouseState.stop();
  mouseState.stop();
  assert.strictEqual(mouseState.poll().held, false);
});

test('常量：轮询间隔要明显短于"状态过期"的判定窗口', () => {
  assert.ok(mouseState.POLL_MS > 0);
  assert.ok(mouseState.POLL_MS * 2 <= mouseState.LINE_FRESH_MS);
  assert.ok(mouseState.START_GRACE_MS >= mouseState.POLL_MS);
});
