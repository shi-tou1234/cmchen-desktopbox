'use strict';

// 一键启动：Windows 双击项目根目录的「启动DeskBasket.cmd」会走到这里；
// mac / Linux 直接 `node scripts/launch.js`（参数原样透传到应用）。
//
// 为什么不直接双击 electron.exe 了事：开发态的启动命令是「electron.exe ＋ 项目目录」，
// 没法双击；而套这一层真正要解决的是三件"双击之后看不出名堂"的事：
//   1. 已经在跑 —— 单实例锁会让第二次启动**静默**退出，看起来就是点了没反应。
//      而"我的 Dock 是不是没了"最容易误判的正是这种时刻，所以这里必须明说"已经在运行"。
//   2. 没装依赖 —— 说清先跑 npm install，而不是丢一句 electron 找不到。
//   3. 启动失败 —— 把这次运行的日志尾部打出来，别让人对着空气猜。
//
// 启动出来的是**分离进程**：这个黑窗口关掉之后 DeskBasket 继续活着（常驻托盘/Dock，
// 它本来就不该跟着一个窗口走）。
//
// 退出码：0 = 这次真的把应用拉起来了；2 = 已经在运行（不是错误，入口据此把消息多留几秒）；
//         1 = 启动失败（入口会停住等你看完日志尾部）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// 判断"启动走到哪一步了"的全部依据是主进程打的两条日志（src/main/main.js）：
// 单实例锁那条是字面量，Dock 就绪那条在主进程里是按 tag 拼的（`[${tag}] 已就绪`，tag='dock'）。
// 措辞改了这里必须跟着改 —— tests/launch.test.js 会拿它们回源码里核。
const ALREADY_RUNNING_MARK = '已有实例在运行';
const DOCK_READY_MARK = '[dock] 已就绪';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const POLL_MS = 120;
const WAIT_MS = 4000;
const LOG_TAIL_LINES = 12;

// 日志沿用既有排查习惯的位置与文件名（%TEMP%\deskbasket-run.log / .err.log）：
// 启动不起来时，这两个文件就是唯一的现场。
function logPaths(tmpDir = os.tmpdir()) {
  return {
    out: path.join(tmpDir, 'deskbasket-run.log'),
    err: path.join(tmpDir, 'deskbasket-run.err.log')
  };
}

// electron 包在"非 Electron 进程"里被 require 时返回可执行文件路径（开发态就是它）。
// 没装依赖时 require 抛 MODULE_NOT_FOUND，由调用方兜住并提示 npm install。
function electronBinary() {
  const resolved = require('electron');
  return typeof resolved === 'string' ? resolved : '';
}

// 给 electron 的参数：第一个是项目目录（开发态的应用入口），其余原样透传
// —— `--settings` 直接开设置面板、`--user-data-dir=` 起隔离实例排查，都靠它。
function appArgs(extra = []) {
  return [PROJECT_ROOT, ...extra];
}

// 一次启动尝试的判读。纯函数，单测直接喂各种日志文本；顺序即优先级：
// 「已经在跑」的证据最硬（这时第二次启动的进程会健康地退出，绝不能报成失败），
// 其次是进程真的没了（=失败），再是 Dock 就绪（可以提前收工），最后才是等超时。
function verdict({ logText = '', exited = false, waitedMs = 0, waitMs = WAIT_MS }) {
  const text = String(logText || '');
  if (text.includes(ALREADY_RUNNING_MARK)) return 'already';
  if (exited) return 'failed';
  if (text.includes(DOCK_READY_MARK)) return 'ready';
  return waitedMs >= waitMs ? 'started' : 'waiting';
}

// 进程还在不在（signal 0 只做存在性检查，不真的发信号）。
// EPERM = 进程存在但没权限碰它，那更算"活着"。
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

// 追加打开日志（不截断：上一次启动的现场留着，对排查有用）。
// 打不开（比如上一轮实例还占着它）不该拦住启动 —— 只是判定退化成"只看进程在不在"。
function openLogs(logs) {
  try {
    return { out: fs.openSync(logs.out, 'a'), err: fs.openSync(logs.err, 'a') };
  } catch (_) {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return '';
  }
}

// 只看"这次启动之后新增的日志"。日志是追加写的共享文件，上一轮留下的内容
// （包括上一次"已有实例在运行"那条）不能算进这一轮的判读，否则会报假"已经在运行"。
function added(full, seenLength) {
  return String(full || '').slice(Math.max(0, seenLength || 0));
}

function tail(text, lines = LOG_TAIL_LINES) {
  const rows = String(text || '')
    .split(/\r?\n/)
    .filter((row) => row.trim());
  return rows.slice(-lines).join('\n');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(argv = process.argv) {
  const extra = argv.slice(2);

  let binary = '';
  try {
    binary = electronBinary();
  } catch (_) {
    binary = '';
  }
  if (!binary || !fs.existsSync(binary)) {
    console.log('找不到 Electron —— 依赖还没装好。');
    console.log(`先在这个目录里跑一次 npm install，再启动：${PROJECT_ROOT}`);
    return 1;
  }

  const logs = logPaths();
  const fds = openLogs(logs);
  const seenBefore = fds ? readText(logs.out).length : 0;
  const child = spawn(binary, appArgs(extra), {
    cwd: PROJECT_ROOT,
    detached: true, // 独立进程组：关掉这个窗口不会把它带走
    stdio: fds ? ['ignore', fds.out, fds.err] : 'ignore',
    windowsHide: true
  });
  child.unref(); // 不 unref 的话本进程要等它退出才结束，而它是要常驻的

  const startedAt = Date.now();
  let state = 'waiting';
  while (state === 'waiting') {
    await sleep(POLL_MS);
    state = verdict({
      logText: fds ? added(readText(logs.out), seenBefore) : '',
      exited: !alive(child.pid),
      waitedMs: Date.now() - startedAt
    });
  }

  if (state === 'already') {
    console.log('DeskBasket 已经在运行了，不用再启动。');
    console.log('（没看到 Dock 的话：常驻模式下它待在桌面图标那一层，被别的窗口盖住时在后面，');
    console.log('把盖住屏幕底部的窗口最小化就能看到；入口还有屏幕右下角托盘的右键菜单。）');
    // 退出码 2 = "什么也没做，但这不是错误"：双击入口据此把这个窗口多留几秒，
    // 否则 Windows Terminal 的标签页会在消息还来不及看的时候关掉。
    return 2;
  }

  if (state === 'failed') {
    console.log('DeskBasket 没能起来：进程启动后立刻退出了。');
    // 先给这次新增的部分；一行都没新增才退回整个文件（至少还能看到上一次的现场）
    const fresh = fds ? added(readText(logs.out), seenBefore) : '';
    const detail = tail([fresh || readText(logs.out), readText(logs.err)].filter(Boolean).join('\n'));
    if (detail) {
      console.log('日志末尾：');
      console.log(detail);
    } else {
      console.log(`没能读到日志，现场在：${logs.out}`);
    }
    return 1;
  }

  console.log(`DeskBasket 已启动（进程 ${child.pid}）。`);
  if (state === 'ready') console.log('Dock 已就绪，就在屏幕底部。');
  else console.log('进程起来了，Dock 应该马上就出现在屏幕底部（若你把 Dock 关掉了，入口在托盘菜单）。');
  console.log(`本次运行日志：${logs.out}`);
  return 0;
}

if (require.main === module) {
  run().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  ALREADY_RUNNING_MARK,
  DOCK_READY_MARK,
  PROJECT_ROOT,
  added,
  appArgs,
  logPaths,
  tail,
  verdict
};