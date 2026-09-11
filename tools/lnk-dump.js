'use strict';

// 把几个解析不出 target 的 .lnk 完整打印出来，看它们到底是什么形态。
// 用法：node_modules/electron/dist/electron.exe tools/lnk-dump.js

const { app, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const NAMES = [
  'Microsoft Edge.lnk',
  'Visual Studio Code.lnk',
  'Steam.lnk',
  'QQ音乐.lnk',
  'Watt Toolkit.lnk',
  'Arduino IDE.lnk'
];

const ROOT = path.resolve(path.join(os.homedir(), 'Desktop'));

// 只允许白名单里的文件名，且解析后必须仍直接落在桌面目录下
function safePath(name) {
  if (!NAMES.includes(name)) throw new Error('不在白名单: ' + name);
  const target = path.resolve(ROOT, name);
  if (path.dirname(target) !== ROOT) throw new Error('路径越界: ' + name);
  return target;
}

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  for (const name of NAMES) {
    const full = safePath(name);
    console.log(`\n=== ${name} ===`);
    try {
      const st = fs.statSync(full);
      console.log(`  size=${st.size} bytes`);
      const head = fs.readFileSync(full).subarray(0, 4);
      const hex = [...head].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      console.log(`  magic=${hex} (4c 00 00 00 = 正常 .lnk)`);
    } catch (error) {
      console.log('  stat 失败: ' + error.message);
    }
    try {
      console.log('  readShortcutLink = ' + JSON.stringify(shell.readShortcutLink(full)));
    } catch (error) {
      console.log('  readShortcutLink 失败: ' + error.message);
    }
  }
  app.quit();
});
