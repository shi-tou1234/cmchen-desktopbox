"""屏幕像素探针：截全屏并输出亮度剖面，用来量 Dock/面板的透明度与离屏幕底边的距离。

用法：.venv/Scripts/python.exe tools/screen-probe.py <tag>
输出：docs/_probe_<tag>.png ＋ 若干剖面的亮度数字。
"""

import sys
from pathlib import Path

from PIL import Image, ImageGrab

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"


def grab():
    return ImageGrab.grab(all_screens=False).convert("RGB")


def luma(pixel):
    r, g, b = pixel
    return 0.299 * r + 0.587 * g + 0.114 * b


def row_mean(img, y, x0, x1):
    total = 0.0
    for x in range(x0, x1):
        total += luma(img.getpixel((x, y)))
    return total / max(1, x1 - x0)


def main():
    tag = sys.argv[1] if len(sys.argv) > 1 else "now"
    img = grab()
    out = DOCS / f"_probe_{tag}.png"
    img.save(out)
    width, height = img.size
    print(f"CAPTURE {tag} {width}x{height} -> {out}")

    # 两次抓屏是否完全一致（判断背景是否静止，跨配置比较才有意义）
    img2 = grab()
    diff = 0
    for y in range(900, height, 3):
        for x in range(200, width, 7):
            a = img.getpixel((x, y))
            b = img2.getpixel((x, y))
            diff = max(diff, max(abs(a[i] - b[i]) for i in range(3)))
    print(f"STATIC_MAXDIFF {diff}  (0 = 背景静止)")

    # 垂直剖面：从 Dock 上方扫到屏幕底部
    print("--- 垂直剖面 x=960（Dock 中部） ---")
    for y in range(940, height, 2):
        print(f"y={y}  luma={row_mean(img, y, 940, 980):6.1f}")

    # 水平剖面：Dock 边框所在行与图标之间
    print("--- 水平剖面 y=976（Dock 顶部内边） ---")
    for x in range(60, 300, 10):
        print(f"x={x}  luma={luma(img.getpixel((x, 976))):6.1f}")

    # 关键点采样
    print("--- 关键点 ---")
    points = {
        "Dock上方(y=950)": (960, 950),
        "Dock内空白(y=977)": (960, 977),
        "Dock内图标行(y=1010)": (960, 1010),
        "Dock底内边(y=1070)": (960, 1070),
        "Dock下缝隙(y=1077)": (960, 1077),
        "Dock左外(x=60,y=1000)": (60, 1000),
        "Dock右外(x=1860,y=1000)": (1860, 1000),
    }
    for label, (x, y) in points.items():
        print(f"{label}: luma={luma(img.getpixel((x, y))):6.1f}  rgb={img.getpixel((x, y))}")


if __name__ == "__main__":
    main()
