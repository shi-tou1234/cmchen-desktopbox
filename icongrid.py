"""图标网格的尺寸计算。

单独抽出来是因为踩过一次坑：网格高度只按"图标 + 一行文字"给，而标签开了自动换行，
文件名的第二行就被裁成半截字（真机截图上一眼看出来很脏）。
这里按 QFontMetrics 实测行高算，给够 lines 行的空间。
"""

from PySide6.QtCore import QRect, QSize, Qt
from PySide6.QtGui import QFontMetrics, QPainter, QPalette
from PySide6.QtWidgets import QStyledItemDelegate

CELL_WIDTH_EXTRA = 46      # 图标两侧留白，决定一行能放几个字
CELL_HEIGHT_PADDING = 12   # 上下内边距
TEXT_LINES = 2             # 文件筐 / 内置浏览器：文件名允许占两行
DOCK_TEXT_LINES = 1        # Dock：名称只在悬停时显示一行


def text_line_height(view):
    """按视图实际字体的行距，避免硬编码 16px 在不同字号下失准。"""
    return QFontMetrics(view.font()).lineSpacing()


def grid_size(view, icon_size, lines=TEXT_LINES):
    """网格单元尺寸：保证 lines 行标签能完整放下，不被裁切。"""
    icon_size = int(icon_size)
    height = icon_size + text_line_height(view) * max(1, lines) + CELL_HEIGHT_PADDING
    return QSize(icon_size + CELL_WIDTH_EXTRA, height)


def apply_grid(view, icon_size, lines=TEXT_LINES):
    """一次性把图标尺寸与网格尺寸都设好（两处必须同步，否则又会裁字）。"""
    view.setIconSize(QSize(int(icon_size), int(icon_size)))
    view.setGridSize(grid_size(view, icon_size, lines))
    return view.gridSize()


def wrap_text(text, metrics, width, max_lines):
    """把文本按宽度折成最多 max_lines 行；放不下的部分在最后一行省略。

    不用 QStyledItemDelegate 自带的换行：实测它会在单元底部把第二行裁掉半截，
    而单元高度给到 88px（两行只需 28px）依然被裁——不如自己排版来得可控。
    中文没有空格，所以按字符切断。

    两行时按"尽量均分"切，而不是贪心填满第一行：贪心会把
    "qq音乐.lnk" 切成 ["qq音乐.ln", "k"]，第二行只剩一个字母很难看。
    """
    text = text or ""
    if not text:
        return []
    if metrics.horizontalAdvance(text) <= width:
        return [text]
    if max_lines <= 1:
        return [metrics.elidedText(text, Qt.ElideRight, width)]

    best = None
    for cut in range(1, len(text)):
        head, tail = text[:cut], text[cut:]
        if metrics.horizontalAdvance(head) > width:
            break
        tail_fits = metrics.horizontalAdvance(tail) <= width
        tail_text = tail if tail_fits else metrics.elidedText(tail, Qt.ElideRight, width)
        score = abs(len(head) - len(tail))
        if not tail_fits:
            score += 1000  # 优先选"第二行不用省略"的切法
        if best is None or score < best[0]:
            best = (score, [head, tail_text])
    if best is not None:
        return best[1]
    return [metrics.elidedText(text, Qt.ElideRight, width)]


class IconGridDelegate(QStyledItemDelegate):
    """图标在上、名称在下（最多两行）的网格绘制。

    位置全部自己算，所以不会出现"第二行被单元底边切掉"的问题；
    文件筐、内置浏览器共用这一个委托，保证两个窗口观感一致。
    """

    def __init__(self, icon_size=48, lines=TEXT_LINES, parent=None):
        super().__init__(parent)
        self.icon_size = int(icon_size)
        self.lines = max(1, int(lines))

    def set_icon_size(self, size):
        self.icon_size = int(size)

    def sizeHint(self, option, index):  # noqa: N802
        metrics = QFontMetrics(option.font)
        return QSize(
            self.icon_size + CELL_WIDTH_EXTRA,
            self.icon_size + metrics.lineSpacing() * self.lines + CELL_HEIGHT_PADDING,
        )

    def paint(self, painter, option, index):  # noqa: N802
        rect = option.rect
        metrics = QFontMetrics(option.font)
        icon = index.data(Qt.DecorationRole)
        text = index.data(Qt.DisplayRole) or ""
        # ForegroundRole 给的是 QBrush；直接 setPen(brush) 会触发 PySide6 的重载
        # 解析告警（FIXME qt_isinstance…），必须取出 QColor 再画。
        brush = index.data(Qt.ForegroundRole)
        if hasattr(brush, "color"):
            color = brush.color()
        else:
            color = option.palette.color(QPalette.Text)

        icon_rect = QRect(
            rect.center().x() - self.icon_size // 2,
            rect.top() + 3,
            self.icon_size,
            self.icon_size,
        )
        painter.save()
        painter.setRenderHint(QPainter.SmoothPixmapTransform, True)
        if icon is not None and not icon.isNull():
            icon.paint(painter, icon_rect, Qt.AlignCenter)
        painter.restore()

        text_top = icon_rect.bottom() + 3
        available = rect.bottom() - text_top
        want = metrics.lineSpacing() * self.lines
        if available < metrics.lineSpacing():
            return
        line_count = self.lines if available >= want else max(1, available // metrics.lineSpacing())

        painter.save()
        painter.setPen(color)
        y = text_top
        for line in wrap_text(text, metrics, rect.width() - 4, line_count):
            painter.drawText(
                QRect(rect.left() + 2, y, rect.width() - 4, metrics.lineSpacing()),
                Qt.AlignHCenter | Qt.AlignTop,
                line,
            )
            y += metrics.lineSpacing()
        painter.restore()

