"""窗口层测试：筐窗口、浏览器窗口、图标缓存、层级降级。

全部在 offscreen 下跑，不调用任何 Windows API（附着层在 offscreen 会降级）。
"""

import os

from PySide6.QtCore import QEventLoop, QTimer

import baskets
import filebrowse
import fileicons
import main
from basket_window import PATH_ROLE, BasketWindow
from explorer_window import ExplorerWindow
from frosted_window import LAYER_WINDOW, FrostedWindow


def drain(window, timeout_ms=6000):
    """把分批渲染的队列跑完（每批之间让出事件循环）。"""
    waited = 0
    while window._pending and waited < timeout_ms:
        loop = QEventLoop()
        QTimer.singleShot(5, loop.quit)
        loop.exec()
        waited += 5
    return not window._pending


def make_files(tmp_path, count):
    paths = []
    for index in range(count):
        target = tmp_path / ("文件%03d.txt" % index)
        target.write_text("x", encoding="utf-8")
        paths.append(str(target))
    return paths


def make_basket(items, name="测试筐"):
    return baskets.normalize_basket({"id": "b1", "name": name, "items": items})


# ---------------------------------------------------------------- 筐窗口


def test_basket_window_lists_all_items(qapp, tmp_path):
    paths = make_files(tmp_path, 3)
    window = BasketWindow(make_basket(paths), fileicons.IconCache(size=32))
    window.show()
    assert window.model.rowCount() == 3
    assert sorted(window.paths()) == sorted(os.path.normpath(p) for p in paths)
    window.hide()


def test_basket_window_marks_missing_item(qapp, tmp_path):
    paths = make_files(tmp_path, 2)
    window = BasketWindow(
        make_basket(paths + [str(tmp_path / "没了.txt")]), fileicons.IconCache(size=32)
    )
    window.show()
    basket = window.basket
    assert len(baskets.missing_items(basket)) == 1
    assert "失效" in window.count_label.text()
    window.hide()


def test_basket_window_add_paths_dedupes(qapp, tmp_path):
    paths = make_files(tmp_path, 2)
    window = BasketWindow(make_basket([]), fileicons.IconCache(size=32))
    window.show()
    assert window.add_paths(paths) == 2
    assert window.add_paths(paths) == 0
    assert window.model.rowCount() == 2
    window.hide()


def test_basket_window_add_paths_ignores_invalid(qapp):
    window = BasketWindow(make_basket([]), fileicons.IconCache(size=32))
    window.show()
    assert window.add_paths([None, "", "   "]) == 0
    assert window.model.rowCount() == 0
    window.hide()


def test_basket_window_remove_path_keeps_others(qapp, tmp_path):
    paths = make_files(tmp_path, 3)
    window = BasketWindow(make_basket(paths), fileicons.IconCache(size=32))
    window.show()
    window.remove_path(paths[0])
    assert window.model.rowCount() == 2
    assert os.path.normpath(paths[0]) not in window.paths()
    window.hide()


def test_basket_window_prune_missing_only_touches_data(qapp, tmp_path):
    real = make_files(tmp_path, 1)
    ghost = str(tmp_path / "没了.txt")
    window = BasketWindow(make_basket(real + [ghost]), fileicons.IconCache(size=32))
    window.show()
    assert window.prune_missing() == 1
    assert window.model.rowCount() == 1
    assert os.path.exists(real[0])
    window.hide()


def test_basket_window_notifies_change(qapp, tmp_path):
    seen = []
    window = BasketWindow(
        make_basket([]), fileicons.IconCache(size=32), on_changed=seen.append
    )
    window.show()
    window.add_paths(make_files(tmp_path, 1))
    assert seen and seen[-1]["items"]
    window.hide()


def test_basket_window_accepts_real_uri_list_drop(qapp, tmp_path):
    paths = make_files(tmp_path, 1)
    window = BasketWindow(make_basket([]), fileicons.IconCache(size=32))
    window.show()
    assert main.simulate_drop(window, paths) is True
    assert window.model.rowCount() == 1
    window.hide()


