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
// 包应用（Store / MSIX）快捷方式是第三种：.lnk 里没有文件目标，目标是一串 AUMID
// （<包族名>!<应用 id>），而 **shell 根本渲染不出它们的图标** —— SHGetFileInfo 对
// .lnk 和对 shell:AppsFolder\<AUMID> 都只回通用「白纸」，缩略图接口
// （IShellItemImageFactory）同样（实测 Watt Toolkit / Fluent Reader / Snipaste
// 三个 Store 应用都是白纸，而计算器这类正经注册了图标的 UWP 应用正常）。
// 所以这类链接改读**应用包里的 logo 素材** —— 开始菜单磁贴用的就是同一套图。
// 请求行因此多了第四种前缀：a=包应用的 AUMID。
//
// 与 PowerShell 之间是「纯行式、全 base64」协议：不用 JSON（PS 5.1 的 ConvertFrom-Json
// 在管道形式下会把数组并成一个字符串），也不依赖长行不被折行（PNG 按固定宽度分块）。
// 每行载荷的第一位是请求种类：f=文件路径，p=shell 解析名，a=包应用 AUMID。
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
const PS_CONCURRENCY = 3;   // 批与批之间最多几个 PowerShell 并行（批间无共享状态，见 runBatch）
const MEMORY_CACHE_MAX = 500;   // 内存图标缓存条数上限，超出按 LRU 淘汰最老的
const DISK_SWEEP_EVERY = 50;    // 每写这么多次磁盘缓存，后台扫一次（清超龄死条目）
const DISK_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;  // 磁盘缓存文件超过 30 天即删
const DEBOUNCE_MS = 30;     // 攒一小会儿再起进程，把同一批请求合成一次调用
const TIMEOUT_MS = 30000;
// 抽取失败的负缓存存活时长。失败**不能**写进 memory（见 runBatch），但也不能
// 「不缓存就每次都重试」——那会让一个真拿不到的图标每来一个请求就起一个 PowerShell。
// 折中：只记一个失败时刻，TTL 内直接回空串不重试，TTL 到了自动放行重试。
// 「自动放行」是关键：虚拟项签名按天失效，没有 TTL 的话一次失败就坏到跨天/坏到重启。
const FAILURE_TTL_MS = 30000;
const FAILURE_CACHE_MAX = 500;   // 负缓存条数上限（键含按天滚动的签名，不封顶会一直长）
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

function encodePackageRequest(aumid) {
  return 'a' + String(aumid || '');
}

// AUMID = <包族名>!<应用 id>：包族名是 <名字>_<13 位发布者哈希>（与版本无关，
// 应用升级后不变），应用 id 是清单里那条 Application 的 Id。
const AUMID_PATTERN = /(?:^|[^\w.!-])([A-Za-z0-9][\w.-]*_[a-z0-9]{13}![A-Za-z0-9.-]{1,64})/g;

// 从 .lnk 的字节里认出包应用：这类链接没有 LinkInfo，目标全在目标 ID 列表里，
// AUMID 以 UTF-16 存在其中（形如 `4651ED44255E.47979655102CE_k6txddmbb6c52!App`）。
// 认不出就回空串 —— 调用方据此退回 shell 那条路，所以这里宁可漏认不可错认成别的字符串。
// 只扫目标 ID 列表这一段；UTF-16 对齐未知，0/1 两个相位都扫一遍。
function aumidFromLink(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 78) return '';
  if (!(buffer.readUInt32LE(20) & 0x1)) return '';        // 没有 HasLinkTargetIDList
  const start = 78;
  const end = Math.min(start + buffer.readUInt16LE(76), buffer.length);
  if (end - start < 8) return '';
  const idList = buffer.subarray(start, end);
  for (const phase of [0, 1]) {
    const text = idList.subarray(phase).toString('utf16le');
    AUMID_PATTERN.lastIndex = 0;
    const hit = AUMID_PATTERN.exec(text);
    if (hit) return hit[1];
  }
  return '';
}

