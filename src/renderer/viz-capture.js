'use strict';

// 音乐律动·抓取窗（Chromium 系统音频环回）。
//
// 这一扇窗只干一件事：把**整机外放**（QQ音乐/网易云/网页播放器都算）接进 Web Audio，
// 用 AnalyserNode 做真·逐频段 FFT，每 55ms 把 64 段能量推给主进程 → 主进程转给绘制窗画。
// 它自己不出图（平时 1×1 藏在屏幕外），只在系统不让静默取流时显出「点一下开启」面板。
//
// 取流两条路，按优先级试：
//   ① 旧式 desktopCapturer + getUserMedia：主进程先把屏幕源 id 递过来（api.vizSources），
//      用 chromeMediaSource:'desktop' 直接抓整个屏幕的回环音频——**不弹选择框、不需要点击**，
//      是 Electron 专属能力。能成就走这条，全程无感。
//   ② 标准 getDisplayMedia：万一 ① 在这台机器/这版内核被拦，退到标准 API——它会弹一次系统选择框，
//      用户在里头勾上「共享标签页音频/系统音频」即可。这一步必须由真人点，故 ① 也失败时才把面板显出来。
//
// 取到的流**绝不接到扬声器**（只接 Analyser → 0 增益 → destination 维持图被拉动），
// 否则等于把系统声音又放一遍。

const api = window.deskbasket;
const BAND_COUNT = 64;
const READ_MS = 40;   // 25fps：55ms 那档看着有点"跟不上鼓点"
// 频谱只看 40Hz–15kHz：这是音乐真正有能量的范围。按 0–22kHz 铺满 64 段的话，
// 右半边（8kHz 以上）在流行乐里几乎是 0，屏幕上就是"只跳了左半条"。
const F_MIN = 40;
const F_MAX = 15000;

let audioCtx = null;
let analyser = null;
let stream = null;
let readTimer = 0;
let resumeTimer = 0;
let lastPumpAt = 0;
let restarts = 0;
let retryTimer = 0;
let retryCount = 0;
// 静音重连：环回流绑的是「取流那一刻的默认输出设备」。用户把声音从笔记本喇叭挪到
// 显示器（HDMI/DP）后，旧流还对着老设备读，读到的永远是零——表现为"换了个输出就没频谱"。
// 静音超过 SILENCE_RESTART_MS 就拆掉重连一次，重新绑到当前的默认设备。
const SILENCE_RESTART_MS = 6000;
let silenceStart = 0;
let silenceRestarts = 0;
let deviceChangeTimer = 0;
let freq = null;
let started = false;

const body = document.body;
const hint = document.getElementById('hint');

function report(status) {
  if (api && typeof api.vizStatus === 'function') api.vizStatus(status);
}

// 抓取窗是隐藏窗，出问题时用户根本看不见；所有关键步骤都留一行日志（主进程写 viz.log）
function note(text) {
  if (api && typeof api.vizLog === 'function') api.vizLog(text);
}

function askUser(text) {
  if (hint) hint.textContent = text;
  body.setAttribute('data-ask', '1');
  if (api && typeof api.vizGrantState === 'function') api.vizGrantState(true);
}

function hideAsk() {
  body.removeAttribute('data-ask');
  if (api && typeof api.vizGrantState === 'function') api.vizGrantState(false);
}

function firstScreenId() {
  if (!api || typeof api.vizSources !== 'function') return Promise.resolve('');
  return Promise.resolve(api.vizSources())
    .then((list) => (Array.isArray(list) && list[0] && list[0].id) || '');
    }

// ① 旧式：抓整个屏幕的回环音频（Electron 专属，无声、无选择框）。
async function captureViaDesktopSource() {
  const id = await firstScreenId();
  if (!id || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('no-desktop-source');
  }
  // audio+video 同源；视频只要 1×1、2fps 省资源，音频才是我们要的
  const s = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'desktop' } },
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: id,
        minWidth: 1, maxWidth: 2,
        minHeight: 1, maxHeight: 2,
        maxFrameRate: 2
      }
    }
  });
  if (!s.getAudioTracks().length) {
    s.getTracks().forEach((t) => t.stop());
    throw new Error('no-audio-track');
  }
  return s;
}