def test_basket_window_rejects_plain_text_drop(qapp, tmp_path):
    window = BasketWindow(make_basket([]), fileicons.IconCache(size=32))
    window.show()
    assert main.simulate_drop(window, ["just some text"], as_text=True) is False
    assert window.model.rowCount() == 0
    window.hide()


def test_basket_window_folder_item_routes_to_explorer(qapp, tmp_path):
    opened = []
    sub = tmp_path / "子目录"
    sub.mkdir()
    window = BasketWindow(
        make_basket([str(sub)]),
        fileicons.IconCache(size=32),
        on_open_explorer=opened.append,
    )
    window.show()
    index = window.model.index(0, 0)
    window._on_double_clicked(index)
    assert opened == [str(sub)]
    window.hide()


def test_basket_window_offscreen_accent_degrades_safely(qapp):
    window = BasketWindow(make_basket([]), fileicons.IconCache(size=32))
    window.show()
    assert window.apply_effects() == "offscreen"
    assert window.paint_count >= 0
    window.hide()


# ---------------------------------------------------------------- 浏览器窗口


def test_explorer_lists_directory(qapp, tmp_path):
    make_files(tmp_path, 4)
    (tmp_path / "子目录").mkdir()
    window = ExplorerWindow(str(tmp_path), fileicons.IconCache(size=32))
    window.show()
    assert drain(window)
    assert window.model.rowCount() == 5
    window.hide()


def test_explorer_navigates_into_subdirectory(qapp, tmp_path):
    sub = tmp_path / "子目录"
    sub.mkdir()
    make_files(sub, 2)
    window = ExplorerWindow(str(tmp_path), fileicons.IconCache(size=32))
    window.show()
    assert drain(window)
    assert window.navigate_to(str(sub)) is True
    assert drain(window)
    assert window.model.rowCount() == 2
    window.hide()


def test_explorer_up_button_disabled_at_drive_root(qapp):
    root = os.path.splitdrive(os.path.abspath(os.sep))[0] + os.sep
    window = ExplorerWindow(root, fileicons.IconCache(size=32))
    window.show()
    drain(window)
    assert window.up_button.isEnabled() is False
    window.hide()


def test_explorer_up_button_enabled_in_subdirectory(qapp, tmp_path):
    window = ExplorerWindow(str(tmp_path), fileicons.IconCache(size=32))
    window.show()
    drain(window)
    assert window.up_button.isEnabled() is True
    window.hide()


def test_explorer_go_up_moves_to_parent(qapp, tmp_path):
    sub = tmp_path / "子目录"
    sub.mkdir()
    window = ExplorerWindow(str(sub), fileicons.IconCache(size=32))
    window.show()
    drain(window)
    assert window.go_up() is True
    assert window.current_path == os.path.normpath(str(tmp_path))
    window.hide()


def test_explorer_breadcrumb_last_matches_current(qapp, tmp_path):
    sub = tmp_path / "子目录"
    sub.mkdir()
    make_files(sub, 1)
    window = ExplorerWindow(str(sub), fileicons.IconCache(size=32))
    window.show()
    drain(window)
    parts = filebrowse.breadcrumb_parts(window.current_path)
    assert parts[-1]["path"] == window.current_path
    window.hide()


def test_explorer_unreadable_directory_shows_chinese_error(qapp, tmp_path):
    window = ExplorerWindow(str(tmp_path), fileicons.IconCache(size=32))
    window.show()
    drain(window)
    assert window.navigate_to(str(tmp_path / "不存在的目录")) is False
    assert "目录不存在" in window.status_label.text()
    assert window.current_path == os.path.normpath(str(tmp_path))
    window.hide()


