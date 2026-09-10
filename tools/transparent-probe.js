'use strict';

// 透明最小实验：只放两个窗口，页面不铺任何底色，用来判定
// 「Electron 的 transparent:true 在这台机器上到底透不透」。
//
//   node_modules/.bin/electron tools/transparent-probe.js

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const PAGE = path.join(__dirname, 'transparent-probe.html');

const VARIANTS = [
  { label: 'A transparent:true + backgroundColor #00000000', opts: { transparent: true, backgroundColor: '#00000000' } },
  { label: 'B transparent:true 不设 backgroundColor', opts: { transparent: true } },
  { label: 'C transparent:false + backgroundColor #00000000', opts: { transparent: false, backgroundColor: '#00000000' } }
];

app.whenReady().then(() => {
  VARIANTS.forEach((variant, index) => {
    const win = new BrowserWindow({
      width: 420,
      height: 150,
      x: 150,
      y: 120 + index * 180,
      frame: false,
      show: false,
      hasShadow: false,
      ...variant.opts
    });
    win.loadFile(PAGE);
    win.once('ready-to-show', () => win.show());
    console.log(variant.label, '已建');
  });
  setTimeout(() => app.quit(), 25000);
});

app.on('window-all-closed', () => app.quit());
