"""Dock 窗口层测试：图标渲染、拖入去重、排序持久化、移除只动数据。

offscreen 下跑，不调用任何 Windows API（附着层会自动降级为 "offscreen"）。
"""

import os

import dockmodel
import settings
from dock_window import PATH_ROLE, DockWindow
from fileicons import IconCache

LINK_NAMES = ("QQ.lnk", "Steam.lnk", "学习通.url")


def make_links(tmp_path, names=LINK_NAMES):
    paths = []
    for name in names:
        target = tmp_path / name
        target.write_text("", encoding="utf-8")
        paths.append(str(target))
    return paths


def make_dock(qapp, items=None, on_changed=None):
    dock = DockWindow(IconCache(size=32), on_changed=on_changed)
    dock.set_items(list(items or []))
    dock.show()
    return dock


def dock_paths(dock):
    return [dock.model.item(row).data(PATH_ROLE) for row in range(dock.model.rowCount())]


# ---------------------------------------------------------------- 渲染


def test_dock_renders_all_items(qapp, tmp_path):
    paths = make_links(tmp_path)
    dock = make_dock(qapp, paths)
    assert dock.item_count() == 3
    assert sorted(dock_paths(dock)) == sorted(os.path.normpath(p) for p in paths)
    dock.hide()


def test_dock_marks_missing_item(qapp, tmp_path):
    paths = make_links(tmp_path, ("QQ.lnk",))
    dock = make_dock(qapp, paths + [str(tmp_path / "没了.lnk")])
    assert dock.item_count() == 2
    dock.hide()


def test_dock_offscreen_accent_degrades_safely(qapp):
    dock = make_dock(qapp)
    assert dock.apply_effects() == "offscreen"
    dock.hide()


def test_dock_width_grows_with_item_count(qapp, tmp_path):
    few = make_dock(qapp, make_links(tmp_path, ("a.lnk",)))
    width_few = few.width()
    many = make_dock(qapp, make_links(tmp_path / "sub" if False else tmp_path, LINK_NAMES))
    width_many = many.width()
    assert width_many >= width_few
    few.hide()
    many.hide()


# ---------------------------------------------------------------- 收录与去重


def test_manual_drop_accepts_any_file_type(qapp, tmp_path):
    """自动收录只认三类后缀，但手动拖进来的东西一律收。"""
    txt = tmp_path / "价格.txt"
    txt.write_text("x", encoding="utf-8")
    folder = tmp_path / "solidwork"
    folder.mkdir()
    dock = make_dock(qapp)
    assert dock.add_paths([str(txt), str(folder)]) == 2
    assert dock.item_count() == 2
    dock.hide()


def test_dock_add_paths_dedupes_case_insensitively(qapp, tmp_path):
    paths = make_links(tmp_path, ("QQ.lnk",))
    dock = make_dock(qapp, paths)
    assert dock.add_paths([paths[0]]) == 0
    assert dock.add_paths([paths[0].upper() if paths[0].islower() else paths[0]]) == 0
    assert dock.item_count() == 1
    dock.hide()


def test_dock_add_paths_ignores_invalid(qapp):
    dock = make_dock(qapp)
    assert dock.add_paths([None, "", "   "]) == 0
    assert dock.item_count() == 0
    dock.hide()


def test_auto_collection_only_takes_shortcut_types(tmp_path):
    """把整个桌面丢给收录逻辑，只该收 .lnk/.url/.exe 三类。"""
    (tmp_path / "价格.txt").write_text("x", encoding="utf-8")
    (tmp_path / "军训.pdf").write_text("x", encoding="utf-8")
    (tmp_path / "solidwork").mkdir()
    make_links(tmp_path)
    desktop = [str(p) for p in tmp_path.iterdir()]
    result = dockmodel.sync_desktop_shortcuts([], [], desktop)
    assert sorted(os.path.basename(p) for p in result) == sorted(LINK_NAMES)


def test_auto_collection_respects_user_removed(tmp_path):
    paths = make_links(tmp_path, ("QQ.lnk", "Steam.lnk"))
    result = dockmodel.sync_desktop_shortcuts([], [paths[0]], paths)
    assert [os.path.basename(p) for p in result] == ["Steam.lnk"]


