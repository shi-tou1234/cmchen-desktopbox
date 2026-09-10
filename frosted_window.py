"""磨砂玻璃窗口基类：无边框、贴桌面层、接受系统拖入。

贴桌面层不能用 Qt 的 WindowStaysOnBottomHint——实测它把窗口压到壁纸层下面
（IsWindowVisible 为 True 但屏幕上完全看不到）。真正可行的是把窗口挂进桌面
窗口层级，见 desktoplayer.py。offscreen（无显示器自检）下不调用任何 Windows
API，只标记 "offscreen"，所以 --selftest 能在没有桌面的环境里跑完且不崩。
"""

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QPainter, QPainterPath
from PySide6.QtWidgets import QWidget

import acrylic
import desktoplayer
import dropfiles

LAYER_WINDOW = desktoplayer.LAYER_WINDOW
LAYER_TOP = desktoplayer.LAYER_TOP
LAYER_DIALOG = desktoplayer.LAYER_DIALOG
LAYER_PROGMAN = desktoplayer.LAYER_PROGMAN
LAYER_WORKERW = desktoplayer.LAYER_WORKERW
LAYER_BOTTOM = desktoplayer.LAYER_BOTTOM

CORNER_RADIUS = 14
# 面板自身的淡底色：磨砂负责"透"，这层负责压暗一点让图标看得清。
PANEL_TINT = QColor(16, 16, 22, 96)


def desktop_layer_flags(layer=LAYER_WINDOW):
    """按层级给窗口标志。

    实测结论（Win11 build 26200）：
    - WindowStaysOnBottomHint：窗口会被压到壁纸层下面，按 Win+D 后彻底看不见。
    - SetParent 到 Progman/WorkerW：DWM 从不合成，同样看不见。
    所以默认用"普通无边框非置顶窗口"——看得见、磨砂生效、不抢焦点、不挡操作；
    想一直浮在最上面就把 layer 设成 top。
    - dialog：给设置面板这类需要键盘输入和焦点的窗口用，不带
      WindowDoesNotAcceptFocus、也不带 Tool（会进任务栏，便于切回来）。
    """
    if layer == LAYER_DIALOG:
        return Qt.FramelessWindowHint | Qt.Window
    flags = Qt.FramelessWindowHint | Qt.Tool | Qt.WindowDoesNotAcceptFocus
    if layer == LAYER_TOP:
        return flags | Qt.WindowStaysOnTopHint
    if layer == LAYER_BOTTOM:
        return flags | Qt.WindowStaysOnBottomHint
    return flags


class FrostedWindow(QWidget):
    """带磨砂效果、可接受文件拖入的无边框窗口。"""

    def __init__(
        self,
        parent=None,
        accent_mode=acrylic.MODE_ACRYLIC,
        layer=LAYER_WINDOW,
        accept_drops=True,
        corner_radius=CORNER_RADIUS,
        translucent=True,
    ):
        super().__init__(parent)
        self.accent_mode = accent_mode
        self.effective_accent = "none"
        self.layer = layer
        self.corner_radius = corner_radius
        self.drop_handler = None
        self.on_top = layer == LAYER_TOP
        self.attached = False
        self.parent_class = ""
        self.paint_count = 0
        self.setWindowFlags(desktop_layer_flags(layer))
        if translucent:
            self.setAttribute(Qt.WA_TranslucentBackground, True)
        if layer != LAYER_DIALOG:
            # 桌面挂件类窗口不该因为显示而抢走焦点；设置面板要能打字，所以豁免
            self.setAttribute(Qt.WA_ShowWithoutActivating, True)
        if accept_drops:
            self.setAcceptDrops(True)

    # ------------------------------------------------------------ 外观

    def apply_effects(self):
        """上磨砂 + 挂桌面层。返回实际生效的磨砂模式名。"""
        if self.__class__.application_platform() != "windows":
            self.effective_accent = "offscreen"
            return self.effective_accent
        hwnd = int(self.winId())
        if self.layer in (LAYER_PROGMAN, LAYER_WORKERW):
            self.attached = desktoplayer.attach_to_desktop(hwnd, self.layer)
            self.parent_class = desktoplayer.parent_class_name(hwnd)
            # 外部 SetParent 会让 Qt 丢掉后备存储，必须主动重画一次
            self.setGeometry(self.geometry())
            self.repaint()
        self.effective_accent = acrylic.apply_frosted(
            hwnd, self.accent_mode, rounded=True
        )
        self.update()
        return self.effective_accent

    @staticmethod
    def application_platform():
        from PySide6.QtGui import QGuiApplication

        app = QGuiApplication.instance()
        return app.platformName() if app is not None else "unknown"

    def paintEvent(self, event):  # noqa: N802 - Qt 命名
        self.paint_count += 1
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing, True)
        painter.setRenderHint(QPainter.TextAntialiasing, True)
        path = QPainterPath()
        rect = self.rect().adjusted(0, 0, -1, -1)
        path.addRoundedRect(rect, self.corner_radius, self.corner_radius)
        painter.fillPath(path, PANEL_TINT)
        painter.end()

    # ------------------------------------------------------------ 拖放

    def dragEnterEvent(self, event):  # noqa: N802
        if self.drop_handler is None or not dropfiles.accepts_drag(event.mimeData()):
            event.ignore()
            return
        event.acceptProposedAction()

    def dragMoveEvent(self, event):  # noqa: N802
        if self.drop_handler is None or not dropfiles.accepts_drag(event.mimeData()):
            event.ignore()
            return
        event.acceptProposedAction()

    def dropEvent(self, event):  # noqa: N802
        """把拖进来的路径交给 drop_handler；没有 handler 就不接受。"""
        if self.drop_handler is None:
            event.ignore()
            return
        paths = dropfiles.paths_from_mime(event.mimeData())
        if not paths:
            event.ignore()
            return
        self.drop_handler(paths)
        event.acceptProposedAction()
