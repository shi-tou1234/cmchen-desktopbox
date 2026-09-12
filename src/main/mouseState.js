'use strict';

// 弹窗开着时要问系统两件 Electron 问不到的事：
//   · 鼠标左/右键现在是不是按着的（按着 = 多半正在拖东西）；
//   · 光标是不是停在桌面上（= 用户可能正走去桌面抓一个文件）。
//
// 为什么要问：弹窗的「鼠标离开 900ms 就收回」在"从桌面/资源管理器拖文件进来"时是致命的——
// 用户必须先把光标移到源文件上（这一段光标确实离开了弹窗），弹窗就在这 900ms 里被收掉了，
// 等文件拖到弹窗原来的位置时已经没有落点了（真机复现：拖到第 2.2 秒，窗口 IsWindowVisible
// 已经是 False）。所以按下按钮期间冻结这个倒计时，光标停在桌面上时给一个更长的预算。
//
// 这两条都只能问 Win32（GetAsyncKeyState / WindowFromPoint + GetClassName），
// Electron 没有对应 API，于是起一个常驻的 PowerShell 小循环。协议极简：
// 每 125ms 往 stdout 写一行 `按下位图:是否桌面`（位 0 = 左键，位 1 = 右键；桌面 1/0）。
// 进程起不来、报数过期、非 Windows —— 一律当"问不到"，调用方退回原来的行为。

const { spawn } = require('node:child_process');
const fs = require('node:fs');

// 固定字面量：不按 PATH 挑可执行文件，避免被换成别的程序（与 windowLayer / shellIcons 一致）
const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

const POLL_MS = 125;
const LINE_FRESH_MS = 800;      // 超过这么久没收到新行 = 状态过期，当"问不到"
const START_GRACE_MS = 1500;    // 刚起进程、还没报第一行：这段按"有拖拽"处理（别在预热里关弹窗）
const IDLE_STOP_MS = 30000;     // 弹窗收掉之后再过这么久就把进程收掉，别常驻占着

// 桌面层的顶层类名：光标下的窗口往上找到根窗口，根是这两个之一才算"停在桌面上"。
// 只看根、不看光标正压着的那个子窗口的类名——子窗口名各版本不一（资源管理器的列表视图
// 也叫过 SysListView32，会误判成桌面），根窗口在 Win10/11 上一直是 Progman 或 WorkerW。
const DESKTOP_ROOT_CLASSES = ['Progman', 'WorkerW'];

const SCRIPT = `
$ErrorActionPreference = 'Stop'

$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class DeskBasketMouse {
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT p);

    [DllImport("user32.dll")]
    public static extern IntPtr WindowFromPoint(POINT p);

    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder buffer, int max);

    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);

    static string ClassOf(IntPtr hWnd) {
        if (hWnd == IntPtr.Zero) return "";
        StringBuilder buffer = new StringBuilder(256);
        GetClassName(hWnd, buffer, 256);
        return buffer.ToString();
    }

    public static string Report() {
        int bits = 0;
        // 取最高位 0x8000 = "此刻按着"。
        // 别用最低位 0x0001：那是"上一次调用之后按过"的锁存位，这个循环每 125ms 自己查一次，
        // 等于每次把自己上一轮置起的锁存位吃掉了——真机实测按住不放也永远报 0。
        if ((GetAsyncKeyState(0x01) & 0x8000) != 0) bits |= 1;   // VK_LBUTTON
        if ((GetAsyncKeyState(0x02) & 0x8000) != 0) bits |= 2;   // VK_RBUTTON

        POINT point;
        GetCursorPos(out point);
        // GA_ROOT = 2：往上找到顶层窗口。桌面图标压着的是哪个子窗口各版本不同，根一直是 Progman/WorkerW
        IntPtr root = GetAncestor(WindowFromPoint(point), 2);
        string cls = ClassOf(root);
        int over = (cls == "Progman" || cls == "WorkerW") ? 1 : 0;
        return bits.ToString() + ":" + over.ToString();
    }
}
'@
Add-Type -TypeDefinition $sig

while ($true) {
    [Console]::Out.WriteLine([DeskBasketMouse]::Report())
    [Console]::Out.Flush()
    Start-Sleep -Milliseconds ${POLL_MS}
}
`;

