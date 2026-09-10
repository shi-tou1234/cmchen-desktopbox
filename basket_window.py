"""文件筐窗口：磨砂面板 + 图标网格 + 拖入收纳 + 双击打开。

只登记路径，绝不移动/删除/改名/改属性磁盘上的文件。所有"移除"都只是
把条目从筐的数据里删掉。失效（文件不在了）的条目用灰色显示并标注，
提供"清理失效项"，同样只动数据。
"""

import os

from PySide6.QtCore import QSize, Qt
from PySide6.QtGui import (
    QColor,
    QDesktopServices,
    QStandardItem,
    QStandardItemModel,
)
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QListView,
    QMenu,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

import baskets
from frosted_window import LAYER_WINDOW, FrostedWindow

PATH_ROLE = Qt.UserRole + 1
MISSING_COLOR = QColor(150, 150, 158)
NORMAL_COLOR = QColor(238, 238, 242)

LIST_STYLE = """
QListView {
    background: transparent;
    border: none;
    outline: none;
}
QListView::item {
    color: #EEEFF2;
    border-radius: 8px;
    padding: 4px;
}
QListView::item:selected {
    background: rgba(255, 255, 255, 0.20);
}
QListView::item:hover {
    background: rgba(255, 255, 255, 0.10);
}
"""

HEADER_STYLE = "color: #F2F2F5; font-size: 13px; font-weight: 600; background: transparent;"
COUNT_STYLE = "color: #B9BAC2; font-size: 12px; background: transparent;"
CLOSE_STYLE = """
QPushButton {
    color: #D8D9DE; background: rgba(255,255,255,0.10);
    border: none; border-radius: 9px; font-size: 12px;
}
QPushButton:hover { background: rgba(255, 90, 90, 0.65); color: white; }
"""


