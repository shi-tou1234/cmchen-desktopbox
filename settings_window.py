"""设置面板：磨砂窗口，改任何一项都立刻生效并落盘。

分组：外观（磨砂模式、筐图标大小）／Dock（开关、图标大小、收起延迟）／
筐（改名、显隐、删除、清理失效项）／系统（开机自启）／底部（恢复默认）。

设计约定：
- 所有改动都走 `_apply(key, value)`：更新内存 → 立即 `save_settings` → 回调外部。
- 读旧配置必须不丢字段（`settings.merged_settings` 保留未知字段），设置面板
  只碰自己认识的键，不认识的键原样带回去。
"""

import os

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QGridLayout,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

import autostart
import baskets
import settings as settings_mod
from frosted_window import LAYER_DIALOG, FrostedWindow

ID_ROLE = Qt.UserRole + 1

TITLE_STYLE = "color: #F4F4F7; font-size: 15px; font-weight: 700; background: transparent;"
GROUP_STYLE = "color: #A9C8FF; font-size: 12px; font-weight: 600; background: transparent;"
LABEL_STYLE = "color: #E4E5EA; font-size: 12px; background: transparent;"
HINT_STYLE = "color: #9A9BA4; font-size: 11px; background: transparent;"

BUTTON_STYLE = """
QPushButton {
    color: #E8E9EE; background: rgba(255,255,255,0.12);
    border: none; border-radius: 6px; padding: 4px 12px; font-size: 12px;
}
QPushButton:hover { background: rgba(255,255,255,0.22); }
QPushButton:disabled { color: rgba(232,233,238,0.35); background: rgba(255,255,255,0.05); }
"""

SPIN_STYLE = """
QSpinBox {
    color: #EDEEF2; background: rgba(255,255,255,0.10);
    border: none; border-radius: 6px; padding: 3px 6px; font-size: 12px;
}
"""

COMBO_STYLE = """
QComboBox {
    color: #EDEEF2; background: rgba(255,255,255,0.10);
    border: none; border-radius: 6px; padding: 3px 8px; font-size: 12px;
}
QComboBox QAbstractItemView {
    color: #EDEEF2; background: #22232B; selection-background-color: #3A3D4A;
}
"""

CHECK_STYLE = "QCheckBox { color: #E4E5EA; font-size: 12px; background: transparent; }"

LIST_STYLE = """
QListWidget {
    color: #E9EAEF; background: rgba(255,255,255,0.06);
    border: none; border-radius: 8px; font-size: 12px; padding: 4px;
}
QListWidget::item { padding: 3px 6px; border-radius: 5px; }
QListWidget::item:selected { background: rgba(255,255,255,0.20); }
"""