// ② 标准：弹系统选择框，用户勾选共享音频（要真人点，故只在①失败后由按钮触发）。
async function captureViaGetDisplayMedia() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    throw new Error('no-getdisplaymedia');
  }
  const s = await navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: { frameRate: 2 }
  });
  if (!s.getAudioTracks().length) {
    s.getTracks().forEach((t) => t.stop());
    throw new Error('user-did-not-share-audio');
  }
  return s;
}

function attachStream(s) {
  stream = s;
  audioCtx = new AudioContext();
  const src = audioCtx.createMediaStreamSource(s);
  analyser = audioCtx.createAnalyser();
  // 8192 点（4096 个频点，5.9Hz 一格）：40Hz 那头每段才不到 5Hz，FFT 太小的话前十几段会落在
  // 同一个 bin 上，左半边就成了一块一起跳的「平头」。8192 时只有 1 段重合，低频也有层次。
  analyser.fftSize = 8192;
  // 平滑别开太大：0.72 会让频谱明显滞后，鼓点都糊成一团；0.5 既稳又有弹性
  analyser.smoothingTimeConstant = 0.5;
  const mute = audioCtx.createGain();
  mute.gain.value = 0;             // 图必须通到 destination 才会被拉起来跑，但增益 0 = 不发声
  src.connect(analyser);
  analyser.connect(mute);
  mute.connect(audioCtx.destination);
  freq = new Uint8Array(analyser.frequencyBinCount);

  let went = false;
  const resumeAndGo = () => {
    if (went) return;
    went = true;
    if (stream) stream.getVideoTracks().forEach((t) => t.stop()); // 视频轨我们不用，关掉省电
    readTimer = setInterval(pump, READ_MS);
    report('');
    note(`pump start ctx=${audioCtx ? audioCtx.state : '?'}`);
  };
  if (audioCtx.state === 'suspended') {
    // 不能 await resume()：没有用户手势时它可能一直 pending，等它 = 永远不开表
    audioCtx.resume().catch(() => {});
    setTimeout(resumeAndGo, 250);
    // 起不来就每隔 2s 再试一次（有的机器要等音频端点就绪）
    resumeTimer = setInterval(() => {
      if (!audioCtx || audioCtx.state !== 'suspended') {
        clearInterval(resumeTimer);
        resumeTimer = 0;
        return;
      }
      audioCtx.resume().catch(() => {});
    }, 2000);
  } else {
    resumeAndGo();
  }

  // 用户在系统里点了「停止共享」→ 音频轨结束：收摊，回到需要点击的状态
  s.getAudioTracks().forEach((track) => {
    track.addEventListener('ended', () => stopAll(true));
  });
}

function pump() {
  if (!analyser || !freq || !audioCtx || !api || typeof api.vizBands !== 'function') return;
  lastPumpAt = Date.now();
  analyser.getByteFrequencyData(freq);
  const n = freq.length;
  const nyquist = audioCtx.sampleRate / 2;
  const out = new Array(BAND_COUNT);
  // 对数分组（每段约 1.6 个半音），取组内峰值：低频段窄、高频段宽，铺出来才是"音乐"的样子。
  // 段宽按频率算，不按 bin 序号算——按序号做 pow 分组会把太多段堆到 10kHz 以上，右半边永远空着。
  for (let i = 0; i < BAND_COUNT; i++) {
    const loF = F_MIN * Math.pow(F_MAX / F_MIN, i / BAND_COUNT);
    const hiF = F_MIN * Math.pow(F_MAX / F_MIN, (i + 1) / BAND_COUNT);
    const lo = Math.max(0, Math.min(n - 1, Math.round((loF / nyquist) * n)));
    const hi = Math.max(lo + 1, Math.min(n, Math.round((hiF / nyquist) * n)));
    let peak = 0;
    for (let j = lo; j < hi; j++) if (freq[j] > peak) peak = freq[j];
    out[i] = peak;
  }
  // 「整帧全零」是判断环回绑错设备的唯一信号：有声就清零静音计时，
  // 连续静音则交给下面的看门狗去重连（重新绑当前的默认输出设备）。
  if (out.some((v) => v > 0)) {
    silenceStart = 0;
    silenceRestarts = 0;
  } else if (!silenceStart) {
    silenceStart = Date.now();
  }
  api.vizBands(out);
}

