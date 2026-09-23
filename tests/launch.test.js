'use strict';

// 一键启动器的纯逻辑单测：只测"一次启动尝试怎么判读"和"判读依据与主进程日志的一致性"，
// 真机启动（进程真的起来、Dock 真的就绪）属于端到端行为，见 PROGRESS 里的实测记录。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const launch = require('../scripts/launch');

test('判读：还没结果时不猜，继续等', () => {
  assert.strictEqual(launch.verdict({ logText: '', waitedMs: 0 }), 'waiting');
  assert.strictEqual(launch.verdict({ logText: '[dock] 正在建窗口', waitedMs: 600 }), 'waiting');
});

test('判读：单实例锁那条日志优先于一切 —— 第二次启动是健康退出，绝不能报成失败', () => {
  const text = `[dock] 已就绪\n${launch.ALREADY_RUNNING_MARK}（单实例锁被占用），本次启动退出\n`;
  assert.strictEqual(launch.verdict({ logText: text, exited: true, waitedMs: 240 }), 'already');
});

test('判读：进程立刻退出且没有"已在运行"的证据 = 启动失败', () => {
  assert.strictEqual(launch.verdict({ logText: 'boom\n', exited: true, waitedMs: 300 }), 'failed');
});

test('判读：Dock 就绪的日志一到就报成功，不用等满超时', () => {
  assert.strictEqual(
    launch.verdict({ logText: `${launch.DOCK_READY_MARK}\n`, waitedMs: 200, waitMs: 4000 }),
    'ready'
  );
});

test('判读：等满超时但进程还活着 = 起来了（Dock 可能稍后才冒出来）', () => {
  assert.strictEqual(launch.verdict({ logText: '什么也没打', waitedMs: 4000, waitMs: 4000 }), 'started');
});

test('判读：日志拿不到（文件被上一轮实例占着）时不误报失败', () => {
  assert.strictEqual(launch.verdict({ logText: '', exited: false, waitedMs: 4000 }), 'started');
});

test('判读只看这次新增的日志：上一轮留下的旧标记不算数', () => {
  const stale = `老的：${launch.ALREADY_RUNNING_MARK}（单实例锁被占用），本次启动退出\n`;
  assert.strictEqual(launch.added(stale, stale.length), '');
  // 本次启动什么都没写 + 进程还在 → 只能是"起来了"，不能因为文件里躺着旧标记就说已在运行
  assert.strictEqual(
    launch.verdict({ logText: launch.added(stale, stale.length), exited: false, waitedMs: 4000 }),
    'started'
  );
  assert.strictEqual(launch.added('abc', 0), 'abc');
  assert.strictEqual(launch.added('abc', undefined), 'abc');
  // 记录的长度超过实际长度（文件被清过/轮转过）时不抛、不返回 undefined
  assert.strictEqual(launch.added('abc', 99), '');
  assert.strictEqual(launch.added(undefined, 0), '');
});

test('日志落在系统临时目录里，且沿用既有排查习惯的文件名', () => {
  const paths = launch.logPaths();
  assert.strictEqual(path.basename(paths.out), 'deskbasket-run.log');
  assert.strictEqual(path.basename(paths.err), 'deskbasket-run.err.log');
  assert.strictEqual(path.dirname(paths.out), path.dirname(paths.err));
});

test('失败时打出来的日志尾部：只留最后几行、丢掉空行', () => {
  assert.strictEqual(launch.tail('a\n\nb\nc\n', 2), 'b\nc');
  assert.strictEqual(launch.tail('a\nb', 10), 'a\nb');
  assert.strictEqual(launch.tail('', 5), '');
  assert.strictEqual(launch.tail(undefined, 5), '');
});

test('参数原样透传给应用（--settings / --user-data-dir 这些调试开关）', () => {
  assert.deepStrictEqual(launch.appArgs([]), [launch.PROJECT_ROOT]);
  assert.deepStrictEqual(launch.appArgs(['--settings']), [launch.PROJECT_ROOT, '--settings']);
});

test('两个判读标记必须仍能在主进程源码里找到', () => {
  // launch.js 判断"启动到哪一步了"的唯一接口就是这两条日志。主进程改了措辞而这里没跟着改，
  // 启动器会安静地退化成"永远等满超时"——不报错，只是再也认不出"已经在运行"。
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  assert.ok(
    source.includes(launch.ALREADY_RUNNING_MARK),
    `${launch.ALREADY_RUNNING_MARK}：主进程那条单实例日志的措辞变了`
  );
  // Dock 就绪那条是按 tag 拼的（`[${tag}] 已就绪`），所以两半分别核：那句后缀、以及 dock 这个 tag
  assert.ok(source.includes('已就绪'), '「已就绪」那句日志的措辞变了');
  assert.ok(source.includes("attachDiagnostics(win, 'dock')"), 'Dock 窗口用的日志 tag 变了');
});