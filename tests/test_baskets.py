"""筐数据模型测试：去重、失效检测、清理，全部只碰数据层，不动磁盘文件。"""

import os

import baskets
from baskets import (
    ITEM_MISSING,
    ITEM_OK,
    add_item,
    create_basket,
    drop_basket,
    find_basket,
    item_status,
    missing_items,
    normalize_basket,
    normalize_baskets,
    normalize_name,
    normalize_path,
    partition_items,
    path_key,
    prune_missing,
    remove_item,
)


def make_basket(items=None, **kwargs):
    raw = {"id": "b1", "name": "测试筐", "items": list(items or [])}
    raw.update(kwargs)
    return normalize_basket(raw)


# ---------------------------------------------------------------- normalize_path


def test_normalize_path_returns_absolute_normalized(tmp_path):
    target = tmp_path / "sub" / ".." / "file.txt"
    result = normalize_path(str(target))
    assert os.path.isabs(result)
    assert ".." not in result


def test_normalize_path_rejects_non_string():
    assert normalize_path(None) is None
    assert normalize_path(123) is None
    assert normalize_path(["C:/a"]) is None


def test_normalize_path_rejects_empty_and_nul():
    assert normalize_path("") is None
    assert normalize_path("   ") is None
    assert normalize_path("C:/a\x00b") is None


def test_normalize_path_strips_quotes(tmp_path):
    raw = '"%s"' % (tmp_path / "a b.txt")
    assert normalize_path(raw) == os.path.normpath(str(tmp_path / "a b.txt"))


def test_normalize_path_handles_chinese_and_space(tmp_path):
    target = tmp_path / "学习 资料" / "军训.pdf"
    assert normalize_path(str(target)) == os.path.normpath(str(target))


# ---------------------------------------------------------------- path_key


def test_path_key_is_stable_and_normalized(tmp_path):
    target = str(tmp_path / "a.txt")
    assert path_key(target) == path_key(target)
    assert path_key(target) == os.path.normcase(os.path.normpath(target))


def test_path_key_is_case_insensitive_on_windows(tmp_path):
    upper = str(tmp_path / "A.TXT")
    lower = str(tmp_path / "a.txt")
    if os.name == "nt":
        assert path_key(upper) == path_key(lower)


# ---------------------------------------------------------------- add_item


def test_add_item_adds_absolute_path(tmp_path):
    basket = make_basket()
    updated, result = add_item(basket, str(tmp_path / "a.txt"))
    assert result == "added"
    assert updated["items"] == [os.path.normpath(str(tmp_path / "a.txt"))]


def test_add_item_dedupes_same_path(tmp_path):
    path = str(tmp_path / "a.txt")
    basket, _ = add_item(make_basket(), path)
    updated, result = add_item(basket, path)
    assert result == "duplicate"
    assert len(updated["items"]) == 1


def test_add_item_dedupes_trailing_separator_variant(tmp_path):
    path = str(tmp_path / "dir")
    basket, _ = add_item(make_basket(), path)
    updated, result = add_item(basket, path + os.sep)
    assert result == "duplicate"
    assert len(updated["items"]) == 1


def test_add_item_dedupes_case_variant_on_windows(tmp_path):
    if os.name != "nt":
        return
    basket, _ = add_item(make_basket(), str(tmp_path / "A.txt"))
    updated, result = add_item(basket, str(tmp_path / "a.txt"))
    assert result == "duplicate"
    assert len(updated["items"]) == 1


def test_add_item_invalid_leaves_basket_untouched():
    basket = make_basket()
    updated, result = add_item(basket, None)
    assert result == "invalid"
    assert updated["items"] == []


def test_add_item_does_not_mutate_original(tmp_path):
    basket = make_basket()
    original_items = list(basket["items"])
    add_item(basket, str(tmp_path / "a.txt"))
    assert basket["items"] == original_items


def test_add_item_allows_path_that_does_not_exist_yet(tmp_path):
    basket, result = add_item(make_basket(), str(tmp_path / "还没建的文件.txt"))
    assert result == "added"


# ---------------------------------------------------------------- remove_item


def test_remove_item_removes_only_that_entry(tmp_path):
    first, second = str(tmp_path / "a.txt"), str(tmp_path / "b.txt")
    basket = make_basket([first, second])
    updated = remove_item(basket, first)
    assert updated["items"] == [os.path.normpath(second)]


def test_remove_item_unknown_path_is_noop(tmp_path):
    basket = make_basket([str(tmp_path / "a.txt")])
    updated = remove_item(basket, str(tmp_path / "nope.txt"))
    assert updated["items"] == basket["items"]


# ---------------------------------------------------------------- 失效检测


def test_item_status_ok_for_existing_file(tmp_path):
    target = tmp_path / "存在.txt"
    target.write_text("x", encoding="utf-8")
    assert item_status(str(target)) == ITEM_OK


def test_item_status_missing_for_absent_path(tmp_path):
    assert item_status(str(tmp_path / "不在了.txt")) == ITEM_MISSING


def test_partition_items_splits_and_keeps_order(tmp_path):
    alive = tmp_path / "在.txt"
    alive.write_text("x", encoding="utf-8")
    gone = tmp_path / "没了.txt"
    basket = make_basket([str(alive), str(gone), str(alive)])
    ok_list, missing = partition_items(basket)
    assert ok_list == [os.path.normpath(str(alive))]
    assert missing == [os.path.normpath(str(gone))]