function decodeRequest(request) {
  const value = String(request || '');
  const kind = value.slice(0, 1);
  if (kind === 'p') return { kind: 'parsing', value: value.slice(1) };
  if (kind === 'a') return { kind: 'package', value: value.slice(1) };
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

# 找出不透明像素的包围盒。有些图标的 48/256 槽位里只在左上角画了一小块
# （典型是只带了 16x16 资源的 .ico），原样画出来就是"图标偏小"。
# 用 LockBits 一次拷出来再扫，比 GetPixel 快两个数量级。
function Get-IconContentBox($bmp) {
    $rect = New-Object System.Drawing.Rectangle(0, 0, $bmp.Width, $bmp.Height)
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
        $bytes = New-Object byte[] ($data.Stride * $bmp.Height)
        [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
        $minX = $bmp.Width; $minY = $bmp.Height; $maxX = -1; $maxY = -1
        for ($y = 0; $y -lt $bmp.Height; $y++) {
            $row = $y * $data.Stride
            for ($x = 0; $x -lt $bmp.Width; $x++) {
                if ($bytes[$row + $x * 4 + 3] -gt 8) {
                    if ($x -lt $minX) { $minX = $x }
                    if ($x -gt $maxX) { $maxX = $x }
                    if ($y -lt $minY) { $minY = $y }
                    if ($y -gt $maxY) { $maxY = $y }
                }
            }
        }
        if ($maxX -lt 0) { return $null }
        return New-Object System.Drawing.Rectangle($minX, $minY, ($maxX - $minX + 1), ($maxY - $minY + 1))
    } finally {
        $bmp.UnlockBits($data)
    }
}

# 把图标画进 size×size 的目标图。有些图标的槽位里只在角落画了一小块（典型是只带了
# 16x16 资源的 .ico），原样画出来就是"图标偏小"；这种就**先在原始分辨率上裁出内容**，
# 再一次性缩放到满格——先缩小再放大等于把清晰度丢两遍，会糊。
function Draw-IconFilled($graphics, $native, $size) {
    $whole = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $box = Get-IconContentBox $native
    $span = [Math]::Max($native.Width, $native.Height)
    if ($null -eq $box -or $span -le 0) {
        $graphics.DrawImage($native, $whole)
        return
    }
    $fill = [Math]::Max($box.Width, $box.Height) / $span
    if ($fill -ge 0.72) {
        $graphics.DrawImage($native, $whole)
        return
    }
    $inner = $size - 2
    $scale = [Math]::Min($inner / $box.Width, $inner / $box.Height)
    $dw = [Math]::Max(1, [int][Math]::Round($box.Width * $scale))
    $dh = [Math]::Max(1, [int][Math]::Round($box.Height * $scale))
    $dest = New-Object System.Drawing.Rectangle([int](($size - $dw) / 2), [int](($size - $dh) / 2), $dw, $dh)
    $graphics.DrawImage($native, $dest, $box, [System.Drawing.GraphicsUnit]::Pixel)
}

# Logo file of a packaged (Store / MSIX) app. The shell cannot draw these apps'
# icons - it hands out the generic "white page" for both the .lnk and
# shell:AppsFolder\<AUMID>, and the thumbnail interface agrees - so the image has
# to come out of the package itself.
#
# Pick the asset by *pixel size*, with every sort key explicit and the path last:
# a name-pattern guess once picked a 16x16 asset for a 128px icon and it came out
# a blurry mess (the names differ per vendor: Square150x150Logo, LargeTile,
# Snipaste_44.targetsize-256_altform-unplated ~). Rules, in order:
#   * square PNGs only, skipping lightunplated / white / black / contrast variants
#     (they are for light or monochrome surfaces) and Badge / Wide / SplashScreen;
#   * prefer the "unplated" family - that is the set Windows itself uses when it
#     draws an app icon without a tile plate;
#   * then the smallest asset that still covers the wanted size (never upscale a
#     16x16 into a 128px dock icon), or the largest if none is big enough.
function Get-PackageLogoPath($aumid, $wanted) {
    $family = $aumid.Split('!')[0]
    $pkg = $null
    if ($family.Length -gt 14) {
        $name = $family.Substring(0, $family.Length - 14)
        $pkg = Get-AppxPackage -Name $name -ErrorAction SilentlyContinue |
            Where-Object { $_.PackageFamilyName -eq $family } | Select-Object -First 1
    }
    if ($null -eq $pkg) {
        $pkg = Get-AppxPackage -ErrorAction SilentlyContinue |
            Where-Object { $_.PackageFamilyName -eq $family } | Select-Object -First 1
    }
    if ($null -eq $pkg) { throw ('package-not-found: ' + $family) }

    $dir = $pkg.InstallLocation
    try {
        $logo = (Get-AppxPackageManifest $pkg).Package.Properties.Logo
        if ($logo) {
            $candidate = Join-Path $pkg.InstallLocation (Split-Path $logo -Parent)
            if (Test-Path -LiteralPath $candidate) { $dir = $candidate }
        }
    } catch { }

    $files = @(Get-ChildItem -LiteralPath $dir -Filter '*.png' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch 'lightunplated|white|black|contrast|Badge|Wide|SplashScreen' })
    if ($files.Count -eq 0) { throw ('no-logo-assets: ' + $dir) }

    $squares = @()
    foreach ($f in $files) {
        try {
            $img = [System.Drawing.Image]::FromFile($f.FullName)
            $width = $img.Width
            $isSquare = ($width -eq $img.Height)
            $img.Dispose()
        } catch { continue }
        if (-not $isSquare) { continue }
        $unplated = 0
        if ($f.Name -match 'unplated') { $unplated = 1 }
        $squares += [pscustomobject]@{ Path = $f.FullName; Size = $width; Unplated = $unplated }
    }
    if ($squares.Count -eq 0) { throw ('no-square-logo: ' + $dir) }

    $pool = @($squares | Where-Object { $_.Unplated -eq 1 })
    if ($pool.Count -eq 0) { $pool = $squares }

    $covering = @($pool | Where-Object { $_.Size -ge $wanted })
    if ($covering.Count -gt 0) {
        $pick = $covering | Sort-Object -Property Size, Path | Select-Object -First 1
    } else {
        $pick = $pool | Sort-Object -Property Size, Path -Descending | Select-Object -First 1
    }
    return $pick.Path
}

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
        if ($kind -eq 'a') {
            $native = New-Object System.Drawing.Bitmap((Get-PackageLogoPath $value $size))
        } else {
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
            $native = $icon.ToBitmap()
        }
        if ($native.Width -le 0) { throw 'empty-icon' }
        $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        Draw-IconFilled $graphics $native $size
        $graphics.Dispose()
        $native.Dispose()
        $stream = New-Object System.IO.MemoryStream
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $b64png = [Convert]::ToBase64String($stream.ToArray())
        $stream.Dispose()
        $bitmap.Dispose()
        if ($null -ne $handle) { [DeskBasketShellIcon]::DestroyIcon($handle) | Out-Null }
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
// 排队中的批次：键正常就是上面那个缓存键；fresh 请求的键带一个递增序号
// （见 requestIcon），保证不跟「可能拍在状态变化之前」的在途请求合并。
// 条目里的 key 永远是规范缓存键——回填、写盘、写内存都按它来。
const pending = new Map();  // 排队键 -> { key, request, px, resolvers, fresh }
// 抽取失败的负缓存：键同上，值是失败时刻。
//
// 为什么单独一张表、为什么失败结果不写 memory：requestIcon 开头 memory 命中就直接返回，
// 一旦把空串写进 memory，这个图标在本次进程生命周期内就永远返回空、再也不问 shell
// （真机报障：此电脑/回收站/天气三个 shell 虚拟项同时破图，只有重启 Dock 才恢复）。
// 失败只记在这里，TTL 到了自动放行重试。
const failures = new Map();
let freshSeq = 0;           // fresh 排队键的序号（只要保证不重复，不承重）
let flushTimer = null;
let diskWriteCount = 0;     // 距上次后台清扫又写了多少次磁盘缓存
let sweepTimer = null;      // 清扫定时器：同一时刻只挂一个，防止重复排队

