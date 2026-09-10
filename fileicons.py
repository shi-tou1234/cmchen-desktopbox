"""系统图标获取与缓存。

要求（任务书）：用 QFileIconProvider 取系统图标，内存＋磁盘双层缓存，
不许每帧重取。

缓存键的设计：
- .lnk / .exe / .url / .ico 这类"图标由文件本身决定"的，按完整路径缓存；
- 其余按扩展名缓存（同类文件图标一致，省内存也省磁盘）。
失效文件单独给一个"缺失"图标，不去问系统。
"""

import hashlib
import os
from pathlib import Path

from PySide6.QtCore import QFileInfo, QSize
from PySide6.QtGui import QColor, QIcon, QPainter, QPixmap

PER_FILE_SUFFIXES = {".lnk", ".exe", ".url", ".ico", ".msi", ".appref-ms"}
DEFAULT_ICON_SIZE = 48
CACHE_DIR_NAME = "icons"


def icon_key(path, is_dir):
    """缓存键：按类型决定粒度。"""
    if is_dir:
        return "dir"
    suffix = os.path.splitext(path)[1].lower()
    if suffix in PER_FILE_SUFFIXES:
        return "file:" + os.path.normcase(os.path.normpath(path))
    return "ext:" + (suffix or "<none>")


def _cache_file(directory, key):
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:32]
    return directory / ("%s.png" % digest)


class IconCache:
    """系统图标缓存：内存 dict + 磁盘 PNG 落盘。"""

    def __init__(self, size=DEFAULT_ICON_SIZE, disk_dir=None):
        self.size = int(size)
        self.disk_dir = Path(disk_dir) if disk_dir else None
        self._memory = {}
        self._provider = None
        self.disk_hits = 0
        self.provider_misses = 0

    def _icon_provider(self):
        if self._provider is None:
            from PySide6.QtWidgets import QFileIconProvider

            self._provider = QFileIconProvider()
        return self._provider

    def _missing_icon(self):
        key = "missing"
        if key in self._memory:
            return self._memory[key]
        pixmap = QPixmap(self.size, self.size)
        pixmap.fill(QColor(0, 0, 0, 0))
        painter = QPainter(pixmap)
        painter.setRenderHint(QPainter.Antialiasing, True)
        painter.setPen(QColor(150, 150, 158))
        painter.drawRect(4, 4, self.size - 9, self.size - 9)
        painter.drawLine(4, 4, self.size - 5, self.size - 5)
        painter.end()
        icon = QIcon(pixmap)
        self._memory[key] = icon
        return icon

    def icon_for(self, path, is_dir=False, exists=True):
        """取图标：内存 → 磁盘 → 系统，逐级回退。"""
        if not exists:
            return self._missing_icon()
        key = "%d:%s" % (self.size, icon_key(path, is_dir))
        cached = self._memory.get(key)
        if cached is not None:
            return cached

        if self.disk_dir is not None:
            target = _cache_file(self.disk_dir, key)
            if target.is_file():
                pixmap = QPixmap(str(target))
                if not pixmap.isNull():
                    icon = QIcon(pixmap)
                    self._memory[key] = icon
                    self.disk_hits += 1
                    return icon

        self.provider_misses += 1
        icon = self._icon_provider().icon(QFileInfo(path))
        if icon.isNull():
            icon = self._icon_provider().icon(
                self._icon_provider().IconType.Folder
                if is_dir
                else self._icon_provider().IconType.File
            )
        self._memory[key] = icon
        self._save_to_disk(key, icon)
        return icon

    def _save_to_disk(self, key, icon):
        if self.disk_dir is None:
            return
        try:
            self.disk_dir.mkdir(parents=True, exist_ok=True)
            pixmap = icon.pixmap(QSize(self.size, self.size))
            if not pixmap.isNull():
                pixmap.save(str(_cache_file(self.disk_dir, key)), "PNG")
        except OSError:
            # 磁盘缓存失败不影响功能，只是下次还要问系统
            self.disk_dir = None

    def clear(self):
        self._memory.clear()
