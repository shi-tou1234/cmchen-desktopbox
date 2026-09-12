'use strict';

const api = window.deskbasket;
const el = (id) => document.getElementById(id);

let view = null;       // 当前视图：{ kind, name, path?, parent?, basketId?, view?, entries, error }
let homeView = null;   // 初始视图（从筐导航出去后能回来）
let iconSize = 48;
let selectedPath = null;
let staggerNext = false;   // 下一次 render 要不要给格子做交错进场（只有"打开"那一次要）

function isDirEntry(entry) {
  return Boolean(entry && entry.isDir);
}

function baseName(target) {
  return String(target).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || target;
}

// 图标取不到时的兜底：既不留空白，也不让浏览器画「破图」标记
function fallbackIcon() {
  const full = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">',
    '<path d="M12 4h16l8 8v32a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="#8d93a5"/>',
    '<path d="M28 4l8 8h-8z" fill="#c3c8d6"/>',
    '</svg>'
  ].join('');
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(full);
}

// ---------------------------------------------------------------- 渲染

function makeCell(entry, index) {
  const cell = document.createElement('div');
  cell.className = 'cell' + (entry.exists === false ? ' missing' : '');
  cell.title = entry.path;
  // 交错进场的节拍：每个格子按序号延后一点（上限 20 格，再多就不至于等太久）
  cell.style.setProperty('--i', Math.min(index, 20));

  const img = document.createElement('img');
  if (entry.iconUrl) {
    // 主进程已经把图标算好塞进载荷了：直接画，不用再等一次 IPC 和图片解码
    img.src = entry.iconUrl;
  } else {
    // 载荷里没有（算图标超时了）：退回异步取，先用兜底图标垫着
    img.src = fallbackIcon();
    api
      .getIcon(entry.path, iconSize)
      .then((dataUrl) => {
        if (dataUrl) img.src = dataUrl;
      })
      .catch(() => {});
  }

  const name = document.createElement('div');
  name.className = 'name';
  // 与桌面图标一致：快捷方式不带 .lnk/.url 后缀展示
  name.textContent = entry.name.replace(/\.(lnk|url)$/i, '');

  cell.append(img, name);

  cell.addEventListener('click', () => {
    for (const node of el('grid').children) node.classList.remove('selected');
    cell.classList.add('selected');
    selectedPath = entry.path;
  });

  cell.addEventListener('dblclick', async () => {
    if (isDirEntry(entry)) {
      navigate(entry.path, 'forward');   // 进下一级：新页从右边推进来
    } else {
      const result = await api.openPath(entry.path);
      if (result && result.ok === false) setStatus('打不开：' + entry.name, true);
    }
  });

  cell.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const items = [
      { key: 'open', label: isDirEntry(entry) ? '打开文件夹' : '打开' },
      { key: 'reveal', label: '在系统资源管理器中显示' }
    ];
    if (view.kind === 'basket') {
      items.push({ separator: true }, { key: 'remove', label: '从筐里移出（不删文件）' });
    }
    window.showContextMenu(items, event).then(async (picked) => {
      if (!picked) return;
      if (picked === 'open') {
        if (isDirEntry(entry)) navigate(entry.path, 'forward');
        else api.openPath(entry.path);
      } else if (picked === 'reveal') {
        api.revealPath(entry.path);
      } else if (picked === 'remove') {
        await api.removeItem(view.basketId, entry.path);
        reloadHome();
      }
    });
  });

  return cell;
}

function setStatus(text, isError = false) {
  el('status').textContent = text || '';
  el('status').className = 'popup-status' + (isError ? ' error' : '');
}

// 加进来的回执：说清楚文件去哪了（搬进筐目录 / 因为 Dock 也在用而只复制了一份 / 没能搬进去）
function addStatus(result) {
  const moved = Number(result.moved) || 0;
  const copied = Number(result.copied) || 0;
  const bad = (result.failed || []).length;
  const how = moved ? '（已移进筐的文件夹）' : copied ? '（Dock 也在用，复制了一份）' : '';
  if (!result.added && !bad) return '没有新增（已在这个筐里的会跳过）';
  let text = '已加入 ' + result.added + ' 项' + how + '，筐里共 ' + result.total + ' 项';
  if (bad) text += '；' + bad + ' 项没能移进去（原文件留在原处）';
  return text;
}

// 翻目录的方向：给网格加一次性动画类，动画放完自动摘掉（避免下次布局也吃这个动画）
function playNav(direction) {
  const grid = el('grid');
  grid.classList.remove('nav-forward', 'nav-backward');
  void grid.offsetWidth;   // 强制重排，让同名 class 再挂上也能重播动画
  grid.classList.add(direction === 'back' ? 'nav-backward' : 'nav-forward');
  const done = () => {
    grid.classList.remove('nav-forward', 'nav-backward');
    grid.removeEventListener('animationend', done);
  };
  grid.addEventListener('animationend', done);
}

