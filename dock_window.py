"""Dock 窗口：屏幕底部的磨砂图标栏，悬浮自动隐藏。

形态（任务书已定的板）：
- 层级＝置顶悬浮。第一份已实测此层级磨砂能正常渲染；「贴桌面层」已实测做不到。
- 不用 AppBar、不预留屏幕空间，平时整体移出屏幕可视区，完全不可见。
- 鼠标进底部热区滑出，离开 400ms 后收起，前台全屏时绝不弹出。
- 轮询 QCursor.pos() 判热区，不装全局钩子、不提权。

决策逻辑全在 dockmodel.py 的纯函数里，本模块只负责"把决定落到窗口上"。
"""

import math
import sys

from PySide6.QtCore import QPoint, QPropertyAnimation, QRect, QSize, Qt, QTimer
from PySide6.QtGui import (
    QColor,
    QDesktopServices,
    QLinearGradient,
    QPainter,
    QPainterPath,
    QPen,
    QStandardItem,
    QStandardItemModel,
)
from PySide6.QtWidgets import (
    QListView,
    QMenu,
    QStyle,
    QStyledItemDelegate,
)

import dockmodel
import dropfiles
import fileicons
import icongrid
from frosted_window import LAYER_TOP, FrostedWindow

PATH_ROLE = Qt.UserRole + 1
WIN32 = sys.platform == "win32"

POLL_INTERVAL_MS = 60
BAR_PADDING = 10
BAR_MARGIN = 4
MIN_BAR_WIDTH = 220
MAX_BAR_WIDTH_RATIO = 0.9

# Dock 参照 Nexus 官方观感：一条半透明承托条（shelf）＋ 悬停放大 ＋ 名称只在悬停时显示。
# 领导先前要求"Dock 不要有背景"，但随后明确要"照 Nexus 官方模仿"——Nexus 本体就有
# 承托条，所以这里做成很淡的渐变玻璃（能透出桌面，不是实心条），两者兼顾。
# 必须给窗口挂一个 DWM 材质，否则这台机器上"半透明无材质"的窗口根本不上屏
# （实测：同一窗口不透明时屏幕亮度 50.3 可见，去掉不透明后 201.4 完全看不到）。
DOCK_ACCENT_MODE = "acrylic"
MAX_SCALE = 1.45             # 悬停时图标最大放大倍数（越大上方余量越多，条越厚）
INFLUENCE_RATIO = 2.3        # 放大影响半径 = 图标尺寸 × 该系数
ICON_GAP = 6                 # 图标之间的最小间隙
HEADROOM_EXTRA = 4           # 余量再留一点，给悬停名称用
LABEL_STRIP = 4              # 图标底下留一点边，避免贴到承托条下沿

SHELF_TOP = QColor(255, 255, 255, 30)
SHELF_BOTTOM = QColor(8, 10, 16, 148)
SHELF_RIM = QColor(255, 255, 255, 64)
LABEL_TEXT = QColor(245, 246, 250)
LABEL_BG = QColor(12, 14, 20, 216)

LIST_STYLE = """
QListView { background: transparent; border: none; outline: none; }
QListView::item { color: #EEEFF2; border-radius: 10px; padding: 3px; }
QListView::item:hover { background: rgba(255,255,255,0.16); }
QListView::item:selected { background: rgba(255,255,255,0.22); }
"""


