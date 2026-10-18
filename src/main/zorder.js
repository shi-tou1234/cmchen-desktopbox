'use strict';

// 直接用 SetWindowPos 管 Dock 的置顶位（TOP / UNTOP）。它是**可见性**的最终保证；
// Electron 自己的 setAlwaysOnTop 路也要走（Chromium 派发鼠标事件用它自家的窗口树，
// 输入恢复靠那次"真抬"，见 main.js 的 setDockTopmost），两条路各管一件事。
//
// 为什么必须有这条外部路：win.setAlwaysOnTop 在本机实测会**静默失效**——常驻模式的
// 「桌面层放置」（windowLayer 逐步下沉）走到拒绝协作的系统窗口（UDriverScan 等，
// ERROR_ACCESS_DENIED=5）而中断后，Electron 内部的置顶账本与真实 WS_EX_TOPMOST 位
// 失同步：之后每次 setAlwaysOnTop(true) 都静默 no-op（既不抛异常、isAlwaysOnTop()
// 也一直是 false、真实样式位从未被置上），Dock 抬不起来 → peek 功能整个哑掉。
// 同一时刻由外部进程直接 SetWindowPos(dock, HWND_TOPMOST) 是成功的——OS 层没问题，
// 坏的是 Electron 的内部账本。（最终处置是常驻模式整个停用下沉，见 applyDockLayerMode。）
//
// 做法与 keyHold / mouseState 同一套路：常驻一个 PowerShell 小循环（Add-Type 只编译一次），
// 主进程往 stdin 写一行命令、它回一行结果，往返是毫秒级，不会像每次现起进程那样重付编译开销。
//
// 协议（纯行式，双向）：
//   主进程 → 子进程：`TOP <hwnd十进制>` / `UNTOP <hwnd十进制>`
//   子进程 → 主进程：`DESKBASKET_Z READY`（起来了、可以收命令）
//                  `DESKBASKET_Z OK 1` / `OK 0`（操作执行完，结尾数字=执行后的置顶位）
//                  `DESKBASKET_Z ERR 5 0`（SetWindowPos 失败，中间是 GetLastError）
// 起不来 / 非 Windows / 报数过期：调用方按"这路不通"处理（setDockTopmost 里 Electron 那次
// 调用仍然会发，两条路互为兜底）。协议与解析全部是纯函数，可直接单测。

const { spawn } = require('node:child_process');
const fs = require('node:fs');

// 固定字面量：不按 PATH 挑可执行文件（与 keyHold / mouseState / windowLayer 一致）
const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

const MARKER = 'DESKBASKET_Z ';
const LINE_FRESH_MS = 3000;   // 超过这么久没收到任何行 = 进程大概率死了
const CMD_TIMEOUT_MS = 3000;  // 一条命令发出这么久没回音 = 当失败（不无限等）
const IDLE_STOP_MS = 30000;   // 松手后再过这么久收进程（与 keyHold 同一取舍）

const SCRIPT = `
$ErrorActionPreference = 'Stop'

$sig = @'
using System;
using System.Runtime.InteropServices;

public static class DeskBasketZ {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("kernel32.dll")]
    public static extern uint GetLastError();

    public static string Handle(long hwnd, bool top) {
        IntPtr h = (IntPtr)hwnd;
        // HWND_TOPMOST(-1) / HWND_NOTOPMOST(-2)；NOMOVE|NOSIZE|NOACTIVATE，只动 z 序
        IntPtr after = top ? (IntPtr)(-1) : (IntPtr)(-2);
        bool ok = SetWindowPos(h, after, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
        int style = GetWindowLong(h, -20);
        string tail = ((style & 0x8) != 0) ? "1" : "0";
        if (ok) { return "OK " + tail; }
        return "ERR " + GetLastError() + " " + tail;
    }
}
'@
Add-Type -TypeDefinition $sig

[Console]::Out.WriteLine('${MARKER}READY')
[Console]::Out.Flush()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    $parts = $line -split ' '
    if ($parts.Count -ne 2) { continue }
    $top = $false
    if ($parts[0] -eq 'TOP') { $top = $true }
    elseif ($parts[0] -ne 'UNTOP') { continue }
    $hwnd = [long]0
    try { $hwnd = [long]$parts[1] } catch { $hwnd = 0 }
    if ($hwnd -le 0) { continue }
    try {
        $result = [DeskBasketZ]::Handle($hwnd, $top)
    } catch {
        $result = 'ERR -1 0'
    }
    [Console]::Out.WriteLine('${MARKER}' + $result)
    [Console]::Out.Flush()
}
`;