def test_missing_items_lists_only_absent(tmp_path):
    alive = tmp_path / "在.txt"
    alive.write_text("x", encoding="utf-8")
    basket = make_basket([str(alive), str(tmp_path / "没了.txt")])
    assert missing_items(basket) == [os.path.normpath(str(tmp_path / "没了.txt"))]


def test_prune_missing_removes_only_missing_entries(tmp_path):
    alive = tmp_path / "在.txt"
    alive.write_text("x", encoding="utf-8")
    gone = str(tmp_path / "没了.txt")
    basket = make_basket([str(alive), gone])
    updated, removed = prune_missing(basket)
    assert updated["items"] == [os.path.normpath(str(alive))]
    assert removed == [os.path.normpath(gone)]


def test_prune_missing_does_not_touch_files_on_disk(tmp_path):
    """反向保证：清理失效项只改筐数据，磁盘上的文件一个都不动。"""
    alive = tmp_path / "在.txt"
    alive.write_text("x", encoding="utf-8")
    basket = make_basket([str(alive), str(tmp_path / "没了.txt")])
    prune_missing(basket)
    assert alive.is_file()
    assert alive.read_text(encoding="utf-8") == "x"


def test_prune_missing_treats_explicitly_missing_predicate(tmp_path):
    """注入式存在性判断：把探测函数换成恒 False，全部条目都该被判失效。"""
    basket = make_basket([str(tmp_path / "a.txt"), str(tmp_path / "b.txt")])
    updated, removed = prune_missing(basket, exists=lambda _path: False)
    assert updated["items"] == []
    assert len(removed) == 2


# ---------------------------------------------------------------- normalize_basket


def test_normalize_basket_fills_defaults():
    basket = normalize_basket({"id": "b7"})
    assert basket["id"] == "b7"
    assert basket["name"] == baskets.NAME_FALLBACK
    assert basket["items"] == []
    assert basket["w"] == baskets.DEFAULT_WIDTH


def test_normalize_basket_rejects_non_dict():
    assert normalize_basket(None) is None
    assert normalize_basket("b1") is None
    assert normalize_basket([]) is None


def test_normalize_basket_clamps_size_and_coords():
    basket = normalize_basket({"id": "b1", "w": 5, "h": 99999, "x": "left"})
    assert basket["w"] == baskets.MIN_WIDTH
    assert basket["h"] == baskets.MAX_DIMENSION
    assert basket["x"] == 80


def test_normalize_basket_drops_invalid_items_and_dedupes():
    basket = normalize_basket({"id": "b1", "items": ["C:/a.txt", None, "", "C:/a.txt", 5]})
    assert basket["items"] == [os.path.normpath(os.path.abspath("C:/a.txt"))]


def test_normalize_basket_survives_items_not_a_list():
    assert normalize_basket({"id": "b1", "items": "C:/a.txt"})["items"] == []


def test_normalize_name_truncates_long_text():
    assert len(normalize_name("筐" * 100)) == baskets.BASKET_NAME_MAX


def test_normalize_name_falls_back_on_blank():
    assert normalize_name("   ") == baskets.NAME_FALLBACK
    assert normalize_name(None) == baskets.NAME_FALLBACK


# ---------------------------------------------------------------- normalize_baskets


def test_normalize_baskets_returns_empty_for_garbage():
    assert normalize_baskets(None) == []
    assert normalize_baskets({"id": "b1"}) == []


def test_normalize_baskets_drops_non_dict_entries():
    result = normalize_baskets([{"id": "b1"}, None, "x", 3])
    assert [b["id"] for b in result] == ["b1"]


def test_normalize_baskets_dedupes_ids():
    result = normalize_baskets([{"id": "b1"}, {"id": "b1"}, {"id": "b1"}])
    assert [b["id"] for b in result] == ["b1", "b1-2", "b1-3"]


def test_normalize_baskets_assigns_missing_ids():
    result = normalize_baskets([{}, {}])
    assert [b["id"] for b in result] == ["b1", "b2"]


# ---------------------------------------------------------------- create / drop / find


def test_create_basket_uses_smallest_free_id():
    baskets_list = normalize_baskets([{"id": "b1"}, {"id": "b3"}])
    updated, basket = create_basket(baskets_list)
    assert basket["id"] == "b2"
    assert len(updated) == 3
    assert updated[-1]["id"] == "b2"


def test_create_basket_keeps_existing_untouched():
    baskets_list = normalize_baskets([{"id": "b1", "items": ["C:/keep.txt"]}])
    updated, _ = create_basket(baskets_list)
    assert updated[0]["items"] == baskets_list[0]["items"]


def test_drop_basket_removes_only_that_basket():
    baskets_list = normalize_baskets([{"id": "b1"}, {"id": "b2"}])
    remaining = drop_basket(baskets_list, "b1")
    assert [b["id"] for b in remaining] == ["b2"]


def test_drop_basket_unknown_id_is_noop():
    baskets_list = normalize_baskets([{"id": "b1"}])
    assert drop_basket(baskets_list, "nope") == baskets_list


def test_find_basket_returns_match_or_none():
    baskets_list = normalize_baskets([{"id": "b1"}, {"id": "b2"}])
    assert find_basket(baskets_list, "b2")["id"] == "b2"
    assert find_basket(baskets_list, "b9") is None