def taskbar_top_logical(screen_rect):
    """底部任务栏当前的上沿（Qt 逻辑像素）；任务栏不在底部或已隐藏时返回 None。

    任务栏是自动隐藏的，隐藏时它的矩形会被移到屏幕外（bottom ≥ 屏幕底边），
    所以这里能顺便区分"正在显示"和"已隐藏"：只有真的显示出来才需要给 Dock 让位。
    """
    if not WIN32 or not screen_rect:
        return None
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        user32.FindWindowW.restype = ctypes.c_void_p
        hwnd = int(user32.FindWindowW("Shell_TrayWnd", None) or 0)
        if not hwnd:
            return None
        rect = wintypes.RECT()
        if not user32.GetWindowRect(ctypes.c_void_p(hwnd), ctypes.byref(rect)):
            return None
        from PySide6.QtGui import QGuiApplication

        screen = QGuiApplication.primaryScreen()
        ratio = screen.devicePixelRatio() if screen is not None else 1.0
        if not ratio:
            ratio = 1.0
        top = int(rect.top / ratio)
        bottom = int(rect.bottom / ratio)
        height = bottom - top
        if not 20 <= height <= 120:      # 高度不像任务栏，别认
            return None
        if bottom < screen_rect[3] - 4:  # 不在屏幕底部（其它边或已隐藏）
            return None
        halfway = screen_rect[1] + (screen_rect[3] - screen_rect[1]) * 0.5
        if top <= halfway:
            return None
        return top
    except (AttributeError, OSError, ValueError):
        return None


def foreground_info():
    """当前前台窗口的 (矩形, 类名, 是否最大化)。拿不到给 (None, "", False)。

    返回值里的"是否最大化"用 IsZoomed 取，是区分"最大化"和"真全屏"的唯一可靠
    依据：最大化窗口的 GetWindowRect 含 DWM 阴影边框，会比屏幕还大，只看矩形
    必然误判。只读查询，不改任何窗口状态。
    """
    if not WIN32:
        return None, "", False
    try:
        import ctypes

        user32 = ctypes.windll.user32
        user32.GetForegroundWindow.restype = ctypes.c_void_p
        hwnd = int(user32.GetForegroundWindow() or 0)
        if not hwnd:
            return None, "", False

        class RECT(ctypes.Structure):
            _fields_ = [
                ("left", ctypes.c_long),
                ("top", ctypes.c_long),
                ("right", ctypes.c_long),
                ("bottom", ctypes.c_long),
            ]

        rect = RECT()
        if not user32.GetWindowRect(ctypes.c_void_p(hwnd), ctypes.byref(rect)):
            return None, "", False
        buffer = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(ctypes.c_void_p(hwnd), buffer, 256)
        zoomed = bool(user32.IsZoomed(ctypes.c_void_p(hwnd)))
        return (rect.left, rect.top, rect.right, rect.bottom), buffer.value, zoomed
    except (AttributeError, OSError, ValueError):
        return None, "", False


class DockList(QListView):
    """Dock 的图标条：内部拖拽排序，外部拖文件则交给 Dock 追加。"""

    def __init__(self, on_external_drop, on_reordered, dock, parent=None):
        super().__init__(parent)
        self.on_external_drop = on_external_drop
        self.on_reordered = on_reordered
        self.dock = dock
        self.setViewMode(QListView.IconMode)
        self.setFlow(QListView.LeftToRight)
        self.setWrapping(False)
        self.setResizeMode(QListView.Adjust)
        self.setMovement(QListView.Static)
        self.setUniformItemSizes(True)
        self.setSelectionMode(QListView.SingleSelection)
        self.setEditTriggers(QListView.NoEditTriggers)
        self.setFrameShape(QListView.NoFrame)
        self.setStyleSheet(LIST_STYLE)
        self.setMouseTracking(True)
        self.setDragDropMode(QListView.InternalMove)

    def dragEnterEvent(self, event):  # noqa: N802
        if dropfiles.accepts_drag(event.mimeData()):
            event.acceptProposedAction()
            return
        super().dragEnterEvent(event)

    def dragMoveEvent(self, event):  # noqa: N802
        if dropfiles.accepts_drag(event.mimeData()):
            event.acceptProposedAction()
            return
        super().dragMoveEvent(event)

    def dropEvent(self, event):  # noqa: N802
        paths = dropfiles.paths_from_mime(event.mimeData())
        if paths:
            self.on_external_drop(paths)
            event.acceptProposedAction()
            return
        super().dropEvent(event)
        # 内部拖拽排序结束后（模型已是最终状态）再同步一次顺序。
        # 不能靠 rowsMoved 信号：QStandardItemModel 没实现 moveRows，
        # QListView 的 InternalMove 是用"插入副本+删除原件"做的，
        # 只会发 rowsInserted/rowsRemoved，而且发信号时模型处于中间状态。
        self.on_reordered()

    # ---- 悬停跟踪：驱动 Nexus 式放大与悬停名称

    def mouseMoveEvent(self, event):  # noqa: N802
        self._push_hover(event.position().toPoint())
        super().mouseMoveEvent(event)

    def leaveEvent(self, event):  # noqa: N802
        self.dock.clear_hover()
        super().leaveEvent(event)

    def _push_hover(self, point):
        index = self.indexAt(point)
        self.dock.set_hover(point.x(), index.row() if index.isValid() else None)


