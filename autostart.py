"""开机自启动管理（跨平台，零第三方依赖）。

机制：
- Windows: HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run 注册表值
  （登录时启动，不弹控制台窗口）
- macOS:   ~/Library/LaunchAgents/com.deskbasket.plist（RunAtLoad）
- Linux:   ~/.config/autostart/deskbasket.desktop（XDG Autostart）

安全设计：写入目标一律由「固定父目录 resolve() + 固定文件名」构造，落盘前用
relative_to 做包含校验；写操作只落在当前用户作用域。enable/disable 幂等。
"""

import plistlib
import subprocess
import sys
from pathlib import Path

APP_NAME = "DeskBasket"
MACOS_LABEL = "com.deskbasket"
WIN_VALUE_NAME = "DeskBasket"

_WIN_RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
_MACOS_DIR = Path.home() / "Library" / "LaunchAgents"
_LINUX_DIR = Path.home() / ".config" / "autostart"
_MACOS_FILENAME = "%s.plist" % MACOS_LABEL
_LINUX_FILENAME = "deskbasket.desktop"


def app_root():
    """应用根目录（源码运行＝项目根；打包运行＝可执行文件所在目录）。"""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def launcher_command():
    """登录后拉起本应用的命令行（列表形式）。

    源码运行优先用 pythonw（Windows 登录启动不弹黑窗）。
    """
    if getattr(sys, "frozen", False):
        return [sys.executable]
    python_exe = Path(sys.executable)
    pythonw = python_exe.with_name("pythonw.exe")
    target = pythonw if pythonw.is_file() else python_exe
    return [str(target), str(app_root() / "main.py")]


def build_windows_command():
    """注册表 Run 值的命令行文本（Windows 引号规则）。"""
    return subprocess.list2cmdline(launcher_command())


def build_macos_plist():
    return {
        "Label": MACOS_LABEL,
        "ProgramArguments": launcher_command(),
        "RunAtLoad": True,
    }


def build_linux_desktop():
    quoted = " ".join('"%s"' % part for part in launcher_command())
    return (
        "[Desktop Entry]\n"
        "Type=Application\n"
        "Name=%s\n"
        "Exec=%s\n"
        "Terminal=false\n"
        "X-GNOME-Autostart-enabled=true\n" % (APP_NAME, quoted)
    )


def _safe_target(directory, filename):
    """固定父目录 resolve + 固定文件名 → 包含校验后返回目标路径。"""
    root = directory.resolve()
    root.mkdir(parents=True, exist_ok=True)
    target = (root / filename).resolve()
    target.relative_to(root)
    return target


def is_supported():
    return sys.platform in ("win32", "darwin", "linux")


def is_enabled():
    try:
        if sys.platform == "win32":
            import winreg

            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _WIN_RUN_KEY) as key:
                winreg.QueryValueEx(key, WIN_VALUE_NAME)
                return True
        if sys.platform == "darwin":
            return (_MACOS_DIR / _MACOS_FILENAME).is_file()
        if sys.platform == "linux":
            return (_LINUX_DIR / _LINUX_FILENAME).is_file()
    except OSError:
        return False
    return False


def current_command():
    """当前注册表里记的命令行；没启用返回空串。自检用。"""
    if sys.platform != "win32":
        return ""
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _WIN_RUN_KEY) as key:
            value, _kind = winreg.QueryValueEx(key, WIN_VALUE_NAME)
            return value
    except OSError:
        return ""


def enable():
    """注册开机自启动（幂等；每次刷新命令行，路径变了会自动纠正）。"""
    if sys.platform == "win32":
        import winreg

        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, _WIN_RUN_KEY) as key:
            winreg.SetValueEx(
                key, WIN_VALUE_NAME, 0, winreg.REG_SZ, build_windows_command()
            )
        return True
    if sys.platform == "darwin":
        target = _safe_target(_MACOS_DIR, _MACOS_FILENAME)
        target.write_bytes(plistlib.dumps(build_macos_plist()))
        return True
    if sys.platform == "linux":
        target = _safe_target(_LINUX_DIR, _LINUX_FILENAME)
        target.write_text(build_linux_desktop(), encoding="utf-8")
        return True
    return False


def disable():
    """注销开机自启动（不存在时静默成功）。"""
    try:
        if sys.platform == "win32":
            import winreg

            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER, _WIN_RUN_KEY, 0, winreg.KEY_SET_VALUE
            ) as key:
                winreg.DeleteValue(key, WIN_VALUE_NAME)
            return True
        if sys.platform == "darwin":
            _safe_target(_MACOS_DIR, _MACOS_FILENAME).unlink(missing_ok=True)
            return True
        if sys.platform == "linux":
            _safe_target(_LINUX_DIR, _LINUX_FILENAME).unlink(missing_ok=True)
            return True
    except FileNotFoundError:
        return True
    return False


def sync(enabled):
    """按开关落盘（界面唯一入口）。返回实际是否处于启用态。"""
    if not is_supported():
        return False
    if enabled:
        return enable()
    disable()
    return False
