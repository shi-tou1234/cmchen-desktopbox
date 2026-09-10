"""内置文件浏览器窗口：磨砂的类资源管理器页面，可逐级深入。

特点（对应任务书）：
- 面包屑可点、有"返回"和"上一级"；已在根时"上一级"置灰。
- 只读遍历，零写操作。
- 大目录分批渲染（filebrowse.CHUNK_SIZE 一批），期间不卡界面。
- 读不了的目录显示中文提示并跳过，不崩。
"""

import os

from PySide6.QtCore import QSize, Qt, QTimer
from PySide6.QtGui import (
    QColor,
    QDesktopServices,
    QIcon,
    QPainter,
    QPixmap,
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

import filebrowse
import fileicons
from frosted_window import LAYER_WINDOW, FrostedWindow

PATH_ROLE = Qt.UserRole + 1
IS_DIR_ROLE = Qt.UserRole + 2
DIR_COLOR = QColor(238, 238, 242)
FILE_COLOR = QColor(214, 216, 222)
ERROR_COLOR = QColor(255, 190, 120)

BAR_STYLE = "color: #F2F2F5; font-size: 12px; background: transparent;"
STATUS_STYLE = "color: #B9BAC2; font-size: 12px; background: transparent;"

BUTTON_STYLE = """
QPushButton {
    color: #E8E9EE; background: rgba(255,255,255,0.10);
    border: none; border-radius: 6px; padding: 3px 10px; font-size: 12px;
}
QPushButton:hover { background: rgba(255,255,255,0.20); }
QPushButton:disabled { color: rgba(232,233,238,0.35); background: rgba(255,255,255,0.04); }
"""

CRUMB_STYLE = """
QPushButton {
    color: #A9C8FF; background: transparent; border: none;
    padding: 2px 4px; font-size: 12px;
}
QPushButton:hover { color: #D6E4FF; text-decoration: underline; }
"""

LIST_STYLE = """
QListView { background: transparent; border: none; outline: none; }
QListView::item { color: #EEEFF2; border-radius: 8px; padding: 4px; }
QListView::item:selected { background: rgba(255,255,255,0.20); }
QListView::item:hover { background: rgba(255,255,255,0.10); }
"""


class ExplorerWindow(FrostedWindow):
    """一个内置浏览器窗口，可在目录树里逐级深入。"""

    def __init__(
        self,
        start_path,
        icon_cache,
        accent_mode="acrylic",
        icon_size=48,
        layer=LAYER_WINDOW,
        parent=None,
    ):
        super().__init__(parent=parent, accent_mode=accent_mode, layer=layer)
        self.icon_cache = icon_cache
        self.icon_size = icon_size
        self.current_path = os.path.normpath(start_path)
        self.history = []
        self._pending = []
        self._listed = 0
        self._load_token = 0
        self._drag_origin = None

        self.setWindowTitle("DeskBasket 浏览 · %s" % os.path.basename(self.current_path))
        self.resize(640, 460)
        self._build_ui()
        self.navigate_to(self.current_path, push_history=False)

    # ------------------------------------------------------------------ UI

    def _build_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(10, 8, 10, 10)
        layout.setSpacing(6)

        toolbar = QWidget(self)
        toolbar.setAttribute(Qt.WA_TranslucentBackground, True)
        bar = QHBoxLayout(toolbar)
        bar.setContentsMargins(0, 0, 0, 0)
        bar.setSpacing(6)

        self.back_button = QPushButton("←", toolbar)
        self.back_button.setStyleSheet(BUTTON_STYLE)
        self.back_button.setFixedWidth(28)
        self.back_button.clicked.connect(self.go_back)

        self.up_button = QPushButton("↑", toolbar)
        self.up_button.setStyleSheet(BUTTON_STYLE)
        self.up_button.setFixedWidth(28)
        self.up_button.clicked.connect(self.go_up)

        self.system_button = QPushButton("在系统中打开", toolbar)
        self.system_button.setStyleSheet(BUTTON_STYLE)
        self.system_button.clicked.connect(self.reveal_in_system)

        self.crumb_host = QWidget(toolbar)
        self.crumb_host.setAttribute(Qt.WA_TranslucentBackground, True)
        self.crumb_layout = QHBoxLayout(self.crumb_host)
        self.crumb_layout.setContentsMargins(0, 0, 0, 0)
        self.crumb_layout.setSpacing(0)

        bar.addWidget(self.back_button)
        bar.addWidget(self.up_button)
        bar.addWidget(self.crumb_host, 1)
        bar.addWidget(self.system_button)
        layout.addWidget(toolbar)

        self.status_label = QLabel(self)
        self.status_label.setStyleSheet(STATUS_STYLE)
        layout.addWidget(self.status_label)

        self.view = QListView(self)
        self.view.setViewMode(QListView.IconMode)
        self.view.setResizeMode(QListView.Adjust)
        self.view.setMovement(QListView.Static)
        self.view.setWordWrap(True)
        self.view.setUniformItemSizes(True)
        self.view.setSelectionMode(QListView.SingleSelection)
        self.view.setEditTriggers(QListView.NoEditTriggers)
        self.view.setDragDropMode(QListView.NoDragDrop)
        self.view.setFrameShape(QListView.NoFrame)
        self.view.setStyleSheet(LIST_STYLE)
        self.view.setIconSize(QSize(self.icon_size, self.icon_size))
        self.view.setGridSize(QSize(self.icon_size + 40, self.icon_size + 34))
        self.view.doubleClicked.connect(self._on_double_clicked)
        self.view.setContextMenuPolicy(Qt.CustomContextMenu)
        self.view.customContextMenuRequested.connect(self._on_context_menu)
        layout.addWidget(self.view, 1)

        self.model = QStandardItemModel(self.view)
        self.view.setModel(self.model)
        toolbar.installEventFilter(self)
        self._toolbar = toolbar

    # ------------------------------------------------------------------ 导航

    def navigate_to(self, path, push_history=True):
        """切到某个目录。目录读不了就只显示中文提示，不改变当前目录。"""
        target = os.path.normpath(path)
        result = filebrowse.list_entries(target)
        if result["error"]:
            self.status_label.setText(result["error"] + "：" + target)
            self.status_label.setStyleSheet("color: #FFBE78; font-size: 12px; background: transparent;")
            return False
        if push_history and self.current_path and self.current_path != target:
            self.history.append(self.current_path)
        self.current_path = target
        self.status_label.setStyleSheet(STATUS_STYLE)
        self._render(result["entries"])
        self._refresh_toolbar()
        return True

    def go_up(self):
        parent = filebrowse.parent_of(self.current_path)
        if parent is None:
            return False
        return self.navigate_to(parent)

    def go_back(self):
        if not self.history:
            return False
        return self.navigate_to(self.history.pop(), push_history=False)

    def _refresh_toolbar(self):
        self.up_button.setEnabled(filebrowse.parent_of(self.current_path) is not None)
        self.back_button.setEnabled(bool(self.history))
        self.setWindowTitle("DeskBasket 浏览 · %s" % os.path.basename(self.current_path))
        while self.crumb_layout.count():
            item = self.crumb_layout.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.deleteLater()
        for index, part in enumerate(filebrowse.breadcrumb_parts(self.current_path)):
            if index:
                separator = QLabel("/", self.crumb_host)
                separator.setStyleSheet(
                    "color: rgba(240,240,245,0.45); font-size: 12px; background: transparent;"
                )
                self.crumb_layout.addWidget(separator)
            button = QPushButton(part["label"], self.crumb_host)
            button.setStyleSheet(CRUMB_STYLE)
            button.setCursor(Qt.PointingHandCursor)
            target = part["path"]
            button.clicked.connect(lambda _checked=False, p=target: self.navigate_to(p))
            self.crumb_layout.addWidget(button)
        self.crumb_layout.addStretch(1)

    # ------------------------------------------------------------------ 渲染

    def _render(self, entries):
        """分批渲染：每批 CHUNK_SIZE 条，批间让出事件循环，大目录也不卡。"""
        self.model.clear()
        self._listed = 0
        self._load_token += 1
        token = self._load_token
        self._pending = filebrowse.chunked(entries, filebrowse.CHUNK_SIZE)
        self._total = len(entries)
        if not entries:
            self.status_label.setText("这个目录是空的")
            return
        self.status_label.setText("正在列出 %d 项……" % self._total)
        self._render_next_chunk(token)

    def _render_next_chunk(self, token):
        if token != self._load_token:
            return
        if not self._pending:
            self.status_label.setText("共 %d 项" % self._total)
            return
        for entry in self._pending.pop(0):
            self.model.appendRow(self._make_item(entry))
            self._listed += 1
        self.status_label.setText("已列出 %d / %d 项……" % (self._listed, self._total))
        QTimer.singleShot(0, lambda: self._render_next_chunk(token))

    def _make_item(self, entry):
        item = QStandardItem(
            self.icon_cache.icon_for(entry["path"], entry["is_dir"], True),
            entry["name"],
        )
        item.setData(entry["path"], PATH_ROLE)
        item.setData(entry["is_dir"], IS_DIR_ROLE)
        item.setEditable(False)
        item.setToolTip(entry["path"])
        item.setForeground(DIR_COLOR if entry["is_dir"] else FILE_COLOR)
        item.setTextAlignment(Qt.AlignHCenter | Qt.AlignTop)
        return item

    # ------------------------------------------------------------------ 交互

    def _on_double_clicked(self, index):
        item = self.model.itemFromIndex(index)
        if item is None:
            return
        path = item.data(PATH_ROLE)
        if item.data(IS_DIR_ROLE):
            if not self.navigate_to(path):
                pass
            return
        if not QDesktopServices.openUrl(self._qurl(path)):
            from PySide6.QtWidgets import QMessageBox

            QMessageBox.warning(self, "打不开这个文件", "系统没有能打开它的程序：\n" + path)

    def reveal_in_system(self):
        import subprocess
        import sys

        if sys.platform == "win32":
            subprocess.Popen(["explorer", os.path.normpath(self.current_path)])
        else:
            QDesktopServices.openUrl(self._qurl(self.current_path))

    @staticmethod
    def _qurl(path):
        from PySide6.QtCore import QUrl

        return QUrl.fromLocalFile(path)

    def _on_context_menu(self, position):
        index = self.view.indexAt(position)
        item = self.model.itemFromIndex(index) if index.isValid() else None
        menu = QMenu(self)
        if item is not None:
            path = item.data(PATH_ROLE)
            if item.data(IS_DIR_ROLE):
                act = menu.addAction("打开这个文件夹")
                act.triggered.connect(lambda: self.navigate_to(path))
            act = menu.addAction("打开")
            act.triggered.connect(lambda: QDesktopServices.openUrl(self._qurl(path)))
            act = menu.addAction("用系统资源管理器打开所在位置")
            act.triggered.connect(lambda: self._reveal(path))
        else:
            act = menu.addAction("返回上一级")
            act.setEnabled(self.up_button.isEnabled())
            act.triggered.connect(self.go_up)
            act = menu.addAction("刷新")
            act.triggered.connect(lambda: self.navigate_to(self.current_path, push_history=False))
        menu.exec(self.view.viewport().mapToGlobal(position))

    def _reveal(self, path):
        import subprocess
        import sys

        if sys.platform == "win32":
            subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])

    # ---- 拖动窗口

    def eventFilter(self, obj, event):  # noqa: N802
        if obj is self._toolbar:
            if event.type() == event.Type.MouseButtonPress and event.button() == Qt.LeftButton:
                self._drag_origin = (
                    event.globalPosition().toPoint() - self.frameGeometry().topLeft()
                )
                return True
            if event.type() == event.Type.MouseMove and self._drag_origin is not None:
                self.move(event.globalPosition().toPoint() - self._drag_origin)
                return True
            if event.type() == event.Type.MouseButtonRelease:
                self._drag_origin = None
                return True
        return super().eventFilter(obj, event)
