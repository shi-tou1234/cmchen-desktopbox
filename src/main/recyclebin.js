'use strict';

// 回收站「空 / 满」状态的廉价探测。
//
// Dock 上回收站图标的空/满两张是 shell 按**当前状态**现给的（实测本机非空时
// SHGetFileInfo(PIDL) 返回下标 32，与 SHGetStockIconInfo(SIID_RECYCLERFULL)
// 逐字节一致；空基准是 31）。坏的是缓存侧：shellIcons 给虚拟项的签名是
// 「按天失效」——当天第一问是什么状态，之后一整天都发那张图，回收站在别处
// （资源管理器/别的用户）增删也全然不知。
//
// 不能简单改成「不缓存、每次现问」：现问要起一次 PowerShell（启动 + Add-Type
// 编译，几百毫秒起步），状态没变时白起进程。于是状态检测与取图拆成两半：
//
//   - 变没变：本模块每秒扫一遍各盘 `$Recycle.Bin\<SID>` 目录的 **mtime**——
//     目录里增删子文件（每项一对 $R/$I）都会顶到目录 mtime，几次 stat、
//     毫秒级、不起进程（本机实测 26 个盘符全扫 2ms）；
//   - 变了才让 shellIcons 用 { fresh: true } 现拉一张真图（绕过按天缓存、
//     写回缓存），拉到后广播给 Dock 换图（见 main.js 的回收站看门狗）。
//
// 只读不写，纯 node:fs，不依赖 Electron —— node --test 直接测 probeWith。

const fs = require('node:fs');
const path = require('node:path');

const ROOT_NAME = '$Recycle.Bin';
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

// 某个盘符的 `$Recycle.Bin` 根目录（测试注入假根目录用）
function defaultRootFor(letter) {
  return `${letter}:\\${ROOT_NAME}`;
}

// token：把「盘符:SID目录:mtime」拼成一串可比较的字符串。
// 任何一个能读到属性的回收站目录有增删（mtime 变了），token 就不同。
// 只收**目录**：根下偶尔有 DIRTY 这类标记文件，不该被它触发取图；
// 读不到的目录/根（无权限、盘不存在、光驱没盘）一律跳过，不拖累别的盘。
function probeWith(rootFor) {
  const parts = [];
  for (const letter of LETTERS) {
    const root = rootFor(letter);
    let dirents;
    try {
      dirents = fs.readdirSync(root, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      try {
        const stat = fs.statSync(path.join(root, dirent.name));
        parts.push(`${letter}:${dirent.name}:${Math.round(stat.mtimeMs)}`);
      } catch (_) {
        continue;
      }
    }
  }
  return parts.join('|');
}

// 生产入口：真扫本机所有盘符
function probeToken() {
  return probeWith(defaultRootFor);
}

module.exports = {
  LETTERS,
  ROOT_NAME,
  probeToken,
  probeWith
};