# ---------------------------------------------------------------- 排序持久化


def test_dock_reorder_persists_new_order(qapp, tmp_path):
    """拖拽排序落盘走的不是 rowsMoved——QStandardItemModel 没实现 moveRows，
    QListView 的 InternalMove 用"插入副本+删除原件"实现，只发 inserted/removed。
    所以真正生效的是 dropEvent 之后那次 _sync_order_from_model。"""
    seen = []
    paths = make_links(tmp_path)
    dock = make_dock(qapp, paths, on_changed=seen.append)

    # 模拟内部移动完成后的模型状态：把第 0 条挪到末尾
    row = dock.model.takeRow(0)
    dock.model.appendRow(row)
    assert dock.items == [os.path.normpath(p) for p in paths], "移位本身不该触发落盘"

    ordered = dock._sync_order_from_model()
    expected = [
        os.path.normpath(paths[1]),
        os.path.normpath(paths[2]),
        os.path.normpath(paths[0]),
    ]
    assert dock.items == expected, dock.items
    assert ordered == expected
    assert seen == [expected]
    dock.hide()


def test_dock_reorder_roundtrips_through_settings(qapp, tmp_path):
    paths = make_links(tmp_path)
    dock = make_dock(qapp, paths)
    row = dock.model.takeRow(0)
    dock.model.appendRow(row)
    dock._sync_order_from_model()
    reordered = list(dock.items)
    saved = settings.save_settings({"dock_items": reordered}, base=str(tmp_path / "配置"))
    loaded = settings.load_settings(base=str(tmp_path / "配置"))
    assert loaded["dock_items"] == saved["dock_items"] == reordered
    dock.hide()


def test_dock_reorder_without_change_does_not_notify(qapp, tmp_path):
    seen = []
    paths = make_links(tmp_path)
    dock = make_dock(qapp, paths, on_changed=seen.append)
    dock._sync_order_from_model()
    assert seen == []
    dock.hide()


def test_set_items_does_not_notify(qapp, tmp_path):
    seen = []
    dock = DockWindow(IconCache(size=32), on_changed=seen.append)
    dock.set_items(make_links(tmp_path))
    assert seen == []
    dock.show()
    dock.hide()


# ---------------------------------------------------------------- 移除只动数据


def test_dock_remove_path_keeps_file_on_disk(qapp, tmp_path):
    paths = make_links(tmp_path, ("QQ.lnk", "Steam.lnk"))
    dock = make_dock(qapp, paths)
    assert dock.remove_path(paths[0]) is True
    assert dock.item_count() == 1
    assert os.path.exists(paths[0]), "移除只该动登记，磁盘文件必须还在"
    dock.hide()


def test_dock_remove_unknown_path_is_noop(qapp, tmp_path):
    seen = []
    dock = make_dock(qapp, make_links(tmp_path, ("QQ.lnk",)), on_changed=seen.append)
    assert dock.remove_path("C:/并不存在.lnk") is False
    assert dock.item_count() == 1
    assert seen == []
    dock.hide()


def test_dock_remove_then_autocollect_does_not_readd(qapp, tmp_path):
    """用户在 Dock 上移除过的东西，不该被下一次自动收录加回来。"""
    paths = make_links(tmp_path, ("QQ.lnk", "Steam.lnk"))
    dock = make_dock(qapp, paths)
    dock.remove_path(paths[0])
    resynced = dockmodel.sync_desktop_shortcuts(dock.items, [paths[0]], paths)
    assert [os.path.basename(p) for p in resynced] == ["Steam.lnk"]
    dock.hide()


# ---------------------------------------------------------------- 显隐开关


def test_dock_disabled_collapses_and_stops_revealing(qapp):
    dock = make_dock(qapp)
    dock.set_revealed(True, animate=False)
    assert dock.revealed is True
    dock.set_dock_enabled(False)
    assert dock.revealed is False
    assert dock.tick() == dockmodel.ACTION_NONE, "关掉后不该再弹出来"
    dock.hide()


def test_dock_set_icon_size_relayouts(qapp, tmp_path):
    dock = make_dock(qapp, make_links(tmp_path))
    before = dock.height()
    dock.set_icon_size(64)
    assert dock.height() > before
    assert dock.item_count() == 3
    dock.hide()
