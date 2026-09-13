'use strict';

// 开机自启：Windows 写 HKCU\Software\Microsoft\Windows\CurrentVersion\Run（登录静默启动）；
// macOS 走 Electron 的 setLoginItemSettings（同一套开关语义）。Linux 的 DE 各写各的，
// 暂不支持（isSupported 返回 false，设置面板会如实说明）。写入目标固定、幂等、开关可查。

const { execFileSync } = require('node:child_process');

const WIN_VALUE_NAME = 'DeskBasket';
const WIN_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

function isSupported() {
  return process.platform === 'win32' || process.platform === 'darwin';
}

function launchCommand() {
  // 打包后 process.execPath 就是 exe；开发态是 electron.exe + 项目目录
  const { app } = require('electron');
  if (app.isPackaged) return `"${process.execPath}"`;
  return `"${process.execPath}" "${app.getAppPath()}"`;
}

// ---- macOS：Electron 的 setLoginItemSettings（各版 Mac 通用的机制）----
function macSetLoginItem(enabled) {
  const { app } = require('electron');
  app.setLoginItemSettings({ openAtLogin: enabled });
  return true;
}

function macLoginItemEnabled() {
  try {
    const { app } = require('electron');
    return Boolean(app.getLoginItemSettings().openAtLogin);
  } catch (_) {
    return false;
  }
}

function currentCommand() {
  if (process.platform !== 'win32') return '';
  try {
    const out = execFileSync(
      'reg',
      ['query', WIN_RUN_KEY, '/v', WIN_VALUE_NAME],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const line = out.split(/\r?\n/).find((row) => row.includes(WIN_VALUE_NAME));
    if (!line) return '';
    const match = line.trim().match(new RegExp(`${WIN_VALUE_NAME}\\s+REG_SZ\\s+(.*)$`));
    return match ? match[1].trim() : '';
  } catch (_) {
    return '';
  }
}

function isEnabled() {
  if (process.platform === 'darwin') return macLoginItemEnabled();
  return currentCommand() !== '';
}

function enable() {
  if (process.platform === 'darwin') return macSetLoginItem(true);
  if (!isSupported()) return false;
  execFileSync(
    'reg',
    ['add', WIN_RUN_KEY, '/v', WIN_VALUE_NAME, '/t', 'REG_SZ', '/d', launchCommand(), '/f'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  return true;
}

function disable() {
  if (process.platform === 'darwin') return macSetLoginItem(false);
  if (!isSupported()) return false;
  try {
    execFileSync('reg', ['delete', WIN_RUN_KEY, '/v', WIN_VALUE_NAME, '/f'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch (_) {
    // 本来就没有这个值，按成功处理（幂等）
  }
  return true;
}

function sync(enabled) {
  if (!isSupported()) return false;
  return enabled ? enable() : (disable(), false);
}

module.exports = {
  WIN_RUN_KEY,
  WIN_VALUE_NAME,
  currentCommand,
  disable,
  enable,
  isEnabled,
  isSupported,
  launchCommand,
  sync
};
