"""拖放解析测试：只测纯函数，不发真实拖放（真实投递在 --probe 里做）。

重点覆盖真实桌面会遇到的形态：中文名、空格、百分号编码、盘符、多文件。
"""

import os

from dropfiles import (
    accepts_drag,
    path_from_uri,
    paths_from_uri_list,
    paths_from_urls,
)


class FakeUrl:
    """鸭子类型的 QUrl 替身：只用于验证 pure 解析分支，不替代被测对象本身。"""

    def __init__(self, local="", uri=""):
        self._local = local
        self._uri = uri

    def toLocalFile(self):
        return self._local

    def scheme(self):
        return "file" if self._local else ""

    def toString(self):
        return self._uri


def test_path_from_uri_drive_letter():
    assert path_from_uri("file:///C:/Users/me/a.txt") == os.path.normpath("C:/Users/me/a.txt")


def test_path_from_uri_percent_encoded_chinese():
    result = path_from_uri("file:///C:/Users/me/%E5%86%9B%E8%AE%AD.pdf")
    assert result == os.path.normpath("C:/Users/me/军训.pdf")


def test_path_from_uri_percent_encoded_space():
    result = path_from_uri("file:///C:/Users/me/a%20b%20c.txt")
    assert result == os.path.normpath("C:/Users/me/a b c.txt")


def test_path_from_uri_rejects_non_file_scheme():
    assert path_from_uri("https://example.com/a.txt") is None
    assert path_from_uri("mailto:a@b.c") is None


def test_path_from_uri_rejects_comment_and_blank():
    assert path_from_uri("# 注释行") is None
    assert path_from_uri("") is None
    assert path_from_uri("   ") is None


def test_path_from_uri_rejects_non_string():
    assert path_from_uri(None) is None
    assert path_from_uri(42) is None


def test_paths_from_uri_list_multiple_and_dedupe():
    text = "\n".join(
        [
            "file:///C:/a.txt",
            "file:///C:/b.txt",
            "file:///C:/a.txt",
        ]
    )
    assert paths_from_uri_list(text) == [os.path.normpath("C:/a.txt"), os.path.normpath("C:/b.txt")]


def test_paths_from_uri_list_skips_comment_lines():
    text = "# 这是注释\r\nfile:///C:/a.txt\r\n"
    assert paths_from_uri_list(text) == [os.path.normpath("C:/a.txt")]


def test_paths_from_uri_list_handles_crlf_and_blank_lines():
    text = "file:///C:/a.txt\r\n\r\nfile:///C:/b.txt\r\n"
    assert len(paths_from_uri_list(text)) == 2


def test_paths_from_uri_list_non_string_returns_empty():
    assert paths_from_uri_list(None) == []
    assert paths_from_uri_list(123) == []


def test_paths_from_uri_list_plain_windows_path_text():
    """有些来源会给不带 file:// 的裸路径，也要认。"""
    assert paths_from_uri_list("C:/Users/me/a.txt") == [os.path.normpath("C:/Users/me/a.txt")]


def test_paths_from_urls_uses_to_local_file():
    urls = [FakeUrl(local="C:/Users/me/军训.pdf")]
    assert paths_from_urls(urls) == [os.path.normpath("C:/Users/me/军训.pdf")]


def test_paths_from_urls_dedupes():
    urls = [FakeUrl(local="C:/a.txt"), FakeUrl(local="C:/a.txt")]
    assert len(paths_from_urls(urls)) == 1


def test_paths_from_urls_handles_empty_and_none():
    assert paths_from_urls(None) == []
    assert paths_from_urls([]) == []
    assert paths_from_urls([FakeUrl()]) == []


def test_accepts_drag_false_for_plain_text_mime():
    class TextOnly:
        def hasUrls(self):
            return False

        def hasFormat(self, _name):
            return False

    assert accepts_drag(TextOnly()) is False


def test_accepts_drag_true_for_uri_list_mime():
    class UriList:
        def hasUrls(self):
            return False

        def hasFormat(self, name):
            return name == "text/uri-list"

        def text(self):
            return "file:///C:/a.txt"

    assert accepts_drag(UriList()) is True