class BasketList(QListView):
    """图标网格：双击打开、右键菜单、非列表拖放只由所属筐处理。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setViewMode(QListView.IconMode)
        self.setResizeMode(QListView.Adjust)
        self.setMovement(QListView.Static)
        self.setWordWrap(True)
        self.setUniformItemSizes(True)
        self.setSelectionMode(QListView.SingleSelection)
        self.setEditTriggers(QListView.NoEditTriggers)
        self.setDragDropMode(QListView.NoDragDrop)
        self.setStyleSheet(LIST_STYLE)
        self.setFrameShape(QListView.NoFrame)
        self.setAutoScroll(True)


class BasketWindow(FrostedWindow):
    """一个文件筐的窗口。"""

    def __init__(
        self,
        basket,
        icon_cache,
        on_changed=None,
        on_open_explorer=None,
        accent_mode="acrylic",
        icon_size=48,
        layer=LAYER_WINDOW,
        parent=None,
    ):
        super().__init__(parent=parent, accent_mode=accent_mode, layer=layer)
        self.basket = dict(basket)
        self.icon_cache = icon_cache
        self.on_changed = on_changed
        self.on_open_explorer = on_open_explorer
        self.icon_size = icon_size
        self._drag_origin = None
        self._item_actions = None

        self.setWindowTitle("DeskBasket · %s" % self.basket.get("name", ""))
        self.resize(self.basket.get("w", baskets.DEFAULT_WIDTH),
                    self.basket.get("h", baskets.DEFAULT_HEIGHT))
        self.move(self.basket.get("x", 80), self.basket.get("y", 80))

        self._build_ui()
        self.drop_handler = self.accept_paths
        self.refresh()

    # ------------------------------------------------------------------ UI

    def _build_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(10, 8, 10, 10)
        layout.setSpacing(6)

        header = QWidget(self)
        header.setAttribute(Qt.WA_TranslucentBackground, True)
        header_layout = QHBoxLayout(header)
        header_layout.setContentsMargins(2, 0, 0, 0)
        header_layout.setSpacing(6)

        self.title_label = QLabel(header)
        self.title_label.setStyleSheet(HEADER_STYLE)
        self.count_label = QLabel(header)
        self.count_label.setStyleSheet(COUNT_STYLE)

        close_button = QPushButton("✕", header)
        close_button.setStyleSheet(CLOSE_STYLE)
        close_button.setFixedSize(18, 18)
        close_button.setToolTip("隐藏这个筐（筐里的文件一个都不会动）")
        close_button.clicked.connect(self.hide)
        self.close_button = close_button

        header_layout.addWidget(self.title_label)
        header_layout.addWidget(self.count_label)
        header_layout.addStretch(1)
        header_layout.addWidget(close_button)
        layout.addWidget(header)

        self.view = BasketList(self)
        self.view.setIconSize(QSize(self.icon_size, self.icon_size))
        self.view.setGridSize(QSize(self.icon_size + 40, self.icon_size + 34))
        self.view.setSpacing(4)
        self.view.doubleClicked.connect(self._on_double_clicked)
        self.view.setContextMenuPolicy(Qt.CustomContextMenu)
        self.view.customContextMenuRequested.connect(self._on_context_menu)
        layout.addWidget(self.view, 1)

        self.model = QStandardItemModel(self.view)
        self.view.setModel(self.model)
        header.installEventFilter(self)
        self._header = header

    # ------------------------------------------------------------------ 数据

    def set_basket(self, basket):
        self.basket = dict(basket)
        self.refresh()

    def refresh(self):
        """重建图标网格。只读磁盘状态，不写任何东西。"""
        items = self.basket.get("items") or []
        alive, missing = baskets.partition_items(self.basket)
        self.model.clear()
        for path in alive + missing:
            self.model.appendRow(self._make_item(path, path in missing))
        self.title_label.setText(self.basket.get("name") or baskets.NAME_FALLBACK)
        if missing:
            self.count_label.setText(
                "%d 项 · %d 项失效" % (len(items), len(missing))
            )
        else:
            self.count_label.setText("%d 项" % len(items))
        self.view.setIconSize(QSize(self.icon_size, self.icon_size))
        self.view.setGridSize(QSize(self.icon_size + 40, self.icon_size + 34))

    def _make_item(self, path, missing):
        name = os.path.basename(path.rstrip("\\/")) or path
        item = QStandardItem(self.icon_cache.icon_for(path, os.path.isdir(path), not missing), name)
        item.setData(path, PATH_ROLE)
        item.setEditable(False)
        item.setToolTip(path if not missing else "%s\n（文件已不在，可右键清理）" % path)
        if missing:
            item.setForeground(MISSING_COLOR)
        else:
            item.setForeground(NORMAL_COLOR)
        item.setTextAlignment(Qt.AlignHCenter | Qt.AlignTop)
        return item

    def paths(self):
        return [
            self.model.item(row).data(PATH_ROLE)
            for row in range(self.model.rowCount())
        ]

    def add_paths(self, paths):
        """把路径加进筐（去重），返回真正新增的数量。"""
        added = 0
        for path in paths:
            self.basket, result = baskets.add_item(self.basket, path)
            if result == "added":
                added += 1
        if added:
            self.refresh()
            self._notify_changed()
        return added

    def accept_paths(self, paths):
        return self.add_paths(paths)

    def remove_path(self, path):
        self.basket = baskets.remove_item(self.basket, path)
        self.refresh()
        self._notify_changed()

    def prune_missing(self):
        self.basket, removed = baskets.prune_missing(self.basket)
        if removed:
            self.refresh()
            self._notify_changed()
        return len(removed)

    def _notify_changed(self):
        if callable(self.on_changed):
            self.on_changed(self.basket)

    # ------------------------------------------------------------------ 交互

    def _path_at(self, index):
        if not index.isValid():
            return None
        item = self.model.itemFromIndex(index)
        return item.data(PATH_ROLE) if item else None

    def _on_double_clicked(self, index):
        path = self._path_at(index)
        if path is None:
            return
        if os.path.isdir(path):
            # 双击文件夹：优先钻到内置浏览器；没有接线时退回系统资源管理器
            if callable(self.on_open_explorer):
                self.on_open_explorer(path)
                return
            QDesktopServices.openUrl(self._qurl(path))
            return
        if not self.open_path(path):
            self.show_open_failed(path)

    def open_path(self, path):
        """用系统默认程序打开；成功返回 True。"""
        return QDesktopServices.openUrl(self._qurl(path))

    @staticmethod
    def _qurl(path):
        from PySide6.QtCore import QUrl

        return QUrl.fromLocalFile(path)

    def show_open_failed(self, path):
        """打开失败必须让用户看见，不许静默失败。"""
        from PySide6.QtWidgets import QMessageBox

        box = QMessageBox(self)
        box.setIcon(QMessageBox.Warning)
        box.setWindowTitle("打不开这个文件")
        box.setText("系统没有能打开它的程序，或者文件已经不在：")
        box.setInformativeText(path)
        box.setStandardButtons(QMessageBox.Ok)
        box.exec()

    def _on_context_menu(self, position):
        index = self.view.indexAt(position)
        menu = QMenu(self)
        path = self._path_at(index)
        if path:
            is_dir = os.path.isdir(path)
            exists = os.path.exists(path)
            if exists and is_dir:
                act = menu.addAction("在内置窗口里打开")
                act.triggered.connect(lambda: self.on_open_explorer and self.on_open_explorer(path))
            if exists:
                act = menu.addAction("打开")
                act.triggered.connect(lambda: self._open_checked(path))
                act = menu.addAction("用系统资源管理器打开")
                act.triggered.connect(lambda: self._reveal(path))
            act = menu.addAction("从这个筐移除")
            act.triggered.connect(lambda: self.remove_path(path))
        else:
            missing = len(baskets.missing_items(self.basket))
            act = menu.addAction("清理失效项（%d）" % missing)
            act.setEnabled(missing > 0)
            act.triggered.connect(self.prune_missing)
            act = menu.addAction("重命名这个筐")
            act.triggered.connect(self._rename)
            act = menu.addAction("隐藏这个筐")
            act.triggered.connect(self.hide)
        menu.exec(self.view.viewport().mapToGlobal(position))

    def _open_checked(self, path):
        if not self.open_path(path):
            self.show_open_failed(path)

    def _reveal(self, path):
        """用系统资源管理器打开所在位置。"""
        import subprocess
        import sys

        if sys.platform == "win32" and os.path.exists(path):
            subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
        else:
            QDesktopServices.openUrl(self._qurl(os.path.dirname(path)))

    def _rename(self):
        from PySide6.QtWidgets import QInputDialog

        current = self.basket.get("name") or baskets.NAME_FALLBACK
        text, ok = QInputDialog.getText(self, "重命名文件筐", "筐的名字：", text=current)
        if ok and text.strip():
            self.basket["name"] = baskets.normalize_name(text)
            self.setWindowTitle("DeskBasket · %s" % self.basket["name"])
            self.refresh()
            self._notify_changed()

    # ---- 无边框窗口拖动（在标题条上按住拖）

    def eventFilter(self, obj, event):  # noqa: N802
        if obj is self._header and not self.basket:
            return super().eventFilter(obj, event)
        if obj is self._header:
            if event.type() == event.Type.MouseButtonPress and event.button() == Qt.LeftButton:
                self._drag_origin = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
                return True
            if event.type() == event.Type.MouseMove and self._drag_origin is not None:
                self.move(event.globalPosition().toPoint() - self._drag_origin)
                return True
            if event.type() == event.Type.MouseButtonRelease:
                self._drag_origin = None
                self._remember_geometry()
                return True
        return super().eventFilter(obj, event)

    def resizeEvent(self, event):  # noqa: N802
        super().resizeEvent(event)
        self._remember_geometry(notify=False)

    def _remember_geometry(self, notify=True):
        geometry = self.geometry()
        changed = (
            self.basket.get("x") != geometry.x()
            or self.basket.get("y") != geometry.y()
            or self.basket.get("w") != geometry.width()
            or self.basket.get("h") != geometry.height()
        )
        self.basket["x"] = geometry.x()
        self.basket["y"] = geometry.y()
        self.basket["w"] = geometry.width()
        self.basket["h"] = geometry.height()
        if changed and notify:
            self._notify_changed()
