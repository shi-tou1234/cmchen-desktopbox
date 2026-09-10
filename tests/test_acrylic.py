"""磨砂模块测试：句柄无效时必须静默失败，不能抛异常。

真机上的视觉效果由 `main.py --probe --win-d` 的截图取证，这里只锁行为契约。
"""

import acrylic


def test_accent_state_value_maps_both_modes():
    assert acrylic.accent_state_value("acrylic") == 4
    assert acrylic.accent_state_value("blur") == 3


def test_accent_state_value_unknown_falls_back_to_acrylic():
    assert acrylic.accent_state_value("乱写") == 4


def test_apply_accent_rejects_zero_handle():
    assert acrylic.apply_accent(0) is False


def test_apply_accent_rejects_none_handle():
    assert acrylic.apply_accent(None) is False


def test_apply_accent_rejects_non_int_handle():
    assert acrylic.apply_accent("12345") is False


def test_clear_accent_rejects_invalid_handle():
    assert acrylic.clear_accent(0) is False
    assert acrylic.clear_accent(None) is False


def test_apply_frosted_returns_off_for_invalid_handle():
    assert acrylic.apply_frosted(0) == acrylic.MODE_OFF
    assert acrylic.apply_frosted(None) == acrylic.MODE_OFF


def test_apply_frosted_accepts_blur_mode_name():
    """blur 模式必须是合法请求，即使这里句柄无效。"""
    assert acrylic.apply_frosted(0, mode=acrylic.MODE_BLUR) == acrylic.MODE_OFF


def test_apply_rounded_corners_invalid_handle():
    assert acrylic.apply_rounded_corners(0) is False


def test_apply_dark_titlebar_invalid_handle():
    assert acrylic.apply_dark_titlebar(0) is False


def test_apply_system_backdrop_invalid_handle():
    assert acrylic.apply_system_backdrop(0) is False


def test_describe_platform_non_empty():
    assert acrylic.describe_platform()


def test_default_tint_has_nonzero_alpha():
    """Acrylic 需要 tint 的 alpha 非 0，否则部分系统上完全不显示磨砂。"""
    assert (acrylic.DEFAULT_TINT >> 24) & 0xFF != 0