// 写内存缓存：Map 的插入序当 LRU 用——已有的键先删再插（刷成最新），
// 超过上限就删最老的键。签名含 mtime+size，源文件一改旧键就成死条目，
// 不淘汰会无限堆积（图标请求是热路径，读命中不回写，仅 set 时维护序）。
function memorySet(key, value) {
  memory.delete(key);
  memory.set(key, value);
  while (memory.size > MEMORY_CACHE_MAX) {
    memory.delete(memory.keys().next().value);
  }
}

// 记一次抽取失败。只进负缓存，绝不碰 memory——memory 是「确定拿到过」的图才配待的地方。
// 顺手扫一遍超龄项并封顶：键里含按天滚动的签名，没人再访问的条目不会被自然清掉。
function noteFailure(key, now = Date.now()) {
  failures.delete(key);
  failures.set(key, now);
  if (failures.size <= FAILURE_CACHE_MAX) return;
  for (const [k, at] of failures) {
    if (now - at >= FAILURE_TTL_MS) failures.delete(k);
  }
  while (failures.size > FAILURE_CACHE_MAX) {
    failures.delete(failures.keys().next().value);
  }
}

function cacheDir() {
  return path.join(store.settingsDir(), CACHE_DIR_NAME);
}

// 缓存签名：文件按 mtime+size（换了图标就重取）；虚拟项按天失效打底。
// 回收站这类「状态相关」（空/满不同）的图只按天失效不够——一天之内状态翻转
// 图标还是旧的（当天第一问定格成当天的状态），所以主进程的回收站看门狗会用
// { fresh: true } 现拉一张**写回本键**（见 main.js），这里的按天键对它只是兜底。
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
  // 低频清扫：写满 DISK_SWEEP_EVERY 次才排队一次后台扫。
  // 清扫绝不在这条热路径上同步做——只挂个定时器，等当前同步流程让出后在队列里跑。
  diskWriteCount += 1;
  if (diskWriteCount >= DISK_SWEEP_EVERY) {
    diskWriteCount = 0;
    scheduleSweep();
  }
}

