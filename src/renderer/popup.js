'use strict';

const api = window.deskbasket;
const el = (id) => document.getElementById(id);

let view = null;       // 当前视图：{ kind, name, path?, parent?, basketId?, view?, entries, error }
let homeView = null;   // 初始视图（从筐导航出去后能回来）
let iconSize = 48;
let selection = new Set();   // 选中的条目路径（筐视图支持多选：Ctrl 点选、Shift 连选、Ctrl+A 全选）
let anchorIndex = -1;        // Shift 连选的起点
let staggerNext = false;   // 下一次 render 要不要给格子做交错进场（只有"打开"那一次要）
let staggerTimer = 0;      // 摘 .stagger 的兜底定时器：等不到格子 animationend 时靠它（U-4）
let focusIndex = -1;       // 键盘光标停在哪个格子（roving tabindex：只有它进 Tab 序列，方向键在它之间挪）
let reorderDrag = null;    // 进行中的拖动换位手势（见底部「弹窗内拖动换位」）
let suppressClick = false; // 拖动换位松手后的那次 click 是"拖完了"，别当选择处理

function currentEntries() {
  return (view && view.entries) || [];
}

function applySelection() {
  for (const node of el('grid').children) {
    const on = selection.has(node.dataset.path);
    node.classList.toggle('selected', on);
    node.setAttribute('aria-selected', on ? 'true' : 'false');   // listbox 的 option 要如实上报选中态（U-2）
  }
}

// roving tabindex（U-2）：整片网格只有一个格子在 Tab 序列里——键盘光标停的那个，
// 其余一律 -1。光标没设过或越界（重绘后条目变少）就落回第一个。
function applyRoving() {
  const cells = el('grid').children;
  if (!cells.length) {
    focusIndex = -1;
    return;
  }
  if (focusIndex < 0 || focusIndex >= cells.length) focusIndex = 0;
  for (let i = 0; i < cells.length; i += 1) cells[i].tabIndex = i === focusIndex ? 0 : -1;
}

function selectSingle(entry, index) {
  selection = new Set([entry.path]);
  anchorIndex = index;
  applySelection();
}

function toggleSelect(entry, index) {
  if (selection.has(entry.path)) selection.delete(entry.path);
  else selection.add(entry.path);
  anchorIndex = index;
  applySelection();
}

function selectRange(fromIndex, toIndex) {
  const [a, b] = fromIndex <= toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];
  selection = new Set(currentEntries().slice(a, b + 1).map((entry) => entry.path));
  applySelection();
}

// 当前操作的对象：选区 ∩ 现有条目（翻页/删除后选区里的死路径自动不算数）
function selectedEntries() {
  return currentEntries().filter((entry) => selection.has(entry.path));
}

// 键盘光标挪到 index：光标、选区（复用 selectSingle 的高亮）、真实焦点三者一次同步（U-2）
function moveCursor(index) {
  const entries = currentEntries();
  if (!entries.length) return;
  const next = Math.max(0, Math.min(entries.length - 1, index));
  focusIndex = next;
  applyRoving();
  selectSingle(entries[next], next);
  const cell = el('grid').children[next];
  if (cell) cell.focus();
}

