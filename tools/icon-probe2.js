'use strict';

// 图标探针 2：对比三条取图标的路子，看哪条能拿到 .lnk 的真实图标。
//   A. 直接 app.getFileIcon(.lnk)                     ← 当前实现
//   B. shell.readShortcutLink(.lnk) 拿 target 再取图标
//   C. 用 .lnk 里记录的 icon / iconIndex 指定文件再取图标
// 用法：node_modules/electron/dist/electron.exe tools/icon-probe2.js

const { app, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const NAMES = [
  'Arduino IDE.lnk',
  'Microsoft Edge.lnk',
  'Visual Studio Code.lnk',
  'ZCode.lnk',
  'QQ音乐.lnk',
  'Steam.lnk',
  'Watt Toolkit.lnk',
  '项目.lnk'
];

function stats(img) {
  const bmp = img.toBitmap();
  let min = 255;
  let max = 0;
  let colored = 0;
  for (let i = 0; i < bmp.length; i += 4) {
    if (bmp[i + 3] > 8) {
      min = Math.min(min, bmp[i], bmp[i + 1], bmp[i + 2]);
      max = Math.max(max, bmp[i], bmp[i + 1], bmp[i + 2]);
      if (Math.max(bmp[i], bmp[i + 1], bmp[i + 2]) - Math.min(bmp[i], bmp[i + 1], bmp[i + 2]) > 24) {
        colored += 1;
      }
    }
  }
  return `min=${min} max=${max} colored=${colored}`;
}

async function probe(label, target) {
  if (!target) return console.log(`  ${label}: (无路径)`);
  try {
    const img = await app.getFileIcon(target, { size: 'large' });
    console.log(`  ${label}: ${img.isEmpty() ? 'EMPTY' : stats(img)}  ← ${target}`);
  } catch (error) {
    console.log(`  ${label}: ERR ${error.message}`);
  }
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const dir = path.join(os.homedir(), 'Desktop');
  for (const name of NAMES) {
    const full = path.join(dir, name);
    console.log(`\n=== ${name} (exists=${fs.existsSync(full)}) ===`);
    await probe('A 直接取 .lnk ', full);
    let link = null;
    try {
      link = shell.readShortcutLink(full);
    } catch (error) {
      console.log('  readShortcutLink 失败: ' + error.message);
    }
    if (link) {
      console.log(`  解析: target=${link.target} icon=${link.icon || '(无)'} iconIndex=${link.iconIndex}`);
      await probe('B target 图标', link.target);
      if (link.icon) await probe('C .lnk 记录的 icon', link.icon);
    }
  }
  app.quit();
});
