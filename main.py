"""DeskBasket 入口：磨砂文件筐。

用法：
    python main.py                       # 正常启动（后续任务接上筐与浏览器窗口）
    python main.py --probe               # 任务 1 探针：磨砂＋贴桌面层＋拖入自检
    python main.py --probe --win-d       # 探针 + 模拟按 Win+D 后截全屏
    python main.py --probe --simulate-drop <路径>   # 程序内投递真实 QDropEvent
    python main.py --selftest            # 无显示器自检，退出码 0 表示通过
"""

import os
import shutil
import sys
import tempfile
from pathlib import Path

from PySide6.QtCore import QMimeData, QPointF, Qt, QTimer, QUrl
from PySide6.QtGui import QColor, QDropEvent, QGuiApplication, QImage, QPainter, QPen
from PySide6.QtWidgets import QApplication, QLabel, QWidget

import acrylic
import autostart
import baskets
import desktoplayer
import dropfiles
import fileicons
import frosted_window
import settings
from basket_window import BasketWindow
from explorer_window import ExplorerWindow
from frosted_window import LAYER_TOP, LAYER_WINDOW, FrostedWindow

APP_NAME = "DeskBasket"
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))

# 关闭磨砂的兜底底色（系统不支持磨砂时至少是半透明深色面板）
FALLBACK_STYLE = "color: #F2F2F5; font-size: 13px; background: transparent;"


MARKER_COLOR = (255, 0, 255)  # 洋红：只用于取证，正常界面不用


class ProbeWindow(FrostedWindow):
    """任务 1 的探针窗口：只验证"磨砂、贴桌面层、接得住拖入"三件事。"""

    def __init__(
        self,
        accent_mode=acrylic.MODE_ACRYLIC,
        layer=LAYER_WINDOW,
        accept_drops=True,
        marker=False,
        always_on_top=False,
        translucent=True,
        show_label=True,
    ):
        super().__init__(
            accent_mode=accent_mode,
            layer=layer,
            accept_drops=accept_drops,
            translucent=translucent,
        )
        self.setWindowTitle("DeskBasket 探针")
        self.resize(460, 200)
        self.marker = marker
        self.dropped = []
        if show_label:
            # 取证模式不画文字：文字的高频远高于条纹，会污染模糊判据
            label = QLabel("DeskBasket 探针\n把文件拖到这里试试", self)
            label.setAlignment(Qt.AlignCenter)
            label.setStyleSheet(FALLBACK_STYLE)
            label.setGeometry(0, 0, 460, 200)
            label.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        if accept_drops:
            self.drop_handler = self.on_paths

    def on_paths(self, paths):
        for path in paths:
            self.dropped.append(path)
            print("DROP_FILE %s" % path, flush=True)

    def paintEvent(self, event):  # noqa: N802
        super().paintEvent(event)
        if not self.marker:
            return
        painter = QPainter(self)
        pen = QPen(QColor(*MARKER_COLOR))
        pen.setWidth(4)
        painter.setPen(pen)
        painter.setBrush(Qt.NoBrush)
        painter.drawRoundedRect(
            self.rect().adjusted(2, 2, -3, -3), self.corner_radius, self.corner_radius
        )
        painter.end()


# ------------------------------------------------------------------ 投递与截图工具


def build_drop_mime(paths, as_text=False):
    """构造拖放的 MIME 数据。"""
    mime = QMimeData()
    if as_text:
        mime.setText("\n".join(paths))
    else:
        mime.setUrls([QUrl.fromLocalFile(path) for path in paths])
    return mime


def simulate_drop(window, paths, as_text=False):
    """按真实拖放顺序调用窗口的处理函数：dragEnter → dragMove → drop。

    实测 QApplication.sendEvent 投递的 QDropEvent 不会派发到 QWidget.dropEvent
    （Qt 只把真实拖放产生的自发事件交给窗口），所以这里直接调用窗口自己的处理
    函数——被测代码仍然是产品代码路径，不经过任何替身。
    返回 True 表示这次拖放被接受。
    """
    from PySide6.QtCore import QPoint
    from PySide6.QtGui import QDragEnterEvent, QDragMoveEvent

    mime = build_drop_mime(paths, as_text=as_text)
    enter = QDragEnterEvent(
        QPoint(20, 20), Qt.CopyAction, mime, Qt.LeftButton, Qt.NoModifier
    )
    window.dragEnterEvent(enter)
    if not enter.isAccepted():
        return False
    move = QDragMoveEvent(
        QPoint(20, 20), Qt.CopyAction, mime, Qt.LeftButton, Qt.NoModifier
    )
    window.dragMoveEvent(move)
    drop = QDropEvent(
        QPointF(20.0, 20.0), Qt.CopyAction, mime, Qt.LeftButton, Qt.NoModifier
    )
    window.dropEvent(drop)
    return bool(drop.isAccepted())