// 格子按行排布、同一行 offsetTop 相同：数第一行有几个就是列数（↑↓ 一次跳一行，←→ 一格一格走）
function columnCount() {
  const cells = el('grid').children;
  if (cells.length < 2) return 1;
  const top = cells[0].offsetTop;
  let n = 1;
  while (n < cells.length && cells[n].offsetTop === top) n += 1;
  return n;
}

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
  cell.className = 'cell';
  cell.setAttribute('role', 'option');   // 容器 #grid 是 role="listbox"（U-2）
  cell.tabIndex = -1;                    // 基准值：render 收尾的 applyRoving 把键盘光标那格改成 0
  cell.dataset.path = entry.path;
  cell.dataset.index = String(index);
  cell.title = entry.path;
  // 交错进场的节拍：每个格子按序号延后一点（上限 20 格，再多就不至于等太久）
  cell.style.setProperty('--i', Math.min(index, 20));

  const img = document.createElement('img');
  img.draggable = false;   // 图标图片别自己可拖（原生图片拖拽会吃掉换位手势的指针事件）
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

  // 拖出去 = 把真文件作为系统拖拽源（落点收到一份复制，筐里保留——真要移出用右键
  // 「移出到桌面」）；拖进来 = 移动进筐。3.9.0 起还有第三种手势：拖在弹窗**内部**挪
  // 摆放位置（见「弹窗内拖动换位」）。格子**不挂** HTML5 draggable：原生拖拽手势会把
  // 后续指针事件整个吞掉（真机实测），换位和"探出弹窗才发起 OS 拖拽"都靠指针事件做。
  if (view.kind === 'basket') {
    cell.addEventListener('pointerdown', (event) => armReorderDrag(event, entry, cell));
  }

  cell.addEventListener('click', (event) => {
    if (suppressClick) {   // 刚拖着放完手的那一下不是点击
      suppressClick = false;
      return;
    }
    if (event.ctrlKey || event.metaKey) toggleSelect(entry, index);
    else if (event.shiftKey && anchorIndex >= 0) selectRange(anchorIndex, index);
    else selectSingle(entry, index);
    // 鼠标点哪格，键盘光标跟到哪：Tab / 方向键从这一格接着走（U-2）
    focusIndex = index;
    applyRoving();
  });

  cell.addEventListener('dblclick', () => openEntry(entry));

  cell.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    // 右键没在选区里的格子：先把它变成当前选中（Windows 的习惯），操作作用于整个选区
    if (!selection.has(entry.path)) selectSingle(entry, index);
    const items = [
      { key: 'open', label: isDirEntry(entry) ? '打开文件夹' : '打开' },
      { key: 'reveal', label: '在系统资源管理器中显示' }
    ];
    if (view.kind === 'basket') {
      items.push(
        { separator: true },
        { key: 'copy', label: '复制' },
        { key: 'trash', label: '删除（进回收站）' },
        { key: 'rename', label: '重命名' },
        { key: 'moveout', label: '移出到桌面' }
      );
    }
    window.showContextMenu(items, event).then(async (picked) => {
      if (!picked) return;
      if (picked === 'open') {
        if (isDirEntry(entry)) navigate(entry.path, 'forward');
        else api.openPath(entry.path);
      } else if (picked === 'reveal') {
        api.revealPath(entry.path);
      } else if (picked === 'copy') {
        await copySelection();
      } else if (picked === 'trash') {
        await trashSelection();
      } else if (picked === 'rename') {
        startRename(entry, cell);
      } else if (picked === 'moveout') {
        await moveOutSelection();
      }
    });
  });

  return cell;
}