function render(navDirection) {
  const title = view.kind === 'basket' ? view.name : (view.name || baseName(view.path || ''));
  el('title').textContent = title;
  document.title = 'DeskBasket · ' + title;

  const grid = el('grid');
  grid.innerHTML = '';
  selectedPath = null;

  const entries = view.entries || [];
  for (let i = 0; i < entries.length; i += 1) grid.append(makeCell(entries[i], i));

  // 交错进场（#6）：只在弹窗刚打开那一次铺 .stagger，动画播完摘掉；
  // 翻目录 / 局部刷新不重播，免得每次动一下整屏格子都在跳。
  if (staggerNext) {
    staggerNext = false;
    grid.classList.remove('nav-forward', 'nav-backward');
    grid.classList.add('stagger');
    const cells = grid.querySelectorAll('.cell');
    const last = cells[cells.length - 1];
    const stop = () => {
      grid.classList.remove('stagger');
      if (last) last.removeEventListener('animationend', stop);
    };
    if (last) last.addEventListener('animationend', stop);
  } else if (navDirection) {
    // 方向性翻页（#5）：进下一级从左/回上级从右，配合下面的 playNav
    playNav(navDirection);
  }

  const hasHome = homeView && view !== homeView;
  el('btnHome').style.display = hasHome ? '' : 'none';
  el('btnHome').textContent = hasHome ? '⌂ ' + homeView.name : '';
  el('btnUp').disabled = !(view.kind === 'dir' && view.parent);
  el('btnUp').style.display = view.kind === 'dir' ? '' : 'none';
  el('btnAdd').style.display = view.kind === 'basket' ? '' : 'none';

  if (view.error) {
    setStatus(view.error, true);
    el('emptyTip').style.display = 'none';
    return;
  }
  el('emptyTip').style.display = entries.length ? 'none' : '';
  el('emptyTip').textContent =
    view.kind === 'basket'
      ? '这个筐还是空的：点上面的「＋」添加文件，或者把文件直接拖进来 / 拖到 Dock 的文件夹图标上（文件会移动进筐的文件夹，原来那处不再保留）'
      : '这个文件夹是空的';
  setStatus(entries.length ? entries.length + ' 项' : '');
}

// ---------------------------------------------------------------- 导航

async function navigate(target, direction) {
  const next = await api.popupNavigate(target);
  if (!next) return;
  view = next;
  render(direction === 'back' ? 'back' : 'forward');
}

async function reloadHome() {
  // 筐内容被移除后刷新当前视图
  if (view.kind === 'basket') {
    const fresh = await api.popupReady();
    if (fresh) {
      homeView = fresh;
      view = fresh;
    }
  }
  render();
}

el('btnUp').addEventListener('click', () => {
  if (view.kind === 'dir' && view.parent) navigate(view.parent, 'back');   // 回上一级：从左边推
});
el('btnHome').addEventListener('click', () => {
  if (homeView) {
    const leaving = view !== homeView;
    view = homeView;
    render(leaving ? 'back' : undefined);
  }
});
// 「＋」：往这个筐里添加文件（可多选）。文件夹可以从设置面板加，或者直接拖进来
el('btnAdd').addEventListener('click', async () => {
  if (!view || view.kind !== 'basket') return;
  const result = await api.pickBasketFiles(view.basketId, 'files');
  if (!result) return;
  if (!result.added && !(result.failed || []).length) {
    setStatus('没有新增（已在这个筐里的会跳过）');
    return;
  }
  await reloadHome();
  setStatus(addStatus(result));
});
el('btnClose').addEventListener('click', () => api.popupClose());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.popupClose();
});

// 把文件直接拖进弹窗 = 加到这个筐里（拖动时给一圈高亮）。
// 拖动期间要告诉主进程"别收窗"：主进程的"鼠标离开就关"挡不住拖拽——用户得先离开弹窗去
// 桌面/资源管理器抓文件，那一段光标确实不在弹窗附近，弹窗会被收掉，文件到了没有落点。
// dragover 在拖动期间以帧率连续触发，所以只在状态真的变了时上报（一次拖拽就两条 IPC）。
let draggingFiles = false;

function setDragState(next) {
  if (next === draggingFiles) return;
  draggingFiles = next;
  api.popupDragState(next);
}

