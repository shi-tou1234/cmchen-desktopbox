"""文件浏览的纯逻辑：面包屑、上一级、目录列举、分批。

全部只读：只用 os.scandir 列目录，绝不创建、删除、改名、写属性。
所有异常都转成中文提示字符串返回，不往上抛——界面上要让用户看到原因，
而不是程序崩掉。
"""

import os

CHUNK_SIZE = 300
ERROR_PERMISSION = "没有权限读取这个目录"
ERROR_NOT_FOUND = "目录不存在或已经被移走"
ERROR_NOT_DIR = "这不是一个目录"
ERROR_UNREADABLE = "读不了这个目录（系统错误码 %s）"


def is_root(path):
    """是否已经到根：盘符根（C:\\）或 UNC 根（\\\\server\\share）。"""
    if not path:
        return True
    normalized = os.path.normpath(path)
    drive, tail = os.path.splitdrive(normalized)
    if not tail or tail == os.sep:
        return True
    return False


def parent_of(path):
    """上一级路径；已在根返回 None。"""
    if not path or is_root(path):
        return None
    parent = os.path.dirname(os.path.normpath(path))
    if not parent or parent == path:
        return None
    return parent


def breadcrumb_parts(path):
    """把路径拆成可点击的面包屑，返回 [{label, path}, ...]，从根到当前。

    例：C:\\Users\\me\\学习  →  [C:\\] / [Users] / [me] / [学习]
    """
    if not path:
        return []
    normalized = os.path.normpath(path)
    drive, tail = os.path.splitdrive(normalized)
    parts = []
    if not tail or tail == os.sep:
        # 盘符根或 UNC 根，只有一个节点
        label = drive or normalized
        return [{"label": label, "path": normalized}]
    current = drive + os.sep
    parts.append({"label": drive or os.sep, "path": current})
    for piece in tail.strip(os.sep).split(os.sep):
        if not piece:
            continue
        current = os.path.join(current, piece)
        parts.append({"label": piece, "path": current})
    return parts


def entry_sort_key(entry):
    """排序：目录在前，同类按名字（忽略大小写）。"""
    return (0 if entry["is_dir"] else 1, entry["name"].lower())


def _error_text(exc):
    if isinstance(exc, PermissionError):
        return ERROR_PERMISSION
    if isinstance(exc, FileNotFoundError):
        return ERROR_NOT_FOUND
    if isinstance(exc, NotADirectoryError):
        return ERROR_NOT_DIR
    return ERROR_UNREADABLE % getattr(exc, "errno", "未知")


def list_entries(path):
    """列出目录内容。返回 {"entries": [...], "error": 中文提示或 None}。

    单个条目读不到（权限/链接失效）就跳过它，不影响整个目录的展示。
    """
    if not path:
        return {"entries": [], "error": ERROR_NOT_FOUND}
    if not os.path.exists(path):
        return {"entries": [], "error": ERROR_NOT_FOUND}
    if not os.path.isdir(path):
        return {"entries": [], "error": ERROR_NOT_DIR}
    try:
        with os.scandir(path) as scanner:
            raw = list(scanner)
    except OSError as exc:
        return {"entries": [], "error": _error_text(exc)}

    entries = []
    for item in raw:
        try:
            is_dir = item.is_dir()
        except OSError:
            continue
        entries.append({"name": item.name, "path": item.path, "is_dir": is_dir})
    entries.sort(key=entry_sort_key)
    return {"entries": entries, "error": None}


def chunked(sequence, size=CHUNK_SIZE):
    """把序列切成若干批，供界面分批渲染（大目录不卡死）。"""
    if size <= 0:
        size = CHUNK_SIZE
    return [sequence[index:index + size] for index in range(0, len(sequence), size)]
