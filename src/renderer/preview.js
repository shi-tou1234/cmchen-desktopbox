'use strict';

// QuickLook 预览页（1.4.0）：拿到 preview:read 的载荷按类型铺内容；
// 空格/Esc 关窗。文件内容是主进程给的（别的页面拿不到），这里只管展示。

const api = window.deskbasket;
const params = new URLSearchParams(location.search);
const target = params.get('path') || '';

function close() {
  window.close();
}

function formatSize(size) {
  if (size >= 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + ' MB';
  if (size >= 1024) return (size / 1024).toFixed(1) + ' KB';
  return size + ' B';
}

function render(payload) {
  const stage = document.getElementById('stage');
  document.getElementById('name').textContent = payload.name || '';
  document.getElementById('meta').textContent =
    formatSize(payload.size || 0) + ' · ' + (payload.mtime ? payload.mtime.slice(0, 10) : '');
  if (!payload.ok) {
    stage.innerHTML = '<div class="none">' + (payload.error || '读不了这个文件') + '</div>';
    return;
  }
  if (payload.kind === 'image') {
    const img = document.createElement('img');
    img.src = payload.url;
    img.alt = payload.name;
    stage.append(img);
    return;
  }
  if (payload.kind === 'media') {
    const lowered = payload.name.toLowerCase();
    const isAudio = /\.(mp3|wav|flac|m4a|ogg)$/.test(lowered);
    const node = document.createElement(isAudio ? 'audio' : 'video');
    node.src = payload.url;
    node.controls = true;
    node.autoplay = true;
    stage.append(node);
    return;
  }
  if (payload.kind === 'text') {
    const pre = document.createElement('pre');
    pre.textContent = (payload.text || '') + (payload.truncated ? '\n\n…（文件太大，只读了前一段）' : '');
    stage.append(pre);
    return;
  }
  stage.innerHTML = '<div class="none">这种类型暂时不支持预览<br>双击文件用系统默认程序打开</div>';
}

window.addEventListener('keydown', (event) => {
  if (event.key === ' ' || event.key === 'Escape') {
    event.preventDefault();
    close();
  }
});

(async () => {
  try {
    render(await api.previewRead({ path: target }));
  } catch (error) {
    render({ ok: false, error: (error && error.message) || String(error) });
  }
})();
