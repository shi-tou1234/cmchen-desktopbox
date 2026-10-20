'use strict';

// QuickLook 空格预览（1.4.0）。
//
// 从 main.js 拆出来的：筐弹窗里选中文件按空格 → 弹预览窗（图片直接看、文本读前 400KB、
// 音视频给播放器）。这块只做三件事：开窗、给预览窗喂文件内容、判断"当前是否开着"
// （弹窗失焦自动关的时候要据此钉住）。
//
// 安全边界：读文件的三个 IPC 都只对**预览窗自己**放行（event.sender 比对），别的页面
// 拿不到任意路径的文件内容——这是当初把接口从通用 file read 收窄下来的原因。

const fs = require('node:fs');
const path = require('node:path');
const { screen } = require('electron');
const basketfiles = require('./basketfiles');

const PREVIEW_TEXT_MAX = 400 * 1024;
const PREVIEW_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico', '.avif'];
const PREVIEW_MEDIA_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.mp3', '.wav', '.flac', '.m4a', '.ogg'];
// 音频律动频谱：只有这几类走「读进内存 → Blob」这条能抽到数据的路（见 preview:media）
const PREVIEW_AUDIO_EXTS = ['.mp3', '.wav', '.flac', '.m4a', '.ogg'];
// 超过这个大小就不抽频谱了（大 WAV/FLAC 读进内存不划算），照常播放、只是没有律动
const PREVIEW_VIZ_MAX_BYTES = 50 * 1024 * 1024;
const PREVIEW_TEXT_EXTS = ['.txt', '.md', '.csv', '.log', '.json', '.js', '.ts', '.py', '.c', '.cpp', '.h', '.css', '.html', '.xml', '.yml', '.yaml', '.ini', '.bat', '.ps1', '.java'];

const PREVIEW_WIDTH = 720;
const PREVIEW_HEIGHT = 520;

function createPreviewController(deps) {
  const { guardHandle, winFactory, attachDiagnostics, appName, closeMenuIfOpen, pathExists } = deps;

  let previewWindow = null;

  function previewKindOf(name) {
    const lowered = String(name || '').toLowerCase();
    const dot = lowered.lastIndexOf('.');
    const ext = dot > 0 ? lowered.slice(dot) : '';
    if (PREVIEW_IMAGE_EXTS.includes(ext)) return 'image';
    if (PREVIEW_MEDIA_EXTS.includes(ext)) return 'media';
    if (PREVIEW_TEXT_EXTS.includes(ext)) return 'text';
    return 'none';
  }

  function closePreviewWindow() {
    if (previewWindow && !previewWindow.isDestroyed()) previewWindow.destroy();
    previewWindow = null;
  }

  // 弹窗失焦自动关的判定要用：预览开着时弹窗钉住（预览盖在网格上，关预览回到弹窗）
  function isOpen() {
    return Boolean(previewWindow && !previewWindow.isDestroyed());
  }

  function registerIpc() {
    guardHandle('preview:open', (_event, { path: target } = {}) => {
      closeMenuIfOpen();
      if (!target || !pathExists(target)) return { ok: false, error: '文件不存在' };
      try {
        if (fs.statSync(target).isDirectory()) return { ok: false, error: '文件夹不支持预览' };
      } catch (_) {
        return { ok: false, error: '文件读不了' };
      }
      closePreviewWindow();
      const area = screen.getPrimaryDisplay().workArea;
      previewWindow = winFactory.createRenameWindow({
        width: PREVIEW_WIDTH,
        height: PREVIEW_HEIGHT,
        x: Math.round(area.x + (area.width - PREVIEW_WIDTH) / 2),
        y: Math.round(area.y + (area.height - PREVIEW_HEIGHT) / 2),
        glass: false,
        title: `${appName} 预览`
      });
      attachDiagnostics(previewWindow, 'preview');
      winFactory.loadPage(previewWindow, 'preview.html', { path: target });
      const win = previewWindow;
      win.once('ready-to-show', () => {
        if (win.isDestroyed()) return;
        win.show();
        win.focus();
      });
      // **不做**失焦即关：预览窗从弹窗里唤出时，弹窗收起的焦点震荡会立刻把它也带走。
      // 关闭只走三条路：空格 / Esc / 点 ✕（预览页里都有监听）。
      win.on('closed', () => {
        if (previewWindow === win) previewWindow = null;
      });
      return { ok: true };
    });

    // 文件内容只给预览窗自己：别的页面来问一律拒绝（任意路径读文件的口子必须收紧）
    guardHandle('preview:read', (event, { path: target } = {}) => {
      if (!isOpen() || event.sender !== previewWindow.webContents) {
        return { ok: false, error: 'denied' };
      }
      if (!target || !pathExists(target)) return { ok: false, error: '文件不存在' };
      let stat = null;
      try {
        stat = fs.statSync(target);
      } catch (_) {
        return { ok: false, error: '文件读不了' };
      }
      const kind = previewKindOf(target);
      const payload = {
        ok: true,
        kind,
        name: path.basename(target),
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        url: kind === 'image' || kind === 'media'
          ? 'file:///' + encodeURI(target).replace(/#/g, '%23').replace(/\?/g, '%3F')
          : ''
      };
      if (kind === 'text') {
        try {
          const handle = fs.openSync(target, 'r');
          const buffer = Buffer.alloc(Math.min(stat.size, PREVIEW_TEXT_MAX));
          const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
          fs.closeSync(handle);
          payload.text = buffer.toString('utf8', 0, read);
          payload.truncated = read < stat.size;
        } catch (error) {
          return { ok: false, error: basketfiles.errorText(error) };
        }
      }
      return payload;
    });

    // 音频律动：把音频字节交给预览窗，渲染层做成 Blob URL 再喂 <audio> + AnalyserNode。
    // 为什么不走现成的 file:// ——预览窗开着 webSecurity，Chromium 把 file:// 当不透明源，
    // createMediaElementSource 会因「跨源污染」输出静音，抽不出频谱。同源 Blob 才拿得到数据。
    // 只对预览窗自己放行、只认音频扩展名、超过上限就不给（渲染层自动降级为「能播没律动」）。
    guardHandle('preview:media', (event, { path: target } = {}) => {
      if (!isOpen() || event.sender !== previewWindow.webContents) {
        return { ok: false, error: 'denied' };
      }
      if (!target || !pathExists(target)) return { ok: false, error: '文件不存在' };
      const lowered = String(target).toLowerCase();
      const dot = lowered.lastIndexOf('.');
      const ext = dot > 0 ? lowered.slice(dot) : '';
      if (!PREVIEW_AUDIO_EXTS.includes(ext)) return { ok: false, error: '非音频' };
      let stat = null;
      try {
        stat = fs.statSync(target);
        if (stat.isDirectory()) return { ok: false, error: '文件夹' };
      } catch (_) {
        return { ok: false, error: '文件读不了' };
      }
      if (stat.size > PREVIEW_VIZ_MAX_BYTES) return { ok: false, tooBig: true };
      try {
        return { ok: true, bytes: fs.readFileSync(target) };
      } catch (error) {
        return { ok: false, error: basketfiles.errorText(error) };
      }
    });
  }

  return { close: closePreviewWindow, isOpen, registerIpc };
}

module.exports = { createPreviewController };
