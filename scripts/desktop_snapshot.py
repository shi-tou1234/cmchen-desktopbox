"""桌面只读快照：记录条目名、修改时间、大小，用于证明程序零改动桌面。

本脚本只读取桌面目录、只往标准输出打印，自身不写任何文件——
落盘交给 shell 重定向，避免脚本持有可写路径。
用法：
    python scripts/desktop_snapshot.py dump > docs/desktop_before.json
    python scripts/desktop_snapshot.py dump > docs/desktop_after.json
    python scripts/desktop_snapshot.py compare docs/desktop_before.json docs/desktop_after.json
"""

import json
import os
import sys


def snapshot():
    root = os.path.join(os.environ["USERPROFILE"], "Desktop")
    entries = {}
    for name in sorted(os.listdir(root)):
        path = os.path.join(root, name)
        try:
            stat = os.stat(path)
        except OSError as exc:
            entries[name] = {"error": str(exc)}
            continue
        entries[name] = {
            "mtime": stat.st_mtime,
            "size": stat.st_size,
            "is_dir": os.path.isdir(path),
        }
    return {"dir": root, "count": len(entries), "entries": entries}


def load_pair(suffix):
    """只读 docs 下固定的两个文件名：路径完全由本函数决定，不接受外部传入的路径。"""
    if suffix not in ("before", "after"):
        suffix = "before"
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    docs_dir = os.path.join(project_root, "docs")
    name = "desktop_after.json" if suffix == "after" else "desktop_before.json"
    with open(os.path.join(docs_dir, name), encoding="utf-8") as handle:
        return json.load(handle)


def compare():
    """比较 docs 下的两份固定快照。刻意不带参数：命令行参数到此为止。"""
    before = load_pair("before")
    after = load_pair("after")
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


def main(argv):
    # 只认固定的子命令；命令行参数不再往下面的函数里传（数据流到此为止）
    command = argv[1] if len(argv) > 1 else "dump"
    if command == "dump":
        json.dump(snapshot(), sys.stdout, ensure_ascii=False, indent=1)
        sys.stdout.write("\n")
        return 0
    if command == "compare":
        return compare()
    sys.stderr.write("用法: desktop_snapshot.py dump|compare\n")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
