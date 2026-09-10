"""Dock 的纯逻辑：热区判定、全屏判定、显隐决策、位置计算、收录与排序。

全部是纯函数，**不 import Qt**，所以能在无显示器环境里直接单测。
窗口与轮询在 dock_window.py，这里只负责"该不该弹、弹到哪、哪些该收录"。

坐标约定：矩形一律用 (left, top, right, bottom) 的屏幕物理像素，与
GetWindowRect / QScreen.geometry 的语义一致。
"""

from baskets import normalize_path, path_key

EDGE_BOTTOM = "bottom"
EDGES = (EDGE_BOTTOM,)

HOT_ZONE_THICKNESS = 3      # 底部热区厚度（像素）
HIDE_DELAY_MS = 400         # 鼠标离开 Dock 后多久收起
ANIMATION_MS = 180          # 滑出/收起动画时长

ACTION_SHOW = "show"
ACTION_HIDE = "hide"
ACTION_NONE = "none"

# 自动收录的后缀：桌面上的快捷方式与可直接运行的程序
COLLECT_SUFFIXES = (".lnk", ".url", ".exe")

# 判定"前台是不是全屏"时要排除的桌面外壳窗口：
# 桌面本身就是铺满屏幕的，不排除的话对着桌面时 Dock 永远弹不出来。
SHELL_WINDOW_CLASSES = frozenset(
    (
        "Progman",
        "WorkerW",
        "Shell_TrayWnd",
        "Shell_SecondaryTrayWnd",
        "SysListView32",
    )
)


# ------------------------------------------------------------------ 热区与全屏


def is_hot_zone(mouse, screen, edge=EDGE_BOTTOM, thickness=HOT_ZONE_THICKNESS):
    """鼠标是否落在屏幕边缘热区里。mouse/screen 为 (l, t, r, b)。"""
    if not mouse or not screen:
        return False
    mx, my = mouse[0], mouse[1]
    left, top, right, bottom = screen[0], screen[1], screen[2], screen[3]
    if mx < left or mx >= right:
        return False
    if edge == EDGE_BOTTOM:
        return bottom - thickness <= my < bottom
    return False


def is_fullscreen(foreground, screen, tolerance=2):
    """前台窗口是否铺满整个显示器（含任务栏区域）。

    最大化窗口只覆盖工作区、不含任务栏，所以不算全屏——这正是我们想要的：
    最大化浏览器时鼠标碰底边依然该弹出 Dock。
    """
    if not foreground or not screen:
        return False
    return (
        foreground[0] <= screen[0] + tolerance
        and foreground[1] <= screen[1] + tolerance
        and foreground[2] >= screen[2] - tolerance
        and foreground[3] >= screen[3] - tolerance
    )


def is_shell_window(class_name):
    """桌面外壳窗口（桌面、任务栏）不算"全屏程序"，不拦 Dock。"""
    return bool(class_name) and class_name in SHELL_WINDOW_CLASSES


def foreground_blocks_dock(foreground_rect, screen_rect, class_name, maximized=False):
    """前台窗口是否应该拦住 Dock。

    - 桌面/任务栏本身不拦：它们本身就铺满屏幕，拦了的话对着桌面永远弹不出来。
    - **最大化窗口不拦**：Windows 最大化窗口的 GetWindowRect 含 DWM 阴影边框，
      实测逻辑矩形 (-5,-5,1712,1072) 比 1707x1067 的屏幕还大，只看矩形会把它
      误判成全屏；用 IsZoomed 判别后按"不拦"处理，这也正是期望行为——最大化
      浏览器时鼠标碰底边仍然该弹出 Dock。
    - 其余铺满整屏、且不是最大化的窗口（全屏视频/游戏/演示）才拦。
    """
    if is_shell_window(class_name):
        return False
    if maximized:
        return False
    return is_fullscreen(foreground_rect, screen_rect)


# ------------------------------------------------------------------ 显隐决策


def should_reveal(
    mouse_in_hot_zone, foreground_fullscreen, locked, already_revealed
):
    """纯函数：返回接下来该做什么（ACTION_SHOW / ACTION_HIDE / ACTION_NONE）。

    规则按"不打扰"优先：
    1. 锁定时什么都不做；
    2. 前台全屏时绝不弹，已经弹出来的要收回去；
    3. 已经滑出时保持（收起由 should_hide 计时决定）；
    4. 否则鼠标在热区里就弹出。
    """
    if locked:
        return ACTION_NONE
    if foreground_fullscreen:
        return ACTION_HIDE if already_revealed else ACTION_NONE
    if already_revealed:
        return ACTION_NONE
    return ACTION_SHOW if mouse_in_hot_zone else ACTION_NONE


