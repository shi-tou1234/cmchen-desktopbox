"""设置持久化测试：坏文件回退、类型校验、原子写、读写互逆。"""

import json
import os

import settings
from settings import (
    DEFAULTS,
    load_settings,
    merged_settings,
    normalize_accent_mode,
    save_settings,
    settings_dir,
    settings_path,
)


# ---------------------------------------------------------------- merged_settings


def test_merged_settings_defaults_on_garbage():
    assert merged_settings(None) == DEFAULTS
    assert merged_settings("nope") == DEFAULTS
    assert merged_settings([1, 2]) == DEFAULTS


def test_merged_settings_keeps_valid_values():
    result = merged_settings({"accent_mode": "blur", "autostart": True, "icon_size": 64})
    assert result["accent_mode"] == "blur"
    assert result["autostart"] is True
    assert result["icon_size"] == 64


def test_merged_settings_rejects_unknown_accent_mode():
    assert merged_settings({"accent_mode": "金属"})["accent_mode"] == "acrylic"


def test_merged_settings_rejects_wrong_typed_bool():
    assert merged_settings({"autostart": "yes"})["autostart"] is False


def test_merged_settings_icon_size_out_of_range_falls_back():
    assert merged_settings({"icon_size": 8})["icon_size"] == DEFAULTS["icon_size"]
    assert merged_settings({"icon_size": 999})["icon_size"] == DEFAULTS["icon_size"]


def test_merged_settings_icon_size_rejects_bool():
    assert merged_settings({"icon_size": True})["icon_size"] == DEFAULTS["icon_size"]


def test_normalize_accent_mode_accepts_only_known_values():
    assert normalize_accent_mode("acrylic") == "acrylic"
    assert normalize_accent_mode("blur") == "blur"
    assert normalize_accent_mode(None) == "acrylic"


def test_merged_settings_normalizes_nested_baskets():
    result = merged_settings({"baskets": [{"id": "b1", "items": ["C:/x.txt", "C:/x.txt"]}]})
    assert len(result["baskets"][0]["items"]) == 1


def test_merged_settings_drops_garbage_baskets():
    assert merged_settings({"baskets": "not-a-list"})["baskets"] == []


# ---------------------------------------------------------------- load_settings


def test_load_settings_missing_file_returns_defaults(tmp_path):
    assert load_settings(base=str(tmp_path / "空目录")) == DEFAULTS


def test_load_settings_corrupt_json_returns_defaults(tmp_path):
    target = tmp_path / "settings.json"
    target.write_text("{ 这不是合法 JSON ", encoding="utf-8")
    assert load_settings(base=str(tmp_path)) == DEFAULTS


def test_load_settings_partial_file_fills_defaults(tmp_path):
    (tmp_path / "settings.json").write_text(
        json.dumps({"autostart": True}), encoding="utf-8"
    )
    result = load_settings(base=str(tmp_path))
    assert result["autostart"] is True
    assert result["accent_mode"] == DEFAULTS["accent_mode"]
    assert result["baskets"] == []


def test_load_settings_reads_utf8_chinese(tmp_path):
    (tmp_path / "settings.json").write_text(
        json.dumps({"baskets": [{"id": "b1", "name": "学习资料"}]}, ensure_ascii=False),
        encoding="utf-8",
    )
    assert load_settings(base=str(tmp_path))["baskets"][0]["name"] == "学习资料"


# ---------------------------------------------------------------- save_settings


def test_save_creates_directory_and_file(tmp_path):
    base = tmp_path / "还没建的目录"
    save_settings({"icon_size": 32}, base=str(base))
    assert (base / settings.SETTINGS_FILENAME).is_file()


def test_save_then_load_roundtrip(tmp_path):
    payload = {
        "accent_mode": "blur",
        "autostart": True,
        "icon_size": 56,
        "baskets": [{"id": "b1", "name": "常用软件", "x": 10, "y": 20, "items": ["C:/a.txt"]}],
    }
    saved = save_settings(payload, base=str(tmp_path))
    loaded = load_settings(base=str(tmp_path))
    assert loaded == saved


def test_save_normalizes_before_writing(tmp_path):
    save_settings({"accent_mode": "乱写", "icon_size": 9999}, base=str(tmp_path))
    raw = json.loads((tmp_path / "settings.json").read_text(encoding="utf-8"))
    assert raw["accent_mode"] == "acrylic"
    assert raw["icon_size"] == DEFAULTS["icon_size"]


def test_save_leaves_no_temp_files(tmp_path):
    save_settings({"icon_size": 40}, base=str(tmp_path))
    leftovers = [name for name in os.listdir(tmp_path) if name.startswith(".settings-")]
    assert leftovers == []


def test_save_overwrites_previous_content(tmp_path):
    save_settings({"icon_size": 40}, base=str(tmp_path))
    save_settings({"icon_size": 72}, base=str(tmp_path))
    assert load_settings(base=str(tmp_path))["icon_size"] == 72


def test_save_returns_normalized_dict(tmp_path):
    saved = save_settings({"accent_mode": None}, base=str(tmp_path))
    assert saved["accent_mode"] == DEFAULTS["accent_mode"]


def test_settings_path_stays_inside_base(tmp_path):
    path = settings_path(base=str(tmp_path))
    assert path.parent == tmp_path.resolve()
    assert path.name == settings.SETTINGS_FILENAME


def test_settings_dir_prefers_appdata(monkeypatch, tmp_path):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    assert settings_dir() == str(tmp_path / settings.APP_DIR_NAME)


def test_settings_dir_falls_back_without_appdata(monkeypatch):
    monkeypatch.delenv("APPDATA", raising=False)
    assert settings_dir().endswith(settings.APP_DIR_NAME)
