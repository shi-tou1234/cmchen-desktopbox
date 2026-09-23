'use strict';

// 跨平台的小助手：这台机器是什么系统、各平台的默认目录放哪。
// Windows 专属能力（开始菜单键、系统图标原质感提取、桌面层下沉、剪贴板真文件…）
// 在非 Windows 上一律优雅降级——调用方先看这里的布尔值，别直接调 Win32。

const os = require('node:os');
const path = require('node:path');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

// 筐的默认目录：Windows 用 E:\文件筐（领导定的）；
// mac 放「文稿/DeskBasket」，Linux 放 ~/DeskBasket。
function defaultBasketDir() {
  if (IS_WIN) return 'E:' + String.fromCharCode(92) + '文件筐';
  if (IS_MAC) return path.join(os.homedir(), 'Documents', 'DeskBasket');
  return path.join(os.homedir(), 'DeskBasket');
}

module.exports = { IS_WIN, IS_MAC, IS_LINUX, defaultBasketDir };
