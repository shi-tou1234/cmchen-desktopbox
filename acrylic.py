"""磨砂玻璃与圆角：ctypes 直调 DWM 与未文档化合成 API，不引入第三方美化库。

两种模式：
- "acrylic"：ACCENT_ENABLE_ACRYLICBLURBEHIND(4)，Win11 上质感最好，但拖动时
  部分机器会有延迟感。
- "blur"：ACCENT_ENABLE_BLURBEHIND(3)，更轻更跟手，观感略弱。

拿不到窗口句柄（hwnd 为 0/None）或不在 Windows 上时，所有函数静默返回 False，
绝不抛异常——offscreen 自检和单元测试都会走到这条路径。
"""

import ctypes
import sys

IS_WINDOWS = sys.platform == "win32"

ACCENT_DISABLED = 0
ACCENT_ENABLE_BLURBEHIND = 3
ACCENT_ENABLE_ACRYLICBLURBEHIND = 4

MODE_ACRYLIC = "acrylic"
MODE_BLUR = "blur"
MODE_OFF = "off"
ACCENT_STATES = {
    MODE_ACRYLIC: ACCENT_ENABLE_ACRYLICBLURBEHIND,
    MODE_BLUR: ACCENT_ENABLE_BLURBEHIND,
    MODE_OFF: ACCENT_DISABLED,
}

WCA_ACCENT_POLICY = 19

DWMWA_USE_IMMERSIVE_DARK_MODE = 20
DWMWA_WINDOW_CORNER_PREFERENCE = 33
DWMWA_SYSTEMBACKDROP_TYPE = 38
DWMWCP_DEFAULT = 0
DWMWCP_DONOTROUND = 1
DWMWCP_ROUND = 2

DWMSBT_AUTO = 0
DWMSBT_MAINWINDOW = 2
DWMSBT_TRANSIENTWINDOW = 3
DWMSBT_TABBEDWINDOW = 4

# 0xAABBGGRR：alpha 越高磨砂底色越实。0x99 在深色壁纸上观感较稳。
DEFAULT_TINT = 0x99101014


class ACCENT_POLICY(ctypes.Structure):
    _fields_ = [
        ("AccentState", ctypes.c_int),
        ("AccentFlags", ctypes.c_int),
        ("GradientColor", ctypes.c_uint),
        ("AnimationId", ctypes.c_int),
    ]


class WINDOWCOMPOSITIONATTRIBDATA(ctypes.Structure):
    _fields_ = [
        ("Attribute", ctypes.c_int),
        ("Data", ctypes.c_void_p),
        ("SizeOfData", ctypes.c_size_t),
    ]


def _user32():
    if not IS_WINDOWS:
        return None
    try:
        return ctypes.windll.user32
    except (AttributeError, OSError):
        return None


def _dwmapi():
    if not IS_WINDOWS:
        return None
    try:
        return ctypes.windll.dwmapi
    except (AttributeError, OSError):
        return None


def _valid(hwnd):
    return IS_WINDOWS and isinstance(hwnd, int) and hwnd != 0


def apply_accent(hwnd, mode=MODE_ACRYLIC, tint=DEFAULT_TINT):
    """给窗口套上磨砂/模糊。成功返回 True；句柄无效或系统不支持返回 False。"""
    if not _valid(hwnd):
        return False
    state = ACCENT_STATES.get(mode)
    if state is None or state == ACCENT_DISABLED:
        return clear_accent(hwnd)
    user32 = _user32()
    if user32 is None:
        return False
    policy = ACCENT_POLICY()
    policy.AccentState = state
    policy.AccentFlags = 0
    policy.GradientColor = tint
    policy.AnimationId = 0
    data = WINDOWCOMPOSITIONATTRIBDATA()
    data.Attribute = WCA_ACCENT_POLICY
    data.Data = ctypes.cast(ctypes.pointer(policy), ctypes.c_void_p)
    data.SizeOfData = ctypes.sizeof(policy)
    try:
        user32.SetWindowCompositionAttribute(
            ctypes.c_void_p(hwnd), ctypes.byref(data)
        )
    except (AttributeError, OSError):
        return False
    return True


def clear_accent(hwnd):
    """撤掉磨砂效果。"""
    if not _valid(hwnd):
        return False
    user32 = _user32()
    if user32 is None:
        return False
    policy = ACCENT_POLICY()
    policy.AccentState = ACCENT_DISABLED
    policy.AccentFlags = 0
    policy.GradientColor = 0
    policy.AnimationId = 0
    data = WINDOWCOMPOSITIONATTRIBDATA()
    data.Attribute = WCA_ACCENT_POLICY
    data.Data = ctypes.cast(ctypes.pointer(policy), ctypes.c_void_p)
    data.SizeOfData = ctypes.sizeof(policy)
    try:
        user32.SetWindowCompositionAttribute(
            ctypes.c_void_p(hwnd), ctypes.byref(data)
        )
    except (AttributeError, OSError):
        return False
    return True


def _set_dwm_attr(hwnd, attribute, value):
    if not _valid(hwnd):
        return False
    dwmapi = _dwmapi()
    if dwmapi is None:
        return False
    try:
        result = dwmapi.DwmSetWindowAttribute(
            ctypes.c_void_p(hwnd),
            ctypes.c_uint(attribute),
            ctypes.byref(ctypes.c_int(value)),
            ctypes.sizeof(ctypes.c_int),
        )
    except (AttributeError, OSError):
        return False
    return result == 0


def apply_rounded_corners(hwnd, rounded=True):
    """Win11 圆角；系统不支持时返回 False（不影响功能）。"""
    preference = DWMWCP_ROUND if rounded else DWMWCP_DONOTROUND
    return _set_dwm_attr(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, preference)


def apply_dark_titlebar(hwnd, dark=True):
    """无边框窗口用不到标题栏，但深色模式会影响系统绘制的阴影/边框。"""
    return _set_dwm_attr(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, 1 if dark else 0)


def apply_system_backdrop(hwnd, kind=DWMSBT_TRANSIENTWINDOW):
    """Win11 22H2+ 的系统级背景材质；失败返回 False，由 Acrylic 兜底。"""
    return _set_dwm_attr(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, kind)


def apply_frosted(hwnd, mode=MODE_ACRYLIC, tint=DEFAULT_TINT, rounded=True):
    """一站式上效果。返回实际生效的模式字符串，供日志与自检断言。

    返回值："acrylic" / "blur" / "off"（off＝明确要求不上磨砂）/
    "none"（系统不支持，调用方应自行用半透明底色兜底，不要因为没磨砂就崩）。
    """
    if not _valid(hwnd):
        return MODE_OFF
    apply_dark_titlebar(hwnd, True)
    if rounded:
        apply_rounded_corners(hwnd, True)
    if mode == MODE_OFF:
        return MODE_OFF
    want = MODE_BLUR if mode == MODE_BLUR else MODE_ACRYLIC
    if apply_accent(hwnd, want, tint):
        return want
    if want != MODE_BLUR and apply_accent(hwnd, MODE_BLUR, tint):
        return MODE_BLUR
    return "none"


def accent_state_value(mode):
    """模式名到 AccentState 数值；未知模式按 acrylic 处理。"""
    return ACCENT_STATES.get(mode, ACCENT_ENABLE_ACRYLICBLURBEHIND)


def describe_platform():
    """一行平台说明，自检时打印，便于判断磨砂为何不生效。"""
    return "win32" if IS_WINDOWS else sys.platform
