# 解析探针：WScript.Shell（走 IShellLink::Resolve）能否解出 MSI 通告式快捷方式的 target/icon。
# 输出全部用 base64，绕开 PowerShell 5.1 的 ANSI/UTF-8 编码坑（中文文件名不会乱码）。
$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE 'Desktop'))
$sh = New-Object -ComObject WScript.Shell

function B64([string]$s) {
    if ([string]::IsNullOrEmpty($s)) { return '' }
    return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))
}

Get-ChildItem -LiteralPath $root -Filter *.lnk -File | ForEach-Object {
    $lnk = $sh.CreateShortcut($_.FullName)
    $target = $lnk.TargetPath
    $icon = $lnk.IconLocation
    $exists = $false
    if ($target) { $exists = Test-Path -LiteralPath $target }
    Write-Output ("ROW`t{0}`t{1}`t{2}`t{3}" -f (B64 $_.Name), (B64 $target), (B64 $icon), $exists)
}