// 排一次磁盘缓存清扫（同一时刻最多一个在排队）
function scheduleSweep() {
  if (sweepTimer) return;
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    try {
      sweepDiskCache();
    } catch (_) {
      /* 整轮清扫失败也不影响功能，下轮再试 */
    }
  }, 0);
}

// 清掉磁盘缓存里超龄的死条目（签名含 mtime+size，源文件一改旧 .png 永远残留）。
// 先 readdir 摸清目录（目录还没建出来/列目录失败就当作没什么可清的），
// 只删 icon-cache 目录内的 *.png，且 mtime 超过 30 天才删；单个文件出错跳过。
function sweepDiskCache() {
  const dir = cacheDir();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return;
  }
  const cutoff = Date.now() - DISK_CACHE_MAX_AGE_MS;
  for (const name of names) {
    if (!name.endsWith('.png')) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile() && stat.mtimeMs < cutoff) fs.unlinkSync(file);
    } catch (_) {
      /* 单个文件读/删失败（被占用等）：跳过，下轮再试 */
    }
  }
}

// 取图的真正执行者：起一个 PowerShell，把结果回填给这一批的等待者。
// 默认是 runPowerShell；单测用 __setBatchRunnerForTests 换成假的（store.__setRootForTests
// 同款注入口），免得测试去起真的 PowerShell。
let batchRunner = runPowerShell;

