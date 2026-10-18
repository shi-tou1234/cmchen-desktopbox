'use strict';

// 置顶助手（zorder.js）的纯逻辑单测（node --test，不碰 Electron、不起 PowerShell）。
//
// 钉住三件事：
//   ①命令行的拼法（hwnd 原样透传、TOP/UNTOP 两个词——拼错一个字符，回音就永远等不到，
//     表现为"抬升悄悄没生效"，只有真机能发现）；
//   ②回音协议的解析（READY / OK / ERR 三种都得认；认不出的行必须返回 null，
//     不能把乱码当成"已经置顶"）；
//   ③main.js 的接线（setDockTopmost 走 Electron + zorder 双路、退出时收进程——
//     用源码文本钉住，与 tests/keyhold.test.js 同一个路子）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const zorder = require('../src/main/zorder');

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');

function functionBody(source, name) {
  const at = source.indexOf(`function ${name}(`);
  if (at < 0) return '';
  let depth = 0;
  let opened = false;
  for (let i = at; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') {
      depth += 1;
      opened = true;
      continue;
    }
    if (ch === '}' && opened) {
      depth -= 1;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  return '';
}

test('commandLine 把 hwnd 原样透传，TOP/UNTOP 两词写死', () => {
  assert.strictEqual(zorder.commandLine('123456', true), 'TOP 123456');
  assert.strictEqual(zorder.commandLine('123456', false), 'UNTOP 123456');
  // 句柄是十进制字符串（windowLayer.handleOf 给什么就传什么），不许加前缀/进制转换
  assert.strictEqual(zorder.commandLine('67410', true), 'TOP 67410');
  assert.strictEqual(zorder.commandLine(67410, true), 'TOP 67410');
});

test('parseReply 认得 READY / OK / ERR', () => {
  assert.deepStrictEqual(zorder.parseReply('DESKBASKET_Z READY'), { ready: true });
  assert.deepStrictEqual(zorder.parseReply('DESKBASKET_Z OK 1'), { ok: true, top: true, err: 0 });
  assert.deepStrictEqual(zorder.parseReply('DESKBASKET_Z OK 0'), { ok: true, top: false, err: 0 });
  assert.deepStrictEqual(zorder.parseReply('DESKBASKET_Z ERR 5 0'), { ok: false, top: false, err: 5 });
  // 行首带别的字符（PowerShell 偶尔会加前导空白）也得认得出
  assert.deepStrictEqual(zorder.parseReply('  DESKBASKET_Z OK 1'), { ok: true, top: true, err: 0 });
});

test('parseReply 认不出的行返回 null，不许猜成"已置顶"', () => {
  assert.strictEqual(zorder.parseReply(''), null);
  assert.strictEqual(zorder.parseReply(null), null);
  assert.strictEqual(zorder.parseReply('some noise'), null);
  assert.strictEqual(zorder.parseReply('DESKBASKET_Z'), null);
  assert.strictEqual(zorder.parseReply('DESKBASKET_Z OK'), null);          // 少了置顶位
  assert.strictEqual(zorder.parseReply('DESKBASKET_Z ERR 5'), null);       // 少了置顶位
  assert.strictEqual(zorder.parseReply('DESKBASKET_Z WEIRD 1'), null);
});

test('main.js 的 setDockTopmost：Electron 异步重置（输入）+ zorder（可见）双路，带去重节流', () => {
  const body = functionBody(MAIN_SOURCE, 'setDockTopmost');
  assert.ok(body, 'setDockTopmost 函数体没找到');
  assert.ok(body.includes('zorder.apply'), 'zorder 直连 SetWindowPos 保证物理置顶');
  assert.ok(body.includes('windowLayer.handleOf'), '要拿真实句柄发给助手');
  assert.ok(body.includes('zorderSent'), '同状态 3s 内不重复发（节流）');
  // 输入靠 Electron 自己的抬升（Chromium 用自家窗口树派发鼠标事件），失同步的窗口上
  // 同步 set(true) 会静默失效，所以翻转那一拍要 false→隔回合→true 强制账本重新下发
  assert.ok(body.includes('setTimeout'), '账本重置要隔一个事件循环回合再下发');
  assert.ok(body.includes('setAlwaysOnTop'), 'Electron 的置顶路不能删（渲染层输入靠它）');
});

test('常驻模式不再做桌面层逐步下沉（失同步总根源，两个真机 bug 的元凶）', () => {
  // applyDockLayerMode 与 createDockWindow 里对 placeDockOnDesktopLayer 的调用都必须停用：
  // 外部 SetWindowPos 走链会把 Electron 置顶账本搞失同步（peek 抬不起来），
  // 并让渲染层收不到 DOM 鼠标事件（能显示但点不动）
  const layer = functionBody(MAIN_SOURCE, 'applyDockLayerMode');
  assert.ok(layer, 'applyDockLayerMode 函数体没找到');
  assert.ok(!/^\s*placeDockOnDesktopLayer\(/m.test(layer), 'applyDockLayerMode 里不许再调下沉');
  const create = functionBody(MAIN_SOURCE, 'createDockWindow');
  assert.ok(create, 'createDockWindow 函数体没找到');
  assert.ok(!/^\s*if \(!autoHide\) placeDockOnDesktopLayer/m.test(create), 'createDockWindow 里不许再调下沉');
});

test('退出路径会收掉 zorder 助手进程', () => {
  assert.ok(/zorder\.stop\(\)/.test(MAIN_SOURCE), 'will-quit 里必须调 zorder.stop()');
});
