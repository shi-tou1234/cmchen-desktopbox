"""设置持久化：JSON 读写、缺省值归一化、坏文件回退默认、原子写。

安全设计：文件名固定为 settings.json，位置只由 base 目录决定
（默认 %APPDATA%\\DeskBasket）。base 先 resolve()，写入前用 relative_to
做白名单包含校验，从结构上排除路径穿越。
"""

import json
import os
import tempfile
from pathlib import Path

import baskets as baskets_mod

SETTINGS_FILENAME = "settings.json"
APP_DIR_NAME = "DeskBasket"

ACCENT_MODES = ("acrylic", "blur")
ACCENT_LABELS = {
    "acrylic": "磨砂玻璃（Acrylic）",
    "blur": "轻量模糊（Blur，拖动更跟手）",
}

ICON_SIZE_MIN, ICON_SIZE_MAX = 24, 128

DEFAULTS = {
    "accent_mode": "acrylic",   # acrylic / blur
    "autostart": False,         # 开机自启动（HKCU Run）
    "icon_size": 48,            # 筐内图标边长（像素）
    "baskets": [],              # 筐列表，见 baskets.normalize_baskets
}


def settings_dir():
    """设置目录：%APPDATA%\\DeskBasket，取不到 APPDATA 时回退用户主目录。"""
    appdata = os.environ.get("APPDATA")
    if appdata:
        return str(Path(appdata) / APP_DIR_NAME)
    return str(Path.home() / ("." + APP_DIR_NAME))


def _base_root(base=None):
    """解析并返回设置根目录（已 resolve 的绝对路径）。"""
    return Path(base).resolve() if base else Path(settings_dir()).resolve()


def settings_path(base=None):
    """设置文件完整路径（base 内固定文件名，无穿越面）。"""
    return _base_root(base) / SETTINGS_FILENAME


def normalize_accent_mode(value, default=DEFAULTS["accent_mode"]):
    """校验磨砂模式取值；非法时回退 default。"""
    if isinstance(value, str) and value in ACCENT_MODES:
        return value
    return default


def _coerce_bool(value, default):
    return value if isinstance(value, bool) else default


def _coerce_icon_size(value):
    if isinstance(value, bool) or not isinstance(value, int):
        return DEFAULTS["icon_size"]
    if ICON_SIZE_MIN <= value <= ICON_SIZE_MAX:
        return value
    return DEFAULTS["icon_size"]


def merged_settings(raw):
    """把任意来源的 dict 合并到缺省值上：缺字段补默认，类型不对回退默认。"""
    result = dict(DEFAULTS)
    if not isinstance(raw, dict):
        return result
    result["accent_mode"] = normalize_accent_mode(raw.get("accent_mode"))
    result["autostart"] = _coerce_bool(raw.get("autostart"), DEFAULTS["autostart"])
    result["icon_size"] = _coerce_icon_size(raw.get("icon_size"))
    result["baskets"] = baskets_mod.normalize_baskets(raw.get("baskets"))
    return result


def load_settings(base=None):
    """读设置；文件缺失、坏 JSON、字段缺失/类型错时逐级回退默认，绝不抛异常。"""
    target = settings_path(base)
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return dict(DEFAULTS)
    return merged_settings(raw)


def save_settings(settings, base=None):
    """原子写设置：写临时文件后 os.replace 顶替，避免断电/中断留下半个文件。

    白名单包含校验：resolved 目标必须仍位于 resolved 的 base 目录内。
    """
    root = _base_root(base)
    root.mkdir(parents=True, exist_ok=True)
    target = (root / SETTINGS_FILENAME).resolve()
    target.relative_to(root)
    merged = merged_settings(settings)
    payload = json.dumps(merged, ensure_ascii=False, indent=2)
    handle = tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=str(root), prefix=".settings-", suffix=".tmp",
        delete=False,
    )
    try:
        with handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(handle.name, target)
    except OSError:
        try:
            os.unlink(handle.name)
        except OSError:
            pass
        raise
    return merged
