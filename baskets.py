"""文件筐的数据模型：只存路径字符串，对文件零写操作。

设计约束（来自任务书）：
- 筐只保存桌面/磁盘上文件的绝对路径，绝不移动、删除、改名、改属性。
- 路径不存在不抛异常，标记为失效项，可一键清理（只从筐里移除条目，不动文件）。
- Windows 路径大小写不敏感，去重按 normcase 归一后比较。

所有函数都是纯函数：传入 dict，返回新的 dict，不改原对象。
"""

import os

BASKET_NAME_MAX = 24
NAME_FALLBACK = "新筐"
DEFAULT_WIDTH = 420
DEFAULT_HEIGHT = 300
MIN_WIDTH = 200
MIN_HEIGHT = 140
MAX_DIMENSION = 4000

ITEM_OK = "ok"
ITEM_MISSING = "missing"


def path_key(path):
    """路径身份键：归一化 + Windows 下大小写不敏感，用于去重与查找。"""
    return os.path.normcase(os.path.normpath(str(path)))


def normalize_path(raw):
    """把外部输入转成绝对路径字符串；非法（空、非字符串、含 NUL）返回 None。"""
    if not isinstance(raw, str):
        return None
    text = raw.strip().strip('"')
    if not text or "\x00" in text:
        return None
    return os.path.normpath(os.path.abspath(text))


def _coerce_dimension(value, default, minimum):
    if isinstance(value, bool) or not isinstance(value, int):
        return default
    if value < minimum:
        return minimum
    if value > MAX_DIMENSION:
        return MAX_DIMENSION
    return value


def _coerce_coord(value, default):
    if isinstance(value, bool) or not isinstance(value, int):
        return default
    if abs(value) > MAX_DIMENSION * 8:
        return default
    return value


def normalize_name(raw, fallback=NAME_FALLBACK):
    if not isinstance(raw, str):
        return fallback
    text = raw.strip()
    if not text:
        return fallback
    return text[:BASKET_NAME_MAX]


def normalize_basket(raw, fallback_id="b1"):
    """把任意来源的筐配置归一化成合法筐；无法识别时返回 None。"""
    if not isinstance(raw, dict):
        return None
    basket_id = raw.get("id")
    if not isinstance(basket_id, str) or not basket_id.strip():
        basket_id = fallback_id
    items = []
    seen = set()
    raw_items = raw.get("items")
    if isinstance(raw_items, list):
        for entry in raw_items:
            path = normalize_path(entry)
            if path is None:
                continue
            key = path_key(path)
            if key in seen:
                continue
            seen.add(key)
            items.append(path)
    return {
        "id": basket_id,
        "name": normalize_name(raw.get("name")),
        "x": _coerce_coord(raw.get("x"), 80),
        "y": _coerce_coord(raw.get("y"), 80),
        "w": _coerce_dimension(raw.get("w"), DEFAULT_WIDTH, MIN_WIDTH),
        "h": _coerce_dimension(raw.get("h"), DEFAULT_HEIGHT, MIN_HEIGHT),
        "items": items,
    }


def normalize_baskets(raw):
    """归一化筐列表：丢掉非法项，补齐/去重 id。"""
    if not isinstance(raw, list):
        return []
    result = []
    used_ids = set()
    for index, entry in enumerate(raw):
        basket = normalize_basket(entry, fallback_id="b%d" % (index + 1))
        if basket is None:
            continue
        base_id = basket["id"]
        candidate = base_id
        suffix = 2
        while candidate in used_ids:
            candidate = "%s-%d" % (base_id, suffix)
            suffix += 1
        basket["id"] = candidate
        used_ids.add(candidate)
        result.append(basket)
    return result


def find_basket(baskets, basket_id):
    """按 id 找筐；找不到返回 None。"""
    for basket in baskets:
        if basket.get("id") == basket_id:
            return basket
    return None


def add_item(basket, raw_path):
    """把路径加进筐：绝对化 + 去重。返回 (新筐, 结果)。

    结果取值："added" / "duplicate" / "invalid"。
    只登记路径，不检查文件是否存在（允许先把路径放进来、再补文件）。
    """
    path = normalize_path(raw_path)
    if path is None:
        return basket, "invalid"
    key = path_key(path)
    items = list(basket.get("items") or [])
    if any(path_key(item) == key for item in items):
        return basket, "duplicate"
    items.append(path)
    updated = dict(basket)
    updated["items"] = items
    return updated, "added"


def remove_item(basket, raw_path):
    """从筐里移除某条路径（只在筐的数据里移除，绝不碰磁盘文件）。"""
    key = path_key(raw_path or "")
    items = [item for item in (basket.get("items") or []) if path_key(item) != key]
    updated = dict(basket)
    updated["items"] = items
    return updated


def item_status(path, exists=os.path.exists):
    """条目状态：文件不在了就是失效项。"""
    return ITEM_OK if exists(path) else ITEM_MISSING


def partition_items(basket, exists=os.path.exists):
    """把筐内条目分成 (有效, 失效) 两组，顺序保持原样。"""
    alive, missing = [], []
    for item in basket.get("items") or []:
        (alive if item_status(item, exists) == ITEM_OK else missing).append(item)
    return alive, missing


def missing_items(basket, exists=os.path.exists):
    """筐内失效条目列表。"""
    return partition_items(basket, exists)[1]


def prune_missing(basket, exists=os.path.exists):
    """清理失效项：只从筐数据里移除。返回 (新筐, 被移除的路径列表)。"""
    alive, missing = partition_items(basket, exists)
    updated = dict(basket)
    updated["items"] = alive
    return updated, missing


def create_basket(baskets, name=None, x=80, y=80):
    """新建一个筐并返回 (新列表, 新筐)。id 取未占用的最小 bN。"""
    existing = {basket.get("id") for basket in baskets}
    index = 1
    while ("b%d" % index) in existing:
        index += 1
    basket = normalize_basket(
        {"id": "b%d" % index, "name": name or ("文件筐 %d" % index), "x": x, "y": y}
    )
    return list(baskets) + [basket], basket


def drop_basket(baskets, basket_id):
    """删掉一个筐（只删筐的定义，筐里指向的文件一个不动）。"""
    return [basket for basket in baskets if basket.get("id") != basket_id]
