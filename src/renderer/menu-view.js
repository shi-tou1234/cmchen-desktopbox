'use strict';

const api = window.deskbasket;
const host = document.getElementById('menu');
const DANGER = /删除|清空/;

// 主进程开菜单窗时会带 ?rm=1 表示「减弱动画」开着（#7）：那就直接到位，不播展开。
// CSS 里也有一条 prefers-reduced-motion（跟系统设置），两者任一命中即不弹。
if (new URLSearchParams(location.search).get('rm') === '1') {
  document.body.classList.add('reduce-motion');
  document.body.classList.add('ready');   // 跳过展开动画，直接就位
}

const rows = [];     // 可选项：[{ key, el }]，跳过分隔线
let hot = -1;        // 当前高亮的下标

function paint() {
  rows.forEach((row, index) => row.el.classList.toggle('hot', index === hot));
}

function move(step) {
  if (!rows.length) return;
  hot = (hot + step + rows.length) % rows.length;
  paint();
}

async function pick(index) {
  const row = rows[index];
  if (!row) return;
  row.el.classList.add('picked');
  // 先让高亮闪一下再关窗：不然点下去像是"没反应"
  await new Promise((resolve) => setTimeout(resolve, document.body.classList.contains('reduce-motion') ? 0 : 80));
  api.menuPick(row.key);
}

(async () => {
  const items = (await api.menuItems()) || [];
  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      host.append(sep);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'menu-item' + (DANGER.test(item.label) ? ' danger' : '');
    el.textContent = item.label;
    const index = rows.length;
    el.addEventListener('mouseenter', () => {
      hot = index;
      paint();
    });
    el.addEventListener('click', () => pick(index));
    rows.push({ key: item.key, el });
    host.append(el);
  }

  // 第一项默认高亮，键盘直接就能用
  if (rows.length) {
    hot = 0;
    paint();
  }
  // 下一帧再加 ready，让淡入/展开的 transition 真的跑起来。
  // 兜底那一下是防"窗口还没显示时 rAF 不回调"——那样菜单会一直停在 opacity:0，
  // 看着就是"右键没反应"。
  requestAnimationFrame(() => document.body.classList.add('ready'));
  setTimeout(() => document.body.classList.add('ready'), 80);
})();

document.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    move(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    move(-1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (hot >= 0) pick(hot);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    api.menuDismiss();
  }
});

// 鼠标移出菜单就撤掉高亮
document.addEventListener('mouseleave', () => {
  hot = -1;
  paint();
});
