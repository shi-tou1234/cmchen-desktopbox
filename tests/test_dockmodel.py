"""Dock 纯逻辑测试：热区、全屏判定、显隐决策、位置计算、收录与排序。

不依赖 Qt，offscreen 与普通环境都能跑。
"""

import os

import dockmodel
from dockmodel import (
    ACTION_HIDE,
    ACTION_NONE,
    ACTION_SHOW,
    add_item,
    foreground_blocks_dock,
    geometry_for,
    hidden_geometry,
    is_collectable,
    is_fullscreen,
    is_hot_zone,
    is_shell_window,
    monitor_geometry,
    move_item,
    point_in_rect,
    remove_item,
    revealed_geometry,
    should_hide,
    should_reveal,
    sync_desktop_shortcuts,
)

SCREEN = (0, 0, 2560, 1600)          # 主屏 2560x1600
SECOND = (2560, 0, 4480, 1200)       # 副屏贴在右边
DOCK = (900, 120)                    # Dock 尺寸 900x120


# ---------------------------------------------------------------- 热区


def test_hot_zone_true_when_mouse_at_bottom_edge():
    assert is_hot_zone((1280, 1599), SCREEN) is True
    assert is_hot_zone((1280, 1597), SCREEN) is True


def test_hot_zone_false_when_mouse_away_from_edge():
    assert is_hot_zone((1280, 1590), SCREEN) is False
    assert is_hot_zone((1280, 800), SCREEN) is False


def test_hot_zone_false_outside_screen_horizontally():
    assert is_hot_zone((3000, 1599), SCREEN) is False
    assert is_hot_zone((-10, 1599), SCREEN) is False


def test_hot_zone_false_for_missing_input():
    assert is_hot_zone(None, SCREEN) is False
    assert is_hot_zone((1280, 1599), None) is False


def test_hot_zone_respects_thickness():
    assert is_hot_zone((1280, 1595), SCREEN, thickness=8) is True
    assert is_hot_zone((1280, 1590), SCREEN, thickness=8) is False


# ---------------------------------------------------------------- 全屏判定


def test_fullscreen_true_when_covering_whole_screen():
    assert is_fullscreen((0, 0, 2560, 1600), SCREEN) is True


def test_fullscreen_false_for_maximized_window():
    """最大化窗口只到工作区（下方少了任务栏高度），不算全屏。"""
    assert is_fullscreen((0, 0, 2560, 1560), SCREEN) is False


def test_fullscreen_false_when_offset_or_smaller():
    assert is_fullscreen((100, 100, 2000, 1200), SCREEN) is False
    assert is_fullscreen((-5, -5, 2565, 1605), SCREEN) is True  # 允许 2px 容差内的溢出


def test_fullscreen_false_for_missing_input():
    assert is_fullscreen(None, SCREEN) is False
    assert is_fullscreen((0, 0, 2560, 1600), None) is False


def test_shell_windows_are_recognised():
    for name in ("Progman", "WorkerW", "Shell_TrayWnd", "SysListView32"):
        assert is_shell_window(name) is True
    assert is_shell_window("Chrome_WidgetWin_1") is False
    assert is_shell_window("") is False


def test_desktop_window_does_not_block_dock():
    """桌面本身就铺满屏幕，但不能因此拦掉 Dock，否则对着桌面时永远弹不出来。"""
    assert foreground_blocks_dock((0, 0, 2560, 1600), SCREEN, "Progman") is False
    assert foreground_blocks_dock((0, 0, 2560, 1600), SCREEN, "WorkerW") is False


def test_fullscreen_app_blocks_dock():
    assert foreground_blocks_dock((0, 0, 2560, 1600), SCREEN, "Chrome_WidgetWin_1") is True


def test_maximized_app_does_not_block_dock():
    assert foreground_blocks_dock((0, 0, 2560, 1560), SCREEN, "Chrome_WidgetWin_1") is False


# ---------------------------------------------------------------- 显隐决策


def test_should_reveal_shows_when_mouse_in_hot_zone():
    assert should_reveal(True, False, False, False) == ACTION_SHOW


def test_should_reveal_does_nothing_when_mouse_away():
    assert should_reveal(False, False, False, False) == ACTION_NONE


def test_should_reveal_never_shows_over_fullscreen_app():
    assert should_reveal(True, True, False, False) == ACTION_NONE


def test_should_reveal_hides_when_fullscreen_app_appears():
    assert should_reveal(True, True, False, True) == ACTION_HIDE
    assert should_reveal(False, True, False, True) == ACTION_HIDE


