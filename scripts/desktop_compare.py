"""比对两份桌面快照，判断程序有没有改动过桌面。

配合 desktop_snapshot.py 用：先 dump 一份 before、操作程序、再 dump 一份 after，
然后跑本脚本。**不带任何命令行参数**：两份快照的文件名在本文件里写死（docs 目录下），
不接受外部传入的路径，也就不存在把参数带进文件操作的数据流。

    python scripts/desktop_snapshot.py > docs/desktop_before.json
    ...（操作程序）...
    python scripts/desktop_snapshot.py > docs/desktop_after.json
    python scripts/desktop_compare.py

输出 CHANGED / ADDED / REMOVED 计数，全部为 0 时打印 DESKTOP_UNCHANGED_OK（退出码 0）。
"""

import json
import os
import sys

# 固定文件名：路径完全由本文件决定
SNAPSHOTS = {"before": "desktop_before.json", "after": "desktop_after.json"}


def load_snapshot(which):
    """只读 docs 下写死的那个文件名。"""
    name = SNAPSHOTS.get(which)
    if name is None:
        raise ValueError("未知的快照: %r" % (which,))
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(project_root, "docs", name), encoding="utf-8") as handle:
        return json.load(handle)


def main():
    before = load_snapshot("before")
    after = load_snapshot("after")
    before_keys = set(before["entries"])
    after_keys = set(after["entries"])
    added = sorted(after_keys - before_keys)
    removed = sorted(before_keys - after_keys)
    changed = sorted(
        name
        for name in before_keys & after_keys
        if before["entries"][name] != after["entries"][name]
    )
    print("BEFORE_COUNT", before["count"])
    print("AFTER_COUNT", after["count"])
    print("ADDED", len(added), added[:10])
    print("REMOVED", len(removed), removed[:10])
    print("CHANGED", len(changed), changed[:10])
    if added or removed or changed:
        print("DESKTOP_UNCHANGED_FAIL")
        return 1
    print("DESKTOP_UNCHANGED_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
