# DeskBasket Windows 打包脚本（实测可用）
# 产物：dist\DeskBasket.exe（单文件绿色版）
$ErrorActionPreference = "Stop"

if (-not (Test-Path ".venv")) { python -m venv --system-site-packages .venv }

# 依赖只要能 import 就不再走 pip：本机到 PyPI 实测只有 18–34 kB/s，
# 而 PySide6-Essentials 的 wheel 有 76.9 MB，重装会长时间卡住。
# （本机 PySide6/pytest 装在用户 site-packages，venv 用 --system-site-packages 继承；
#   pip 看不到这个分发的元数据，所以这里用 import 而不是 pip 判断。）
& .venv\Scripts\python.exe -c "import PySide6, PyInstaller, pytest" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "== 安装依赖 =="
    .venv\Scripts\python.exe -m pip install PySide6-Essentials pyinstaller pytest
}

Write-Host "== 生成图标 =="
$env:QT_QPA_PLATFORM = "offscreen"
& .venv\Scripts\python.exe scripts\gen_icon.py
if ($LASTEXITCODE -ne 0) { throw "生成图标失败" }

Write-Host "== 打包 =="
& .venv\Scripts\pyinstaller.exe --noconfirm --clean DeskBasket.spec
if ($LASTEXITCODE -ne 0) { throw "打包失败，退出码 $LASTEXITCODE" }

Write-Host "== 自检（源码，无显示器） =="
$env:QT_QPA_PLATFORM = "offscreen"
& .venv\Scripts\python.exe main.py --selftest
if ($LASTEXITCODE -ne 0) { throw "源码自检失败，退出码 $LASTEXITCODE" }

Write-Host "== 自检（exe，无显示器） =="
# GUI 子系统程序（console=False）PowerShell 不会等它跑完，必须用 Start-Process -Wait
$selftest = Start-Process -FilePath ".\dist\DeskBasket.exe" -ArgumentList "--selftest" -NoNewWindow -Wait -PassThru
if ($selftest.ExitCode -ne 0) { throw "exe 自检失败，退出码 $($selftest.ExitCode)" }

Write-Host "== 单元测试 =="
& .venv\Scripts\python.exe -m pytest tests -q
if ($LASTEXITCODE -ne 0) { throw "单元测试失败" }

Get-Item dist\DeskBasket.exe | Select-Object Name, @{N="MB";E={[math]::Round($_.Length/1MB,1)}}
Write-Host "产物: dist\DeskBasket.exe"
