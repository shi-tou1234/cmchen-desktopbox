"""桌面只读快照：记录条目名、修改时间、大小，用于证明程序零改动桌面。

本脚本只读取桌面目录、只往标准输出打印，自身不写任何文件——
落盘交给 shell 重定向，避免脚本持有可写路径。

用法（**不带任何命令行参数**：脚本不接受外部输入，也就没有把参数带进逻辑的入口）：
    python scripts/desktop_snapshot.py > docs/desktop_before.json
    ...（操作程序）...
    python scripts/desktop_snapshot.py > docs/desktop_after.json
    python scripts/desktop_compare.py          # 比对上面两份，打印 CHANGED 计数

比较逻辑放在 desktop_compare.py 里，两边都刻意不读 sys.argv。
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


def main():
    json.dump(snapshot(), sys.stdout, ensure_ascii=False, indent=1)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