def send_win_d():
    """用 SendInput 模拟按 Win+D（显示桌面）。非 Windows 返回 False。

    INPUT 结构体必须按 Win32 原样定义（含 MOUSEINPUT 联合体），
    否则 sizeof(INPUT) 对不上，SendInput 会因为 cbSize 不符直接失败。
    """
    import ctypes
    import sys as _sys

    if _sys.platform != "win32":
        return False

    VK_LWIN, VK_D = 0x5B, 0x44
    KEYEVENTF_KEYUP = 0x0002
    INPUT_KEYBOARD = 1

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [
            ("dx", ctypes.c_long),
            ("dy", ctypes.c_long),
            ("mouseData", ctypes.c_ulong),
            ("dwFlags", ctypes.c_ulong),
            ("time", ctypes.c_ulong),
            ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
        ]

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [
            ("wVk", ctypes.c_ushort),
            ("wScan", ctypes.c_ushort),
            ("dwFlags", ctypes.c_ulong),
            ("time", ctypes.c_ulong),
            ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
        ]

    class HARDWAREINPUT(ctypes.Structure):
        _fields_ = [
            ("uMsg", ctypes.c_ulong),
            ("wParamL", ctypes.c_ushort),
            ("wParamH", ctypes.c_ushort),
        ]

    class INPUTUNION(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]

    class INPUT(ctypes.Structure):
        _fields_ = [("type", ctypes.c_ulong), ("u", INPUTUNION)]

    user32 = ctypes.windll.user32
    user32.SendInput.argtypes = [
        ctypes.c_uint,
        ctypes.POINTER(INPUT),
        ctypes.c_int,
    ]
    user32.SendInput.restype = ctypes.c_uint

    def key(vk, flags=0):
        item = INPUT()
        item.type = INPUT_KEYBOARD
        item.u.ki = KEYBDINPUT(vk, 0, flags, 0, None)
        return item

    sequence = [
        key(VK_LWIN),
        key(VK_D),
        key(VK_D, KEYEVENTF_KEYUP),
        key(VK_LWIN, KEYEVENTF_KEYUP),
    ]
    array = (INPUT * len(sequence))(*sequence)
    sent = user32.SendInput(len(sequence), array, ctypes.sizeof(INPUT))
    if sent != len(sequence):
        print(
            "SENDINPUT_SHORT %d/%d input_size=%d last_error=%d"
            % (sent, len(sequence), ctypes.sizeof(INPUT), ctypes.get_last_error()),
            flush=True,
        )
    return sent == len(sequence)


def window_visible(hwnd):
    """窗口在系统眼里是否仍然可见（Win+D 之后的关键判据）。"""
    import ctypes
    import sys as _sys

    if _sys.platform != "win32" or not hwnd:
        return False
    return bool(ctypes.windll.user32.IsWindowVisible(ctypes.c_void_p(hwnd)))


def window_iconic(hwnd):
    """窗口是否被最小化（Win+D 会最小化普通窗口，贴桌面层的应该不会）。"""
    import ctypes
    import sys as _sys

    if _sys.platform != "win32" or not hwnd:
        return False
    return bool(ctypes.windll.user32.IsIconic(ctypes.c_void_p(hwnd)))


def window_rect(hwnd):
    """窗口在屏幕上的矩形 (left, top, right, bottom)；失败返回 None。"""
    import ctypes
    import sys as _sys

    if _sys.platform != "win32" or not hwnd:
        return None

    class RECT(ctypes.Structure):
        _fields_ = [
            ("left", ctypes.c_long),
            ("top", ctypes.c_long),
            ("right", ctypes.c_long),
            ("bottom", ctypes.c_long),
        ]

    rect = RECT()
    ok = ctypes.windll.user32.GetWindowRect(ctypes.c_void_p(hwnd), ctypes.byref(rect))
    if not ok:
        return None
    return (rect.left, rect.top, rect.right, rect.bottom)


