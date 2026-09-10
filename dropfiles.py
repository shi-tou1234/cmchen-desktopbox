"""拖放解析：把系统拖进来的 uri-list / QUrl 列表转成磁盘路径。

纯函数，不依赖 Qt 类型（只做鸭子类型调用），因此可以脱离 GUI 单测。
关键边界：中文名、空格、百分号编码、file:///C:/ 形式、多文件、注释行。
"""

import os
from urllib.parse import unquote, urlparse


def path_from_uri(uri):
    """单个 file:// URI 转本地路径；非 file 协议返回 None。"""
    if not isinstance(uri, str):
        return None
    text = uri.strip()
    if not text or text.startswith("#"):
        return None
    parsed = urlparse(text)
    scheme = (parsed.scheme or "").lower()
    # 单字母 scheme 其实是盘符（"C:/x" 会被 urlparse 当成 scheme="c"）
    if len(scheme) == 1 and scheme.isalpha():
        return os.path.normpath(unquote(text))
    if scheme and scheme != "file":
        return None
    if scheme == "file":
        raw_path = unquote(parsed.path)
        # file:///C:/dir/a.txt -> /C:/dir/a.txt；UNC file://server/share -> /share
        if parsed.netloc and parsed.netloc not in ("", "localhost"):
            raw_path = "//%s%s" % (parsed.netloc, raw_path)
        elif len(raw_path) >= 3 and raw_path[0] == "/" and raw_path[2] == ":":
            raw_path = raw_path[1:]
    else:
        raw_path = unquote(text)
    if not raw_path:
        return None
    return os.path.normpath(raw_path)


def paths_from_uri_list(text):
    """解析 text/uri-list 文本（每行一个 URI，# 开头是注释行）。"""
    if not isinstance(text, str):
        return []
    result = []
    seen = set()
    for line in text.splitlines():
        path = path_from_uri(line)
        if path is None:
            continue
        if path not in seen:
            seen.add(path)
            result.append(path)
    return result


def paths_from_urls(urls):
    """Qt 的 QUrl 列表转路径；用 toLocalFile() 保留中文与空格。"""
    result = []
    seen = set()
    for url in urls or []:
        path = None
        local = getattr(url, "toLocalFile", None)
        if callable(local):
            try:
                candidate = local()
            except (TypeError, ValueError):
                candidate = ""
            if candidate:
                path = os.path.normpath(candidate)
        if path is None:
            scheme = getattr(url, "scheme", None)
            text = getattr(url, "toString", None)
            if callable(text):
                candidate = path_from_uri(text())
                if candidate is not None and (not scheme or scheme() == "file"):
                    path = candidate
        if path is None:
            continue
        if path not in seen:
            seen.add(path)
            result.append(path)
    return result


def paths_from_mime(mime):
    """从 QMimeData 取路径：优先 urls()，退化到 text/uri-list 文本。

    非 uri-list 的纯文本一律不认（避免把随便一段文字当成路径）。
    """
    if mime is None:
        return []
    has_urls = getattr(mime, "hasUrls", None)
    if callable(has_urls) and has_urls():
        return paths_from_urls(getattr(mime, "urls")())
    has_format = getattr(mime, "hasFormat", None)
    if callable(has_format) and has_format("text/uri-list"):
        return paths_from_uri_list(getattr(mime, "text")())
    return []


def accepts_drag(mime):
    """拖进动作里能否接受这个 mime（用于 dragEnterEvent 判定）。"""
    return bool(paths_from_mime(mime))