function __setBatchRunnerForTests(fn) {
  batchRunner = typeof fn === 'function' ? fn : runPowerShell;
  return null;
}

// 单批：把结果回填给这一批的等待者。
// 批与批之间没有共享可变状态——runPowerShell 各自 spawn 各自的子进程、env 是新对象，
// pending 在 flush 开头就已清空且每条 entry 只属于一个 chunk，回填写的 key 互不重叠，
// 因此每条 key 只被回填一次（幂等），一批失败/超时只让该批回空串，不牵连其它批。
async function runBatch(px, chunk) {
  let icons = new Map();
  try {
    const result = await batchRunner(chunk.map((entry) => entry.request), px);
    icons = result.icons;
  } catch (_) {
    icons = new Map();   // 这批失败：这批全回空串（上层退回通用图标），错误照旧被兜底
  }
  for (const entry of chunk) {
    const base64 = icons.get(entry.request) || '';
    const dataUrl = base64 ? `data:image/png;base64,${base64}` : '';
    if (base64) {
      failures.delete(entry.key);
      writeDisk(entry.key, base64);
      memorySet(entry.key, dataUrl);
    } else {
      // 失败（含空串）一律不写 memory：写进去就是「本次进程内永远返回空、再也不问 shell」，
      // 等于坏到重启为止。改记负缓存，TTL 到了自动放行重试。
      // 磁盘也不写（下面 writeDisk 只在成功分支），所以重启必然重新抽取——
      // 「重启就好了」一直成立，但不该是唯一的出路。
      noteFailure(entry.key);
    }
    // fresh 与普通请求同走这一条：都不拿空串盖掉手里那张还对的图（否则一次 PowerShell
    // 抖动就把好好显示着的图标变成「破图占位」），何时重试交给调用方决定
    // （回收站看门狗有补拉，此电脑/天气见 main.js 的 scheduleSpecialIconRetry）。
    for (const resolve of entry.resolvers) resolve(dataUrl);
  }
}