// 一行报数 → { held, overDesktop }；不认识的行返回 null（协议出错不该当成"没拖拽"）
function parseReport(line) {
  const text = String(line === undefined || line === null ? '' : line).trim();
  const match = /^([0-9]{1,3}):([01])$/.exec(text);
  if (!match) return null;
  const bits = Number(match[1]);
  return { held: (bits & 3) !== 0, overDesktop: match[2] === '1' };
}

let child = null;
let latest = null;
let lastLineAt = 0;
let startedAt = 0;
let buffer = '';
let idleTimer = null;
let announced = false;

function forget(proc) {
  if (child !== proc) return;
  child = null;
  latest = null;
  lastLineAt = 0;
}

function stop() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const proc = child;
  child = null;
  latest = null;
  lastLineAt = 0;
  startedAt = 0;
  buffer = '';
  if (!proc) return;
  try {
    proc.kill();
  } catch (_) {
    /* 可能已经退出 */
  }
}

function ensureRunning() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (child) return;
  if (process.platform !== 'win32' || !fs.existsSync(POWERSHELL_EXE)) return;
  let proc;
  try {
    proc = spawn(
      POWERSHELL_EXE,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(SCRIPT, 'utf16le').toString('base64')
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch (_) {
    return;
  }
  child = proc;
  startedAt = Date.now();
  buffer = '';
  if (!announced) {
    announced = true;
    console.log('[mouseState] 起了全局鼠标侦察进程（拖拽判定用，随应用退出）');
  }
  proc.stdout.on('data', (chunk) => {
    if (child !== proc) return;
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const report = parseReport(line);
      if (!report) continue;
      latest = report;
      lastLineAt = Date.now();
    }
  });
  // 进程出问题就"问不到"：调用方会退回原来的行为（弹窗按老规矩自动收），不影响功能
  proc.on('error', (error) => {
    console.log(`[mouseState] 侦察进程出错：${String((error && error.message) || error)}`);
    forget(proc);
  });
  proc.on('close', () => forget(proc));
}

// 弹窗收掉之后再收进程：拖拽/再次打开弹窗随时会用到，留着比"每次重付一遍 Add-Type 编译"便宜
function scheduleIdleStop() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    stop();
  }, IDLE_STOP_MS);
}

// 取当前状态。带 `at`（这份报数是什么时候到的）：调用方要判断"某个事件之后的状态"时
// 必须看 at —— 光看 held 会踩到"刚按下、报数还是上一拍的"这个空档（真机踩过，见 main.js 失焦那条路）。
// 问不到时 held/overDesktop 一律 false（= 完全按老行为走），
// 唯一的例外是"刚起还没报第一行"的预热期：这时 held 当 true，先别关弹窗。
function poll(now = Date.now()) {
  if (child && latest && now - lastLineAt <= LINE_FRESH_MS) {
    return {
      active: true,
      known: true,
      held: latest.held,
      overDesktop: latest.overDesktop,
      grace: false,
      at: lastLineAt
    };
  }
  if (child && !latest && now - startedAt < START_GRACE_MS) {
    return { active: true, known: false, held: true, overDesktop: false, grace: true, at: 0 };
  }
  return { active: Boolean(child), known: false, held: false, overDesktop: false, grace: false, at: 0 };
}

module.exports = {
  DESKTOP_ROOT_CLASSES,
  IDLE_STOP_MS,
  LINE_FRESH_MS,
  POLL_MS,
  START_GRACE_MS,
  ensureRunning,
  parseReport,
  poll,
  scheduleIdleStop,
  stop
};
