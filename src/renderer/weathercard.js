'use strict';

// 天气悬浮卡片（页面）：鼠标靠近 Dock 上的天气图标时浮出来，显示当前天气 ＋ 未来几天。
// 只读展示——不响应点击、不抢焦点，鼠标一离开由主进程把窗口收掉。
// 数据来自主进程的快照：打开时取一次，之后跟着 weather:changed 更新。

const api = window.deskbasket;
const icons = window.weatherIcons;
const cardEl = document.getElementById('card');

function node(className, text) {
  const el = document.createElement('div');
  el.className = className || '';
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
}

function img(className, src) {
  const el = document.createElement('img');
  el.className = className;
  el.alt = '';
  el.src = src;
  return el;
}

// 更新时间：只写 时:分（卡片很窄，写全日期反而挤）
function clockText(stamp) {
  if (!stamp) return '';
  const d = new Date(stamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())} 更新`;
}

function head(state) {
  const box = node('head');
  const label = (state.place && state.place.label) || state.city || '天气';
  box.append(node('city', label));
  // 自动定位时标一句：地名是 IP 推出来的，跟实际住处可能差一个城市，别让人以为是准的
  const stamp = clockText(state.updatedAt);
  const updated = [state.auto ? '自动定位' : '', stamp].filter(Boolean).join(' · ');
  if (updated) box.append(node('updated', updated));
  return box;
}

function now(state) {
  const current = state.current;
  const box = node('now');
  box.append(img('', icons.glyph(current.icon)));
  box.append(node('temp', icons.temp(current.temperature) + '°'));
  const meta = node('meta');
  meta.append(node('desc', current.text || ''));
  const extra = [];
  if (current.feelsLike !== null && current.feelsLike !== undefined) {
    extra.push('体感 ' + icons.temp(current.feelsLike) + '°');
  }
  if (current.humidity !== null && current.humidity !== undefined) {
    extra.push('湿度 ' + Math.round(current.humidity) + '%');
  }
  if (extra.length) meta.append(node('extra', extra.join(' · ')));
  box.append(meta);
  return box;
}

function days(state) {
  const box = node('days');
  for (const day of state.days || []) {
    const row = node('day');
    row.append(node('when', day.label || ''));
    row.append(img('g', icons.glyph(day.icon)));
    row.append(node('what', day.text || ''));
    row.append(node('hi', icons.temp(day.max) + '°'));
    row.append(node('lo', icons.temp(day.min) + '°'));
    box.append(row);
  }
  return box;
}

function paint(state) {
  cardEl.innerHTML = '';
  if (!state || !state.current) {
    // 还没取到（或第一次就没取成）：给一句话，别留一张空卡片
    const note = node('note', '天气读取中…');
    if (state && state.error) {
      note.textContent = '天气取不到：' + state.error;
      note.className = 'note warn';
    }
    cardEl.append(note);
    document.body.classList.add('ready');
    return;
  }
  cardEl.append(head(state), now(state), node('sep'));
  cardEl.append(days(state));
  // 这次刷新失败但还留着上次的数据：说明一句，别让人以为数据是新的
  if (state.ok === false && state.error) {
    cardEl.append(node('note warn', '数据可能有点旧：' + state.error));
  }
  document.body.classList.add('ready');
}

api.onWeatherChanged((state) => paint(state));
api.getWeather().then(paint).catch(() => paint(null));