def test_explorer_survives_navigating_to_a_file(qapp, tmp_path):
    target = tmp_path / "文件.txt"
    target.write_text("x", encoding="utf-8")
    window = ExplorerWindow(str(tmp_path), fileicons.IconCache(size=32))
    window.show()
    drain(window)
    assert window.navigate_to(str(target)) is False
    assert "不是一个目录" in window.status_label.text()
    window.hide()


def test_explorer_renders_large_directory_in_batches(qapp, tmp_path):
    total = filebrowse.CHUNK_SIZE + 40
    make_files(tmp_path, total)
    window = ExplorerWindow(str(tmp_path), fileicons.IconCache(size=32))
    window.show()
    drained = drain(window)
    assert drained
    assert window.model.rowCount() == total
    window.hide()


def test_explorer_go_back_returns_to_previous(qapp, tmp_path):
    sub = tmp_path / "子目录"
    sub.mkdir()
    window = ExplorerWindow(str(tmp_path), fileicons.IconCache(size=32))
    window.show()
    drain(window)
    window.navigate_to(str(sub))
    drain(window)
    assert window.go_back() is True
    assert window.current_path == os.path.normpath(str(tmp_path))
    window.hide()


def test_explorer_offscreen_accent_degrades_safely(qapp, tmp_path):
    window = ExplorerWindow(str(tmp_path), fileicons.IconCache(size=32))
    window.show()
    assert window.apply_effects() == "offscreen"
    window.hide()


# ---------------------------------------------------------------- 图标缓存


def test_icon_cache_reuses_memory_entry(qapp, tmp_path):
    target = tmp_path / "文件.txt"
    target.write_text("x", encoding="utf-8")
    cache = fileicons.IconCache(size=32)
    first = cache.icon_for(str(target))
    second = cache.icon_for(str(target))
    assert first is second
    assert cache.provider_misses == 1


def test_icon_cache_missing_icon_for_absent_path(qapp):
    cache = fileicons.IconCache(size=32)
    icon = cache.icon_for("C:/并不存在.txt", exists=False)
    assert not icon.isNull()
    assert cache.provider_misses == 0


def test_icon_cache_disk_layer_is_reused(qapp, tmp_path):
    target = tmp_path / "文件.txt"
    target.write_text("x", encoding="utf-8")
    disk = tmp_path / "icons"
    first_cache = fileicons.IconCache(size=32, disk_dir=disk)
    first_cache.icon_for(str(target))
    assert list(disk.glob("*.png"))
    second_cache = fileicons.IconCache(size=32, disk_dir=disk)
    second_cache.icon_for(str(target))
    assert second_cache.disk_hits == 1
    assert second_cache.provider_misses == 0


def test_icon_cache_key_groups_by_extension(qapp):
    assert fileicons.icon_key("C:/a.txt", False) == fileicons.icon_key("C:/b.txt", False)
    assert fileicons.icon_key("C:/a.lnk", False) != fileicons.icon_key("C:/b.lnk", False)
    assert fileicons.icon_key("C:/dir", True) == "dir"


# ---------------------------------------------------------------- 层级降级


def test_layer_window_does_not_use_bottom_hint(qapp, tmp_path):
    """回归测试：WindowStaysOnBottomHint 会被压到壁纸下，禁止再出现在默认层级里。"""
    from PySide6.QtCore import Qt as QtNS

    window = BasketWindow(make_basket([]), fileicons.IconCache(size=32), layer=LAYER_WINDOW)
    window.show()
    assert not (window.windowFlags() & QtNS.WindowStaysOnBottomHint)
    assert not (window.windowFlags() & QtNS.WindowStaysOnTopHint)
    window.hide()


def test_layer_top_uses_top_hint(qapp):
    from PySide6.QtCore import Qt as QtNS

    window = BasketWindow(make_basket([]), fileicons.IconCache(size=32), layer="top")
    window.show()
    assert window.windowFlags() & QtNS.WindowStaysOnTopHint
    window.hide()


def test_frosted_window_platform_is_offscreen_in_tests(qapp):
    assert FrostedWindow.application_platform() == "offscreen"
