"""列出所有 DeskBasket 窗口，标出它是 Electron 版还是旧 Qt 版，以及所属进程。

用途：确认"看到的那个会收起的 Dock / 深色面板"到底属于哪个版本。
"""

import ctypes
from ctypes import wintypes

user32 = ctypes.windll.user32
k32 = ctypes.windll.kernel32
k32.OpenProcess.restype = ctypes.c_void_p
k32.QueryFullProcessImageNameW.argtypes = [
    ctypes.c_void_p,
    ctypes.c_ulong,
    ctypes.c_wchar_p,
    ctypes.POINTER(ctypes.c_ulong),
]

SEP = chr(92)  # 反斜杠，避免转义问题


def process_name(pid):
    handle = k32.OpenProcess(0x1000, False, pid)
    if not handle:
        return "?"
    buffer = ctypes.create_unicode_buffer(512)
    size = ctypes.c_ulong(512)
    ok = k32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size))
    k32.CloseHandle(handle)
    return buffer.value.split(SEP)[-1] if ok else "?"


rows = []


def callback(hwnd, _lparam):
    buffer = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(hwnd, buffer, 256)
    title = buffer.value
    if "文件筐" in title or "DeskBasket" in title:
        cls = ctypes.create_unicode_buffer(128)
        user32.GetClassNameW(hwnd, cls, 128)
        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        rows.append(
            (
                title,
                cls.value,
                (rect.left, rect.top, rect.right, rect.bottom),
                bool(user32.IsWindowVisible(hwnd)),
                pid.value,
                process_name(pid.value),
            )
        )
    return True


user32.EnumWindows(
    ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)(callback), 0
)

print("匹配窗口数:", len(rows))
for title, cls, rect, visible, pid, name in rows:
    if cls.startswith("Chrome"):
        kind = "Electron(新版)"
    elif cls.startswith("Qt"):
        kind = "Qt(旧版!!)"
    else:
        kind = cls
    print("  [%s] %-22s rect=%-26s visible=%-5s pid=%s proc=%s" % (
        kind, title, rect, visible, pid, name
    ))