def top_window_at_center(hwnd):
    """窗口矩形正中心处，系统认为最顶层的窗口句柄。

    等于自己的 hwnd：说明窗口真的在桌面之上、能被看见和点到。
    等于桌面（Progman/WorkerW）：说明窗口被压在桌面下面，用户看不见。
    """
    import ctypes
    import sys as _sys

    if _sys.platform != "win32" or not hwnd:
        return 0
    rect = window_rect(hwnd)
    if rect is None:
        return 0

    class POINT(ctypes.Structure):
        _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

    point = POINT((rect[0] + rect[2]) // 2, (rect[1] + rect[3]) // 2)
    user32 = ctypes.windll.user32
    return int(user32.WindowFromPoint(point) or 0)


def window_class_name(hwnd):
    """窗口类名，便于认出 Progman / WorkerW / Qt 窗口。"""
    import ctypes
    import sys as _sys

    if _sys.platform != "win32" or not hwnd:
        return ""
    buffer = ctypes.create_unicode_buffer(256)
    ctypes.windll.user32.GetClassNameW(ctypes.c_void_p(hwnd), buffer, 256)
    return buffer.value


def save_screen(path):
    """抓整屏存 PNG。返回 (宽, 高) 或 None。"""
    screen = QGuiApplication.primaryScreen()
    if screen is None:
        return None
    pixmap = screen.grabWindow(0)
    if pixmap.isNull():
        return None
    if not pixmap.save(path, "PNG"):
        return None
    return pixmap.width(), pixmap.height()


def grab_screen_image():
    """抓整屏为 QImage（RGB32），供像素判据使用。"""
    screen = QGuiApplication.primaryScreen()
    if screen is None:
        return None
    pixmap = screen.grabWindow(0)
    if pixmap.isNull():
        return None
    return pixmap.toImage().convertToFormat(QImage.Format_RGB32)


def grab_window_image(hwnd):
    """抓取指定窗口自身的表面（不依赖它是否被其他窗口遮挡）。"""
    screen = QGuiApplication.primaryScreen()
    if screen is None or not hwnd:
        return None
    pixmap = screen.grabWindow(hwnd)
    if pixmap.isNull():
        return None
    return pixmap.toImage().convertToFormat(QImage.Format_RGB32)


def count_marker_pixels(image, color=MARKER_COLOR):
    """数图里有多少像素正好是标记色。

    RGB32 在小端机器上按 B,G,R,A 排列，所以洋红 (255,0,255) 的字节是
    FF 00 FF FF。窗口若真被渲染出来，这个计数必然显著大于 0。
    """
    if image is None:
        return 0
    red, green, blue = color
    needle = bytes((blue, green, red, 255))
    raw = bytes(image.constBits())
    return raw.count(needle)


# ------------------------------------------------------------------ 探针


def run_probe(argv):
    accent_mode = acrylic.MODE_ACRYLIC
    for token in argv:
        if token.startswith("--accent="):
            accent_mode = token.split("=", 1)[1]
    layer = LAYER_WINDOW
    for token in argv:
        if token.startswith("--layer="):
            chosen = token.split("=", 1)[1]
            if chosen in desktoplayer.LAYER_CHOICES:
                layer = chosen
    accept_drops = "--no-accept" not in argv
    marker = "--marker" in argv
    opaque = "--opaque" in argv
    hold_seconds = 0.0
    for token in argv:
        if token.startswith("--hold="):
            hold_seconds = float(token.split("=", 1)[1])
    drop_paths = []
    as_text = "--mime=text" in argv
    for index, token in enumerate(argv):
        if token == "--simulate-drop" and index + 1 < len(argv):
            drop_paths.append(argv[index + 1])

    app = QApplication.instance() or QApplication(argv)
    app.setApplicationName(APP_NAME)
    window = ProbeWindow(
        accent_mode=accent_mode,
        layer=layer,
        accept_drops=accept_drops,
        marker=marker,
        translucent=not opaque,
    )
    window.show()
    app.processEvents()
    hwnd = int(window.winId())
    effective = window.apply_effects()
    app.processEvents()
    # 处理一轮事件，确保 paintEvent 落到原生表面上
    for _ in range(3):
        app.processEvents()
    print(
        "PROBE_OK hwnd=%d accent=%s platform=%s layer=%s attached=%s parent=%s"
        % (
            hwnd,
            effective,
            FrostedWindow.application_platform(),
            layer,
            window.attached,
            window.parent_class,
        ),
        flush=True,
    )
    if marker:
        self_pixels = count_marker_pixels(grab_window_image(hwnd))
        screen_pixels = count_marker_pixels(grab_screen_image())
        print(
            "SELF_GRAB_PIXELS %d SCREEN_PIXELS %d PAINTS %d"
            % (self_pixels, screen_pixels, window.paint_count),
            flush=True,
        )

    if drop_paths:
        accepted = simulate_drop(window, drop_paths, as_text=as_text)
        app.processEvents()
        if accepted and window.dropped:
            print("DROP_ACCEPTED %d" % len(window.dropped), flush=True)
        else:
            print("DROP_REJECTED %d" % len(window.dropped), flush=True)

    if "--win-d" in argv:
        sent = send_win_d()
        print("WIN_D_SENT %s" % sent, flush=True)
        observed = {}

        def finish():
            observed["visible"] = window_visible(hwnd)
            observed["iconic"] = window_iconic(hwnd)
            observed["qt_visible"] = window.isVisible()
            observed["rect"] = window_rect(hwnd)
            top = top_window_at_center(hwnd)
            observed["top_hwnd"] = top
            observed["top_class"] = window_class_name(top)
            observed["on_top_at_center"] = top == hwnd
            image = grab_screen_image()
            observed["marker_pixels"] = count_marker_pixels(image) if marker else -1
            if image is not None:
                image.save(os.path.join(PROJECT_ROOT, "docs", "probe.png"), "PNG")
                observed["shot"] = (image.width(), image.height())
            else:
                observed["shot"] = None
            app.quit()

        QTimer.singleShot(1500, finish)
        app.exec()
        print(
            "WINDOW_VISIBLE %s ICONIC %s QT_VISIBLE %s RECT %s"
            % (
                observed.get("visible"),
                observed.get("iconic"),
                observed.get("qt_visible"),
                observed.get("rect"),
            ),
            flush=True,
        )
        print(
            "CENTER_TOP_HWND %s CLASS %s IS_SELF %s PAINTS %d"
            % (
                observed.get("top_hwnd"),
                observed.get("top_class"),
                observed.get("on_top_at_center"),
                window.paint_count,
            ),
            flush=True,
        )
        if marker:
            marker_pixels = observed.get("marker_pixels") or 0
            verdict = "RENDERED" if marker_pixels > 0 else "NOT_RENDERED"
            print(
                "MARKER_PIXELS %d WINDOW_%s" % (marker_pixels, verdict), flush=True
            )
        if observed.get("shot") is None:
            print("SCREENSHOT_FAIL", flush=True)
            return 1
        print("SCREENSHOT_OK %d %d" % observed["shot"], flush=True)
        if hold_seconds > 0:
            # 保持窗口不动，方便用外部工具独立观察（Qt 自己的截屏可能对
            # 桌面子窗口不成立，必须用第二条路径交叉验证）
            print("HOLDING %d" % hold_seconds, flush=True)
            QTimer.singleShot(int(hold_seconds * 1000), app.quit)
            app.exec()
        window.hide()
        return 0

    if "--keep-open" in argv:
        seconds = 3.0
        for token in argv:
            if token.startswith("--keep-open="):
                seconds = float(token.split("=", 1)[1])
        QTimer.singleShot(int(seconds * 1000), app.quit)
        app.exec()
    window.hide()
    return 0


def region_variance(image, x, y, width, height, step=3):
    """区域内像素亮度方差（稀疏采样），用来判断"糊没糊"。

    清晰的高对比条纹方差很大；被磨砂模糊后局部方差会明显下降。
    注意：单纯加一层半透明底色也会等比降低方差，所以只靠方差没法区分
    "模糊"和"压暗"，判定磨砂要用 region_sharpness。
    """
    if image is None:
        return 0.0
    values = []
    max_x = min(x + width, image.width())
    max_y = min(y + height, image.height())
    for py in range(max(0, y), max_y, step):
        for px in range(max(0, x), max_x, step):
            color = image.pixelColor(px, py)
            values.append((color.red() + color.green() + color.blue()) / 3.0)
    if len(values) < 2:
        return 0.0
    mean = sum(values) / len(values)
    return sum((value - mean) ** 2 for value in values) / len(values)


def region_sharpness(image, x, y, width, height, step=2):
    """区域的高频能量：水平相邻像素亮度差的平均绝对值。

    这是判定"磨砂"的关键指标——真实模糊会把高频大幅削平（比值接近 0），
    而单纯盖一层半透明底色只是把差值等比缩小（比值≈透光率）。
    """
    if image is None:
        return 0.0
    total = 0.0
    count = 0
    max_x = min(x + width, image.width() - 1)
    max_y = min(y + height, image.height())
    for py in range(max(0, y), max_y, step):
        previous = None
        for px in range(max(0, x), max_x, step):
            color = image.pixelColor(px, py)
            value = (color.red() + color.green() + color.blue()) / 3.0
            if previous is not None:
                total += abs(value - previous)
                count += 1
            previous = value
    return (total / count) if count else 0.0


def wait_ms(app, milliseconds):
    """在事件循环里真等一会儿（不是空转 processEvents）。"""
    from PySide6.QtCore import QEventLoop

    loop = QEventLoop()
    QTimer.singleShot(int(milliseconds), loop.quit)
    loop.exec()
    app.processEvents()


class StripeBackdrop(QWidget):
    """高对比条纹背板：磨砂糊没糊，看它后面的条纹就知道了。"""

    def __init__(self):
        super().__init__()
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool)
        self.setGeometry(200, 150, 1000, 700)

    def paintEvent(self, event):  # noqa: N802
        painter = QPainter(self)
        palette = [
            QColor(255, 255, 255),
            QColor(0, 0, 0),
            QColor(230, 30, 30),
            QColor(30, 220, 30),
            QColor(40, 60, 240),
        ]
        band = 12
        for index in range(0, self.width() // band + 1):
            painter.fillRect(
                index * band, 0, band, self.height(), palette[index % len(palette)]
            )
        painter.end()


def run_visual_test(argv):
    """自包含的磨砂观感取证。

    做法：条纹背板 + 磨砂面板，先抓一张"面板还没显示"的原始条纹图，再抓一张
    "面板盖上去"的图，比较同一块区域的高频能量（相邻像素亮度差）。
    真实模糊会把高频削平（比值远小于透光率），只压暗不模糊则接近透光率。
    `--accent=off` 是反向验证：那时必须报 NOT_BLURRED，证明判据不是恒真。
    """
    accent_mode = acrylic.MODE_ACRYLIC
    for token in argv:
        if token.startswith("--accent="):
            accent_mode = token.split("=", 1)[1]

    app = QApplication.instance() or QApplication(argv)
    app.setApplicationName(APP_NAME)
    backdrop = StripeBackdrop()
    backdrop.show()
    app.processEvents()

    window = ProbeWindow(
        accent_mode=accent_mode, layer=LAYER_TOP, marker=True, show_label=False
    )
    window.setGeometry(370, 400, 460, 200)
    window.show()
    app.processEvents()
    effective = window.apply_effects()
    wait_ms(app, 500)

    # 取样区域按**物理**矩形算：GetWindowRect 与 grabWindow(0) 同为物理像素，
    # 逻辑坐标在 125%/150% 缩放下会整体偏移，写死坐标会量到面板外面去。
    panel_rect = window_rect(int(window.winId()))
    backdrop_rect = window_rect(int(backdrop.winId()))
    if not panel_rect or not backdrop_rect:
        print("VISUAL_FAIL 取不到窗口矩形", flush=True)
        return 1

    def sample():
        image = grab_screen_image()
        if image is None:
            return None, None
        return image, (
            panel_rect[0] + 24,
            panel_rect[1] + 40,
        )

    # A) 面板隐藏：原始条纹
    window.hide()
    wait_ms(app, 400)
    hidden_image, (sx, sy) = sample()
    if hidden_image is None:
        print("VISUAL_FAIL 抓屏失败", flush=True)
        return 1

    # B) 面板显示：同一块区域
    window.show()
    window.apply_effects()
    wait_ms(app, 500)
    shown_image, _ = sample()
    if shown_image is None:
        print("VISUAL_FAIL 抓屏失败", flush=True)
        return 1
    shown_image.save(os.path.join(PROJECT_ROOT, "docs", "probe_visual.png"), "PNG")

    sample_w, sample_h = 240, 60
    sharp_hidden = region_sharpness(hidden_image, sx, sy, sample_w, sample_h)
    sharp_shown = region_sharpness(shown_image, sx, sy, sample_w, sample_h)
    ratio = (sharp_shown / sharp_hidden) if sharp_hidden else 0.0
    tint_transmittance = 1.0 - (frosted_window.PANEL_TINT.alpha() / 255.0)

    print("VISUAL_ACCENT %s" % effective, flush=True)
    print(
        "PANEL_RECT %s BACKDROP_RECT %s SAMPLE_AT (%d,%d) IMAGE %dx%d"
        % (panel_rect, backdrop_rect, sx, sy, shown_image.width(), shown_image.height()),
        flush=True,
    )
    print(
        "SHARPNESS_HIDDEN %.2f SHOWN %.2f RATIO %.3f TINT_TRANSMITTANCE %.2f"
        % (sharp_hidden, sharp_shown, ratio, tint_transmittance),
        flush=True,
    )
    print(
        "BLUR_VERDICT %s"
        % ("BLURRED" if sharp_hidden and ratio < 0.5 else "NOT_BLURRED"),
        flush=True,
    )
    print("VISUAL_OK %d %d" % (shown_image.width(), shown_image.height()), flush=True)
    window.hide()
    backdrop.hide()
    return 0


def data_root():
    """数据/产物根目录：源码运行＝项目根；onefile 打包后＝exe 所在目录。

    onefile 运行时 __file__ 指向临时解包目录，直接拿它拼路径会指向一个
    只读且随时消失的地方，所以冻结态要用可执行文件所在目录。
    """
    if getattr(sys, "frozen", False):
        return str(Path(sys.executable).resolve().parent)
    return PROJECT_ROOT


def app_dirs(base=None):
    """配置目录与图标缓存目录。base 参数只给测试用。"""
    config_dir = Path(base) if base else Path(settings.settings_dir())
    return config_dir, config_dir / fileicons.CACHE_DIR_NAME


def build_icon_cache(config_dir, icon_size):
    return fileicons.IconCache(
        size=icon_size, disk_dir=config_dir / fileicons.CACHE_DIR_NAME
    )


def ensure_basket(settings_data, name="桌面文件筐"):
    """保证至少有一个筐；没有就建一个空筐（不自动分类，靠拖入）。"""
    if settings_data.get("baskets"):
        return settings_data
    updated, _basket = baskets.create_basket([], name=name, x=90, y=110)
    settings_data = dict(settings_data)
    settings_data["baskets"] = updated
    return settings_data


def desktop_items(limit=None):
    """桌面上的条目路径（只读目录列表，不碰文件）。"""
    root = os.path.join(os.environ.get("USERPROFILE", str(Path.home())), "Desktop")
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return []
    paths = [os.path.join(root, name) for name in names if name != "desktop.ini"]
    return paths[:limit] if limit else paths


def wait_until(predicate, timeout_ms=4000, step_ms=20):
    """等条件成立（用于等分批渲染完成），超时返回 False。"""
    from PySide6.QtCore import QEventLoop

    waited = 0
    while waited <= timeout_ms:
        if predicate():
            return True
        loop = QEventLoop()
        QTimer.singleShot(step_ms, loop.quit)
        loop.exec()
        waited += step_ms
    return predicate()


class DeskBasketApp:
    """把设置、筐窗口、浏览器窗口、托盘串起来。"""

    def __init__(self, app, base=None, demo_fill=0):
        self.app = app
        self.base = base
        self.config_dir, self.icon_dir = app_dirs(base)
        self.settings = ensure_basket(settings.load_settings(base=self.base))
        self.icon_cache = build_icon_cache(self.config_dir, self.settings["icon_size"])
        self.basket_windows = []
        self.explorer_windows = []
        self.tray = None
        if demo_fill:
            self._fill_demo(demo_fill)

    def _fill_demo(self, count):
        """仅用于截图取证：把桌面前 count 个条目登记进第一个筐（同一套拖入代码路径）。"""
        if not self.settings["baskets"]:
            return
        first = self.settings["baskets"][0]
        for path in desktop_items(count):
            first, _result = baskets.add_item(first, path)
        self.settings["baskets"][0] = first

    # ------------------------------------------------------------ 筐

    def save(self):
        settings.save_settings(self.settings, base=self.base)

    def _on_basket_changed(self, basket):
        updated = []
        for existing in self.settings["baskets"]:
            updated.append(basket if existing.get("id") == basket.get("id") else existing)
        self.settings["baskets"] = updated
        self.save()

    def open_explorer(self, path):
        window = ExplorerWindow(
            path,
            self.icon_cache,
            accent_mode=self.settings["accent_mode"],
            icon_size=self.settings["icon_size"],
            layer=self.settings.get("layer", LAYER_WINDOW),
        )
        window.show()
        window.apply_effects()
        self.explorer_windows.append(window)
        return window

    def build_windows(self):
        for basket in self.settings["baskets"]:
            window = BasketWindow(
                basket,
                self.icon_cache,
                on_changed=self._on_basket_changed,
                on_open_explorer=self.open_explorer,
                accent_mode=self.settings["accent_mode"],
                icon_size=self.settings["icon_size"],
                layer=self.settings.get("layer", LAYER_WINDOW),
            )
            window.show()
            window.apply_effects()
            self.basket_windows.append(window)
        return self.basket_windows

    def add_basket(self):
        updated, new_basket = baskets.create_basket(self.settings["baskets"])
        self.settings["baskets"] = updated
        self.save()
        window = BasketWindow(
            new_basket,
            self.icon_cache,
            on_changed=self._on_basket_changed,
            on_open_explorer=self.open_explorer,
            accent_mode=self.settings["accent_mode"],
            icon_size=self.settings["icon_size"],
            layer=self.settings.get("layer", LAYER_WINDOW),
        )
        window.show()
        window.apply_effects()
        self.basket_windows.append(window)
        return window

    # ------------------------------------------------------------ 托盘

    def install_tray(self):
        from PySide6.QtGui import QIcon
        from PySide6.QtWidgets import QMenu, QSystemTrayIcon

        if not QSystemTrayIcon.isSystemTrayAvailable():
            return None
        tray = QSystemTrayIcon(self.app.windowIcon(), self.app)
        tray.setToolTip(APP_NAME)
        menu = QMenu()
        menu.addAction("显示所有筐", self.show_all)
        menu.addAction("新建文件筐", self.add_basket)
        menu.addSeparator()
        autostart_action = menu.addAction("开机自启动")
        autostart_action.setCheckable(True)
        autostart_action.setChecked(self.settings.get("autostart", False))
        autostart_action.toggled.connect(self.toggle_autostart)
        menu.addAction("退出", self.app.quit)
        tray.setContextMenu(menu)
        tray.show()
        self.tray = tray
        return tray

    def show_all(self):
        for window in self.basket_windows:
            window.show()
            window.apply_effects()

    def toggle_autostart(self, enabled):
        autostart.sync(enabled)
        self.settings["autostart"] = bool(enabled)
        self.save()


def run_app(argv):
    """正常启动。"""
    app = QApplication.instance() or QApplication(argv)
    app.setApplicationName(APP_NAME)
    app.setOrganizationName(APP_NAME)
    app.setQuitOnLastWindowClosed(False)

    demo_fill = 0
    for token in argv:
        if token.startswith("--demo-fill="):
            demo_fill = int(token.split("=", 1)[1])
    state = DeskBasketApp(app, demo_fill=demo_fill)
    state.build_windows()
    state.install_tray()
    if state.settings.get("autostart"):
        autostart.sync(True)
    return app.exec()


def run_screenshot(argv):
    """真机截图取证：显示筐（和浏览器窗口）后抓整屏。"""
    from basket_window import BasketWindow
    from explorer_window import ExplorerWindow

    app = QApplication.instance() or QApplication(argv)
    app.setApplicationName(APP_NAME)
    state = DeskBasketApp(app, demo_fill=12)
    windows = state.build_windows()
    if windows:
        windows[0].setGeometry(160, 200, 520, 360)
        explorer = state.open_explorer(str(Path.home() / "Desktop"))
        explorer.setGeometry(720, 240, 700, 480)
        wait_until(lambda: not explorer._pending, timeout_ms=6000)
    wait_ms(app, 900)
    target = os.path.join(data_root(), "docs", "screenshot.png")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    size = save_screen(target)
    for window in list(state.basket_windows) + list(state.explorer_windows):
        window.hide()
    if size is None:
        print("SCREENSHOT_FAIL", flush=True)
        return 1
    print("SCREENSHOT_OK %d %d" % size, flush=True)
    return 0


def run_autostart_cli(argv):
    """--autostart on|off|status。"""
    mode = "status"
    for index, token in enumerate(argv):
        if token == "--autostart" and index + 1 < len(argv):
            mode = argv[index + 1]
    if mode == "on":
        autostart.enable()
    elif mode == "off":
        autostart.disable()
    enabled = autostart.is_enabled()
    print(
        "AUTOSTART %s enabled=%s command=%s"
        % (mode, enabled, autostart.current_command() or "(空)"),
        flush=True,
    )
    return 0


def run_selftest(argv):
    """无显示器自检：建窗、渲染、渲染分批、检查不空。退出码 0 表示通过。"""
    from basket_window import BasketWindow
    from explorer_window import ExplorerWindow

    app = QApplication.instance() or QApplication(argv)
    app.setApplicationName(APP_NAME)

    index = argv.index("--config") if "--config" in argv else -1
    if index >= 0 and index + 1 < len(argv) and not os.path.isdir(argv[index + 1]):
        print("SELFTEST_FAIL_config: 配置目录不存在", flush=True)
        return 1

    window = ProbeWindow()
    window.show()
    app.processEvents()
    pixmap = window.grab()
    if pixmap.isNull() or pixmap.width() <= 0 or pixmap.height() <= 0:
        print("SELFTEST_FAIL_probe: 渲染出空帧", flush=True)
        return 1
    print("SELFTEST_OK_probe %d %d" % (pixmap.width(), pixmap.height()), flush=True)
    window.hide()

    # 拖放解析的端到端确认：真的 QMimeData → 真的路径
    sample = os.path.join(PROJECT_ROOT, "main.py")
    mime = QMimeData()
    mime.setUrls([QUrl.fromLocalFile(sample)])
    parsed = dropfiles.paths_from_mime(mime)
    if parsed != [os.path.normpath(sample)]:
        print("SELFTEST_FAIL_drop: %r" % (parsed,), flush=True)
        return 1
    print("SELFTEST_OK_drop %d" % len(parsed), flush=True)

    # 筐窗口：用自建的临时目录当"真实文件"，这样源码跑和 exe 跑结果一致
    # （onefile 打包后 __file__ 在临时解包目录里，拿项目文件当真实文件会全判失效）
    workdir = tempfile.mkdtemp(prefix="deskbasket-selftest-")
    real_files = []
    for _ in range(4):
        handle, path = tempfile.mkstemp(dir=workdir, prefix="样本", suffix=".txt")
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write("selftest")
        real_files.append(path)
    os.makedirs(os.path.join(workdir, "子目录"), exist_ok=True)
    ghost = os.path.join(workdir, "不存在的文件.txt")

    cache = fileicons.IconCache(size=48)
    test_basket = baskets.normalize_basket(
        {"id": "selftest", "name": "自检筐", "items": real_files + [ghost]}
    )
    basket_window = BasketWindow(test_basket, cache, on_changed=None)
    basket_window.show()
    app.processEvents()
    frame = basket_window.grab()
    if frame.isNull() or frame.width() <= 0:
        print("SELFTEST_FAIL_basket: 渲染出空帧", flush=True)
        return 1
    count = basket_window.model.rowCount()
    if count != 5:
        print("SELFTEST_FAIL_basket: 期望 5 个条目，实际 %d" % count, flush=True)
        return 1
    missing = len(baskets.missing_items(basket_window.basket))
    if missing != 1:
        print("SELFTEST_FAIL_basket: 失效项应为 1，实际 %d" % missing, flush=True)
        return 1
    print("SELFTEST_OK_basket %d" % count, flush=True)
    basket_window.hide()

    # 浏览器窗口：真的列一个目录，并等分批渲染走完
    explorer = ExplorerWindow(workdir, cache)
    explorer.show()
    app.processEvents()
    finished = wait_until(lambda: not explorer._pending, timeout_ms=6000)
    listed = explorer.model.rowCount()
    if not finished or listed != 5:
        print(
            "SELFTEST_FAIL_explorer: 期望列出 5 项，实际 %d（渲染完成=%s）"
            % (listed, finished),
            flush=True,
        )
        return 1
    print("SELFTEST_OK_explorer %d" % listed, flush=True)

    # 钻进子目录再退回来
    if not explorer.navigate_to(os.path.join(workdir, "子目录")):
        print("SELFTEST_FAIL_explorer: 进不去子目录", flush=True)
        return 1
    if not explorer.go_up():
        print("SELFTEST_FAIL_explorer: 退不回上级", flush=True)
        return 1

    # 已经在根时"上一级"必须置灰
    explorer.navigate_to(os.path.splitdrive(workdir)[0] + os.sep)
    app.processEvents()
    if explorer.up_button.isEnabled():
        print("SELFTEST_FAIL_explorer: 已在根目录但上一级仍可点", flush=True)
        return 1
    explorer.hide()
    shutil.rmtree(workdir, ignore_errors=True)
    return 0


def main():
    argv = sys.argv[1:]
    if "--probe" in argv:
        return run_probe(argv)
    if "--visual" in argv:
        return run_visual_test(argv)
    if "--autostart" in argv:
        return run_autostart_cli(argv)
    if "--screenshot" in argv:
        return run_screenshot(argv)
    if "--selftest" in argv:
        return run_selftest(argv)
    return run_app(argv)


if __name__ == "__main__":
    sys.exit(main())