def test_should_reveal_keeps_state_when_locked():
    assert should_reveal(True, False, True, False) == ACTION_NONE
    assert should_reveal(True, True, True, True) == ACTION_NONE


def test_should_reveal_keeps_when_already_revealed():
    assert should_reveal(True, False, False, True) == ACTION_NONE


def test_should_hide_waits_for_delay():
    assert should_hide(False, False, False, elapsed_ms=100) is False
    assert should_hide(False, False, False, elapsed_ms=400) is True


def test_should_hide_keeps_when_mouse_on_dock():
    assert should_hide(True, False, False, elapsed_ms=99999) is False


def test_should_hide_immediately_when_fullscreen():
    assert should_hide(False, True, False, elapsed_ms=0) is True


def test_should_hide_respects_lock():
    assert should_hide(False, True, True, elapsed_ms=99999) is False


# ---------------------------------------------------------------- 位置计算


def test_monitor_geometry_prefers_primary():
    screens = [(SECOND, False), (SCREEN, True)]
    assert monitor_geometry(screens, "primary") == SCREEN


def test_monitor_geometry_by_index():
    screens = [(SECOND, False), (SCREEN, True)]
    assert monitor_geometry(screens, 0) == SECOND
    assert monitor_geometry(screens, 1) == SCREEN


def test_monitor_geometry_index_out_of_range_falls_back_to_primary():
    screens = [(SECOND, False), (SCREEN, True)]
    assert monitor_geometry(screens, 9) == SCREEN


def test_monitor_geometry_falls_back_to_first_when_no_primary():
    screens = [(SECOND, False), ((100, 100, 900, 700), False)]
    assert monitor_geometry(screens, "primary") == SECOND


def test_monitor_geometry_empty_returns_none():
    assert monitor_geometry([], "primary") is None


def test_revealed_geometry_is_centered_and_flush_to_bottom():
    x, y, w, h = revealed_geometry(SCREEN, DOCK)
    assert w == DOCK[0] and h == DOCK[1]
    assert x == (2560 - 900) // 2
    assert y + h == SCREEN[3]


def test_revealed_geometry_respects_margin():
    _x, y, _w, h = revealed_geometry(SCREEN, DOCK, margin=8)
    assert y + h == SCREEN[3] - 8


def test_hidden_geometry_moves_fully_off_screen():
    _x, y, _w, _h = hidden_geometry(SCREEN, DOCK)
    assert y == SCREEN[3]
    assert y >= SCREEN[3], "收起后必须完全离开可视区"


def test_hidden_geometry_peek_keeps_a_sliver():
    _x, y, _w, h = hidden_geometry(SCREEN, DOCK, peek=2)
    assert y + h == SCREEN[3] + h - 2


def test_geometry_for_switches_between_two_rects():
    shown = geometry_for(SCREEN, DOCK, revealed=True)
    hidden = geometry_for(SCREEN, DOCK, revealed=False)
    assert shown != hidden
    assert shown[1] < hidden[1]


def test_revealed_geometry_uses_second_monitor_coordinates():
    x, y, _w, h = revealed_geometry(SECOND, DOCK)
    assert x >= SECOND[0]
    assert x + 900 <= SECOND[2]
    assert y + h == SECOND[3]


def test_point_in_rect():
    assert point_in_rect((10, 10), (0, 0, 20, 20)) is True
    assert point_in_rect((20, 10), (0, 0, 20, 20)) is False
    assert point_in_rect(None, (0, 0, 20, 20)) is False
    assert point_in_rect((10, 10), None) is False


# ---------------------------------------------------------------- 收录


def test_collectable_suffixes():
    assert is_collectable("C:/Users/me/Desktop/QQ.lnk") is True
    assert is_collectable("C:/Users/me/Desktop/学习通.url") is True
    assert is_collectable("C:/Users/me/Desktop/万用表.exe") is True
    assert is_collectable("C:/Users/me/Desktop/QQ.LNK") is True


def test_non_collectable_types_are_rejected():
    assert is_collectable("C:/Users/me/Desktop/价格.txt") is False
    assert is_collectable("C:/Users/me/Desktop/军训.pdf") is False
    assert is_collectable("C:/Users/me/Desktop/solidwork") is False
    assert is_collectable("C:/Users/me/Desktop/desktop.ini") is False


def test_collectable_rejects_invalid():
    assert is_collectable(None) is False
    assert is_collectable("") is False
    assert is_collectable(123) is False


