'use strict';

// 快捷方式与系统图标：让 Windows shell 自己去解析。
//
// 为什么不能只靠 Electron：MSI 通告式快捷方式（Edge / VS Code / Steam / QQ音乐 …）
// 的 .lnk 里根本不存目标 —— 二进制里是一段 Darwin 描述符（SPS1 块），真正落点由
// Windows Installer 在解析时给出。于是：
//   shell.readShortcutLink()  → target / icon / description 全空
//   WScript.Shell.TargetPath  → 空
// 取不到目标，就只能对着 .lnk 本身要图标，而 app.getFileIcon 对 .lnk 只会回
// 32×32 的通用「白纸＋蓝箭头」；对个别目标 exe 也会回通用「窗口」图标（实测 ZCode）。
//
// 唯一可靠的办法是让 shell 解析：SHGetFileInfo 取系统图标列表下标
// （SHGFI_SYSICONINDEX，不画快捷方式小箭头叠加——叠加是 shell 视图绘制时才合上去的），
// 再从 Jumbo 列表里取出原图。
//
// 「此电脑 / 回收站」这类虚拟项没有文件路径，`::{CLSID}` 形式 SHGetFileInfo 也不认，
// 所以走 SHGetStockIconInfo 取系统内置图标（同样用系统图标列表下标）。
//
// 与 PowerShell 之间是「纯行式、全 base64」协议：不用 JSON（PS 5.1 的 ConvertFrom-Json
// 在管道形式下会把数组并成一个字符串），也不依赖长行不被折行（PNG 按固定宽度分块）。
// 每行载荷的第一位是请求种类：f=文件路径，s=系统内置图标号。
//
// 本模块不依赖 Electron（只用 child_process / fs），node --test 可直接测。

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const store = require('./store');

const MARKER = 'DESKBASKET_ICON ';
const CHUNK = 76;           // 每行 base64 的宽度，防宿主对长行折行
const ICON_PX = 128;        // 抽出图标后缩到的边长（够 Dock 悬停放大用）
const BATCH_SIZE = 64;      // 一个 PowerShell 进程最多处理多少条（一次覆盖整个 Dock，省一次编译开销）
const DEBOUNCE_MS = 30;     // 攒一小会儿再起进程，把同一批请求合成一次调用
const TIMEOUT_MS = 30000;
const CACHE_DIR_NAME = 'icon-cache';
// 固定字面量：不按环境变量或 PATH 挑可执行文件，避免被换成别的程序
const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

// ------------------------------------------------------------------ 纯逻辑

// 按顺序给出「去哪要图标」的候选，第一个拿到图标的即为结果。
//   file  → 交给 Electron 的 app.getFileIcon
//   shell → 交给 Windows shell（SHGetFileInfo 取系统图标列表）
//
// .lnk 一律先问 shell：快捷方式在资源管理器里长什么样，这里就长什么样，
// 因为 Electron 的 getFileIcon 对 .lnk 只给通用白纸图标、对个别目标 exe 也给通用图标。
//
// resolved 是 .lnk 的 readShortcutLink 结果或 .url 的 IconFile（{ target, icon }，
// 都可能为空）；exists 是注入的存在性判断，便于纯逻辑测试。
function iconSources(target, resolved, exists) {
  const value = String(target || '');
  const lowered = value.toLowerCase();
  const has = (candidate) => Boolean(candidate) && Boolean(exists(candidate));
  const candidates = [];

  if (lowered.endsWith('.lnk')) {
    candidates.push({ kind: 'shell', path: value });
    // shell 拿不到时的兜底：解析出的目标 / 它记录的图标，最后是 .lnk 自己
    if (resolved && has(resolved.target)) candidates.push({ kind: 'file', path: resolved.target });
    else if (resolved && has(resolved.icon)) candidates.push({ kind: 'file', path: resolved.icon });
    candidates.push({ kind: 'file', path: value });
    return candidates;
  }
  if (lowered.endsWith('.url')) {
    // IconFile 常指向已卸载程序的图标，存在才用
    if (resolved && has(resolved.icon)) candidates.push({ kind: 'file', path: resolved.icon });
    candidates.push({ kind: 'file', path: value });
    return candidates;
  }
  return [{ kind: 'file', path: value }];
}

// 请求编码：线上每一行 = 一位种类 + 载荷
//   f<路径>        → SHGetFileInfo 解析文件 / 快捷方式
//   p<解析名>      → SHParseDisplayName 拿 PIDL 再问图标（虚拟项：此电脑、回收站…）
function encodeFileRequest(target) {
  return 'f' + String(target || '');
}

