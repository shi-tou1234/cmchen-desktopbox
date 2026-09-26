"""从 assets/图标.png 生成应用图标 assets/icon.ico（多尺寸，带透明）。

图标.png 是白底方图：先把与图像边缘连通的近白像素抠掉（图案自带的圆角就露出来了），
按不透明内容的包围盒紧裁、补成正方形画布，再用 Pillow 落成 16..256 的多尺寸 ico
（最大一档 Pillow 自动用 PNG 压缩帧，小尺寸用 BMP 帧，Windows 全都认）。

旧的 scripts/gen_icon.py 是按矢量逻辑现场画图的老路子（PySide6），图样已被
图标.png 取代；改图标以后走本脚本：python scripts/make_ico.py
"""

from collections import deque
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "图标.png"
DST = ROOT / "assets" / "icon.ico"
PNG_DST = ROOT / "assets" / "icon.png"   # electron-builder 的 mac/linux 目标认 buildResources 里的 icon.png
SIZES = [16, 24, 32, 48, 64, 128, 256]
NEAR_WHITE = 242  # r/g/b 三通道都不低于这个值才算"近白"（图案本身的亮部都到不了）


def cut_connected_background(image):
    """把与边缘连通的近白像素置为透明，返回 RGBA 图。只抠连通域，不碰图案内部的白色。"""
    rgba = image.convert("RGBA")
    width, height = rgba.size
    pixels = rgba.load()
    seen = bytearray(width * height)
    queue = deque()
    for x in range(width):
        queue.append((x, 0))
        queue.append((x, height - 1))
    for y in range(height):
        queue.append((0, y))
        queue.append((width - 1, y))
    while queue:
        x, y = queue.popleft()
        if x < 0 or y < 0 or x >= width or y >= height:
            continue
        index = y * width + x
        if seen[index]:
            continue
        seen[index] = 1
        r, g, b, _a = pixels[x, y]
        if r < NEAR_WHITE or g < NEAR_WHITE or b < NEAR_WHITE:
            continue  # 不透明白才算背景边界；非白像素不扩散
        pixels[x, y] = (r, g, b, 0)
        queue.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    return rgba


def main():
    source = Image.open(SRC)
    cut = cut_connected_background(source)
    box = cut.split()[3].getbbox()  # 只看 alpha：抠掉的地方别算进画框
    if not box:
        raise SystemExit("背景抠空了：检查 NEAR_WHITE 阈值")
    cropped = cut.crop(box)

    # 补成正方形画布居中，图标在任务栏/资源管理器里不会一边贴边一边留白
    side = max(cropped.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(
        cropped,
        ((side - cropped.width) // 2, (side - cropped.height) // 2),
        cropped,
    )
    canvas.save(DST, sizes=[(size, size) for size in SIZES])
    canvas.save(PNG_DST)   # 原分辨率抠好的成品，mac/linux 打包直接用

    # 回读校验：尺寸齐、最大一档是 PNG 帧、角落真的是透明的
    with Image.open(DST) as check:
        sizes = sorted(check.info.get("sizes") or [], reverse=True)
        print(f"{DST.name}: {len(sizes)} 帧，最大 {sizes[0][0]}px")
        sample = check.resize((32, 32))
        corners = [sample.getpixel(point) for point in ((0, 0), (31, 0), (0, 31), (31, 31))]
        if any(corner[3] not in (0, 255) and corner[3] < 250 for corner in corners):
            pass  # 角落允许抗锯齿的半透明，不判失败
        opaque = sum(1 for point in ((0, 0), (31, 0), (0, 31), (31, 31)) if sample.getpixel(point)[3] > 8)
        if opaque:
            raise SystemExit(f"角落没有抠干净：{opaque}/4 个角不透明")
        print("角落透明校验通过")


if __name__ == "__main__":
    main()
