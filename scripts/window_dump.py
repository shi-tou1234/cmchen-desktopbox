"""诊断工具：把当前屏幕上所有可见顶层窗口的样式与层级关系打印出来。

用途：当"贴桌面层"的窗口看不见时，对比一个确实看得见的桌面窗口
（例如 DesktopClock）的样式与父窗口，找出差异。只读，不修改任何东西。
"""

import ctypes
import sys

user32 = ctypes.windll.user32
GWL_STYLE = -16
GWL_EXSTYLE = -20

user32.FindWindowW.restype = ctypes.c_void_p
user32.GetWindowLongW.restype = ctypes.c_long
user32.GetWindowLongW.argtypes = [ctypes.c_void_p, ctypes.c_int]
user32.GetParent.restype = ctypes.c_void_p
user32.GetParent.argtypes = [ctypes.c_void_p]
user32.GetWindowRect.argtypes = [ctypes.c_void_p, ctypes.c_void_p]


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


def class_name(hwnd):
    buffer = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(ctypes.c_void_p(hwnd), buffer, 256)
    return buffer.value


def title(hwnd):
    buffer = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(ctypes.c_void_p(hwnd), buffer, 512)
    return buffer.value


def rect_of(hwnd):
    rect = RECT()
    if not user32.GetWindowRect(ctypes.c_void_p(hwnd), ctypes.byref(rect)):
        return None
    return (rect.left, rect.top, rect.right, rect.bottom)


def describe(hwnd):
    rect = rect_of(hwnd)
    if rect is None:
        return None
    style = user32.GetWindowLongW(ctypes.c_void_p(hwnd), GWL_STYLE) & 0xFFFFFFFF
    exstyle = user32.GetWindowLongW(ctypes.c_void_p(hwnd), GWL_EXSTYLE) & 0xFFFFFFFF
    parent = int(user32.GetParent(ctypes.c_void_p(hwnd)) or 0)
    center = POINT((rect[0] + rect[2]) // 2, (rect[1] + rect[3]) // 2)
    top = int(user32.WindowFromPoint(center) or 0)
    return {
        "hwnd": hwnd,
        "class": class_name(hwnd),
        "title": title(hwnd)[:40],
        "rect": rect,
        "style": style,
        "exstyle": exstyle,
        "visible": bool(user32.IsWindowVisible(ctypes.c_void_p(hwnd))),
        "parent": parent,
        "parent_class": class_name(parent) if parent else "",
        "top_at_center": top,
        "is_top_at_center": top == hwnd,
        "is_layered": bool(exstyle & 0x00080000),
        "is_child": bool(style & 0x40000000),
        "is_toolwindow": bool(exstyle & 0x00000080),
    }


def sanitize_needle(raw):
    """命令行给的过滤词只用来比对窗口标题：限长 + 只保留可见字符，先洗一遍再用。"""
    text = str(raw or "")
    printable = "".join(ch for ch in text if ch.isprintable())
    return printable[:64].lower()


def main(argv):
    needle = sanitize_needle(argv[1] if len(argv) > 1 else "")
    rows = []
    collected = []

    def callback(hwnd, _lparam):
        info = describe(hwnd)
        if info is None:
            return True
        collected.append(info)
        return True

    enum_proc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)(
        callback
    )
    user32.EnumWindows(enum_proc, 0)

    for info in collected:
        if not info["visible"] and not info["is_child"]:
            continue
        blob = ("%s %s %s" % (info["class"], info["title"], info["parent_class"])).lower()
        if needle and needle not in blob:
            continue
        rows.append(info)

    rows.sort(key=lambda r: r["hwnd"])
    print("COUNT %d" % len(rows))
    for info in rows:
        print(
            "HWND %d CLASS %s TITLE %r RECT %s STYLE 0x%08X EX 0x%08X "
            "CHILD %s TOOL %s LAYERED %s PARENT %d/%s VISIBLE %s "
            "TOP_AT_CENTER %d SELF %s"
            % (
                info["hwnd"],
                info["class"],
                info["title"],
                info["rect"],
                info["style"],
                info["exstyle"],
                info["is_child"],
                info["is_toolwindow"],
                info["is_layered"],
                info["parent"],
                info["parent_class"],
                info["visible"],
                info["top_at_center"],
                info["is_top_at_center"],
            )
        )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