// 一次 flush：把攒下的请求按 px 分组、按批切块，批与批之间受控并发——
// 一次最多 PS_CONCURRENCY(3) 个 PowerShell 并行。串行跑的话，超过 BATCH_SIZE 的部分
// 每一批都要重付一遍 PowerShell 启动 + Add-Type 编译开销；并发取 3 是因为批间已确认
// 无共享状态（见 runBatch），而每个子进程都要各自编译 C# 并在内存里持一份图标位图，
// 开太高只会互相抢 CPU/内存、收益递减。批内 64 条的切法不变。
async function flushPending() {
  const entries = [...pending.values()];
  pending.clear();
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.px)) groups.set(entry.px, []);
    groups.get(entry.px).push(entry);
  }
  for (const [px, group] of groups) {
    const chunks = [];
    for (let start = 0; start < group.length; start += BATCH_SIZE) {
      chunks.push(group.slice(start, start + BATCH_SIZE));
    }
    for (let i = 0; i < chunks.length; i += PS_CONCURRENCY) {
      await Promise.all(
        chunks.slice(i, i + PS_CONCURRENCY).map((chunk) => runBatch(px, chunk))
      );
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

// 取图标（dataURL）；拿不到回空串，由上层退回通用图标。
//
// opts.fresh = 状态相关图标（回收站空/满）的「现拉」通道：
//   * 跳过内存/磁盘读——哪怕按天缓存里躺着一张也不发它；
//   * 排队键带序号，不搭上任何在途请求（在途那张可能拍在状态变化之前）；
//   * 结果照旧写回规范缓存键——之后所有普通请求读到的就是这张新图。
function requestIcon(request, px = ICON_PX, opts = {}) {
  if (!request || request.length < 2) return Promise.resolve('');
  const fresh = Boolean(opts && opts.fresh);
  const signature = signatureOf(request);
  const key = cacheKey(request, signature, px);
  if (!fresh) {
    if (memory.has(key)) return Promise.resolve(memory.get(key));
    const cached = readDisk(key);
    if (cached) {
      memorySet(key, cached);
      return Promise.resolve(cached);
    }
    // 负缓存：刚失败过就先回空串，别每来一个请求就起一个 PowerShell。
    // TTL 到了自动放行重试——这正是「失败不写 memory」能生效的前提。
    // fresh 不查这张表：现拉的语义就是「缓存一概不算」，回收站看门狗的补拉
    // 不能被自己上一次失败记录挡住，否则补拉会连着三次秒失败然后放弃。
    const failedAt = failures.get(key);
    if (failedAt !== undefined) {
      if (Date.now() - failedAt < FAILURE_TTL_MS) return Promise.resolve('');
      failures.delete(key);
    }
  }
  const queueKey = fresh ? `${key}#fresh:${(freshSeq += 1)}` : key;
  return new Promise((resolve) => {
    const entry = pending.get(queueKey);
    if (entry) {
      entry.resolvers.push(resolve);
      return;
    }
    pending.set(queueKey, { key, request, px, resolvers: [resolve], fresh });
    schedule();
  });
}

// 文件 / 快捷方式的图标。
// 包应用快捷方式（.lnk 里带 AUMID 的那种）先走包里的 logo 素材 —— shell 只会回白纸；
// 拿不到（包已卸载、素材被裁掉）再退回老路，至少不比从前差。
const linkAumidCache = new Map();   // `${路径}|${mtime}:${size}` -> AUMID 或 ''

function aumidOf(target) {
  const value = String(target || '');
  if (!value.toLowerCase().endsWith('.lnk')) return '';
  let signature;
  try {
    const stat = fs.statSync(value);
    signature = `${Math.round(stat.mtimeMs)}:${stat.size}`;
  } catch (_) {
    return '';                       // 读不到就不猜，交给后面那条路去报错
  }
  const key = `${value.toLowerCase()}|${signature}`;
  if (linkAumidCache.has(key)) return linkAumidCache.get(key);
  let aumid = '';
  try {
    aumid = aumidFromLink(fs.readFileSync(value));
  } catch (_) {
    aumid = '';
  }
  linkAumidCache.set(key, aumid);
  return aumid;
}

async function iconDataUrl(target, px = ICON_PX) {
  if (process.platform !== 'win32') return Promise.resolve('');   // 非 Windows：图标由 app.getFileIcon 兜底
  const aumid = aumidOf(target);
  if (aumid) {
    const packaged = await requestIcon(encodePackageRequest(aumid), px);
    if (packaged) return packaged;
  }
  return requestIcon(encodeFileRequest(target), px);
}

// 虚拟项的图标（此电脑、回收站…）——载荷是 shell 解析名，如 ::{CLSID}。
// opts 透传给 requestIcon（回收站的 { fresh: true } 现拉走这里）
function parsingNameIconDataUrl(parsingName, px = ICON_PX, opts) {
  if (process.platform !== 'win32') return Promise.resolve('');   // 非 Windows：图标由 app.getFileIcon 兜底
  return requestIcon(encodeParsingNameRequest(parsingName), px, opts);
}

// 把负缓存里所有条目的失败时刻改到 TTL 之前（等价于「已经放了 30 秒」）。
// 给测试用的注入口（同 __setBatchRunnerForTests）：TTL 30 秒在单测里干等不起，
// 但「TTL 到了必须自动放行重试」这条正是本次修复的核心，不能不测。
function __expireFailuresForTests() {
  const old = Date.now() - FAILURE_TTL_MS - 1;
  for (const key of [...failures.keys()]) failures.set(key, old);
}

module.exports = {
  ICON_PX,
  MARKER,
  __expireFailuresForTests,
  __setBatchRunnerForTests,
  aumidFromLink,
  aumidOf,
  decodeRequest,
  encodePackageRequest,
  iconDataUrl,
  iconSources,
  parseOutput,
  parseRows,
  parsingNameIconDataUrl,
  requestIcon,
  runPowerShell
};