function stopAll(backToAsk) {
  if (readTimer) { clearInterval(readTimer); readTimer = 0; }
  if (resumeTimer) { clearInterval(resumeTimer); resumeTimer = 0; }
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  analyser = null;
  freq = null;
  if (backToAsk) start();
}

async function start() {
  if (started) return;
  started = true;
  report('正在启动…');
  note('start');
  // 重启后第一下取流偶尔会落空（上一个实例刚放开桌面音频、屏幕源还没枚举出来）。
  // 以前一次失败就直接退到"点一下授权"的面板——而那个面板在隐藏窗里、常常被别的窗口盖住，
  // 用户看到的就是"重启后频谱再也不出现"。这里给它三次机会，失败才退人工。
  const waits = [0, 500, 900, 1500, 2200];
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const s = await captureViaDesktopSource();
      hideAsk();
      note(`capture ok attempt=${attempt}`);
      attachStream(s);
      return;
    } catch (err) {
      const text = String((err && err.message) || err);
      console.log(`[vizcap] 第 ${attempt} 次取流失败：${text}`);
      note(`capture fail attempt=${attempt} ${text}`);
      if (attempt < 4) await new Promise((r) => setTimeout(r, waits[attempt] || 500));
    }
  }
  started = false;
  report('没拿到系统声音');
  askUser('点一下「开启律动」，在弹窗里勾选共享音频');
  scheduleRetry();
}

// 取流失败后别就此躺平：每 8 秒在后台再试一次（最多 6 次）。音频端点刚被上个实例放开、
// 或者设备刚切换时，过几秒往往就能取到了——成功了会自动把授权面板收掉。
function scheduleRetry() {
  if (retryTimer || retryCount >= 6) return;
  retryTimer = setInterval(() => {
    if (stream) {
      clearInterval(retryTimer);
      retryTimer = 0;
      return;
    }
    retryCount += 1;
    note(`retry #${retryCount}`);
    started = false;
    start();
  }, 8000);
}

if (hint) {
  hint.parentElement.querySelector('button').addEventListener('click', async () => {
    try {
      const s = await captureViaGetDisplayMedia();
      started = true;
      hideAsk();
      attachStream(s);
    } catch (err) {
      askUser('没拿到音频，再点一次试试');
      console.log('[vizcap] 标准取流失败：' + String((err && err.message) || err));
    }
  });
}

window.addEventListener('pagehide', () => stopAll(false));

// 看门狗：流接上了、但 pump 三秒没跑（典型的：AudioContext 的 resume 一直 pending、
// 音频轨被系统悄悄掐断）→ 自己拆掉重来。最多重来 5 次，坏设备上别无限重启。
setInterval(() => {
  if (!stream || !audioCtx) return;
  if (Date.now() - lastPumpAt < 3000) {
    // pump 还在跑：看是不是"绑错了设备"的静音
    if (silenceStart && Date.now() - silenceStart > SILENCE_RESTART_MS && silenceRestarts < 3) {
      silenceRestarts += 1;
      silenceStart = Date.now();   // 重置计时：连续静音也别连环拆，3 次后等设备变化或声音回来
      note(`silence rebind #${silenceRestarts}`);
      report('重新绑定音频输出…');
      stopAll(false);
      started = false;
      start();
    }
    return;
  }
  if (restarts >= 5) return;
  restarts += 1;
  note(`watchdog restart #${restarts}`);
  report('重新连接系统声音…');
  stopAll(false);
  started = false;
  start();
}, 4000);

// 设备插拔（插上/拔掉显示器、耳机）也会让旧环回流失效：收到事件就重连一次（防抖 1 秒）。
if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    if (!stream) return;
    if (deviceChangeTimer) return;
    deviceChangeTimer = setTimeout(() => {
      deviceChangeTimer = 0;
      if (!stream) return;
      note('devicechange -> rebind');
      stopAll(false);
      started = false;
      start();
    }, 1000);
  });
}

start();
