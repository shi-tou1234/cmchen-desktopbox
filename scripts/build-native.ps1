$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw '缺少 .NET Framework C# 编译器' }
New-Item -ItemType Directory -Path (Join-Path $taskRoot 'native') -Force | Out-Null
& $compiler /nologo /optimize+ /target:exe ("/out:" + (Join-Path $taskRoot 'native\DeskBasketState.exe')) (Join-Path $taskRoot 'src\native\DeskBasketState.cs')
if ($LASTEXITCODE -ne 0) { throw '原生助手编译失败' }