// 打开一条（双击与回车共用这一条路径，U-2）：文件夹往里走一级（翻页动画），文件交给系统打开
async function openEntry(entry) {
  if (isDirEntry(entry)) {
    navigate(entry.path, 'forward');   // 进下一级：新页从右边推进来
  } else {
    const result = await api.openPath(entry.path);
    if (result && result.ok === false) setStatus('打不开：' + entry.name, true);
  }
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

// ------------------------------------------------- 选中项的操作（真文件）
//
// 右键菜单与 Ctrl+C / Ctrl+V / Delete / F2 都走这里。操作对象是"选区 ∩ 现有条目"，
// 所以翻页、自动清理之后选区里残留的死路径不会误伤。

function opTargets() {
  if (!view || view.kind !== 'basket') return [];
  const list = selectedEntries();
  if (!list.length) setStatus('先选中要操作的条目', true);
  return list;
}

async function copySelection() {
  const list = opTargets();
  if (!list.length) return;
  const result = await api.copyToClipboard(list.map((entry) => entry.path));
  if (result.ok) setStatus('已复制 ' + list.length + ' 项（去资源管理器 Ctrl+V 可粘贴出来）');
  else setStatus('复制失败：' + result.error, true);
}

async function pasteClipboard() {
  if (!view || view.kind !== 'basket') return;
  setStatus('粘贴中…');
  const result = await api.pasteFromClipboard(view.basketId);
  await reloadHome();
  if (result && result.error) {
    setStatus('粘贴失败：' + result.error, true);
    return;
  }
  if (!result || !result.added) {
    setStatus('剪贴板里没有可粘贴的文件', true);
    return;
  }
  const how = result.moved ? '（剪切来的已移入）' : '（复制了一份）';
  setStatus('已粘贴 ' + result.added + ' 项' + how + '，筐里共 ' + result.total + ' 项');
}

async function trashSelection() {
  const list = opTargets();
  if (!list.length) return;
  const names = list.map((entry) => entry.name);
  const result = await api.trashItems(view.basketId, list.map((entry) => entry.path));
  await reloadHome();
  if (result.failed && result.failed.length) {
    setStatus('有 ' + result.failed.length + ' 项没能删：' + result.failed[0].reason, true);
    return;
  }
  setStatus('已删除（进回收站，可恢复）：' + names.slice(0, 3).join('、') + (names.length > 3 ? ' 等' : ''));
}

async function moveOutSelection() {
  const list = opTargets();
  if (!list.length) return;
  const result = await api.moveOutItems(view.basketId, list.map((entry) => entry.path));
  await reloadHome();
  const ok = (result.results || []).filter((r) => r.ok);
  const bad = (result.results || []).filter((r) => !r.ok);
  if (!ok.length) {
    setStatus('没能移出：' + ((bad[0] && bad[0].error) || '未知原因'), true);
    return;
  }
  setStatus('已移出到桌面 ' + ok.length + ' 项' + (bad.length ? '；' + bad.length + ' 项失败' : '') + '，筐里共 ' + result.total + ' 项');
}

// 行内改名：把格子上的名字换成输入框，Enter 提交、Esc 取消（改的是筐目录里的真文件名）
function startRename(entry, cell) {
  // 右键菜单开着的那几秒里视图可能自动重画过：挂到脱节格子上的输入框用户看不见
  if (!cell.isConnected) {
    reloadHome();
    return;
  }
  if (cell.querySelector('input')) return;
  // **先把弹窗拿到前台，再挂输入框**：右键菜单是另一个小窗口，菜单关掉后焦点还在它身上；
  // 顺序反过来（先挂输入框再去抢焦点）时，"窗口刚拿到焦点"这一下会让刚挂上的输入框瞬间失焦，
  // 而失焦被当成"用户放弃"——改名就这么无声无息地没了。这就是"重命名失效"的真凶。
  const focused = api.popupFocus ? api.popupFocus().catch(() => false) : Promise.resolve(false);
  focused.then(() => attachRenameEditor(entry, cell));
}

const RENAME_GRACE_MS = 500;   // 刚打开这几百毫秒里的失焦不算"放弃"（窗口正在做前后台切换）

function attachRenameEditor(entry, cell) {
  const nameEl = cell.querySelector('.name');
  if (!nameEl || cell.querySelector('input')) return;
  const editor = document.createElement('input');
  editor.value = entry.name;
  editor.className = 'rename-editor';
  editor.setAttribute('spellcheck', 'false');
  nameEl.replaceWith(editor);
  const openedAt = Date.now();
  let settled = false;
  const finish = async (commit) => {
    if (settled) return;
    settled = true;
    const value = editor.value.trim();
    if (commit && value && value !== entry.name) {
      const result = await api.renameItem(view.basketId, entry.path, value);
      await reloadHome();   // 成败都先把格子刷新；render 会用"N 项"盖掉状态行，提示要放在重画之后
      if (result && result.ok) {
        setStatus('已改名为 ' + baseName(result.path));
        return;
      }
      setStatus('改名失败：' + ((result && result.error) || '未知原因'), true);
      return;
    }
    await reloadHome();   // 取消：把格子画回去
  };
  editor.addEventListener('keydown', (event) => {
    // 输入框里的事件不再往下传（全局快捷键不该在改名时触发）
    event.stopPropagation();
    // 中文输入法组词期间 Enter 是"确认候选"，不是"提交改名"
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') finish(true);
    else if (event.key === 'Escape') finish(false);
  });
  editor.addEventListener('blur', () => {
    const elapsed = Date.now() - openedAt;
    // 刚打开这一下：窗口正在前后台切换，不是用户放弃——把焦点抢回来，别把改名判死
    if (!settled && elapsed < RENAME_GRACE_MS) {
      editor.focus();
      return;
    }
    finish(false);
  });
  editor.focus();
  editor.select();
}

// 弹窗开着时，资源管理器那边删掉/改名/加进来的，2 秒内跟上：取一次筐视图，变了就重画。
// 主进程取视图时会顺手清掉"文件已不在"的登记。只在筐首页且窗口可见时轮询。
setInterval(async () => {
  if (!view || view.kind !== 'basket' || view !== homeView) return;
  if (document.querySelector('input.rename-editor')) return;   // 正在改名，别打断
  if (reorderDrag) return;                                     // 正在拖动换位，别把拖着的格子换掉
  if (document.visibilityState !== 'visible') return;          // 窗口藏着就不白问
  try {
    const fresh = await api.basketGet(view.basketId);
    if (!fresh) return;
    const paths = (a) => JSON.stringify((a.entries || []).map((entry) => entry.path));
    // 比对里加上 name：别处（设置面板）改了筐名，2 秒内标题与「⌂ 筐名」跟着刷新（C-1）。
    // 仍在原来这一次请求里比，不新增轮询，叠不出请求循环。
    if (fresh.name !== view.name || paths(view) !== paths(fresh)) {
      view = fresh;
      homeView = fresh;
      render();
    }
  } catch (_) {
    /* 取不到就这一拍不刷 */
  }
}, 2000);

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
  // 上一轮的交错先摘干净再重建（U-4）：空筐 0 格等不到 animationend，交错播完前重绘
  // 也会把挂着 listener 的最后一个格子换掉——不摘的话 .stagger 永驻，本次打开内每次
  // 重绘（加文件/改名/2s 轮询/翻目录）都会永久重播整屏交错进场。
  clearTimeout(staggerTimer);
  staggerTimer = 0;
  grid.classList.remove('stagger');
  grid.innerHTML = '';

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
    // 兜底摘除：0 格时没有 last、重绘也会把 last 换掉，等不到 animationend 就靠这个。
    // 覆盖最长延迟（上限 20 × 16ms = 320ms）+ 时长（200ms）= 520ms，再多留点掉帧余量。
    staggerTimer = setTimeout(() => {
      grid.classList.remove('stagger');
      staggerTimer = 0;
    }, 600);
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
  applySelection();
  applyRoving();   // 格子刚重建完：把 roving tabindex 重新落到键盘光标那一格上（U-2）
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
  // 文件对话框里点了「取消」（主进程返回 canceled:true，形状其余不变）：没东西要刷，提一句就行（C-2）。
  // 主进程还没带上 canceled 时这个分支自然不触发，落到下面的「没有新增」，属正常降级。
  if (result.canceled) {
    setStatus('已取消添加');
    return;
  }
  if (!result.added && !(result.failed || []).length) {
    setStatus('没有新增（已在这个筐里的会跳过）');
    return;
  }
  await reloadHome();
  setStatus(addStatus(result));
});
el('btnClose').addEventListener('click', () => api.popupClose());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    api.popupClose();
    return;
  }
  // 正在改名时事件不往下走（startRename 里已经 stopPropagation，这里是双保险）
  if (event.target && event.target.tagName === 'INPUT') return;

  // 方向键 / Home / End 移动选区、Enter 打开（listbox 的键盘语义，U-2）。
  // 放在「只认筐视图」的早退之前：文件夹视图同样要能键盘走进子目录。
  if (
    event.key === 'ArrowLeft' || event.key === 'ArrowRight' ||
    event.key === 'ArrowUp' || event.key === 'ArrowDown' ||
    event.key === 'Home' || event.key === 'End'
  ) {
    const entries = currentEntries();
    if (!entries.length) return;
    event.preventDefault();
    const cols = columnCount();          // ↑↓ 一次跳一行，←→ 一格一格走
    const cursor = focusIndex < 0 ? 0 : focusIndex;
    let next = cursor;
    if (event.key === 'ArrowLeft') next = cursor - 1;
    else if (event.key === 'ArrowRight') next = cursor + 1;
    else if (event.key === 'ArrowUp') next = cursor - cols;
    else if (event.key === 'ArrowDown') next = cursor + cols;
    else if (event.key === 'Home') next = 0;
    else next = entries.length - 1;      // End
    moveCursor(next);                    // 越界在 moveCursor 里统一钳到 [0, len-1]
    return;
  }
  if (event.key === 'Enter') {
    // 焦点停在头部按钮上时交给按钮自己原生激活，别再叠一次「打开」
    if (event.target && event.target.tagName === 'BUTTON') return;
    const entries = currentEntries();
    if (!entries.length) return;
    event.preventDefault();
    // 单选开选中那个；多选（或还没选）开键盘光标停着的那格——都是双击走的那条路径
    const picked = selectedEntries();
    const target = picked.length === 1 ? picked[0] : entries[focusIndex < 0 ? 0 : focusIndex];
    if (target) openEntry(target);
    return;
  }

  if (!view || view.kind !== 'basket') return;
  const mod = event.ctrlKey || event.metaKey;
  if (mod && (event.key === 'c' || event.key === 'C')) {
    event.preventDefault();
    copySelection();
  } else if (mod && (event.key === 'v' || event.key === 'V')) {
    event.preventDefault();
    pasteClipboard();
  } else if (mod && (event.key === 'a' || event.key === 'A')) {
    event.preventDefault();
    selection = new Set(currentEntries().map((entry) => entry.path));
    applySelection();
  } else if (event.key === 'Delete') {
    event.preventDefault();
    trashSelection();
  } else if (event.key === 'F2') {
    event.preventDefault();
    const list = selectedEntries();
    if (list.length !== 1) {
      setStatus('先选中一个要改名的条目', true);
      return;
    }
    const index = currentEntries().findIndex((entry) => entry.path === list[0].path);
    const cell = el('grid').children[index];
    if (cell) startRename(list[0], cell);
  }
});