def should_hide(
    mouse_in_dock_area,
    foreground_fullscreen,
    locked,
    elapsed_ms,
    hide_delay_ms=HIDE_DELAY_MS,
):
    """纯函数：已滑出的 Dock 该不该收起。

    鼠标还在 Dock 上、被锁定、还没到延迟时间，都保持不动；前台转为全屏时立刻收起。
    """
    if locked or mouse_in_dock_area:
        return False
    if foreground_fullscreen:
        return True
    return elapsed_ms >= hide_delay_ms


# ------------------------------------------------------------------ 位置计算


def monitor_geometry(screens, preferred="primary"):
    """挑显示器：preferred='primary' 取主屏，整数取第 N 块（越界回退主屏再回退第一块）。

    screens 形如 [(geometry, is_primary), ...]。
    """
    if not screens:
        return None
    if isinstance(preferred, int) and not isinstance(preferred, bool):
        if 0 <= preferred < len(screens):
            return screens[preferred][0]
    for geometry, is_primary in screens:
        if is_primary:
            return geometry
    return screens[0][0]


def revealed_geometry(screen, dock_size, edge=EDGE_BOTTOM, margin=0, anchor=None):
    """滑出后的位置：水平居中、贴着指定边。返回 (x, y, w, h)。

    anchor 是"底边该贴在哪"的可选上沿（Qt 逻辑像素）。默认贴屏幕底边；
    底部任务栏正显示时传任务栏上沿，Dock 就会让开它，不会两条叠在一起。
    """
    left, top, right, bottom = screen
    width, height = dock_size
    x = left + max(0, (right - left - width) // 2)
    if edge == EDGE_BOTTOM:
        base = bottom if anchor is None else anchor
        return (x, base - height - margin, width, height)
    return (x, top + margin, width, height)


def hidden_geometry(screen, dock_size, edge=EDGE_BOTTOM, peek=0):
    """收起后的位置：整体移出屏幕可视区（默认一点也不留）。"""
    left, top, right, bottom = screen
    width, height = dock_size
    x = left + max(0, (right - left - width) // 2)
    if edge == EDGE_BOTTOM:
        return (x, bottom - peek, width, height)
    return (x, top - height + peek, width, height)


def geometry_for(screen, dock_size, revealed, edge=EDGE_BOTTOM, margin=0, peek=0):
    """按显隐状态给出目标矩形。动画的起止点就是这两个矩形。"""
    if revealed:
        return revealed_geometry(screen, dock_size, edge, margin)
    return hidden_geometry(screen, dock_size, edge, peek)


def point_in_rect(point, rect):
    """点是否在矩形内（鼠标是否还停在 Dock 上）。"""
    if not point or not rect:
        return False
    return rect[0] <= point[0] < rect[2] and rect[1] <= point[1] < rect[3]


# ------------------------------------------------------------------ 收录与排序


def is_collectable(raw_path):
    """是否是自动收录的三类文件。"""
    path = normalize_path(raw_path)
    if path is None:
        return False
    lowered = path.lower()
    return any(lowered.endswith(suffix) for suffix in COLLECT_SUFFIXES)


def add_item(items, raw_path):
    """追加一条（去重，大小写不敏感）。返回 (新列表, "added"/"duplicate"/"invalid")。"""
    path = normalize_path(raw_path)
    if path is None:
        return list(items), "invalid"
    key = path_key(path)
    if any(path_key(item) == key for item in items):
        return list(items), "duplicate"
    return list(items) + [path], "added"


def remove_item(items, raw_path):
    """移除一条（只动列表，不碰磁盘文件）。"""
    key = path_key(raw_path or "")
    return [item for item in items if path_key(item) != key]


def move_item(items, from_index, to_index):
    """拖拽排序：把 from 位置的条目移到 to 位置。越界原样返回。"""
    result = list(items)
    if not result:
        return result
    if not (0 <= from_index < len(result) and 0 <= to_index < len(result)):
        return result
    if from_index == to_index:
        return result
    moved = result.pop(from_index)
    result.insert(to_index, moved)
    return result


def sync_desktop_shortcuts(items, removed, desktop_paths):
    """把桌面上新出现的快捷方式补进 Dock。

    - 只收录 COLLECT_SUFFIXES 里的类型；
    - 已经在 items 里的不重复添加；
    - 在 removed 里的（用户手动移除过）永不自动加回，除非用户再手动拖进来。
    返回新的 items 列表，顺序保持"原有在前、新增按桌面顺序追加"。
    """
    result = list(items)
    present = {path_key(item) for item in result}
    blocked = {path_key(item) for item in (removed or [])}
    for raw in desktop_paths or []:
        path = normalize_path(raw)
        if path is None or not is_collectable(path):
            continue
        key = path_key(path)
        if key in present or key in blocked:
            continue
        present.add(key)
        result.append(path)
    return result


def find_index(items, raw_path):
    """某条在列表里的下标；找不到返回 -1。"""
    key = path_key(raw_path or "")
    for index, item in enumerate(items):
        if path_key(item) == key:
            return index
    return -1
