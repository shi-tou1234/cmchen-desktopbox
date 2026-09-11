'use strict';

// 图标探针：对桌面上的真实快捷方式逐个调用 app.getFileIcon，
// 报告返回图像是否为空、尺寸、以及最小/最大像素值（全白＝通用图标）。
// 用法：node_modules/electron/dist/electron.exe tools/icon-probe.js

const { app } = require('electron');
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
  '学习通.url',
  'STC-ISP-v6.96S.exe',
  '万用表.exe',
  '项目.lnk',
  'WinRAR.lnk',
  '不存在的快捷方式.lnk'
];

function stats(img) {
  const size = img.getSize();
  const bmp = img.toBitmap();
  let min = 255;
  let max = 0;
  let colored = 0;
  for (let i = 0; i < bmp.length; i += 4) {
    const r = bmp[i];
    const g = bmp[i + 1];
    const b = bmp[i + 2];
    const a = bmp[i + 3];
    if (a > 8) {
      min = Math.min(min, r, g, b);
      max = Math.max(max, r, g, b);
      if (Math.max(r, g, b) - Math.min(r, g, b) > 24) colored += 1;
    }
  }
  return { size, min, max, coloredPixels: colored };
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const dir = path.join(os.homedir(), 'Desktop');
  for (const name of NAMES) {
    const full = path.join(dir, name);
    const exists = fs.existsSync(full);
    let detail = '';
    try {
      const img = await app.getFileIcon(full, { size: 'large' });
      if (img.isEmpty()) {
        detail = 'EMPTY';
      } else {
        const s = stats(img);
        detail = `size=${JSON.stringify(s.size)} min=${s.min} max=${s.max} colored=${s.coloredPixels}`;
      }
    } catch (error) {
      detail = 'ERR ' + error.message;
    }
    console.log(`EXISTS=${exists} ${detail} :: ${name}`);
  }
  app.quit();
});