// ------------------------------------------------- 弹窗内拖动换位（3.9.0）
//
// 指针手势：按住格子挪动，弹窗内实时画插入线，松手就把该条目重排到落点（走
// basket:reorder，只改 basket.items 的登记顺序——显示顺序就是清单顺序，磁盘不动）。
// 手势中途把指针拖出弹窗 = 老语义「拖出去复制一份」：在探出边框那一刻把 OS 拖拽
// （basket:item-drag → startDrag）从当前位置接手过去，弹窗内的换位就地作废。
// 不借 OS 拖拽做弹窗内换位的原因：startDrag 的回环（拖回自己的窗口）实测不给页面
// dragover/drop 事件（拖拽影子和 tooltip 都正常，页面却全程蒙在鼓里），指针事件才是稳的。

const REORDER_START_PX = 6;   // 挪过这个距离才算"在拖"：单击选中的手感不受影响

function clearReorderHint() {
  for (const cell of el('grid').children) cell.classList.remove('drop-before', 'drop-after');
}

// 在第 index 个格子前画一条插入线；index 等于条目数（追加到最后）就画在末格右缘
function showReorderHint(index) {
  clearReorderHint();
  const cells = el('grid').children;
  if (index >= 0 && index < cells.length) cells[index].classList.add('drop-before');
  else if (cells.length) cells[cells.length - 1].classList.add('drop-after');
}

