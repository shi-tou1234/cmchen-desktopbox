'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { app, BrowserWindow, ipcMain, screen, desktopCapturer, globalShortcut } = require('electron');
const root = process.env.DESKBASKET_TEST_ROOT || path.resolve(__dirname, '../..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'deskbasket-startup-'));
fs.writeFileSync(path.join(os.tmpdir(), 'deskbasket-startup-latest.txt'), output);
console.log = console.error = (...args) => fs.appendFileSync(path.join(output, 'events.log'), args.join(' ') + '\n');
app.setName('DeskBasket-Startup-Integration');
app.setPath('userData', path.join(output, 'electron'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], started = Date.now();
let finished = false;
function pass(name, evidence = {}) { checks.push({ name, evidence }); }
async function until(fn, name) {
  for (let i = 0; i < 180; i++) { const result = await fn(); if (result) return result; await sleep(50); }
  throw Error('timeout: ' + name);
}
function finish(error) {
  if (finished) return; finished = true;
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ ok: !error, checks, error: error?.stack }, null, 2));
  app.exit(error ? 1 : 0);
}
setTimeout(() => finish(Error('startup integration timed out')), 25000);
app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  // 已知纯色背景用于检验 Windows 最终合成结果，不能只测网页自己的 alpha。
  const bg = new BrowserWindow({ ...display.bounds, frame: false, show: false, alwaysOnTop: true,
    skipTaskbar: true, backgroundColor: '#359f7f', webPreferences: { nodeIntegration: false, contextIsolation: true } });
  await bg.loadURL('data:text/html,<style>html{background:%23359f7f}</style>'); bg.showInactive();
  const data = path.join(output, 'data'); fs.mkdirSync(data);
  const files = Array.from({ length: 22 }, (_, i) => path.join(data, 'sample-' + i + '.txt'));
  files.forEach(file => fs.writeFileSync(file, 'fixture'));
  app.setPath('desktop', data);
  const store = require(path.join(root, 'src/main/store'));
  store.__setRootForTests(path.join(output, 'config'));
  store.saveSettings({ theme_mode: 'dark', autostart: false, focus_fullscreen: false, music_viz: false,
    dock_auto_hide: false, dock_hotkey: 'F9', dock_items: files, dock_specials: [],
    shortcuts_dir: data, basket_dir: path.join(output, 'baskets'), baskets: [] });
  // 真实 preload/renderer IPC，故意让内容迟到；第二实例事件也不能提前显示空表面。
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) => handle(channel, channel === 'dock:get'
    ? async (...args) => { await sleep(1400); return fn(...args); } : fn);
  let hotkey; globalShortcut.register = (_, fn) => { hotkey = fn; return true; };
  globalShortcut.isRegistered = () => true; globalShortcut.unregister = () => {};
  const events = [];
  app.on('browser-window-created', (_, w) => {
    w.once('ready-to-show', () => {
      if (w.getTitle() !== 'DeskBasket Dock') return;
      events.push({ name: 'native-ready', at: Date.now() - started, visible: w.isVisible() });
      assert.equal(w.isVisible(), false); app.emit('second-instance'); assert.equal(w.isVisible(), false);
      pass('原生首帧先到和重复启动均不提前显示');
    });
    w.on('show', () => { if (w.getTitle() === 'DeskBasket Dock') {
      w.setAlwaysOnTop(true); events.push({ name: 'show', at: Date.now() - started, painted: w.__dockPaintReady });
    } });
  });
  require(path.join(root, 'src/main/main'));
  const dock = await until(() => BrowserWindow.getAllWindows().find(w => w.getTitle() === 'DeskBasket Dock'), 'Dock');
  await until(() => dock.isVisible(), 'content-ready show');
  assert.equal(dock.__dockPaintReady, true);
  assert.ok(await dock.webContents.executeJavaScript('document.querySelectorAll(".dock-item").length > 0'));
  pass('内容延迟 1.4 秒时等待内容，随后显示图标', { events });
  for (const delay of [0, 150, 1200, 3000]) {
    await sleep(delay);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: display.size });
    const source = sources.find(s => s.display_id === String(display.id));
    assert.ok(source);
    const bounds = dock.getBounds(), scale = source.thumbnail.getSize().width / display.bounds.width;
    const crop = source.thumbnail.crop({ x: Math.round((bounds.x - display.bounds.x) * scale),
      y: Math.round((bounds.y - display.bounds.y) * scale), width: Math.round(bounds.width * scale), height: Math.round(bounds.height * scale) });
    fs.writeFileSync(path.join(output, 'composited-' + delay + '.png'), crop.toPNG());
    const bitmap = crop.toBitmap(), size = crop.getSize(); let wrong = 0, total = 0;
    for (let y = 4; y < Math.min(30, size.height - 4); y++) for (let x = 4; x < size.width - 4; x++) {
      const at = (y * size.width + x) * 4; total++;
      if (Math.abs(bitmap[at] - 127) > 2 || Math.abs(bitmap[at + 1] - 159) > 2 || Math.abs(bitmap[at + 2] - 53) > 2) wrong++;
    }
    assert.equal(wrong, 0, 'native composition must expose the green backdrop');
    pass('Windows 合成的 Dock 上方留白透明：' + delay + 'ms', { total, wrong });
  }
  hotkey(); assert.equal(dock.isVisible(), false); hotkey(); assert.equal(dock.isVisible(), true);
  pass('F9 隐藏和恢复正常');
  const call = code => dock.webContents.executeJavaScript(code);
  await call('window.deskbasket.updateSettings({focus_manual:true})');
  assert.equal(dock.isVisible(), false); hotkey(); assert.equal(dock.isVisible(), false);
  await call('window.deskbasket.updateSettings({focus_manual:false})');
  await until(() => dock.isVisible(), 'focus exit'); pass('专注模式隐藏与退出恢复正常');
  await call('window.deskbasket.updateSettings({dock_auto_hide:true})');
  await sleep(1500); assert.equal(dock.isVisible(), true);
  pass('切换自动收起不破坏首帧状态');
  assert.equal(ipcMain.listenerCount('dock:paint-ready'), 0);
  pass('首帧完成后清理一次性监听');
  finish();
}).catch(finish);