document.addEventListener('dragover', (event) => {
  if (!view || view.kind !== 'basket') return;
  event.preventDefault();
  document.body.classList.add('dragover');
  setDragState(true);
});
document.addEventListener('dragleave', (event) => {
  // 拖到窗口外才取消高亮（子元素之间移动也会触发 dragleave）
  if (event.relatedTarget === null) {
    document.body.classList.remove('dragover');
    setDragState(false);
  }
});
document.addEventListener('drop', async (event) => {
  setDragState(false);
  if (!view || view.kind !== 'basket') return;
  event.preventDefault();
  document.body.classList.remove('dragover');
  const paths = api.pathsFromFiles();
  if (!paths.length) return;
  const result = await api.addPaths(view.basketId, paths);
  await reloadHome();
  if (result) setStatus(addStatus(result));
});

// 点击弹窗本身保持主进程的聚焦状态（失焦自动关的定时器会被取消）
document.addEventListener('mousedown', () => {
  api.popupPresent();
});

// ---------------------------------------------------------------- 拖角调尺寸（#3）
//
// 右下角把手：按下记录起点和窗口内容尺寸，移动时按 delta 算新尺寸发给主进程，
// 主进程 setBounds 后触发 resized → 防抖落盘到 popup_width/height，下次打开就用这个大小。

const grip = el('grip');
let gripDrag = null;

grip.addEventListener('pointerdown', (event) => {
  if (!api.resizePopup) return;
  event.preventDefault();
  event.stopPropagation();
  gripDrag = { x: event.clientX, y: event.clientY, w: window.innerWidth, h: window.innerHeight };
  grip.setPointerCapture(event.pointerId);
});
grip.addEventListener('pointermove', (event) => {
  if (!gripDrag) return;
  const w = Math.max(260, gripDrag.w + (event.clientX - gripDrag.x));
  const h = Math.max(200, gripDrag.h + (event.clientY - gripDrag.y));
  api.resizePopup(w, h);
});
const endGrip = (event) => {
  if (!gripDrag) return;
  gripDrag = null;
  try {
    grip.releasePointerCapture(event.pointerId);
  } catch (_) {
    /* 指针已释放 */
  }
};
grip.addEventListener('pointerup', endGrip);
grip.addEventListener('pointercancel', endGrip);

// ---------------------------------------------------------------- 启动

// 铺开一份内容并播"从图标抽出来"的动画。
// 图标已经在载荷里（主进程算好的 dataURL），所以这一帧就是终态、没有待解码的图片。
function showPayload(payload) {
  view = payload;
  homeView = payload;
  iconSize = payload.iconSize || 48;
  // 磨砂模式的窗口底是一整块系统材质，动画得换个做法（见下面的 CSS）
  document.body.classList.toggle('glass', payload.glass === true);
  // 主题（#1）与减弱动画（#7）：主进程把结果塞进载荷，这一帧就用对
  document.body.classList.toggle('reduce-motion', payload.reduceMotion === true);
  // 动画原点落在被点开的 Dock 图标中心
  if (Number.isFinite(payload.originX)) {
    document.documentElement.style.setProperty('--origin-x', payload.originX * 100 + '%');
  }
  // 先回到"收起"态再铺内容：收起态是完全透明的，所以此时窗口里既看不见旧内容、
  // 也看不见新内容，什么时候显示都不会闪。
  document.body.classList.add('collapsed');
  staggerNext = true;   // 这次打开：格子依次进场（#6）
  render();
  // **不能等 requestAnimationFrame 再显示窗口**：隐藏中的窗口 Chromium 不跑 rAF，
  // 复用热窗口时（窗口是隐藏的）会一直等不到回调 —— 表现就是"文件夹打不开"。
  // 所以这里直接显示：新建窗口由主进程等 ready-to-show（页面首帧）把关；
  // 复用窗口里显示的也是"透明的内容"，不会露出旧画面。
  api.popupPresent().then(() => {
    const expand = () => document.body.classList.remove('collapsed');
    requestAnimationFrame(() => requestAnimationFrame(expand));
    // 兜底：窗口刚显示时合成器可能还没开始出帧，别让内容一直缩着不动
    setTimeout(expand, 120);
  });
}

// 主进程要收窗口时先让我们播"收回"动画
if (api.onPopupClosing) api.onPopupClosing(() => document.body.classList.add('collapsed'));
// 弹窗窗口是复用的：新内容从这里送进来（不用重新加载页面，动画从第一帧就顺）
if (api.onPopupData) api.onPopupData((payload) => {
  if (payload) showPayload(payload);
});

(async () => {
  const payload = await api.popupReady();
  if (!payload) {
    // 主进程不认这个窗口（已被顶掉）：直接关闭，别显示一片空白
    await api.popupClose();
    return;
  }
  showPayload(payload);
})();