function clearReorderDrag() {
  if (reorderDrag) {
    try {
      reorderDrag.cell.releasePointerCapture(reorderDrag.pointerId);
    } catch (_) {
      /* 指针早释放了/格子已重建 */
    }
  }
  reorderDrag = null;
  clearReorderHint();
  for (const cell of el('grid').children) cell.classList.remove('dragging-source');
}

// 按下（左键、不带 Ctrl/Shift）：登记一场可能的换位手势，指针捕获到这格上，
// 之后就算指针滑出格子/窗口，move/up 也照样送到这里
function armReorderDrag(event, entry, cell) {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (!view || view.kind !== 'basket') return;
  clearReorderDrag();
  reorderDrag = {
    entry,
    cell,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    active: false,   // 过了位移阈值、真在拖
    handedOff: false, // 已交给 OS 拖拽（拖出弹窗）
    slot: -1
  };
  try {
    cell.setPointerCapture(event.pointerId);
  } catch (_) {
    /* 拿不到捕获就只在格子上拖，出了格子松手算取消 */
  }
}

function reorderDragMove(event) {
  const drag = reorderDrag;
  if (!drag || drag.handedOff) return;
  if (!drag.active) {
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < REORDER_START_PX) return;
    drag.active = true;
    drag.cell.classList.add('dragging-source');
  }
  // 探出弹窗客户区 = 用户要拖出去：换位作废，OS 拖拽从当前光标位置接手
  if (
    event.clientX < 0 || event.clientY < 0 ||
    event.clientX >= window.innerWidth || event.clientY >= window.innerHeight
  ) {
    drag.handedOff = true;
    clearReorderHint();
    drag.cell.classList.remove('dragging-source');
    api.startItemDrag(drag.entry.path);
    return;
  }
  // 指针落在网格上时算插入位：0..条目数（「插到第几个格子前面」）。按行主序逐格问
  // 「这格是不是已经被指针越过了」——指针整格在它下方、或与它同行但越过了它的中线。
  // 第一个还没被越过的格子就是插入点；全部越过（网格底部留白）就是追加到末尾。
  // 注意同行必须看左右半边：只看竖直中线的话，同一行里中线以上的横向拖动永远算出 0。
  const grid = el('grid');
  const rect = grid.getBoundingClientRect();
  const inside =
    event.clientX >= rect.left && event.clientX <= rect.right &&
    event.clientY >= rect.top && event.clientY <= rect.bottom;
  let slot = grid.children.length;
  if (inside) {
    for (let i = 0; i < grid.children.length; i += 1) {
      const box = grid.children[i].getBoundingClientRect();
      const passed =
        event.clientY > box.bottom ||
        (event.clientY >= box.top && event.clientX > box.left + box.width / 2);
      if (!passed) { slot = i; break; }
    }
  } else if (event.clientY < rect.top) {
    slot = 0;
  }
  drag.slot = slot;
  showReorderHint(slot);
  // 拖到网格上下边缘附近自动滚（条目多到出了滚动条才用得上）；move 帧率触发，步子给小
  const edge = 28;
  if (event.clientY < rect.top + edge) grid.scrollTop -= 9;
  else if (event.clientY > rect.bottom - edge) grid.scrollTop += 9;
}

