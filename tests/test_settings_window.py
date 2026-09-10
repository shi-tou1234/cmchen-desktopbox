"""设置面板测试：旧配置字段不丢、未知字段保留、改一项立刻落盘、恢复默认。

兼容性样本 tests/data/settings_v1.json 复刻第一份（第二轮之前）写出来的真实
配置格式，并额外塞了两个"未来版本才认识"的字段，用来验证新版本读旧配置、
以及旧版本读新配置都不会把字段吃掉。
"""

import json
import os
from pathlib import Path

import autostart
import baskets
import settings as settings_mod
from frosted_window import LAYER_DIALOG
from settings_window import SettingsWindow

V1_SAMPLE = Path(__file__).resolve().parent / "data" / "settings_v1.json"


def load_v1():
    return json.loads(V1_SAMPLE.read_text(encoding="utf-8"))


def make_window(qapp, tmp_path, data=None, baskets_list=None, on_changed=None):
    window = SettingsWindow(
        data if data is not None else load_v1(),
        basket_list=baskets_list,
        on_changed=on_changed,
        base=str(tmp_path / "配置"),
    )
    window.show()
    return window


def read_saved(tmp_path):
    path = tmp_path / "配置" / settings_mod.SETTINGS_FILENAME
    return json.loads(path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------- 旧配置兼容


def test_v1_config_loads_without_losing_any_field():
    raw = load_v1()
    merged = settings_mod.merged_settings(raw)
    assert merged["accent_mode"] == "acrylic"
    assert merged["icon_size"] == 48
    assert len(merged["baskets"]) == 2
    assert merged["baskets"][0]["name"] == "桌面文件筐"
    assert len(merged["baskets"][0]["items"]) == 3
    assert merged["baskets"][1]["name"] == "学习"


def test_v1_config_gains_dock_defaults():
    merged = settings_mod.merged_settings(load_v1())
    assert merged["dock_enabled"] is True
    assert merged["dock_icon_size"] == settings_mod.DEFAULTS["dock_icon_size"]
    assert merged["dock_items"] == []
    assert merged["dock_removed"] == []


def test_unknown_scalar_field_is_preserved():
    merged = settings_mod.merged_settings(load_v1())
    assert merged["unknown_scalar"] == "保留我"


def test_unknown_nested_field_is_preserved_as_is():
    raw = load_v1()
    merged = settings_mod.merged_settings(raw)
    assert merged["future_feature_flag"] == raw["future_feature_flag"]


def test_unknown_fields_survive_save_and_reload(tmp_path):
    merged = settings_mod.merged_settings(load_v1())
    settings_mod.save_settings(merged, base=str(tmp_path / "配置"))
    reloaded = settings_mod.load_settings(base=str(tmp_path / "配置"))
    assert reloaded["unknown_scalar"] == "保留我"
    assert reloaded["future_feature_flag"] == {"theme": "dark", "nested": [1, 2, 3]}


def test_v1_baskets_get_visible_default_true():
    """第一份的筐配置里没有 visible 字段，读进来必须默认为显示。"""
    merged = settings_mod.merged_settings(load_v1())
    assert all(basket["visible"] is True for basket in merged["baskets"])


def test_v1_basket_geometry_is_kept():
    merged = settings_mod.merged_settings(load_v1())
    first = merged["baskets"][0]
    assert (first["x"], first["y"], first["w"], first["h"]) == (90, 110, 420, 300)


# ---------------------------------------------------------------- 面板载入


def test_window_loads_v1_values_into_widgets(qapp, tmp_path):
    window = make_window(qapp, tmp_path)
    assert window.accent_combo.currentData() == "acrylic"
    assert window.icon_size_spin.value() == 48
    assert window.basket_list_widget.count() == 2
    assert "桌面文件筐" in window.basket_list_widget.item(0).text()
    assert window.dock_enabled_check.isChecked() is True
    window.hide()


def test_load_does_not_write_any_file(qapp, tmp_path):
    make_window(qapp, tmp_path)
    assert not (tmp_path / "配置").exists(), "载入阶段不该落盘"


def test_window_keeps_unknown_fields_after_a_change(qapp, tmp_path):
    window = make_window(qapp, tmp_path)
    window.set_icon_size(64)
    saved = read_saved(tmp_path)
    assert saved["icon_size"] == 64
    assert saved["unknown_scalar"] == "保留我"
    assert saved["future_feature_flag"] == {"theme": "dark", "nested": [1, 2, 3]}
    window.hide()


def test_window_is_dialog_layer_and_accepts_focus(qapp, tmp_path):
    from PySide6.QtCore import Qt

    window = make_window(qapp, tmp_path)
    assert window.layer == LAYER_DIALOG
    assert not (window.windowFlags() & Qt.WindowDoesNotAcceptFocus)
    window.hide()


# ---------------------------------------------------------------- 即时生效


def test_set_accent_mode_persists_immediately(qapp, tmp_path):
    window = make_window(qapp, tmp_path)
    window.set_accent_mode("blur")
    assert read_saved(tmp_path)["accent_mode"] == "blur"
    assert settings_mod.load_settings(base=str(tmp_path / "配置"))["accent_mode"] == "blur"
    assert window.accent_mode == "blur"
    window.hide()


def test_set_icon_size_persists_immediately(qapp, tmp_path):
    window = make_window(qapp, tmp_path)
    window.set_icon_size(72)
    assert read_saved(tmp_path)["icon_size"] == 72
    window.hide()


def test_set_dock_enabled_persists_immediately(qapp, tmp_path):
    window = make_window(qapp, tmp_path)
    window.set_dock_enabled(False)
    assert read_saved(tmp_path)["dock_enabled"] is False
    window.hide()


def test_set_dock_icon_size_and_delay_persist(qapp, tmp_path):
    window = make_window(qapp, tmp_path)
    window.set_dock_icon_size(64)
    window.set_dock_hide_delay(800)
    saved = read_saved(tmp_path)
    assert saved["dock_icon_size"] == 64
    assert saved["dock_hide_delay_ms"] == 800
    window.hide()


def test_out_of_range_values_are_normalised(qapp, tmp_path):
    window = make_window(qapp, tmp_path)
    window.set_dock_hide_delay(999999)
    window.set_dock_icon_size(1)
    saved = read_saved(tmp_path)
    assert saved["dock_hide_delay_ms"] == settings_mod.DEFAULTS["dock_hide_delay_ms"]
    assert saved["dock_icon_size"] == settings_mod.DEFAULTS["dock_icon_size"]
    window.hide()


def test_on_changed_receives_saved_dict(qapp, tmp_path):
    seen = []
    window = make_window(qapp, tmp_path, on_changed=seen.append)
    window.set_icon_size(56)
    assert seen and seen[-1]["icon_size"] == 56
    assert seen[-1]["unknown_scalar"] == "保留我"
    window.hide()


def test_set_dock_items_persists(qapp, tmp_path):
    window = make_window(qapp, tmp_path)
    window.set_dock_items(["C:/d/QQ.lnk", "C:/d/Steam.lnk", "C:/d/QQ.lnk"])
    saved = read_saved(tmp_path)
    assert len(saved["dock_items"]) == 2, "同一路径只留一条"
    window.hide()


def test_autostart_toggle_is_written_to_settings(qapp, tmp_path, monkeypatch):
    """不许真去动注册表：autostart.sync 用替身，验证的是设置面板自己的行为。"""
    calls = []
    monkeypatch.setattr(autostart, "sync", lambda enabled: calls.append(enabled) or True)
    monkeypatch.setattr(autostart, "current_command", lambda: "")
    window = make_window(qapp, tmp_path)
    window.set_autostart(True)
    assert calls == [True]
    assert read_saved(tmp_path)["autostart"] is True
    window.hide()


# ---------------------------------------------------------------- 筐操作


def test_rename_basket_persists(qapp, tmp_path):
    window = make_window(qapp, tmp_path)
    window.rename_basket("b1", "常用软件")
    saved = read_saved(tmp_path)
    names = {b["id"]: b["name"] for b in saved["baskets"]}
    assert names["b1"] == "常用软件"
    assert names["b2"] == "学习"
    window.hide()


def test_toggle_basket_visible_persists(qapp, tmp_path):
    window = make_window(qapp, tmp_path)
    window.toggle_basket_visible("b1")
    saved = read_saved(tmp_path)
    assert saved["baskets"][0]["visible"] is False
    assert saved["baskets"][1]["visible"] is True
    window.toggle_basket_visible("b1")
    assert read_saved(tmp_path)["baskets"][0]["visible"] is True
    window.hide()


def test_delete_basket_only_removes_definition(qapp, tmp_path):
    window = make_window(qapp, tmp_path)
    window.delete_basket("b1")
    saved = read_saved(tmp_path)
    assert [b["id"] for b in saved["baskets"]] == ["b2"]
    window.hide()


def test_delete_unknown_basket_is_noop(qapp, tmp_path):
    window = make_window(qapp, tmp_path)
    assert window.delete_basket("nope") is None
    assert not (tmp_path / "配置").exists()
    window.hide()


def test_prune_missing_items_only_touches_data(qapp, tmp_path):
    real = tmp_path / "真的在.txt"
    real.write_text("x", encoding="utf-8")
    data = load_v1()
    data["baskets"][0]["items"] = [str(real), str(tmp_path / "不在了.txt")]
    window = make_window(qapp, tmp_path, data=data)
    removed = window.prune_missing_items()
    assert removed == 1
    assert real.exists(), "清理失效项不许删磁盘文件"
    saved = read_saved(tmp_path)
    assert saved["baskets"][0]["items"] == [os.path.normpath(str(real))]
    window.hide()


# ---------------------------------------------------------------- 恢复默认


def test_restore_defaults_resets_values_but_keeps_basket_names(qapp, tmp_path):
    window = make_window(qapp, tmp_path)
    window.set_icon_size(96)
    window.set_accent_mode("blur")
    saved = window.restore_defaults()
    assert saved["icon_size"] == settings_mod.DEFAULTS["icon_size"]
    assert saved["accent_mode"] == settings_mod.DEFAULTS["accent_mode"]
    names = [b["name"] for b in saved["baskets"]]
    assert names == ["桌面文件筐", "学习"], "恢复默认不该把用户建的筐删掉"
    window.hide()


def test_restore_defaults_drops_unknown_fields(qapp, tmp_path):
    window = make_window(qapp, tmp_path)
    saved = window.restore_defaults()
    assert "unknown_scalar" not in saved
    assert "future_feature_flag" not in saved
    window.hide()


def test_restore_defaults_writes_file(qapp, tmp_path):
    window = make_window(qapp, tmp_path)
    window.restore_defaults()
    assert read_saved(tmp_path)["icon_size"] == settings_mod.DEFAULTS["icon_size"]
    window.hide()


def test_basket_normalize_keeps_visible_false():
    basket = baskets.normalize_basket({"id": "b1", "visible": False})
    assert basket["visible"] is False


def test_basket_normalize_rejects_non_bool_visible():
    assert baskets.normalize_basket({"id": "b1", "visible": "no"})["visible"] is True