function encodeParsingNameRequest(parsingName) {
  return 'p' + String(parsingName || '');
}

function decodeRequest(request) {
  const value = String(request || '');
  const kind = value.slice(0, 1);
  if (kind === 'p') return { kind: 'parsing', value: value.slice(1) };
  return { kind: 'file', value: value.slice(1) };
}

// ------------------------------------------------------------------ PowerShell

// 内嵌脚本：纯 ASCII。输入是 base64 的请求行（换行分隔），输出逐行分块。
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Runtime.InteropServices;

public static class DeskBasketShellIcon {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct SHFILEINFO {
        public IntPtr hIcon;
        public int iIcon;
        public uint dwAttributes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szDisplayName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)]
        public string szTypeName;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SHGetFileInfo(string pszPath, uint dwFileAttributes,
        ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);

    // 同一个入口的 PIDL 版本：虚拟项（此电脑 / 回收站 / 网络…）没有文件路径，
    // 只能用「shell 解析名 → PIDL」再去问图标
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, EntryPoint = "SHGetFileInfoW")]
    public static extern IntPtr SHGetFileInfoPidl(IntPtr pidl, uint dwFileAttributes,
        ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern int SHParseDisplayName(string pszName, IntPtr pbc,
        out IntPtr ppidl, uint sfgaoIn, out uint psfgaoOut);

    [DllImport("ole32.dll")]
    public static extern void CoTaskMemFree(IntPtr ptr);

    [DllImport("shell32.dll")]
    public static extern int SHGetImageList(int iImageList, ref Guid riid, out IntPtr ppv);

    [DllImport("comctl32.dll")]
    public static extern IntPtr ImageList_GetIcon(IntPtr himl, int i, uint flags);

    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr hIcon);

    public const uint SHGFI_SYSICONINDEX = 0x4000;
    public const uint SHGFI_PIDL = 0x0008;

    public static int IndexOf(string path) {
        SHFILEINFO info = new SHFILEINFO();
        IntPtr result = SHGetFileInfo(path, 0, ref info,
            (uint)Marshal.SizeOf(typeof(SHFILEINFO)), SHGFI_SYSICONINDEX);
        if (result == IntPtr.Zero) return -1;
        return info.iIcon;
    }

    public static int ParsingNameIndexOf(string parsingName) {
        IntPtr pidl;
        uint attributes;
        int hr = SHParseDisplayName(parsingName, IntPtr.Zero, out pidl, 0, out attributes);
        if (hr != 0 || pidl == IntPtr.Zero) return -1;
        try {
            SHFILEINFO info = new SHFILEINFO();
            IntPtr result = SHGetFileInfoPidl(pidl, 0, ref info,
                (uint)Marshal.SizeOf(typeof(SHFILEINFO)), SHGFI_PIDL | SHGFI_SYSICONINDEX);
            if (result == IntPtr.Zero) return -1;
            return info.iIcon;
        } finally {
            CoTaskMemFree(pidl);
        }
    }

    public static IntPtr IconFrom(int shil, int index) {
        Guid iid = new Guid("46EB5926-582E-4017-9FDF-E8998DAA0950");
        IntPtr list;
        if (SHGetImageList(shil, ref iid, out list) != 0 || list == IntPtr.Zero) return IntPtr.Zero;
        return ImageList_GetIcon(list, index, 1);
    }
}
'@

$compileError = ''
try {
    Add-Type -AssemblyName System.Drawing
    Add-Type -TypeDefinition $source
} catch { $compileError = $_.Exception.Message }
$typeReady = $null -ne ('DeskBasketShellIcon' -as [type])
$debug = $env:DESKBASKET_ICON_DEBUG
$marker = '${MARKER}'
$size = [int]$env:DESKBASKET_ICON_SIZE

$requests = @()
$payload = $env:DESKBASKET_ICON_PATHS
if (-not [string]::IsNullOrEmpty($payload)) {
    $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))
    $requests = @($text -split ([char]10))
}

