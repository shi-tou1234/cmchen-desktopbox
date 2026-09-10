"""把窗口挂到 Windows 桌面层级里（贴桌面层）。

背景（已实测）：Qt 的 Qt.WindowStaysOnBottomHint 只是把窗口 SetWindowPos 到
HWND_BOTTOM，而现代 Windows 的桌面（Progman / WorkerW）就位于 z 序最底部，
结果是窗口被压在壁纸层下面——`IsWindowVisible` 返回 True，但用户在屏幕上
完全看不到它（实测窗口中心处的最顶层窗口是桌面图标列表 SysListView32）。

可行做法是把窗口 SetParent 到桌面窗口之下，成为桌面的一部分：

- PROGMAN：挂到 Progman，并把窗口提到 Progman 子窗口的最上层 →
  位于桌面图标「之上」、所有普通窗口「之下」，Win+D 后仍在。这是想要的形态。
- WORKERW：挂到承载壁纸的 WorkerW → 位于桌面图标「之下」，图标会盖住面板。

两种都需要把窗口从弹出式改成子窗口样式（WS_CHILD），否则不会跟随父窗口绘制。
拿不到句柄或非 Windows 时全部静默返回 False。
"""

import ctypes
import sys

IS_WINDOWS = sys.platform == "win32"

LAYER_WINDOW = "window"      # 普通无边框非置顶窗口（默认，实测唯一能看见的桌面形态）
LAYER_TOP = "top"            # 置顶悬浮
LAYER_PROGMAN = "progman"    # 挂 Progman 子窗口（实测：能命中但完全不渲染）
LAYER_WORKERW = "workerw"    # 挂壁纸 WorkerW（实测：同上）
LAYER_BOTTOM = "bottom"      # Qt WindowStaysOnBottomHint（实测：Win+D 后被压到壁纸下）
LAYER_CHOICES = (LAYER_WINDOW, LAYER_TOP, LAYER_PROGMAN, LAYER_WORKERW, LAYER_BOTTOM)

GWL_STYLE = -16
WS_CHILD = 0x40000000
WS_POPUP = 0x80000000

HWND_TOP = 0
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOACTIVATE = 0x0010
SWP_FRAMECHANGED = 0x0020
SWP_SHOWWINDOW = 0x0040

WM_SPAWN_WORKER = 0x052C


def _bind(user32):
    """显式声明参数/返回类型，避免 HWND 被截断、样式值溢出有符号长整型。"""
    user32.FindWindowW.restype = ctypes.c_void_p
    user32.FindWindowW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p]
    user32.FindWindowExW.restype = ctypes.c_void_p
    user32.FindWindowExW.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_wchar_p,
        ctypes.c_wchar_p,
    ]
    user32.GetWindowLongW.restype = ctypes.c_long
    user32.GetWindowLongW.argtypes = [ctypes.c_void_p, ctypes.c_int]
    user32.SetWindowLongW.restype = ctypes.c_long
    user32.SetWindowLongW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_uint32]
    user32.SetParent.restype = ctypes.c_void_p
    user32.SetParent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    user32.GetParent.restype = ctypes.c_void_p
    user32.GetParent.argtypes = [ctypes.c_void_p]
    user32.SetWindowPos.restype = ctypes.c_bool
    user32.SetWindowPos.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_uint,
    ]
    user32.EnumWindows.restype = ctypes.c_bool
    return user32


def _user32():
    if not IS_WINDOWS:
        return None
    try:
        return _bind(ctypes.windll.user32)
    except (AttributeError, OSError):
        return None


def _valid(hwnd):
    return IS_WINDOWS and isinstance(hwnd, int) and hwnd != 0


