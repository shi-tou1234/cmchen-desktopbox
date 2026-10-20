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

// 音频 MIME：Blob 得带类型，<audio> 才知道怎么解（按扩展名给，取不到退回 mpeg）
function audioMime(name) {
  const lowered = String(name || '').toLowerCase();
  const ext = lowered.slice(lowered.lastIndexOf('.'));
  return (
    { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
      '.m4a': 'audio/mp4', '.ogg': 'audio/ogg' }[ext] || 'audio/mpeg'
  );
}

// 音频律动：读字节 → 同源 Blob → <audio> 播，同时接 AnalyserNode 画底部频谱条。
// 走 Blob 而非 file:// 的原因见主进程 preview:media 注释；拿不到字节（太大/出错）
// 或用户偏好减少动效时，自动降级为普通 file:// 播放，只是没有律动。
function renderAudio(payload, stage) {
  const wrap = document.createElement('div');
  wrap.className = 'player';
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.autoplay = true;
  const canvas = document.createElement('canvas');
  canvas.className = 'viz';
  wrap.append(audio, canvas);
  stage.append(wrap);

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let blobUrl = '';
  let audioCtx = null;
  let analyser = null;
  let raf = 0;

  // 直接播 file://（无律动的降级路径）
  function playPlain() {
    audio.src = payload.url;
  }

  // 画一帧频谱条：对数分组，别让低频把整排吃掉；顶部带小圆角
  function paint() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    ctx.clearRect(0, 0, w, h);

    const light = matchMedia('(prefers-color-scheme: light)').matches;
    const bars = 52;
    const gap = 3;
    const bw = (w - gap * (bars - 1)) / bars;
    const grad = ctx.createLinearGradient(0, h, 0, 0);
    if (light) {
      grad.addColorStop(0, 'rgba(60, 95, 185, 0.5)');
      grad.addColorStop(1, 'rgba(120, 80, 200, 0.92)');
    } else {
      grad.addColorStop(0, 'rgba(88, 140, 255, 0.5)');
      grad.addColorStop(1, 'rgba(184, 120, 255, 0.95)');
    }
    ctx.fillStyle = grad;
    for (let i = 0; i < bars; i++) {
      const t0 = Math.floor(Math.pow(i / bars, 1.7) * data.length);
      const t1 = Math.max(t0 + 1, Math.floor(Math.pow((i + 1) / bars, 1.7) * data.length));
      let v = 0;
      for (let j = t0; j < t1 && j < data.length; j++) if (data[j] > v) v = data[j];
      const bh = Math.max(2, (v / 255) * h * 0.94);
      const x = i * (bw + gap);
      const y = h - bh;
      const r = Math.min(bw / 2, 3);
      ctx.beginPath();
      ctx.moveTo(x, h);
      ctx.lineTo(x, y + r);
      ctx.arcTo(x, y, x + r, y, r);
      ctx.lineTo(x + bw - r, y);
      ctx.arcTo(x + bw, y, x + bw, y + r, r);
      ctx.lineTo(x + bw, h);
      ctx.closePath();
      ctx.fill();
    }
  }

  function frame() {
    raf = 0;
    if (!analyser || audio.paused || audio.ended) return;   // 暂停/结束停表，省 CPU
    paint();
    raf = requestAnimationFrame(frame);
  }
  function startLoop() {
    if (analyser && !raf && !audio.paused) raf = requestAnimationFrame(frame);
  }

  function attachAnalyser() {
    let ctx = null;
    let src = null;
    try {
      ctx = new AudioContext();
      // createMediaElementSource 一旦调用，元素声音就被引进图里——后面任何一步没接到
      // destination 都会「接得上却没声」。所以先建好再逐步连，失败就把 src 直连 destination。
      src = ctx.createMediaElementSource(audio);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.82;
      src.connect(analyser);
      analyser.connect(ctx.destination);
      audioCtx = ctx;
    } catch (_) {
      analyser = null;
      try {
        if (src) src.connect(ctx.destination);   // 退而求其次：至少保证能听到
        else if (ctx) ctx.close().catch(() => {});
      } catch (__) { /* 连兜底都失败就算了，浏览器仍会按普通 <audio> 播 */ }
    }
  }

  audio.addEventListener('play', () => {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    startLoop();
  });
  audio.addEventListener('pause', () => {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  });

  window.addEventListener('pagehide', () => {
    if (raf) cancelAnimationFrame(raf);
    if (audioCtx) audioCtx.close().catch(() => {});
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  });

  (async () => {
    if (reducedMotion) { playPlain(); return; }
    try {
      const res = await api.previewMedia({ path: target });
      if (!res || !res.ok || !res.bytes) { playPlain(); return; }
      blobUrl = URL.createObjectURL(new Blob([res.bytes], { type: audioMime(payload.name) }));
      audio.src = blobUrl;
      attachAnalyser();
      startLoop();
    } catch (_) {
      playPlain();
    }
  })();
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
    if (isAudio) {
      renderAudio(payload, stage);
      return;
    }
    const node = document.createElement('video');
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
