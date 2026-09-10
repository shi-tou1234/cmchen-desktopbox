'use strict';

// 定量测透明度：先铺一块自己控制的纯色背板，再把「面板」盖上去，
// 比较面板内外的亮度就能得出窗口自身的透光比（背景是纯色，不存在干扰）。
//
//   node_modules/.bin/electron tools/opacity-meter.js

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const BACKDROP_COLOR = '#787878';   // 120,120,120
const PANEL_HTML = path.join(__dirname, 'opacity-meter-panel.html');
const BACKDROP_HTML = path.join(__dirname, 'opacity-meter-backdrop.html');

app.whenReady().then(() => {
  const backdrop = new BrowserWindow({
    x: 100,
    y: 100,
    width: 900,
    height: 520,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false
  });
  backdrop.loadFile(BACKDROP_HTML, { search: `?color=${encodeURIComponent(BACKDROP_COLOR)}` });

  let panel = null;
  backdrop.once('ready-to-show', () => {
    backdrop.show();
    setTimeout(() => {
      // 透明面板（页面只有一个细边框，不铺任何底色）
      panel = new BrowserWindow({
        x: 300,
        y: 240,
        width: 500,
        height: 220,
        frame: false,
        resizable: false,
        alwaysOnTop: true,
        show: false,
        hasShadow: false,
        transparent: true,
        backgroundColor: '#00000000'
      });
      panel.loadFile(PANEL_HTML);
      panel.once('ready-to-show', () => {
        panel.show();
        fs.writeFileSync(
          path.join(__dirname, '..', 'docs', 'opacity-meter.ready'),
          `${JSON.stringify({ backdrop: backdrop.getBounds(), panel: panel.getBounds() })}\n`
        );
        console.log('READY', JSON.stringify({ backdrop: backdrop.getBounds(), panel: panel.getBounds() }));
      });
    }, 600);
  });

  setTimeout(() => app.quit(), 30000);
});

app.on('window-all-closed', () => app.quit());