def find_desktop_windows():
    """返回 (Progman 句柄, 承载壁纸的 WorkerW 句柄)。找不到给 0。"""
    user32 = _user32()
    if user32 is None:
        return 0, 0
    progman = int(user32.FindWindowW("Progman", None) or 0)
    if progman:
        # 让 Progman 生成/唤醒承载壁纸的 WorkerW
        user32.SendMessageTimeoutW(
            ctypes.c_void_p(progman), WM_SPAWN_WORKER, 0, 0, 0, 1000, None
        )
    worker = [0]

    def callback(hwnd, _lparam):
        if user32.FindWindowExW(hwnd, 0, "SHELLDLL_DefView", None):
            found = user32.FindWindowExW(0, hwnd, "WorkerW", None)
            if found:
                worker[0] = int(found)
        return True

    enum_proc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)(
        callback
    )
    user32.EnumWindows(enum_proc, 0)
    return progman, worker[0]


def current_style(hwnd):
    """当前窗口样式（按无符号 32 位读，避免最高位被当成符号位）。"""
    user32 = _user32()
    if not _valid(hwnd) or user32 is None:
        return 0
    return user32.GetWindowLongW(ctypes.c_void_p(hwnd), GWL_STYLE) & 0xFFFFFFFF


def make_child(hwnd):
    """把弹出式窗口改成子窗口样式（SetParent 的前置条件）。"""
    user32 = _user32()
    if not _valid(hwnd) or user32 is None:
        return False
    style = current_style(hwnd)
    new_style = ((style | WS_CHILD) & ~WS_POPUP) & 0xFFFFFFFF
    if new_style != style:
        user32.SetWindowLongW(ctypes.c_void_p(hwnd), GWL_STYLE, new_style)
    return True


def attach_to_desktop(hwnd, layer=LAYER_PROGMAN):
    """把窗口挂到桌面窗口层级。成功返回 True。

    注意：实测在 Win11 build 26200 上，挂进 Progman / WorkerW 的子窗口虽然能
    通过命中测试（WindowFromPoint 返回自己），但 DWM 从不把它合成到屏幕上，
    肉眼完全看不见（透明/不透明、有磨砂/无磨砂都一样）。所以这两个 mode 只保留
    作为可复现的实验入口，正常使用不要走这条路。
    """
    if not _valid(hwnd) or layer not in (LAYER_PROGMAN, LAYER_WORKERW):
        return False
    user32 = _user32()
    if user32 is None:
        return False
    progman, worker = find_desktop_windows()
    target = progman if layer == LAYER_PROGMAN else (worker or progman)
    if not target:
        return False
    make_child(hwnd)
    user32.SetParent(ctypes.c_void_p(hwnd), ctypes.c_void_p(target))
    # SetParent 成功时也可能返回 NULL（原父窗口为空），所以反查确认
    actual = int(user32.GetParent(ctypes.c_void_p(hwnd)) or 0)
    if actual != target:
        return False
    flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW
    user32.SetWindowPos(
        ctypes.c_void_p(hwnd), ctypes.c_void_p(HWND_TOP), 0, 0, 0, 0, flags
    )
    return True


def detach_from_desktop(hwnd):
    """把窗口从桌面父窗口摘出来（退出/切换层时用）。"""
    user32 = _user32()
    if not _valid(hwnd) or user32 is None:
        return False
    user32.SetParent(ctypes.c_void_p(hwnd), None)
    style = current_style(hwnd)
    user32.SetWindowLongW(
        ctypes.c_void_p(hwnd), GWL_STYLE, ((style & ~WS_CHILD) | WS_POPUP) & 0xFFFFFFFF
    )
    return True


def window_class_name(hwnd):
    """窗口类名，便于日志与自检查看挂到了谁下面。"""
    user32 = _user32()
    if not _valid(hwnd) or user32 is None:
        return ""
    buffer = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(ctypes.c_void_p(hwnd), buffer, 256)
    return buffer.value


def parent_class_name(hwnd):
    """窗口的父窗口类名；无父窗口返回空串。"""
    user32 = _user32()
    if not _valid(hwnd) or user32 is None:
        return ""
    parent = int(user32.GetParent(ctypes.c_void_p(hwnd)) or 0)
    return window_class_name(parent) if parent else ""