class DockDelegate(QStyledItemDelegate):
    """Nexus 式绘制：按鼠标距离放大图标，名称只在悬停的那一项上方出现。

    放大倍数用余弦衰减：鼠标正下方最大，超过影响半径回到 1.0。
    图标底边对齐（向上长高），所以放大时看起来是从承托条上"浮起来"。
    """

    def __init__(self, dock):
        super().__init__(dock)
        self.dock = dock

    def sizeHint(self, option, index):  # noqa: N802
        return self.dock.cell_size()

    def _scale_for(self, center_x):
        hover = self.dock.hover_x
        if hover is None:
            return 1.0
        influence = self.dock.icon_size * INFLUENCE_RATIO
        distance = abs(center_x - hover)
        if distance >= influence:
            return 1.0
        # 余弦衰减：0 距离→1，影响半径处→0
        weight = 0.5 * (1.0 + math.cos(math.pi * distance / influence))
        return 1.0 + (MAX_SCALE - 1.0) * weight

    def paint(self, painter, option, index):  # noqa: N802
        hovered = option.state & QStyle.State_MouseOver
        row_hover = self.dock.hover_row
        is_current = row_hover is not None and index.row() == row_hover
        center_x = option.rect.center().x()
        scale = self._scale_for(center_x)
        size = int(round(self.dock.icon_size * scale))

        icon = index.data(Qt.DecorationRole)
        base_bottom = option.rect.bottom() - self.dock.shelf_baseline()
        icon_top = int(base_bottom - size)
        target = QRect(int(center_x - size / 2), icon_top, size, size)
        painter.save()
        painter.setRenderHint(QPainter.SmoothPixmapTransform, True)
        if icon is not None and not icon.isNull():
            icon.paint(painter, target, Qt.AlignCenter)
        else:
            fallback = fileicons.IconCache(size=self.dock.icon_size)
            icon = fallback.icon_for("", False, exists=False)
            icon.paint(painter, target, Qt.AlignCenter)
        painter.restore()

        # 名称只在悬停项上方显示（Nexus 官方就是这个行为，平时不占地方）。
        # 画在**图标**上方而不是"单元"上方：单元顶边就是窗口顶边，再往上会被裁掉。
        if (is_current or hovered) and icon_top > 0:
            name = index.data(Qt.DisplayRole) or ""
            if name:
                self._paint_label(painter, center_x, icon_top, name)

    def _paint_label(self, painter, center_x, icon_top, text):
        metrics = painter.fontMetrics()
        height = metrics.height() + 8
        width = min(metrics.horizontalAdvance(text) + 20, 190)
        left = max(4, min(int(center_x - width // 2), self.dock.width() - int(width) - 4))
        top = max(1, int(icon_top - height - 4))
        label_rect = QRect(int(left), top, int(width), int(height))
        painter.save()
        painter.setRenderHint(QPainter.Antialiasing, True)
        painter.setPen(Qt.NoPen)
        painter.setBrush(LABEL_BG)
        painter.drawRoundedRect(label_rect, 6, 6)
        painter.setPen(LABEL_TEXT)
        painter.drawText(
            label_rect,
            Qt.AlignCenter,
            metrics.elidedText(text, Qt.ElideMiddle, int(width) - 14),
        )
        painter.restore()


class DockWindow(FrostedWindow):
    """底部磨砂 Dock。items 由外部（settings）提供，变化通过 on_changed 落盘。"""

    def __init__(
        self,
        icon_cache,
        on_changed=None,
        accent_mode=DOCK_ACCENT_MODE,
        icon_size=48,
        hide_delay_ms=dockmodel.HIDE_DELAY_MS,
        edge=dockmodel.EDGE_BOTTOM,
        monitor_preference="primary",
        parent=None,
    ):
        super().__init__(
            parent=parent,
            accent_mode=accent_mode,
            layer=LAYER_TOP,
            draw_panel=False,  # 承托条由本类自己画（渐变＋上沿高光）
        )
        self.icon_cache = icon_cache
        self.on_changed = on_changed
        self.icon_size = int(icon_size)
        self.hide_delay_ms = int(hide_delay_ms)
        self.edge = edge
        self.monitor_preference = monitor_preference
        self.items = []
        self.locked = False
        self.revealed = False
        self.hover_x = None  # 鼠标在列表视口里的 x，委托据此算放大倍数
        self.hover_row = None
        self._left_at = None
        self._animation = None
        self._last_revealed_rect = None
        self.setWindowTitle("DeskBasket Dock")
        self._build_ui()

    # ------------------------------------------------------------------ UI

    def shelf_baseline(self):
        """图标底边距窗口底边的距离：留一点内边距，别贴着承托条下沿。"""
        return LABEL_STRIP

    def shelf_height(self):
        """承托条本身的高度：贴着图标与名称，保持紧凑（Nexus 的条也很窄）。"""
        return (
            self.icon_size
            + icongrid.text_line_height(self.view) * icongrid.DOCK_TEXT_LINES
            + BAR_PADDING * 2
        )

    def headroom(self):
        """承托条上方的透明余量：放大的图标会长到这里来，超出承托条上沿。"""
        return int(self.icon_size * (MAX_SCALE - 1.0)) + HEADROOM_EXTRA

    def cell_size(self):
        """网格单元 = 整窗高度（含余量），图标底对齐，放大时在单元内向上长，不会被裁。"""
        width = int(self.icon_size * MAX_SCALE) + ICON_GAP
        return QSize(width, self.headroom() + self.shelf_height())

    def _apply_grid(self):
        self.view.setIconSize(QSize(self.icon_size, self.icon_size))
        self.view.setGridSize(self.cell_size())
        self.view.setSpacing(0)

    def _build_ui(self):
        self.view = DockList(
            self.add_paths, self._sync_order_from_model, self, self
        )
        self.view.setItemDelegate(DockDelegate(self))
        self.view.setMouseTracking(True)
        self.view.viewport().setMouseTracking(True)
        self.view.setContextMenuPolicy(Qt.CustomContextMenu)
        self.view.customContextMenuRequested.connect(self._on_context_menu)
        self.view.clicked.connect(self._on_clicked)
        self.model = QStandardItemModel(self.view)
        self.view.setModel(self.model)
        self._apply_grid()
        self.resize(MIN_BAR_WIDTH, self.cell_size().height() + BAR_PADDING * 2)
        self.set_items([])

    def set_accent_mode(self, mode):
        self.accent_mode = mode
        self.apply_effects()

    def set_icon_size(self, size):
        self.icon_size = int(size)
        self._apply_grid()
        self._relayout()
        self.refresh()

    def set_hover(self, x, row=None):
        """由列表在鼠标移动时调用：驱动放大效果与悬停名称。"""
        if x == self.hover_x and row == self.hover_row:
            return
        self.hover_x = x
        self.hover_row = row
        self.view.viewport().update()

    def clear_hover(self):
        if self.hover_x is None and self.hover_row is None:
            return
        self.hover_x = None
        self.hover_row = None
        self.view.viewport().update()

    # ------------------------------------------------------------------ 外观

    def paintEvent(self, event):  # noqa: N802
        """画 Nexus 式承托条：上浅下深的渐变玻璃 ＋ 上沿一道细高光。"""
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing, True)
        # 只在下半部分画承托条；上半部分是透明余量，给放大的图标让路
        rect = QRect(
            0, self.headroom(), self.width() - 1, self.shelf_height() - 1
        )
        path = QPainterPath()
        radius = min(18, rect.height() // 2)
        path.addRoundedRect(rect, radius, radius)
        gradient = QLinearGradient(0, rect.top(), 0, rect.bottom())
        gradient.setColorAt(0.0, SHELF_TOP)
        gradient.setColorAt(1.0, SHELF_BOTTOM)
        painter.fillPath(path, gradient)
        pen = QPen(SHELF_RIM)
        pen.setWidth(1)
        painter.setPen(pen)
        painter.setBrush(Qt.NoBrush)
        painter.drawRoundedRect(
            rect.adjusted(0.5, 0.5, -0.5, -0.5), radius, radius
        )
        painter.end()

    # ------------------------------------------------------------------ 数据

    def set_items(self, items):
        """设置条目并重算尺寸。不会触发 on_changed（外部同步用）。"""
        self.items = [path for path in (items or [])]
        self.refresh()

    def refresh(self):
        self.model.clear()
        for path in self.items:
            exists = self._path_exists(path)
            name = self._display_name(path)
            item = QStandardItem(
                self.icon_cache.icon_for(path, self._path_is_dir(path), exists), name
            )
            item.setData(path, PATH_ROLE)
            item.setEditable(False)
            item.setToolTip(path if exists else "%s\n（文件已不在）" % path)
            if not exists:
                item.setForeground(QColor(150, 150, 158))
            item.setTextAlignment(Qt.AlignHCenter | Qt.AlignTop)
            self.model.appendRow(item)
        self._relayout()

    def add_paths(self, paths):
        """追加条目（去重）。返回真正新增的条数。"""
        added = 0
        for path in paths or []:
            self.items, result = dockmodel.add_item(self.items, path)
            if result == "added":
                added += 1
        if added:
            self.refresh()
            self._notify_changed()
        return added

    def remove_path(self, path):
        before = len(self.items)
        self.items = dockmodel.remove_item(self.items, path)
        if len(self.items) != before:
            self.refresh()
            self._notify_changed()
            return True
        return False

    def item_count(self):
        return len(self.items)

    def _notify_changed(self):
        if callable(self.on_changed):
            self.on_changed(self.items)

    @staticmethod
    def _path_exists(path):
        import os

        return os.path.exists(path)

    @staticmethod
    def _path_is_dir(path):
        import os

        return os.path.isdir(path)

    @staticmethod
    def _display_name(path):
        import os

        return os.path.basename(str(path).rstrip("\\/")) or str(path)

    def _relayout(self):
        """按条目数把 Dock 宽度收成"刚好装下"，并夹在屏幕可用范围内。"""
        screen = self._screen_rect()
        screen_width = (screen[2] - screen[0]) if screen else 1920
        cell = self.cell_size()
        wanted = BAR_PADDING * 2 + max(1, len(self.items)) * cell.width()
        limit = int(screen_width * MAX_BAR_WIDTH_RATIO)
        width = max(MIN_BAR_WIDTH, min(wanted, limit))
        height = cell.height()
        self.resize(width, height)
        # 列表铺满整窗（含上方余量），图标在委托里底对齐，放大才有地方长
        self.view.setGeometry(
            BAR_PADDING, 0, max(1, width - BAR_PADDING * 2), height
        )
        self._apply_geometry(self._geometry_for(self.revealed), animate=False)

    # ------------------------------------------------------------------ 几何

    def _screen_rect(self):
        """目标显示器的矩形，**Qt 逻辑像素**。

        坐标系必须统一：QCursor.pos() 与 QWidget.move() 用的都是 Qt 逻辑像素，
        所以这里也用 QScreen.geometry()。绝不能混进 GetSystemMetrics 的物理像素——
        本机缩放 150%，物理屏宽 2560 而逻辑只有 1707，混用会让热区判定永远不命中，
        也会把最大化窗口误判成全屏。
        """
        from PySide6.QtGui import QGuiApplication

        app = QGuiApplication.instance()
        if app is None:
            return None
        screens = []
        primary = QGuiApplication.primaryScreen()
        for screen in QGuiApplication.screens():
            geometry = screen.geometry()
            screens.append(
                (
                    (
                        geometry.x(),
                        geometry.y(),
                        geometry.x() + geometry.width(),
                        geometry.y() + geometry.height(),
                    ),
                    screen is primary,
                )
            )
        return dockmodel.monitor_geometry(screens, self.monitor_preference)

    def foreground_rect_logical(self):
        """前台窗口矩形（转成 Qt 逻辑像素）＋类名＋是否最大化。

        GetWindowRect 给的是物理像素，必须按 devicePixelRatio 折算后再和
        _screen_rect() 比较，否则 150% 缩放下坐标根本不在一个尺度上。
        """
        from PySide6.QtGui import QGuiApplication

        rect, class_name, zoomed = foreground_info()
        if rect is None:
            return None, class_name, zoomed
        screen = QGuiApplication.primaryScreen()
        ratio = screen.devicePixelRatio() if screen is not None else 1.0
        if not ratio:
            ratio = 1.0
        return tuple(int(value / ratio) for value in rect), class_name, zoomed

    def _geometry_for(self, revealed):
        screen = self._screen_rect()
        if screen is None:
            return None
        size = (self.width(), self.height())
        if not revealed:
            return dockmodel.hidden_geometry(screen, size, edge=self.edge)
        # 任务栏正显示时让开它，别在屏幕底部叠成两条
        anchor = taskbar_top_logical(screen)
        return dockmodel.revealed_geometry(
            screen, size, edge=self.edge, margin=BAR_MARGIN, anchor=anchor
        )

    def _apply_geometry(self, rect, animate=True):
        if rect is None:
            return
        target = QPoint(rect[0], rect[1])
        if not animate or not WIN32:
            self.move(target)
            self._last_revealed_rect = rect
            return
        animation = QPropertyAnimation(self, b"pos", self)
        animation.setDuration(dockmodel.ANIMATION_MS)
        animation.setStartValue(self.pos())
        animation.setEndValue(target)
        animation.start()
        self._animation = animation
        self._last_revealed_rect = rect

    # ------------------------------------------------------------------ 显隐

    def cursor_position(self):
        from PySide6.QtGui import QCursor

        point = QCursor.pos()
        return (point.x(), point.y())

    def reveal(self, animate=True):
        if self.revealed:
            return False
        self.revealed = True
        self._left_at = None
        self._apply_geometry(self._geometry_for(True), animate=animate)
        if not self.isVisible():
            self.show()
            self.apply_effects()
            if not animate or not WIN32:
                self._apply_geometry(self._geometry_for(True), animate=False)
        return True

    def collapse(self, animate=True):
        if not self.revealed:
            return False
        self.revealed = False
        self._apply_geometry(self._geometry_for(False), animate=animate)
        return True

    def set_revealed(self, revealed, animate=True):
        return self.reveal(animate) if revealed else self.collapse(animate)

    def set_dock_enabled(self, enabled):
        """总开关：关掉就直接收起并不再轮询弹出来。"""
        self.locked = not enabled
        if not enabled:
            self.collapse()

    def tick(self, now_ms=None):
        """轮询一次：判断该弹还是该收。返回这次做的动作。

        供自检与测试直接调用，不依赖真实鼠标与计时器。
        """
        screen = self._screen_rect()
        if screen is None:
            return dockmodel.ACTION_NONE
        cursor = self.cursor_position()
        foreground_rect, class_name, zoomed = self.foreground_rect_logical()
        fullscreen = dockmodel.foreground_blocks_dock(
            foreground_rect, screen, class_name, zoomed
        )

        in_hot_zone = dockmodel.is_hot_zone(cursor, screen, self.edge)
        action = dockmodel.should_reveal(
            in_hot_zone, fullscreen, self.locked, self.revealed
        )
        if action == dockmodel.ACTION_SHOW:
            self.reveal()
            return action
        if action == dockmodel.ACTION_HIDE:
            self.collapse()
            return action

        if self.revealed:
            revealed_rect = self._geometry_for(True)
            on_dock = dockmodel.point_in_rect(cursor, revealed_rect)
            if on_dock:
                self._left_at = None
            elif self._left_at is None:
                self._left_at = self._now_ms()
            elapsed = (self._now_ms() - self._left_at) if self._left_at else 0
            if dockmodel.should_hide(on_dock, fullscreen, self.locked, elapsed, self.hide_delay_ms):
                self.collapse()
                return dockmodel.ACTION_HIDE
        return dockmodel.ACTION_NONE

    @staticmethod
    def _now_ms():
        from PySide6.QtCore import QDateTime

        return QDateTime.currentMSecsSinceEpoch()

    def start_polling(self):
        """真机上启动轮询；offscreen 自检不需要，避免空转。"""
        if not WIN32:
            return None
        if not hasattr(self, "_poller"):
            self._poller = QTimer(self)
            self._poller.timeout.connect(self.tick)
        self._poller.start(POLL_INTERVAL_MS)
        return self._poller

    def stop_polling(self):
        poller = getattr(self, "_poller", None)
        if poller is not None:
            poller.stop()

    # ------------------------------------------------------------------ 交互

    def _on_clicked(self, index):
        item = self.model.itemFromIndex(index)
        if item is None:
            return
        path = item.data(PATH_ROLE)
        if not QDesktopServices.openUrl(self._qurl(path)):
            from PySide6.QtWidgets import QMessageBox

            QMessageBox.warning(
                self, "打不开这一项", "系统没有能打开它的程序，或者文件已经不在了：\n" + path
            )

    def _sync_order_from_model(self):
        """把模型里的当前顺序同步回 items 并落盘（拖拽排序结束后调用）。"""
        ordered = [
            self.model.item(row).data(PATH_ROLE) for row in range(self.model.rowCount())
        ]
        if ordered != self.items:
            self.items = ordered
            self._notify_changed()
        return ordered

    def _on_context_menu(self, position):
        index = self.view.indexAt(position)
        item = self.model.itemFromIndex(index) if index.isValid() else None
        menu = QMenu(self)
        if item is not None:
            path = item.data(PATH_ROLE)
            menu.addAction("打开", lambda: QDesktopServices.openUrl(self._qurl(path)))
            menu.addAction("用系统资源管理器打开所在位置", lambda: self._reveal(path))
            menu.addSeparator()
            menu.addAction("从 Dock 移除", lambda: self.remove_path(path))
        else:
            menu.addAction("收起 Dock", lambda: self.collapse())
        menu.exec(self.view.viewport().mapToGlobal(position))

    def _reveal(self, path):
        import os
        import subprocess

        if WIN32:
            subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
        else:
            QDesktopServices.openUrl(self._qurl(os.path.dirname(path)))

    @staticmethod
    def _qurl(path):
        from PySide6.QtCore import QUrl

        return QUrl.fromLocalFile(path)
