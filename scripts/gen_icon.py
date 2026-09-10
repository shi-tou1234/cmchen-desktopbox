"""生成应用图标 assets/icon.ico（多尺寸：16/32/48 用 DIB，256 用 PNG entry）。

图标设计（极简扁平）：深蓝→青绿渐变圆角方块底，白色磨砂托盘 + 三个文件方块
从上方落进托盘，配一枚向下箭头，表达"把桌面文件收进筐里"。

用法：python scripts/gen_icon.py   （退出码 0 即成功，含回读校验）
"""

import struct
import sys
from pathlib import Path

from PySide6.QtCore import QBuffer, QRectF, Qt
from PySide6.QtGui import QColor, QImage, QLinearGradient, QPainter, QPen
from PySide6.QtWidgets import QApplication

SIZES = [16, 32, 48, 256]
ICON_PATH = Path(__file__).resolve().parent.parent / "assets" / "icon.ico"


def render_icon(size):
    """按矢量逻辑绘制一枚 size×size 的图标，返回 QImage。"""
    image = QImage(size, size, QImage.Format_ARGB32)
    image.fill(Qt.transparent)
    painter = QPainter(image)
    try:
        painter.setRenderHint(QPainter.Antialiasing)
        scale = size / 256.0

        gradient = QLinearGradient(0, 0, size, size)
        gradient.setColorAt(0.0, QColor("#1F3A6E"))
        gradient.setColorAt(1.0, QColor("#1E7A78"))
        painter.setBrush(gradient)
        painter.setPen(Qt.NoPen)
        painter.drawRoundedRect(QRectF(0, 0, size, size), 52 * scale, 52 * scale)

        highlight = QLinearGradient(0, 0, 0, size * 0.5)
        highlight.setColorAt(0.0, QColor(255, 255, 255, 40))
        highlight.setColorAt(1.0, QColor(255, 255, 255, 0))
        painter.setBrush(highlight)
        painter.drawRoundedRect(QRectF(0, 0, size, size * 0.5), 52 * scale, 52 * scale)

        # 托盘：下半部一个开口向上的容器
        painter.setBrush(Qt.NoBrush)
        painter.setPen(QPen(QColor(255, 255, 255, 235), 14 * scale, Qt.SolidLine, Qt.RoundCap))
        painter.drawLine(
            round(48 * scale), round(150 * scale), round(48 * scale), round(196 * scale)
        )
        painter.drawLine(
            round(208 * scale), round(150 * scale), round(208 * scale), round(196 * scale)
        )
        painter.drawLine(
            round(48 * scale), round(196 * scale), round(208 * scale), round(196 * scale)
        )

        # 筐里的文件：三个白色圆角小方块
        painter.setPen(Qt.NoPen)
        painter.setBrush(QColor(255, 255, 255, 235))
        for index, x in enumerate((70, 112, 154)):
            height = 52 + (index % 2) * 10
            painter.drawRoundedRect(
                QRectF(x * scale, (150 - height) * scale, 32 * scale, height * scale),
                6 * scale,
                6 * scale,
            )

        # 落料箭头：从上方指向筐内
        painter.setPen(QPen(QColor("#FFC46B"), 13 * scale, Qt.SolidLine, Qt.RoundCap))
        painter.drawLine(
            round(128 * scale), round(28 * scale), round(128 * scale), round(92 * scale)
        )
        painter.drawLine(
            round(106 * scale), round(72 * scale), round(128 * scale), round(94 * scale)
        )
        painter.drawLine(
            round(150 * scale), round(72 * scale), round(128 * scale), round(94 * scale)
        )
    finally:
        painter.end()
    return image


def png_bytes(image):
    buffer = QBuffer()
    buffer.open(QBuffer.WriteOnly)
    image.save(buffer, "PNG")
    return bytes(buffer.data())


def dib_bytes(image):
    """32bpp DIB：BITMAPINFOHEADER + 倒序 BGRA + 全 0 AND 掩码（走 alpha 通道）。"""
    width, height = image.width(), image.height()
    argb = image.convertToFormat(QImage.Format_ARGB32)
    xor = bytearray()
    for y in range(height - 1, -1, -1):
        for x in range(width):
            pixel = argb.pixel(x, y)
            xor += bytes(
                (
                    pixel & 0xFF,
                    (pixel >> 8) & 0xFF,
                    (pixel >> 16) & 0xFF,
                    (pixel >> 24) & 0xFF,
                )
            )
    and_stride = ((width + 31) // 32) * 4
    and_mask = bytes(and_stride * height)
    header = struct.pack(
        "<IiiHHIIiiII",
        40,
        width,
        height * 2,
        1,
        32,
        0,
        len(xor) + len(and_mask),
        0,
        0,
        0,
        0,
    )
    return header + bytes(xor) + and_mask


def assemble_ico(path):
    blobs = []
    for size in SIZES:
        image = render_icon(size)
        blobs.append(png_bytes(image) if size >= 256 else dib_bytes(image))
    out = struct.pack("<HHH", 0, 1, len(SIZES))
    offset = 6 + 16 * len(SIZES)
    for size, blob in zip(SIZES, blobs):
        out += struct.pack(
            "<BBBBHHII",
            0 if size >= 256 else size,
            0 if size >= 256 else size,
            0,
            0,
            1,
            32,
            len(blob),
            offset,
        )
        offset += len(blob)
    out += b"".join(blobs)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(out)
    return out


def verify(path):
    raw = path.read_bytes()
    reserved, ico_type, count = struct.unpack("<HHH", raw[:6])
    widths = [raw[6 + 16 * index] for index in range(count)]
    assert reserved == 0 and ico_type == 1, (reserved, ico_type)
    assert widths == [16, 32, 48, 0], widths  # 0 表示 256px
    return ico_type, widths


def main():
    _app = QApplication(sys.argv)  # 光栅绘制兜底环境
    assemble_ico(ICON_PATH)
    ico_type, widths = verify(ICON_PATH)
    print("ICON_OK", ICON_PATH.name, ico_type, widths, ICON_PATH.stat().st_size)
    return 0


if __name__ == "__main__":
    sys.exit(main())