class SettingsWindow(FrostedWindow):
    """磨砂设置面板。settings 变化通过 on_changed 通知外部立即生效。"""

    def __init__(
        self,
        settings_data,
        basket_list=None,
        on_changed=None,
        accent_mode=None,
        base=None,
        parent=None,
    ):
        super().__init__(
            parent=parent,
            accent_mode=accent_mode or settings_data.get("accent_mode", "acrylic"),
            layer=LAYER_DIALOG,
            accept_drops=False,
        )
        self.settings = settings_mod.merged_settings(settings_data)
        self.basket_list = baskets.normalize_baskets(basket_list or self.settings["baskets"])
        self.on_changed = on_changed
        self.base = base
        self._loading = False
        self.setWindowTitle("DeskBasket 设置")
        self.resize(560, 620)
        self._build_ui()
        self.load_from(self.settings, self.basket_list)

    # ------------------------------------------------------------------ UI

    def _build_ui(self):
        outer = QVBoxLayout(self)
        outer.setContentsMargins(14, 12, 14, 12)
        outer.setSpacing(10)

        title = QLabel("DeskBasket 设置", self)
        title.setStyleSheet(TITLE_STYLE)
        outer.addWidget(title)

        scroll = QScrollArea(self)
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.NoFrame)
        scroll.setStyleSheet("QScrollArea { background: transparent; border: none; }")
        body = QWidget(scroll)
        body.setAttribute(Qt.WA_TranslucentBackground, True)
        layout = QVBoxLayout(body)
        layout.setContentsMargins(0, 0, 6, 0)
        layout.setSpacing(12)

        layout.addWidget(self._build_appearance_group(body))
        layout.addWidget(self._build_dock_group(body))
        layout.addWidget(self._build_basket_group(body))
        layout.addWidget(self._build_system_group(body))
        layout.addStretch(1)
        scroll.setWidget(body)
        outer.addWidget(scroll, 1)

        footer = QHBoxLayout()
        self.reset_button = QPushButton("恢复默认", self)
        self.reset_button.setStyleSheet(BUTTON_STYLE)
        self.reset_button.clicked.connect(self.restore_defaults)
        self.close_button = QPushButton("关闭", self)
        self.close_button.setStyleSheet(BUTTON_STYLE)
        self.close_button.clicked.connect(self.hide)
        self.status_label = QLabel("", self)
        self.status_label.setStyleSheet(HINT_STYLE)
        footer.addWidget(self.reset_button)
        footer.addWidget(self.status_label, 1)
        footer.addWidget(self.close_button)
        outer.addLayout(footer)
        self._body = body

    def _group(self, parent, title):
        wrapper = QWidget(parent)
        wrapper.setAttribute(Qt.WA_TranslucentBackground, True)
        box = QVBoxLayout(wrapper)
        box.setContentsMargins(0, 0, 0, 0)
        box.setSpacing(6)
        label = QLabel(title, wrapper)
        label.setStyleSheet(GROUP_STYLE)
        box.addWidget(label)
        grid = QGridLayout()
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(10)
        grid.setVerticalSpacing(6)
        box.addLayout(grid)
        wrapper._grid = grid
        return wrapper

    @staticmethod
    def _label(parent, text):
        label = QLabel(text, parent)
        label.setStyleSheet(LABEL_STYLE)
        return label

    def _build_appearance_group(self, parent):
        group = self._group(parent, "外观")

        self.accent_combo = QComboBox(group)
        self.accent_combo.setStyleSheet(COMBO_STYLE)
        for mode in settings_mod.ACCENT_MODES:
            self.accent_combo.addItem(settings_mod.ACCENT_LABELS[mode], mode)
        self.accent_combo.currentIndexChanged.connect(
            lambda _index: self.set_accent_mode(self.accent_combo.currentData())
        )
        group._grid.addWidget(self._label(group, "磨砂模式"), 0, 0)
        group._grid.addWidget(self.accent_combo, 0, 1)

        self.icon_size_spin = QSpinBox(group)
        self.icon_size_spin.setStyleSheet(SPIN_STYLE)
        self.icon_size_spin.setRange(
            settings_mod.ICON_SIZE_MIN, settings_mod.ICON_SIZE_MAX
        )
        self.icon_size_spin.setSuffix(" px")
        self.icon_size_spin.valueChanged.connect(self.set_icon_size)
        group._grid.addWidget(self._label(group, "筐内图标大小"), 1, 0)
        group._grid.addWidget(self.icon_size_spin, 1, 1)
        return group

    def _build_dock_group(self, parent):
        group = self._group(parent, "底部 Dock")

        self.dock_enabled_check = QCheckBox("显示底部 Dock（鼠标碰屏幕底边滑出）", group)
        self.dock_enabled_check.setStyleSheet(CHECK_STYLE)
        self.dock_enabled_check.toggled.connect(self.set_dock_enabled)
        group._grid.addWidget(self.dock_enabled_check, 0, 0, 1, 2)

        self.dock_icon_spin = QSpinBox(group)
        self.dock_icon_spin.setStyleSheet(SPIN_STYLE)
        self.dock_icon_spin.setRange(
            settings_mod.ICON_SIZE_MIN, settings_mod.ICON_SIZE_MAX
        )
        self.dock_icon_spin.setSuffix(" px")
        self.dock_icon_spin.valueChanged.connect(self.set_dock_icon_size)
        group._grid.addWidget(self._label(group, "Dock 图标大小"), 1, 0)
        group._grid.addWidget(self.dock_icon_spin, 1, 1)

        self.dock_delay_spin = QSpinBox(group)
        self.dock_delay_spin.setStyleSheet(SPIN_STYLE)
        self.dock_delay_spin.setRange(
            settings_mod.DOCK_HIDE_DELAY_MIN, settings_mod.DOCK_HIDE_DELAY_MAX
        )
        self.dock_delay_spin.setSingleStep(50)
        self.dock_delay_spin.setSuffix(" ms")
        self.dock_delay_spin.valueChanged.connect(self.set_dock_hide_delay)
        group._grid.addWidget(self._label(group, "鼠标离开后收起延迟"), 2, 0)
        group._grid.addWidget(self.dock_delay_spin, 2, 1)

        self.dock_count_label = QLabel("", group)
        self.dock_count_label.setStyleSheet(HINT_STYLE)
        group._grid.addWidget(self.dock_count_label, 3, 0, 1, 2)
        return group

    def _build_basket_group(self, parent):
        group = self._group(parent, "文件筐")
        self.basket_list_widget = QListWidget(group)
        self.basket_list_widget.setStyleSheet(LIST_STYLE)
        self.basket_list_widget.setMinimumHeight(120)
        group._grid.addWidget(self.basket_list_widget, 0, 0, 1, 4)

        self.rename_button = QPushButton("改名", group)
        self.visible_button = QPushButton("显示/隐藏", group)
        self.prune_button = QPushButton("清理失效项", group)
        self.delete_button = QPushButton("删除", group)
        for button in (
            self.rename_button,
            self.visible_button,
            self.prune_button,
            self.delete_button,
        ):
            button.setStyleSheet(BUTTON_STYLE)
        self.rename_button.clicked.connect(self.rename_selected_basket)
        self.visible_button.clicked.connect(self.toggle_selected_basket)
        self.prune_button.clicked.connect(self.prune_missing_items)
        self.delete_button.clicked.connect(self.delete_selected_basket)
        buttons = QHBoxLayout()
        for button in (
            self.rename_button,
            self.visible_button,
            self.prune_button,
            self.delete_button,
        ):
            buttons.addWidget(button)
        group._grid.addLayout(buttons, 1, 0, 1, 4)
        return group

    def _build_system_group(self, parent):
        group = self._group(parent, "系统")
        self.autostart_check = QCheckBox("开机自启动（写 HKCU 注册表 Run 值）", group)
        self.autostart_check.setStyleSheet(CHECK_STYLE)
        self.autostart_check.toggled.connect(self.set_autostart)
        group._grid.addWidget(self.autostart_check, 0, 0, 1, 2)
        self.autostart_label = QLabel("", group)
        self.autostart_label.setStyleSheet(HINT_STYLE)
        group._grid.addWidget(self.autostart_label, 1, 0, 1, 2)
        return group

    # ------------------------------------------------------------------ 载入

    def load_from(self, settings_data, basket_list=None):
        """把配置灌进控件。载入过程中不触发落盘。"""
        self._loading = True
        try:
            self.settings = settings_mod.merged_settings(settings_data)
            if basket_list is not None:
                self.basket_list = baskets.normalize_baskets(basket_list)
            else:
                self.basket_list = self.settings["baskets"]

            index = self.accent_combo.findData(self.settings["accent_mode"])
            self.accent_combo.setCurrentIndex(index if index >= 0 else 0)
            self.icon_size_spin.setValue(self.settings["icon_size"])
            self.dock_enabled_check.setChecked(self.settings["dock_enabled"])
            self.dock_icon_spin.setValue(self.settings["dock_icon_size"])
            self.dock_delay_spin.setValue(self.settings["dock_hide_delay_ms"])
            self.autostart_check.setChecked(bool(self.settings["autostart"]))
            self.autostart_label.setText(
                "当前注册表内容：%s" % (autostart.current_command() or "（未启用）")
            )
            self._reload_basket_list()
            self.dock_count_label.setText(
                "Dock 现有 %d 项；自动收录桌面的 .lnk / .url / .exe，也可直接拖进去"
                % len(self.settings["dock_items"])
            )
        finally:
            self._loading = False

    def _reload_basket_list(self):
        self.basket_list_widget.clear()
        for basket in self.basket_list:
            label = "%s（%d 项）%s" % (
                basket.get("name") or baskets.NAME_FALLBACK,
                len(basket.get("items") or []),
                "" if basket.get("visible", True) else " · 已隐藏",
            )
            item = QListWidgetItem(label, self.basket_list_widget)
            item.setData(ID_ROLE, basket.get("id"))
        if self.basket_list_widget.count():
            self.basket_list_widget.setCurrentRow(0)

    def selected_basket_id(self):
        item = self.basket_list_widget.currentItem()
        return item.data(ID_ROLE) if item is not None else None

    # ------------------------------------------------------------------ 落盘

    def _apply(self, **changes):
        """更新内存 → 立刻落盘 → 通知外部。载入中不落盘。"""
        if self._loading:
            return None
        self.settings.update(changes)
        self.settings["baskets"] = self.basket_list
        saved = settings_mod.save_settings(self.settings, base=self.base)
        self.settings = saved
        if callable(self.on_changed):
            self.on_changed(saved)
        return saved

    def _flash(self, text):
        self.status_label.setText(text)

    # ------------------------------------------------------------------ 各项

    def set_accent_mode(self, mode):
        mode = settings_mod.normalize_accent_mode(mode)
        self.accent_mode = mode
        saved = self._apply(accent_mode=mode)
        if saved is not None:
            self.apply_effects()
            self._flash("磨砂模式已切换为 %s" % settings_mod.ACCENT_LABELS[mode])

    def set_icon_size(self, size):
        saved = self._apply(icon_size=int(size))
        if saved is not None:
            self._flash("筐内图标大小已改为 %d px" % saved["icon_size"])

    def set_dock_enabled(self, enabled):
        saved = self._apply(dock_enabled=bool(enabled))
        if saved is not None:
            self._flash("Dock 已%s" % ("打开" if enabled else "关闭"))

    def set_dock_icon_size(self, size):
        saved = self._apply(dock_icon_size=int(size))
        if saved is not None:
            self._flash("Dock 图标大小已改为 %d px" % saved["dock_icon_size"])

    def set_dock_hide_delay(self, milliseconds):
        saved = self._apply(dock_hide_delay_ms=int(milliseconds))
        if saved is not None:
            self._flash("收起延迟已改为 %d ms" % saved["dock_hide_delay_ms"])

    def set_dock_items(self, items):
        saved = self._apply(dock_items=list(items or []))
        if saved is not None:
            self.dock_count_label.setText("Dock 现有 %d 项" % len(saved["dock_items"]))

    def set_autostart(self, enabled):
        if self._loading:
            return
        autostart.sync(bool(enabled))
        saved = self._apply(autostart=bool(enabled))
        if saved is not None:
            self.autostart_label.setText(
                "当前注册表内容：%s" % (autostart.current_command() or "（未启用）")
            )
            self._flash("开机自启已%s" % ("打开" if enabled else "关闭"))

    # ---- 筐操作

    def rename_basket(self, basket_id, new_name):
        updated = []
        for basket in self.basket_list:
            if basket.get("id") == basket_id:
                basket = dict(basket)
                basket["name"] = baskets.normalize_name(new_name)
            updated.append(basket)
        self.basket_list = updated
        self._reload_basket_list()
        return self._apply()

    def set_basket_visible(self, basket_id, visible):
        updated = []
        for basket in self.basket_list:
            if basket.get("id") == basket_id:
                basket = dict(basket)
                basket["visible"] = bool(visible)
            updated.append(basket)
        self.basket_list = updated
        self._reload_basket_list()
        return self._apply()

    def toggle_basket_visible(self, basket_id):
        target = baskets.find_basket(self.basket_list, basket_id)
        if target is None:
            return None
        return self.set_basket_visible(basket_id, not target.get("visible", True))

    def delete_basket(self, basket_id):
        """只删筐的定义，筐里指向的文件一个都不动。"""
        remaining = [b for b in self.basket_list if b.get("id") != basket_id]
        if len(remaining) == len(self.basket_list):
            return None
        self.basket_list = remaining
        self._reload_basket_list()
        return self._apply()

    def prune_missing_items(self):
        """清理所有筐里的失效项：只改数据，不碰磁盘。"""
        total_removed = 0
        updated = []
        for basket in self.basket_list:
            basket, removed = baskets.prune_missing(basket)
            total_removed += len(removed)
            updated.append(basket)
        self.basket_list = updated
        self._reload_basket_list()
        self._apply()
        self._flash("已清理 %d 个失效项（只清登记，磁盘文件未动）" % total_removed)
        return total_removed

    def restore_defaults(self):
        """恢复默认：清掉所有非默认键（含未知字段），只留筐的名单。"""
        fresh = dict(settings_mod.DEFAULTS)
        fresh["baskets"] = [
            {"id": b.get("id"), "name": b.get("name")} for b in self.basket_list
        ]
        self.basket_list = baskets.normalize_baskets(fresh["baskets"])
        fresh["baskets"] = self.basket_list
        self.load_from(fresh, self.basket_list)
        saved = self._apply()
        if saved is not None:
            self._flash("已恢复默认设置")
        return saved

    # ---- 右键菜单式入口

    def rename_selected_basket(self):
        basket_id = self.selected_basket_id()
        target = baskets.find_basket(self.basket_list, basket_id)
        if target is None:
            return None
        current = target.get("name") or baskets.NAME_FALLBACK
        text, ok = QInputDialog.getText(self, "重命名文件筐", "筐的名字：", text=current)
        if not ok or not text.strip():
            return None
        return self.rename_basket(basket_id, text)

    def toggle_selected_basket(self):
        basket_id = self.selected_basket_id()
        if basket_id is None:
            return None
        saved = self.toggle_basket_visible(basket_id)
        if saved is not None:
            target = baskets.find_basket(saved["baskets"], basket_id)
            state = "显示" if (target or {}).get("visible", True) else "隐藏"
            self._flash("这个筐已设为%s" % state)
        return saved

    def delete_selected_basket(self):
        basket_id = self.selected_basket_id()
        target = baskets.find_basket(self.basket_list, basket_id)
        if target is None:
            return None
        answer = QMessageBox.question(
            self,
            "删除这个筐？",
            "只会删掉「%s」这个筐的登记，筐里指向的文件一个都不会动。"
            % (target.get("name") or baskets.NAME_FALLBACK),
        )
        if answer != QMessageBox.Yes:
            return None
        return self.delete_basket(basket_id)