// 主进程 → 子进程的一条命令。纯函数：只负责拼字符串，便于单测
function commandLine(hwnd, on) {
  return `${on ? 'TOP' : 'UNTOP'} ${String(hwnd)}`;
}

// 一行回音 → { ok, top, err }；不认识的行返回 null。纯函数
function parseReply(line) {
  const text = String(line === undefined || line === null ? '' : line).trim();
  const at = text.indexOf(MARKER);
  if (at < 0) return null;
  const body = text.slice(at + MARKER.length).trim();
  if (body === 'READY') return { ready: true };
  const parts = body.split(/\s+/);
  if (parts[0] === 'OK' && parts.length >= 2) {
    return { ok: true, top: parts[1] === '1', err: 0 };
  }
  if (parts[0] === 'ERR' && parts.length >= 3) {
    return { ok: false, top: parts[2] === '1', err: Number.parseInt(parts[1], 10) || 0 };
  }
  return null;
}

let child = null;
let buffer = '';
let lastLineAt = 0;
let idleTimer = null;
let startedAt = 0;
let announced = false;
const pending = [];   // [{ resolve, timer }] —— 命令按写入顺序排队，回音也按序到达

function settlePending(result) {
  const entry = pending.shift();
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.resolve(result);
}

function failAllPending() {
  while (pending.length) settlePending({ ok: false, top: null, err: -1 });
}

function handleLine(line) {
  const parsed = parseReply(line);
  if (!parsed) return;
  lastLineAt = Date.now();
  if (parsed.ready) return;                 // READY 只说明进程就绪，不对应任何排队命令
  settlePending(parsed);                    // OK / ERR 都算这条命令的回音
}

function onChildExit(proc) {
  if (child !== proc) return;
  child = null;
  buffer = '';
  lastLineAt = 0;
  startedAt = 0;
  failAllPending();
}

function stop() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const proc = child;
  child = null;
  buffer = '';
  lastLineAt = 0;
  startedAt = 0;
  failAllPending();
  if (!proc) return;
  try {
    proc.kill();
  } catch (_) {
    /* 可能已经退出 */
  }
}

// 起进程（已在跑就复用）。返回是否可用
function ensureRunning() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (child) return true;
  if (process.platform !== 'win32' || !fs.existsSync(POWERSHELL_EXE)) return false;
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
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: process.env
      }
    );
  } catch (_) {
    return false;
  }
  child = proc;
  startedAt = Date.now();
  lastLineAt = Date.now();
  buffer = '';
  if (!announced) {
    announced = true;
    console.log('[zorder] 起了置顶助手进程（SetWindowPos 直连，随应用退出）');
  }
  proc.stdout.on('data', (chunk) => {
    if (child !== proc) return;
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) handleLine(line);
  });
  proc.on('error', (error) => {
    console.log(`[zorder] 助手进程出错：${String((error && error.message) || error)}`);
    onChildExit(proc);
  });
  proc.on('close', () => onChildExit(proc));
  return true;
}

// 发一条命令，等回音。超时/进程出问题按失败处理（{ ok:false, top:null, err:-1 }）
function apply(hwnd, on) {
  const target = String(hwnd || '').trim();
  if (!target || !ensureRunning() || !child) {
    return Promise.resolve({ ok: false, top: null, err: -1 });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const at = pending.findIndex((entry) => entry.resolve === resolve);
      if (at >= 0) pending.splice(at, 1);
      resolve({ ok: false, top: null, err: -1 });
    }, CMD_TIMEOUT_MS);
    pending.push({ resolve, timer });
    try {
      child.stdin.write(`${commandLine(target, on)}\n`);
    } catch (_) {
      settlePending({ ok: false, top: null, err: -1 });
      onChildExit(child);
    }
  });
}

// 松手之后收进程（同 keyHold：留着比每次重付 Add-Type 编译便宜）
function scheduleIdleStop() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    stop();
  }, IDLE_STOP_MS);
}

// 取当前进程活性（给调用方做日志/兜底判断用）
function poll(now = Date.now()) {
  return { active: Boolean(child), fresh: Boolean(child) && now - lastLineAt <= LINE_FRESH_MS };
}

module.exports = {
  CMD_TIMEOUT_MS,
  IDLE_STOP_MS,
  LINE_FRESH_MS,
  MARKER,
  apply,
  commandLine,
  ensureRunning,
  parseReply,
  poll,
  scheduleIdleStop,
  stop
};