def test_sync_adds_new_desktop_shortcuts():
    desktop = ["C:/d/QQ.lnk", "C:/d/价格.txt", "C:/d/学习通.url"]
    result = sync_desktop_shortcuts([], [], desktop)
    assert [os.path.basename(p) for p in result] == ["QQ.lnk", "学习通.url"]


def test_sync_does_not_duplicate_existing():
    existing = ["C:/d/QQ.lnk"]
    result = sync_desktop_shortcuts(existing, [], ["C:/d/QQ.lnk", "C:/d/Steam.lnk"])
    assert [os.path.basename(p) for p in result] == ["QQ.lnk", "Steam.lnk"]


def test_sync_never_readds_user_removed_item():
    desktop = ["C:/d/QQ.lnk", "C:/d/Steam.lnk"]
    result = sync_desktop_shortcuts([], ["C:/d/QQ.lnk"], desktop)
    assert [os.path.basename(p) for p in result] == ["Steam.lnk"]


def test_sync_keeps_existing_order_and_appends_new():
    existing = ["C:/d/B.lnk", "C:/d/A.lnk"]
    result = sync_desktop_shortcuts(existing, [], ["C:/d/A.lnk", "C:/d/C.lnk"])
    assert [os.path.basename(p) for p in result] == ["B.lnk", "A.lnk", "C.lnk"]


def test_sync_handles_garbage_input():
    assert sync_desktop_shortcuts([], [], None) == []
    assert sync_desktop_shortcuts([], None, ["C:/d/A.lnk"]) == [os.path.normpath("C:/d/A.lnk")]


# ---------------------------------------------------------------- 增删与排序


def test_add_item_appends_and_dedupes():
    items, result = add_item([], "C:/d/A.lnk")
    assert result == "added" and len(items) == 1
    items, result = add_item(items, "C:/d/a.LNK")
    assert result == "duplicate" and len(items) == 1


def test_add_item_rejects_invalid():
    items, result = add_item([], None)
    assert result == "invalid" and items == []


def test_remove_item_only_touches_list():
    items = [os.path.normpath("C:/d/A.lnk"), os.path.normpath("C:/d/B.lnk")]
    result = remove_item(items, "C:/d/A.lnk")
    assert [os.path.basename(p) for p in result] == ["B.lnk"]


def test_move_item_reorders():
    items = ["a", "b", "c", "d"]
    assert move_item(items, 0, 2) == ["b", "c", "a", "d"]
    assert move_item(items, 3, 0) == ["d", "a", "b", "c"]


def test_move_item_out_of_range_is_noop():
    items = ["a", "b"]
    assert move_item(items, 5, 0) == items
    assert move_item(items, 0, 5) == items
    assert move_item([], 0, 0) == []


def test_move_item_same_index_is_noop():
    assert move_item(["a", "b"], 1, 1) == ["a", "b"]


def test_defaults_are_sane():
    assert dockmodel.HIDE_DELAY_MS == 400
    assert dockmodel.ANIMATION_MS == 180
    assert dockmodel.HOT_ZONE_THICKNESS == 3
    assert dockmodel.EDGE_BOTTOM == "bottom"


# ---------------------------------------------------------------- 最大化 vs 全屏


def test_maximized_window_rect_overflows_screen_but_does_not_block():
    """实测坑：Windows 最大化窗口的 GetWindowRect 含 DWM 阴影，会比屏幕还大
    （逻辑 (-5,-5,1712,1072) 对 1707x1067）。纯矩形判定会把它误判成全屏，
    结果任何最大化窗口在前时 Dock 都弹不出来。"""
    overflowing = (-5, -5, 1712, 1072)
    screen = (0, 0, 1707, 1067)
    assert is_fullscreen(overflowing, screen) is True  # 只看矩形确实像全屏
    assert (
        foreground_blocks_dock(overflowing, screen, "Chrome_WidgetWin_1", maximized=True)
        is False
    ), "最大化窗口绝不能拦住 Dock"


def test_true_fullscreen_still_blocks():
    assert (
        foreground_blocks_dock(
            (0, 0, 1707, 1067), (0, 0, 1707, 1067), "Chrome_WidgetWin_1", maximized=False
        )
        is True
    )


def test_shell_window_never_blocks_even_when_maximized():
    assert (
        foreground_blocks_dock(
            (0, 0, 1707, 1067), (0, 0, 1707, 1067), "Progman", maximized=True
        )
        is False
    )


def test_maximized_flag_defaults_to_not_maximized():
    assert foreground_blocks_dock((0, 0, 100, 100), (0, 0, 1707, 1067), "X") is False
    assert foreground_blocks_dock((0, 0, 1707, 1067), (0, 0, 1707, 1067), "X") is True