foreach ($item in $requests) {
    if ([string]::IsNullOrEmpty($item)) { continue }
    $b64req = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($item))
    $kind = $item.Substring(0, 1)
    $value = $item.Substring(1)
    $b64png = ''
    $problem = ''
    try {
        if ($compileError -ne '') { throw ('add-type: ' + $compileError) }
        if (-not $typeReady) { throw 'type-missing' }
        if ($kind -eq 'p') {
            $index = [DeskBasketShellIcon]::ParsingNameIndexOf($value)
        } else {
            $index = [DeskBasketShellIcon]::IndexOf($value)
        }
        if ($index -lt 0) { throw ('index-failed kind=' + $kind) }
        $handle = [DeskBasketShellIcon]::IconFrom(4, $index)
        if ($handle -eq [IntPtr]::Zero) { $handle = [DeskBasketShellIcon]::IconFrom(2, $index) }
        if ($handle -eq [IntPtr]::Zero) { $handle = [DeskBasketShellIcon]::IconFrom(0, $index) }
        if ($handle -eq [IntPtr]::Zero) { throw 'image-list-failed' }
        $icon = [System.Drawing.Icon]::FromHandle($handle)
        $pixels = $icon.Width
        if ($pixels -gt $size) { $pixels = $size }
        if ($pixels -le 0) { throw 'empty-icon' }
        $bitmap = New-Object System.Drawing.Bitmap($pixels, $pixels, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.DrawImage($icon.ToBitmap(), (New-Object System.Drawing.Rectangle(0, 0, $pixels, $pixels)))
        $graphics.Dispose()
        $stream = New-Object System.IO.MemoryStream
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $b64png = [Convert]::ToBase64String($stream.ToArray())
        $stream.Dispose()
        $bitmap.Dispose()
        [DeskBasketShellIcon]::DestroyIcon($handle) | Out-Null
    } catch { $problem = $_.Exception.Message }

    if ($b64png -eq '') {
        $line = $marker + $b64req + ' -'
        if ($debug -and $problem -ne '') {
            $line = $line + ' #' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($problem))
        }
        Write-Output $line
    } else {
        $count = [Math]::Ceiling($b64png.Length / ${CHUNK})
        for ($i = 0; $i -lt $count; $i++) {
            $start = $i * ${CHUNK}
            $len = [Math]::Min(${CHUNK}, $b64png.Length - $start)
            Write-Output ($marker + $b64req + ' ' + $i + ' ' + $b64png.Substring($start, $len))
        }
    }
}
`;

// 解析脚本输出。每行形如：
//   DESKBASKET_ICON <b64请求行> -               该条没有图标
//   DESKBASKET_ICON <b64请求行> <seq> <分块>     拼接成 PNG 的 base64
function parseRows(text) {
  const grouped = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const at = line.indexOf(MARKER);
    if (at < 0) continue;
    const body = line.slice(at + MARKER.length).trim();
    if (!body) continue;
    const parts = body.split(' ');
    const key = parts[0];
    if (!key) continue;
    let entry = grouped.get(key);
    if (!entry) {
      entry = { chunks: [], empty: false, problem: '' };
      grouped.set(key, entry);
    }
    if (parts[1] === '-') {
      entry.empty = true;
      if (parts[2] && parts[2].startsWith('#')) {
        try {
          entry.problem = Buffer.from(parts[2].slice(1), 'base64').toString('utf8');
        } catch (_) {
          entry.problem = '';
        }
      }
      continue;
    }
    const seq = Number(parts[1]);
    if (!Number.isInteger(seq) || seq < 0) continue;
    entry.chunks[seq] = parts[2] || '';
  }

  const rows = [];
  for (const [key, entry] of grouped) {
    let request;
    try {
      request = Buffer.from(key, 'base64').toString('utf8');
    } catch (_) {
      continue;
    }
    rows.push({ request, png: entry.empty ? '' : entry.chunks.join(''), err: entry.problem });
  }
  return rows;
}

function parseOutput(text) {
  const found = new Map();
  for (const row of parseRows(text)) {
    if (row.png) found.set(row.request, row.png);
  }
  return found;
}

// 起一次 PowerShell，拿一批请求的图标。
// 返回 { icons: Map(请求行 → PNG base64), stdout, stderr }；失败一律空表，由上层兜底。
function runPowerShell(requests, px) {
  return new Promise((resolve) => {
    const empty = (stdout, stderr) => ({ icons: new Map(), stdout: stdout || '', stderr: stderr || '' });
    if (!fs.existsSync(POWERSHELL_EXE)) {
      resolve(empty('', 'powershell 不存在: ' + POWERSHELL_EXE));
      return;
    }
    let payload;
    try {
      payload = Buffer.from(requests.join('\n'), 'utf8').toString('base64');
    } catch (_) {
      resolve(empty());
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
          Buffer.from(PS_SCRIPT, 'utf16le').toString('base64')
        ],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, DESKBASKET_ICON_PATHS: payload, DESKBASKET_ICON_SIZE: String(px) }
        }
      );
    } catch (error) {
      resolve(empty('', String((error && error.message) || error)));
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
        /* 进程可能已退出 */
      }
      finish(empty(out, err + '\n(超时)'));
    }, TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      err += chunk.toString('utf8');
    });
    child.on('error', (error) => finish(empty(out, String((error && error.message) || error))));
    child.on('close', () => finish({ icons: parseOutput(out), stdout: out, stderr: err }));
  });
}

// ------------------------------------------------------------------ 缓存与批量

const memory = new Map();   // `${request}|${signature}|${px}` -> dataURL
const pending = new Map();  // 同上 key -> { request, signature, px, resolvers }
let flushTimer = null;

function cacheDir() {
  return path.join(store.settingsDir(), CACHE_DIR_NAME);
}

// 缓存签名：文件按 mtime+size（换了图标就重取）；虚拟项按天失效，
// 因为回收站这类图标是「状态相关」的（空/非空不同），不能永久缓存。
function signatureOf(request, now = new Date()) {
  const { kind, value } = decodeRequest(request);
  if (kind !== 'file') return `virtual:${now.toISOString().slice(0, 10)}`;
  try {
    const stat = fs.statSync(value);
    return `${Math.round(stat.mtimeMs)}:${stat.size}`;
  } catch (_) {
    return 'missing';
  }
}

function cacheKey(request, signature, px) {
  return `${request}|${signature}|${px}`;
}

function diskFile(key) {
  const name = crypto.createHash('sha256').update(key).digest('hex');
  return path.join(cacheDir(), `${name}.png`);
}

function readDisk(key) {
  try {
    const buffer = fs.readFileSync(diskFile(key));
    if (!buffer.length) return '';
    return `data:image/png;base64,${buffer.toString('base64')}`;
  } catch (_) {
    return '';
  }
}

function writeDisk(key, base64) {
  try {
    const dir = cacheDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(diskFile(key), Buffer.from(base64, 'base64'));
  } catch (_) {
    /* 缓存写不进去不影响功能 */
  }
}

// 一次 flush：把攒下的请求按 px 分组、按批切块，每块起一个 PowerShell
async function flushPending() {
  const entries = [...pending.values()];
  pending.clear();
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.px)) groups.set(entry.px, []);
    groups.get(entry.px).push(entry);
  }
  for (const [px, group] of groups) {
    for (let start = 0; start < group.length; start += BATCH_SIZE) {
      const chunk = group.slice(start, start + BATCH_SIZE);
      let icons = new Map();
      try {
        const result = await runPowerShell(chunk.map((entry) => entry.request), px);
        icons = result.icons;
      } catch (_) {
        icons = new Map();
      }
      for (const entry of chunk) {
        const base64 = icons.get(entry.request) || '';
        const dataUrl = base64 ? `data:image/png;base64,${base64}` : '';
        if (base64) writeDisk(entry.key, base64);
        memory.set(entry.key, dataUrl);
        for (const resolve of entry.resolvers) resolve(dataUrl);
      }
    }
  }
}

function schedule() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushPending().catch(() => {});
  }, DEBOUNCE_MS);
}

// 取图标（dataURL）；拿不到回空串，由上层退回通用图标
function requestIcon(request, px = ICON_PX) {
  if (!request || request.length < 2) return Promise.resolve('');
  const signature = signatureOf(request);
  const key = cacheKey(request, signature, px);
  if (memory.has(key)) return Promise.resolve(memory.get(key));
  const cached = readDisk(key);
  if (cached) {
    memory.set(key, cached);
    return Promise.resolve(cached);
  }
  return new Promise((resolve) => {
    const entry = pending.get(key);
    if (entry) {
      entry.resolvers.push(resolve);
      return;
    }
    pending.set(key, { key, request, px, resolvers: [resolve] });
    schedule();
  });
}

// 文件 / 快捷方式的图标
function iconDataUrl(target, px = ICON_PX) {
  return requestIcon(encodeFileRequest(target), px);
}

// 虚拟项的图标（此电脑、回收站…）——载荷是 shell 解析名，如 ::{CLSID}
function parsingNameIconDataUrl(parsingName, px = ICON_PX) {
  return requestIcon(encodeParsingNameRequest(parsingName), px);
}

module.exports = {
  ICON_PX,
  MARKER,
  decodeRequest,
  iconDataUrl,
  iconSources,
  parseOutput,
  parseRows,
  parsingNameIconDataUrl,
  requestIcon,
  runPowerShell
};
