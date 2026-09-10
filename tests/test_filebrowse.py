"""文件浏览纯逻辑测试：面包屑、上一级、目录列举、分批。

只读逻辑，用真实临时目录验证；权限错误一类没法在 Windows 上稳定造出来的
情况，替换的是 os.scandir 这个操作系统边界（不是因为被测对象难测而打桩）。
"""

import os

import pytest

import filebrowse
from filebrowse import (
    breadcrumb_parts,
    chunked,
    entry_sort_key,
    is_root,
    list_entries,
    parent_of,
)


# ---------------------------------------------------------------- 根与上级


def test_is_root_true_for_drive_root():
    assert is_root("C:\\") is True


def test_is_root_true_for_forward_slash_drive():
    assert is_root("C:/") is True


def test_is_root_false_for_subdirectory(tmp_path):
    assert is_root(str(tmp_path)) is False


def test_is_root_true_for_empty():
    assert is_root("") is True


def test_parent_of_subdirectory(tmp_path):
    child = tmp_path / "a" / "b"
    child.mkdir(parents=True)
    assert parent_of(str(child)) == os.path.normpath(str(tmp_path / "a"))


def test_parent_of_drive_root_is_none():
    assert parent_of("C:\\") is None


def test_parent_of_empty_is_none():
    assert parent_of("") is None


# ---------------------------------------------------------------- 面包屑


def test_breadcrumb_parts_nested(tmp_path):
    deep = tmp_path / "学习" / "资料"
    deep.mkdir(parents=True)
    parts = breadcrumb_parts(str(deep))
    assert [part["label"] for part in parts][-2:] == ["学习", "资料"]
    assert parts[0]["path"].endswith(os.sep)


def test_breadcrumb_parts_last_is_current(tmp_path):
    deep = tmp_path / "a" / "b"
    deep.mkdir(parents=True)
    parts = breadcrumb_parts(str(deep))
    assert parts[-1]["path"] == os.path.normpath(str(deep))


def test_breadcrumb_parts_drive_root_is_single_node():
    parts = breadcrumb_parts("C:\\")
    assert len(parts) == 1
    assert parts[0]["path"] == "C:\\"


def test_breadcrumb_parts_empty_is_empty_list():
    assert breadcrumb_parts("") == []


def test_breadcrumb_parts_are_clickable_paths(tmp_path):
    deep = tmp_path / "one" / "two"
    deep.mkdir(parents=True)
    for part in breadcrumb_parts(str(deep)):
        assert os.path.isdir(part["path"])


# ---------------------------------------------------------------- 排序与列举


def test_entry_sort_key_puts_directories_first():
    file_entry = {"name": "a.txt", "is_dir": False}
    dir_entry = {"name": "z_dir", "is_dir": True}
    assert sorted([file_entry, dir_entry], key=entry_sort_key)[0] is dir_entry


def test_entry_sort_key_is_case_insensitive():
    upper = {"name": "B.txt", "is_dir": False}
    lower = {"name": "a.txt", "is_dir": False}
    assert sorted([upper, lower], key=entry_sort_key) == [lower, upper]


def test_list_entries_real_directory(tmp_path):
    (tmp_path / "子目录").mkdir()
    (tmp_path / "文件.txt").write_text("x", encoding="utf-8")
    result = list_entries(str(tmp_path))
    assert result["error"] is None
    names = [entry["name"] for entry in result["entries"]]
    assert names == ["子目录", "文件.txt"]
    assert result["entries"][0]["is_dir"] is True


def test_list_entries_missing_path_gives_chinese_error(tmp_path):
    result = list_entries(str(tmp_path / "并不存在"))
    assert result["entries"] == []
    assert result["error"] == filebrowse.ERROR_NOT_FOUND


def test_list_entries_on_a_file_gives_not_a_directory(tmp_path):
    target = tmp_path / "文件.txt"
    target.write_text("x", encoding="utf-8")
    result = list_entries(str(target))
    assert result["error"] == filebrowse.ERROR_NOT_DIR


def test_list_entries_permission_error_is_caught(monkeypatch, tmp_path):
    def deny(_path):
        raise PermissionError(13, "拒绝访问")

    monkeypatch.setattr(filebrowse.os, "scandir", deny)
    result = list_entries(str(tmp_path))
    assert result["entries"] == []
    assert result["error"] == filebrowse.ERROR_PERMISSION


def test_list_entries_skips_entries_that_error_out(monkeypatch, tmp_path):
    class BrokenEntry:
        name = "坏掉的链接"
        path = str(tmp_path / "坏掉的链接")

        def is_dir(self):
            raise OSError(22, "无效参数")

    class Ctx:
        def __enter__(self_inner):
            return [BrokenEntry()]

        def __exit__(self_inner, *_exc):
            return False

    monkeypatch.setattr(filebrowse.os, "scandir", lambda _path: Ctx())
    result = list_entries(str(tmp_path))
    assert result["error"] is None
    assert result["entries"] == []


def test_list_entries_empty_directory(tmp_path):
    result = list_entries(str(tmp_path))
    assert result["error"] is None
    assert result["entries"] == []


# ---------------------------------------------------------------- 分批


def test_chunked_splits_evenly():
    assert chunked(list(range(10)), 3) == [[0, 1, 2], [3, 4, 5], [6, 7, 8], [9]]


def test_chunked_empty_sequence():
    assert chunked([], 3) == []


def test_chunked_default_size_is_300():
    assert filebrowse.CHUNK_SIZE == 300
    assert len(chunked(list(range(601)))) == 3


def test_chunked_non_positive_size_falls_back():
    assert chunked([1, 2, 3], 0) == [[1, 2, 3]]


def test_chunked_preserves_total_count():
    items = list(range(2500))
    assert sum(len(batch) for batch in chunked(items)) == 2500
