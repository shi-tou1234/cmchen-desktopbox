'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const frame = require('../src/main/windowFrame');

test('去边框命令只发 FRAME <hwnd>，空句柄不发', () => {
  assert.equal(frame.commandLine(123), 'FRAME 123');
  assert.equal(frame.commandLine('657622'), 'FRAME 657622');
});

test('助手回音解析：READY / OK / ERR 都认得，其余一律忽略', () => {
  assert.deepEqual(frame.parseReply('DESKBASKET_F READY'), { ready: true });
  assert.deepEqual(frame.parseReply('DESKBASKET_F OK'), { ok: true, err: 0 });
  assert.deepEqual(frame.parseReply('  DESKBASKET_F ERR 8  '), { ok: false, err: 8 });
  assert.equal(frame.parseReply(''), null);
  assert.equal(frame.parseReply(null), null);
  assert.equal(frame.parseReply('随便一行'), null);
  assert.equal(frame.parseReply('DESKBASKET_F'), null);
});

test('没有窗口/非 Windows 时直接返回 false，不起进程', async () => {
  assert.equal(await frame.clearBorder(null), false);
  assert.equal(await frame.clearBorder({ isDestroyed: () => true }), false);
});