async function reorderDragEnd(event) {
  const drag = reorderDrag;
  if (!drag) return;
  const { cell, entry, active, handedOff, slot } = drag;
  clearReorderDrag();
  if (!active || handedOff || !cell.isConnected) return;
  suppressClick = true;   // 拖过的手势，松手那一下别把落点格子选中
  if (!view || view.kind !== 'basket' || !Number.isInteger(slot) || slot < 0) return;
  const from = currentEntries().findIndex((item) => item.path === entry.path);
  // 落回原位（含「落在自己紧后面」）就不动，省一次重画
  if (from < 0 || slot === from || slot === from + 1) return;
  const fresh = await api.reorderBasket(view.basketId, entry.path, slot);
  if (fresh && fresh.kind === 'basket') {
    view = fresh;
    homeView = fresh;
    render();
  }
}

// move/up 挂 document 捕获阶段：指针落到哪格、甚至滑出窗口（捕获在手时）都收得到，
// 不赌"事件一定路由回按下的那格"。state 判重入：一次手势只有一份。
document.addEventListener('pointermove', (event) => {
  if (reorderDrag && !reorderDrag.handedOff) reorderDragMove(event);
}, true);
document.addEventListener('pointerup', (event) => {
  if (reorderDrag) reorderDragEnd(event);
}, true);
document.addEventListener('pointercancel', () => {
  if (reorderDrag) clearReorderDrag();
}, true);

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
  selection = new Set();
  anchorIndex = -1;
  reorderDrag = null;   // 新内容把格子整个换掉了：上一场手势就算它结束了
  suppressClick = false;
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
