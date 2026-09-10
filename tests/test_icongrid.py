"""图标网格与折行测试。

这一块踩过两次坑，所以单独锁行为：
1. 网格高度只给一行文字的余量 → 第二行被单元底边裁掉半截字；
2. 用 QStyledItemDelegate 自带的换行，即使把单元高度加到 88px（两行只需 28px）
   依然被裁 —— 所以改成自己排版，这里就是在锁自己那套排版的行为。
"""

import icongrid
from PySide6.QtCore import QSize
from PySide6.QtGui import QFontMetrics
from PySide6.QtWidgets import QApplication


def line_metrics(qapp):
    return QFontMetrics(qapp.font())


# ---------------------------------------------------------------- 网格尺寸


def test_grid_height_fits_requested_line_count(qapp):
    view = _FakeView(qapp)
    lines = 2
    grid = icongrid.grid_size(view, 48, lines)
    line_h = icongrid.text_line_height(view)
    assert grid.height() >= 48 + line_h * lines, "网格高度必须容得下两行文字"
    assert grid.width() > 48, "宽度要给文字留位置"


def test_grid_grows_with_line_count(qapp):
    view = _FakeView(qapp)
    one = icongrid.grid_size(view, 48, 1).height()
    two = icongrid.grid_size(view, 48, 2).height()
    assert two > one


def test_grid_grows_with_icon_size(qapp):
    view = _FakeView(qapp)
    assert icongrid.grid_size(view, 64, 2).height() > icongrid.grid_size(view, 48, 2).height()


def test_dock_uses_single_line(qapp):
    assert icongrid.DOCK_TEXT_LINES == 1
    assert icongrid.TEXT_LINES == 2


class _FakeView:
    """只需要 font()，不必真的建一个 QListView。"""

    def __init__(self, app):
        from PySide6.QtWidgets import QWidget

        self._widget = QWidget()
        self._widget.setFont(app.font())

    def font(self):
        return self._widget.font()


# ---------------------------------------------------------------- 折行


def test_wrap_text_single_line_when_it_fits(qapp):
    metrics = line_metrics(qapp)
    assert icongrid.wrap_text("QQ.lnk", metrics, 200, 2) == ["QQ.lnk"]


def test_wrap_text_never_exceeds_max_lines(qapp):
    metrics = line_metrics(qapp)
    for text in ("Arduino IDE.lnk", "一个非常非常长的文件名后面还有内容.lnk", "a b c d e f"):
        lines = icongrid.wrap_text(text, metrics, 90, 2)
        assert 1 <= len(lines) <= 2, (text, lines)


def test_wrap_text_lines_fit_the_width(qapp):
    metrics = line_metrics(qapp)
    width = 90
    for text in ("Arduino IDE.lnk", "腾讯桌面整理工具", "Microsoft Edge.lnk"):
        for line in icongrid.wrap_text(text, metrics, width, 2):
            assert metrics.horizontalAdvance(line) <= width + 1, (text, line)


def test_wrap_text_balances_two_lines(qapp):
    """贪心会切出"第二行只剩一个字母"，这里要求尽量均分。"""
    metrics = line_metrics(qapp)
    lines = icongrid.wrap_text("qq音乐.lnk", metrics, 60, 2)
    assert len(lines) == 2
    assert len(lines[1]) > 1, "第二行不该只剩一个字符"


def test_wrap_text_does_not_drop_content_when_it_fits(qapp):
    metrics = line_metrics(qapp)
    lines = icongrid.wrap_text("Arduino IDE.lnk", metrics, 400, 2)
    assert "".join(lines) == "Arduino IDE.lnk"


def test_wrap_text_elides_when_too_long(qapp):
    metrics = line_metrics(qapp)
    long_name = "这是一个特别特别长的文件名用来验证省略号会出现.lnk"
    lines = icongrid.wrap_text(long_name, metrics, 80, 2)
    assert len(lines) == 2
    assert "…" in lines[-1]


def test_wrap_text_empty_input(qapp):
    metrics = line_metrics(qapp)
    assert icongrid.wrap_text("", metrics, 100, 2) == []
    assert icongrid.wrap_text(None, metrics, 100, 2) == []


def test_wrap_text_single_line_mode_elides(qapp):
    metrics = line_metrics(qapp)
    lines = icongrid.wrap_text("Microsoft Edge.lnk", metrics, 40, 1)
    assert len(lines) == 1
    assert "…" in lines[0]


# ---------------------------------------------------------------- 委托


def test_delegate_size_hint_leaves_room_for_text(qapp):
    delegate = icongrid.IconGridDelegate(icon_size=48, lines=2)
    hint = delegate.sizeHint(_Option(qapp), None)
    metrics = line_metrics(qapp)
    assert hint.height() >= 48 + metrics.lineSpacing() * 2
    assert hint.width() == QSize(48 + icongrid.CELL_WIDTH_EXTRA, hint.height()).width()


def test_delegate_tracks_icon_size(qapp):
    delegate = icongrid.IconGridDelegate(icon_size=48, lines=2)
    before = delegate.sizeHint(_Option(qapp), None).height()
    delegate.set_icon_size(72)
    assert delegate.sizeHint(_Option(qapp), None).height() > before


class _Option:
    """sizeHint/paint 只用到 font / rect / palette。"""

    def __init__(self, app):
        from PySide6.QtCore import QRect
        from PySide6.QtGui import QPalette
        from PySide6.QtWidgets import QStyleOptionViewItem

        self._option = QStyleOptionViewItem()
        self._option.font = app.font()
        self._option.rect = QRect(0, 0, 94, 90)
        self._option.palette = QPalette()

    def __getattr__(self, name):
        return getattr(self._option, name)
