# 图标探针 3：绕开 Electron，直接用 Win32 SHGetFileInfo 取 .lnk 的图标。
# 关键点：不能带 SHGFI_USEFILEATTRIBUTES（带了就只按扩展名给通用图标）。
# 把每个图标存成 PNG 到 docs/icon-probe/，并打印像素统计。

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$sig = @'
using System;
using System.Runtime.InteropServices;

public static class ShellIcon {
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

    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr hIcon);

    public const uint SHGFI_ICON = 0x000000100;
    public const uint SHGFI_LARGEICON = 0x000000000;
    public const uint SHGFI_USEFILEATTRIBUTES = 0x000000010;
}
'@

Add-Type -TypeDefinition $sig

$names = @(
  'Arduino IDE.lnk',
  'Microsoft Edge.lnk',
  'Visual Studio Code.lnk',
  'Steam.lnk',
  'QQ音乐.lnk',
  'ZCode.lnk'
)

$root = [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE 'Desktop'))
$outDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\docs\icon-probe'))
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

foreach ($name in $names) {
    $full = [System.IO.Path]::GetFullPath((Join-Path $root $name))
    if ([System.IO.Path]::GetDirectoryName($full) -ne $root) { throw "路径越界: $name" }

    $info = New-Object ShellIcon+SHFILEINFO
    # 不带 SHGFI_USEFILEATTRIBUTES：让 shell 真正解析这个 .lnk
    $res = [ShellIcon]::SHGetFileInfo($full, 0, [ref]$info, [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($info), [ShellIcon]::SHGFI_ICON)

    if ($info.hIcon -eq [IntPtr]::Zero) {
        Write-Output "GETFAIL:: $name"
        continue
    }

    $icon = [System.Drawing.Icon]::FromHandle($info.hIcon)
    $bmp = $icon.ToBitmap()
    $safe = ($name -replace '[\\/:*?"<>|]', '_') -replace '\.lnk$', ''
    $png = Join-Path $outDir ($safe + '.png')
    $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
    [ShellIcon]::DestroyIcon($info.hIcon) | Out-Null

    # 像素统计：通用图标（白纸＋蓝箭头）只有极少数彩色像素
    $colored = 0
    $min = 255; $max = 0
    for ($y = 0; $y -lt $bmp.Height; $y++) {
        for ($x = 0; $x -lt $bmp.Width; $x++) {
            $p = $bmp.GetPixel($x, $y)
            if ($p.A -gt 8) {
                $lo = [Math]::Min($p.R, [Math]::Min($p.G, $p.B))
                $hi = [Math]::Max($p.R, [Math]::Max($p.G, $p.B))
                if ($lo -lt $min) { $min = $lo }
                if ($hi -gt $max) { $max = $hi }
                if (($hi - $lo) -gt 24) { $colored++ }
            }
        }
    }
    $bmp.Dispose()
    Write-Output ("RESULT:: {0}  {1}x{2}  min={3} max={4} colored={5}  -> {6}" -f $name, $icon.Width, $icon.Height, $min, $max, $colored, $png)
}
