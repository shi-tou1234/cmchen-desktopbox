'use strict';

// 去掉 Win11 给顶层窗口描的那一圈 DWM 边框。
//
// 症状：Dock / 律动窗已经 thickFrame:false、清掉系统材质、底色全透明，屏幕上仍有一圈
// 细的浅色矩形——它既不是窗口背景、也不是页面画的（像素采样也验不出来），是 DWM 自己的
// 窗口边框：设置 → 个性化 → 颜色 →「在标题栏和窗口边框上显示强调色」打开时，系统给每个
// 顶层窗口描一条 1px 边，无边框的透明窗口照样被描。
// WS_THICKFRAME 只管客户区/缩放边框，与这条线是两回事——所以 1.7.1 那轮关掉 thickFrame
// 之后它还在（真机截图：整圈框正好等于 Dock 窗口矩形）。
//
// Electron 没有对应 API，只能：
//   DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR(34), DWMWA_COLOR_NONE(0xFFFFFFFE))
// 走一个常驻 PowerShell 小循环（与 zorder 同一套路：Add-Type 只编译一次，命令走 stdin）。
// 不能在 Node 里直接调 user32，也不依赖 native/DeskBasketState.exe（那是 mouseState 的
// 高频通道，不该为了这一个月一次的动作去改它的二进制）。
// 只在窗口创建时用一次，空闲 5 秒即收进程，不留常驻开销。
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const windowLayer = require('./windowLayer');

const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const MARKER = 'DESKBASKET_F ';
const CMD_TIMEOUT_MS = 4000;
const IDLE_STOP_MS = 5000;   // 每个窗口只设一次属性，设完就没用了

const SCRIPT = `
$ErrorActionPreference = 'Stop'
$sig = @'
using System;
using System.Runtime.InteropServices;
public static class DeskBasketFrame {
    [DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(IntPtr hWnd, int attribute, ref int value, int size);
    public static string Clear(IntPtr hWnd) {
        // DWMWA_BORDER_COLOR = 34，DWMWA_COLOR_NONE = 0xFFFFFFFE
        int none = unchecked((int)0xFFFFFFFE);
        int hr = DwmSetWindowAttribute(hWnd, 34, ref none, 4);
        // Win10 等不认这个属性的系统返回非 0：本来也没有这条边，按失败上报、调用方忽略
        return hr == 0 ? "OK" : ("ERR " + hr);
    }
}
'@
Add-Type -TypeDefinition $sig

[Console]::Out.WriteLine('${MARKER}READY')
[Console]::Out.Flush()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $parts = $line.Trim() -split ' '
    if ($parts.Count -ne 2 -or $parts[0] -ne 'FRAME') { continue }
    $hwnd = [long]0
    try { $hwnd = [long]$parts[1] } catch { $hwnd = 0 }
    if ($hwnd -le 0) { continue }
    try { $result = [DeskBasketFrame]::Clear([IntPtr]$hwnd) } catch { $result = 'ERR -1' }
    [Console]::Out.WriteLine('${MARKER}' + $result)
    [Console]::Out.Flush()
}
`;

// 纯函数：主进程 → 子进程的一行命令
function commandLine(hwnd) {
  return `FRAME ${String(hwnd)}`;
}

// 纯函数：一行回音 → { ready } | { ok, err }；不认识的行返回 null
function parseReply(line) {
  const text = String(line === undefined || line === null ? '' : line).trim();
  const at = text.indexOf(MARKER);
  if (at < 0) return null;
  const body = text.slice(at + MARKER.length).trim();
  if (!body) return null;
  if (body === 'READY') return { ready: true };
  const parts = body.split(/\s+/);
  if (parts[0] === 'OK') return { ok: true, err: 0 };
  if (parts[0] === 'ERR') return { ok: false, err: Number.parseInt(parts[1], 10) || 0 };
  return null;
}

let child = null;
let buffer = '';
let pending = null;
let idleTimer = null;
let announced = false;

function settle(result) {
  const entry = pending;
  pending = null;
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.resolve(result);
}

function stop() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const proc = child;
  child = null;
  buffer = '';
  settle({ ok: false, err: -1 });
  if (!proc) return;
  try {
    proc.kill();
  } catch (_) {
    /* 可能已经退出 */
  }
}

function scheduleIdleStop() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    stop();
  }, IDLE_STOP_MS);
}

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
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
        Buffer.from(SCRIPT, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
    );
  } catch (_) {
    return false;
  }
  child = proc;
  buffer = '';
  if (!announced) {
    announced = true;
    console.log('[frame] 起了去边框助手进程（DwmSetWindowAttribute，设完即收）');
  }
  proc.stdout.on('data', (chunk) => {
    if (child !== proc) return;
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const parsed = parseReply(line);
      if (!parsed || parsed.ready) continue;
      settle(parsed);
    }
  });
  proc.on('error', () => { if (child === proc) { child = null; settle({ ok: false, err: -1 }); } });
  proc.on('close', () => { if (child === proc) { child = null; settle({ ok: false, err: -1 }); } });
  proc.stdin.on('error', () => { if (child === proc) stop(); });
  return true;
}

function send(hwnd) {
  const target = String(hwnd || '').trim();
  if (!target || target === '0') return Promise.resolve({ ok: false, err: -1 });
  if (!ensureRunning() || !child) return Promise.resolve({ ok: false, err: -1 });
  if (pending) settle({ ok: false, err: -1 });   // 同一时刻只跑一条：前一条的窗口多半已经没了
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // 没回音 ⇒ 回音与后续命令没法配对，直接重启助手，别错配下一条
      if (pending && pending.resolve === resolve) stop();
      resolve({ ok: false, err: -1 });
    }, CMD_TIMEOUT_MS);
    pending = { resolve, timer };
    try {
      child.stdin.write(`${commandLine(target)}\n`);
    } catch (_) {
      stop();
      resolve({ ok: false, err: -1 });
    }
  });
}

// 给一扇窗口关掉 DWM 边框。返回 Promise<boolean>（true = 系统确认已关）。
// 越早调越好：命令在窗口 show 之前发出，边框来不及被看见。
function clearBorder(win, log = () => {}) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return Promise.resolve(false);
  const handle = windowLayer.handleOf(win);
  if (!handle || handle === '0') return Promise.resolve(false);
  return send(handle).then((result) => {
    if (!result.ok) {
      log(`去 DWM 边框未成功 hwnd=${handle} err=${result.err}`);
      return false;
    }
    log(`DWM 边框已关 hwnd=${handle}`);
    scheduleIdleStop();
    return true;
  });
}

module.exports = { CMD_TIMEOUT_MS, IDLE_STOP_MS, MARKER, clearBorder, commandLine, parseReply, stop };
