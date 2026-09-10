'use strict';

// 玻璃探针：把几种 Electron 窗口透明/材质配置并排放出来，用于真机比对。
// 目的：确定「半透明玻璃」在这台机器上到底哪种配置真的能上屏。
//
// 用法： node_modules/.bin/electron tools/glass-probe.js

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PAGE = path.join(__dirname, 'glass-probe.html');

function iconSamples() {
  const dir = path.join(os.homedir(), 'Desktop');
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => /\.(lnk|exe|url)$/i.test(name))
      .slice(0, 3)
      .map((name) => path.join(dir, name));
  } catch (_) {
    return [];
  }
}

function makeWindow({ label, desc, x, y, options }) {
  const win = new BrowserWindow({
    width: 360,
    height: 150,
    x,
    y,
    frame: false,
    show: false,
    skipTaskbar: false,
    resizable: false,
    hasShadow: false,
    ...options
  });
  const query = new URLSearchParams({
    label,
    desc,
    icons: iconSamples().join('|')
  });
  win.loadFile(PAGE, { search: `?${query.toString()}` });
  win.once('ready-to-show', () => win.show());
  return win;
}

app.whenReady().then(() => {
  const isWin = process.platform === 'win32';
  const variants = [
    {
      label: 'A 非透明+acrylic 材质',
      desc: 'transparent:false + backgroundMaterial:acrylic（token 的写法）',
      options: {
        transparent: false,
        backgroundColor: '#00000000',
        ...(isWin ? { backgroundMaterial: 'acrylic' } : {})
      }
    },
    {
      label: 'B 真透明 transparent:true',
      desc: 'transparent:true，无材质（页面自己控制透明度）',
      options: { transparent: true, backgroundColor: '#00000000' }
    },
    {
      label: 'C 非透明+不挂材质',
      desc: 'transparent:false + 无材质（对照：应该是不透明底）',
      options: { transparent: false, backgroundColor: '#00000000' }
    }
  ];

  const windows = variants.map((variant, index) =>
    makeWindow({ ...variant, x: 120, y: 120 + index * 170 })
  );

  console.log('探针已启动：三个窗口从上到下 A / B / C');
  setTimeout(() => {
    // 保持一段时间便于外部截屏比对
    if (process.argv.includes('--hold')) return;
    app.quit();
  }, 20000);

  global.__windows = windows;
});

app.on('window-all-closed', () => app.quit());
