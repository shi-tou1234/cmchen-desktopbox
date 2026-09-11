'use strict';

// 把「常驻显示」的 Dock 放到桌面层：桌面之上、所有应用窗口之下。
//
// 领导的要求是「常驻也不能压在其他程序上面，只应该浮在桌面上」。Windows 的 z 序最底部
// 依次是壁纸层和桌面层（WorkerW / Progman），直接把窗口插到 HWND_BOTTOM 会被压到壁纸
// 下面（上一版 Qt 与本次实测都是这个结果）。可靠的做法是**逐步下沉**：
//
//   每一步看「z 序里紧挨在 Dock 下面的那个窗口」是谁（GetWindow(hwnd, GW_HWNDNEXT)）：
//     · 是桌面层（Progman / WorkerW / SysListView32）→ 到位了，停；
//     · 是别的窗口                                    → 把 Dock 插到它后面，再来一步。
//
// 这样不依赖对 z 序方向的任何猜测（这一点踩过坑：插入点选错方向就会掉到桌面层下面，
// 结果"可见但看不见"），而且每一步都能用同一个判据验证。停下来的状态保证：
// Dock 紧贴桌面层之上 ⇒ 任何盖住屏幕底部的应用窗口都会盖住它，而桌面露出来时它在。
//
// 另外两个坑记在这里：
//   · `SetWindowPos` 把非置顶窗口插到**置顶**窗口之后，会把目标变成置顶——所以插入点
//     只取 z 序邻居，不拿"前台窗口"之类可能置顶的句柄；
//   · 只在这个模式（常驻）下做，自动收起模式仍保持置顶，好让它滑出时盖得住任务栏。

const { spawn } = require('node:child_process');
const fs = require('node:fs');

const MARKER = 'DESKBASKET_LAYER ';
// 下沉步数上限要留足：系统里可能夹着一大串看不见的助手窗口（实测遇到过联想的一串
// 管道窗口 \\.\pipe\LenovoLeFileTask 连续十几个），多下沉几步只是把它挪到更靠桌面
// 的位置，不影响可见结果。
const MAX_STEPS = 200;
// 固定字面量：不按环境变量或 PATH 挑可执行文件，避免被换成别的程序
const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

const SCRIPT = `
$ErrorActionPreference = 'Stop'

$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class DeskBasketLayer {
    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder buffer, int max);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int X, int Y, int cx, int cy, uint flags);

    public static string ClassOf(IntPtr hWnd) {
        StringBuilder buffer = new StringBuilder(256);
        GetClassName(hWnd, buffer, 256);
        return buffer.ToString();
    }
}
'@
Add-Type -TypeDefinition $sig

$dock = [IntPtr]([long]$env:DESKBASKET_DOCK_HWND)
if ($dock -eq [IntPtr]::Zero) {
    Write-Output ('${MARKER}SKIP_NO_WINDOW')
    exit
}

# 桌面层的类名，与 src/main/dockmodel.js 的 SHELL_WINDOW_CLASSES 保持一致
$desktopClasses = @('Progman', 'WorkerW', 'SysListView32')
$seen = @()
$result = 'STILL_MOVING'
for ($i = 0; $i -lt ${MAX_STEPS}; $i++) {
    # GW_HWNDNEXT = 2：z 序里紧挨在下面的那个窗口
    $below = [DeskBasketLayer]::GetWindow($dock, 2)
    if ($below -eq [IntPtr]::Zero) { $result = 'AT_BOTTOM'; break }
    $className = [DeskBasketLayer]::ClassOf($below)
    if ($desktopClasses -contains $className) { $result = 'ABOVE_DESKTOP'; break }
    $seen += $className
    [DeskBasketLayer]::SetWindowPos($dock, $below, 0, 0, 0, 0, (0x0001 -bor 0x0002 -bor 0x0010)) | Out-Null
}
Write-Output ('${MARKER}' + $result + ' steps=' + $seen.Count + ' last=' + (($seen | Select-Object -Last 3) -join '>'))
`;

// Electron 给的句柄是 Buffer（Windows 上是窗口句柄的小端字节序）
function handleOf(win) {
  try {
    const buffer = win.getNativeWindowHandle();
    if (!buffer || buffer.length < 4) return '0';
    const value = buffer.length >= 8 ? buffer.readBigUInt64LE(0) : BigInt(buffer.readUInt32LE(0));
    return value.toString();
  } catch (_) {
    return '0';
  }
}

// 返回 'ABOVE_DESKTOP'（到位）/ 'AT_BOTTOM' / 'SKIP_NO_WINDOW' / 'STILL_MOVING' / 空
function placeOnDesktopLayer(win) {
  return new Promise((resolve) => {
    const handle = win && !win.isDestroyed() ? handleOf(win) : '0';
    if (!handle || handle === '0' || !fs.existsSync(POWERSHELL_EXE)) {
      resolve('');
      return;
    }
    let child;
    try {
      child = spawn(
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
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, DESKBASKET_DOCK_HWND: handle }
        }
      );
    } catch (_) {
      resolve('');
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {
        /* 可能已退出 */
      }
      finish('');
    }, 20000);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      err += chunk.toString('utf8');
    });
    child.on('error', () => finish(''));
    child.on('close', () => {
      const at = out.indexOf(MARKER);
      if (at >= 0) {
        finish(out.slice(at + MARKER.length).trim());
        return;
      }
      const tail = (text) => text.replace(/\s+/g, ' ').slice(-200);
      finish(err ? `ERR stderr=${tail(err)}` : '');
    });
  });
}

module.exports = { DESKTOP_CLASSES: ['Progman', 'WorkerW', 'SysListView32'], MARKER, handleOf, placeOnDesktopLayer };
