'use strict';

// Dock 页面：条目渲染 + Nexus 式悬停放大 + 点击弹跳/回弹 + 拖拽排序 + 拖入落筐 + FLIP 进出场。
// 动画全部由一个会自己停歇的逐帧循环（tick）驱动：静止且鼠标不在 Dock 上就停，省得占着合成器。

const api = window.deskbasket;
const dockEl = document.getElementById('dock');

// 把一个 #rrggbb 主色调亮/调暗，用于文件夹图标的渐变（顶部亮、底部深）
function shade(hex, amount) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return hex;
  const num = parseInt(m[1], 16);
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(((num >> 16) & 255) * amount);
  const g = clamp(((num >> 8) & 255) * amount);
  const b = clamp((num & 255) * amount);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// 文件夹筐图标：按筐的主色画一个 Windows 风格的文件夹（筐没有磁盘路径可问系统要图标）。
// 每个筐颜色不同，Dock 上并排摆着时一眼能分清是谁（#2）。传空就用原来的金色。
function folderIcon(color) {
  const base = color && /^#[0-9a-f]{6}$/i.test(color) ? color : '#e8973a';
  const top = shade(base, 1.18);      // 翻盖高光
  const body1 = base;                 // 正面渐变上端
  const body2 = shade(base, 0.78);    // 正面渐变下端
  const flap = shade(base, 0.9);      // 后翻盖
  const full = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">',
    '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">',
    `<stop offset="0" stop-color="${body1}"/><stop offset="1" stop-color="${body2}"/>`,
    '</linearGradient></defs>',
    `<path d="M4 10a3 3 0 0 1 3-3h11l4 4h16a3 3 0 0 1 3 3v3H4z" fill="${flap}"/>`,
    `<path d="M4 15h37a3 3 0 0 1 3 3l-2 16a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z" fill="url(#g)"/>`,
    `<path d="M4 15h40v2H4z" fill="${top}" opacity="0.5"/>`,
    '</svg>'
  ].join('');
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(full);
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

let iconSize = 48;
let reduceMotion = false;   // 减弱动画开关（#7）：来自设置 reduce_motion
let entries = [];       // { type:'special', id, name } | { type:'basket', id, name, color } | { type:'shortcut', path }
let nodes = [];         // 与 entries 对齐的动画节点

function baseName(target) {
  return String(target).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || target;
}

function stripExt(name) {
  return name.replace(/\.(lnk|url|exe)$/i, '');
}

// 条目对外显示的名字（主进程已经算好：快捷方式是"别名优先，其次文件名去后缀"）
function displayName(entry) {
  if (entry.type === 'shortcut') return entry.name || stripExt(baseName(entry.path));
  return entry.name || '';
}

// 条目的身份：用来判断这次重画里谁是新来的、谁走了、谁只是挪了位置
function keyOf(entry) {
  return entry.type === 'shortcut' ? 'p:' + entry.path : entry.type + ':' + entry.id;
}

// ---------------------------------------------------------------- 渲染

function makeNode(entry) {
  const item = document.createElement('div');
  item.className = 'dock-item';
  // 每条挂一份动画状态，全部由 tick 逐帧积分：
  //   influence 悬停联动 / press 按下回弹 / hopAt 点开时的弹跳 / enter 新条目进场 / dx,dy 位移
  const node = {
    entry,
    el: item,
    key: keyOf(entry),
    influence: 0,
    press: 0,
    pressV: 0,
    pressTarget: 0,
    hopAt: 0,
    enter: 0,
    enterAt: 0,
    dx: 0,
    dy: 0
  };

  const img = document.createElement('img');
  img.alt = '';
  if (entry.type === 'basket') {
    img.src = folderIcon(entry.color);
  } else if (entry.type === 'special') {
    // 此电脑 / 回收站：图标由 shell 按解析名给（带状态，如回收站空/非空）
    api
      .getSpecialIcon(entry.id)
      .then((dataUrl) => {
        img.src = dataUrl || fallbackIcon();
      })
      .catch(() => {
        img.src = fallbackIcon();
      });
  } else {
    api
      .getIcon(entry.path, iconSize)
      .then((dataUrl) => {
        img.src = dataUrl || fallbackIcon();
      })
      .catch(() => {
        img.src = fallbackIcon();
      });
  }
  item.append(img);

  // 图标下面那行小字：只有文件夹筐写名字（其余条目留空，位置保持对齐）
  const caption = document.createElement('div');
  caption.className = 'dock-caption';
  caption.textContent = entry.type === 'basket' ? displayName(entry) : '';
  item.append(caption);
  node.caption = caption;

  // 不画悬停名称气泡（领导要求）：视觉名称只留给无障碍用
  item.setAttribute('aria-label', displayName(entry));

  // 按下压一下、松手弹回来（弹簧在 tick 里积分），点开时再向上跳一下
  item.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    node.pressTarget = 1;
    ensureTick();
  });
  const releasePress = () => {
    node.pressTarget = 0;
  };
  item.addEventListener('pointerup', releasePress);
  item.addEventListener('pointerleave', releasePress);
  item.addEventListener('pointercancel', releasePress);
  item.addEventListener('dragstart', releasePress);

  item.addEventListener('click', () => {
    if (!reduceMotion) {
      node.hopAt = performance.now();
      ensureTick();
    }
    const rect = item.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    if (entry.type === 'basket') {
      api.toggleFolder({ kind: 'basket', id: entry.id }, centerX);
    } else if (entry.type === 'special') {
      api.openSpecial(entry.id).then((result) => {
        if (result && result.ok === false) {
          api.alertMessage('打不开「' + entry.name + '」：\n' + result.error);
        }
      });
    } else {
      api.activateDockItem(entry.path, centerX).then((result) => {
        if (result && result.opened === 'app' && result.ok === false) {
          api.alertMessage('打不开这一项：\n' + entry.path);
        }
      });
    }
  });

  item.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (entry.type === 'basket') {
      window.showContextMenu(
        [
          { key: 'open', label: '打开' },
          { key: 'prune', label: '清理失效项' },
          { separator: true },
          { key: 'rename', label: '改名…' },
          { key: 'delete', label: '删除这个筐' }
        ],
        event
      ).then((picked) => {
        if (!picked) return;
        if (picked === 'open') {
          const rect = item.getBoundingClientRect();
          api.toggleFolder({ kind: 'basket', id: entry.id }, rect.left + rect.width / 2);
        } else if (picked === 'prune') {
          api.pruneMissing(entry.id);
        } else if (picked === 'rename') {
          // 不能在 Dock 里弹输入框：Electron 不支持 window.prompt（调用会抛异常、
          // 渲染进程就像卡死），而且 Dock 窗口本身不可聚焦、收不到键盘。
          // 所以让主进程在图标上方开一个可聚焦的小输入窗。
          const rect = item.getBoundingClientRect();
          api.openRename({
            kind: 'basket',
            id: entry.id,
            anchorX: rect.left + rect.width / 2
          });
        } else if (picked === 'delete') {
          api.deleteBasket(entry.id);
        }
      });
    } else if (entry.type === 'special') {
      window.showContextMenu(
        [
          { key: 'open', label: '打开' },
          { separator: true },
          { key: 'remove', label: '从 Dock 移除' }
        ],
        event
      ).then((picked) => {
        if (picked === 'open') api.openSpecial(entry.id);
        else if (picked === 'remove') api.removeDockSpecial(entry.id);
      });
    } else {
      window.showContextMenu(
        [
          { key: 'open', label: '打开' },
          { key: 'reveal', label: '用系统资源管理器打开所在位置' },
          { separator: true },
          { key: 'rename', label: '改名…' },
          { key: 'remove', label: '从 Dock 移除' }
        ],
        event
      ).then((picked) => {
        if (!picked) return;
        if (picked === 'open') api.openPath(entry.path);
        else if (picked === 'reveal') api.revealPath(entry.path);
        else if (picked === 'rename') {
          // 改的是 Dock 上的显示名（别名），磁盘上的文件名一个字都不动
          const rect = item.getBoundingClientRect();
          api.openRename({
            kind: 'shortcut',
            path: entry.path,
            anchorX: rect.left + rect.width / 2
          });
        } else if (picked === 'remove') api.removeDockItem(entry.path);
      });
    }
  });

  // 拖拽排序（筐固定在最前，只有快捷方式之间可排）
  if (entry.type === 'shortcut') {
    item.draggable = true;
    item.addEventListener('dragstart', (event) => {
      item.classList.add('dragging');
      event.dataTransfer.setData('text/deskbasket-index', String(shortcutIndexOf(entry)));
      event.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));
    item.addEventListener('dragover', (event) => {
      if (event.dataTransfer.types.includes('text/deskbasket-index')) {
        event.preventDefault();
      }
    });
    item.addEventListener('drop', async (event) => {
      const raw = event.dataTransfer.getData('text/deskbasket-index');
      if (raw === '') return;
      event.preventDefault();
      event.stopPropagation();
      const from = Number(raw);
      const to = shortcutIndexOf(entry);
      if (Number.isNaN(from) || from === to) return;
      const paths = entries.filter((e) => e.type === 'shortcut').map((e) => e.path);
      const [moved] = paths.splice(from, 1);
      paths.splice(to, 0, moved);
      await api.reorderDock(paths);
    });
  }

  return node;
}

function shortcutIndexOf(entry) {
  let index = 0;
  for (const item of entries) {
    if (item === entry) return index;
    if (item.type === 'shortcut') index += 1;
  }
  return -1;
}

function render() {
  document.documentElement.style.setProperty('--icon', iconSize + 'px');
  // 空 Dock：一条都没有时显示一行拖拽提示（#4）
  if (!entries.length) {
    dockEl.innerHTML = '';
    nodes = [];
    const hint = document.createElement('div');
    hint.className = 'dock-empty';
    hint.textContent = '把文件或快捷方式拖到这里';
    dockEl.append(hint);
    return;
  }

  // 重画前先记住旧图标的位置和身份，好让这次重画有"来龙去脉"：
  // 新来的淡入放大、走掉的缩小淡出、留下的按位移滑过去（拖拽排序也吃这套）
  const before = new Map();
  for (const node of nodes) {
    before.set(node.key, { el: node.el, rect: node.el.getBoundingClientRect() });
  }

  dockEl.innerHTML = '';
  const firstPaint = before.size === 0;
  nodes = entries.map((entry) => {
    const node = makeNode(entry);
    dockEl.append(node.el);
    return node;
  });
  measureNodes();

  nodes.forEach((node, index) => {
    const old = before.get(node.key);
    if (old) {
      const rect = node.el.getBoundingClientRect();
      node.dx = old.rect.left - rect.left;
      node.dy = old.rect.top - rect.top;
      before.delete(node.key);
      return;
    }
    if (reduceMotion) return;   // 减弱动画：新条目直接到位，不播进场
    // 新条目：从小、淡 → 正常。首次铺满时按顺序错开一点，像依次落位
    node.enter = 1;
    node.enterAt = performance.now() + (firstPaint ? index * 26 : 0);
  });

  // 剩下没被认领的就是这次消失的条目
  for (const old of before.values()) {
    const ghost = old.el.cloneNode(true);
    ghost.classList.add('leaving');
    ghost.classList.remove('dragging');
    // 清掉动画帧留下的内联 transform/opacity，否则它们会盖住 .gone 的缩小淡出
    ghost.style.transform = '';
    ghost.style.opacity = '';
    ghost.style.left = old.rect.left + 'px';
    ghost.style.top = old.rect.top + 'px';
    ghost.style.width = old.rect.width + 'px';
    ghost.style.height = old.rect.height + 'px';
    document.body.append(ghost);
    if (reduceMotion) {
      ghost.remove();
      continue;
    }
    requestAnimationFrame(() => ghost.classList.add('gone'));
    setTimeout(() => ghost.remove(), 260);
  }
  ensureTick();
}

// 测量每个条目的中心点（动画联动按中心距离衰减）
function measureNodes() {
  const base = dockEl.getBoundingClientRect();
  for (const node of nodes) {
    const rect = node.el.getBoundingClientRect();
    node.centerX = rect.left + rect.width / 2 - base.left;
    node.centerY = rect.top + rect.height / 2 - base.top;
  }
}

async function refresh() {
  const state = await api.getState();
  applyRuntimeFlags(state);
  iconSize = state.settings.dock_icon_size || 48;
  // 悬停放大程度由设置决定（百分比 → 比例）
  const magnify = Number(state.settings.dock_magnify);
  boostScale = Math.max(0, (Number.isFinite(magnify) ? magnify : 50) / 100);
  const data = await api.getDockItems();
  entries = [
    // 顺序：系统虚拟项（此电脑/回收站）→ 筐 → 快捷方式
    ...(data.specials || []).map((item) => ({ type: 'special', id: item.id, name: item.label })),
    ...(data.baskets || []).map((basket) => ({ type: 'basket', id: basket.id, name: basket.name, color: basket.color })),
    ...(data.shortcuts || []).map((item) => ({
      type: 'shortcut',
      path: item.path,
      name: item.name
    }))
  ];
  render();
}

// 主题 / 减弱动画：主进程随 state 一起广播，这里同步 body 类名（#1 #7）
function applyRuntimeFlags(state) {
  reduceMotion = Boolean(state.settings.reduce_motion);
  document.body.classList.toggle('reduce-motion', reduceMotion);
}

// ------------------------------------------------ Nexus 式靠近动画
//
// 鼠标附近的图标放大上浮，两侧邻居按余弦衰减依次变小：
//   influence = cos衰减(x) × cos衰减(y)
// x 方向影响半径大（左右联动），y 方向陡（只联动本行）。
// 每帧向目标值缓动，避免生硬跳变。

const BOOST_LIFT = 10;     // 中心最大上浮 10px
const RANGE_X = 2.2;       // x 影响半径 = 图标尺寸 × 2.2
const RANGE_Y = 1.1;       // y 影响半径 = 图标尺寸 × 1.1
const EASE = 0.25;         // 每帧缓动系数

let boostScale = 0.5;      // 中心最大放大比例，由设置 dock_magnify 决定（50 = 放大 50%）

let pointer = null;        // { x, y } 相对 dock 容器；null = 鼠标不在内

dockEl.addEventListener('mousemove', (event) => {
  const base = dockEl.getBoundingClientRect();
  pointer = { x: event.clientX - base.left, y: event.clientY - base.top };
  ensureTick();
});
dockEl.addEventListener('mouseleave', () => {
  pointer = null;
});
window.addEventListener('resize', () => {
  measureNodes();
});

function cosineFalloff(distance, range) {
  if (distance >= range) return 0;
  return 0.5 + 0.5 * Math.cos((Math.PI * distance) / range);
}

// 点击与进场的动画参数
const PRESS_SCALE = 0.16;   // 按住时压到 84%
const HOP_LIFT = 22;        // 点开时向上跳 22px
const HOP_SCALE = 0.10;     // 同时放大 10%
const HOP_MS = 420;         // 一次弹跳的时长
const ENTER_DECAY = 0.84;   // 进场每帧衰减：约 180ms 落位
const SLIDE_DECAY = 0.80;   // 位移每帧衰减：约 200ms 滑到位

let ticking = false;        // 动画循环是否在跑（静止时会停掉，见 tick 末尾）

function tick() {
  const now = performance.now();
  let busy = false;
  for (const node of nodes) {
    // 悬停联动
    let target = 0;
    if (pointer) {
      const dx = Math.abs(pointer.x - node.centerX);
      const dy = Math.abs(pointer.y - node.centerY);
      target = cosineFalloff(dx, iconSize * RANGE_X) * cosineFalloff(dy, iconSize * RANGE_Y);
    }
    node.influence += (target - node.influence) * EASE;
    if (Math.abs(target - node.influence) < 0.002) node.influence = target;

    // 按下回弹：欠阻尼弹簧，松手会自己过冲一下，看着是"弹"回来的
    const pressTarget = node.pressTarget;
    node.pressV = (node.pressV + (pressTarget - node.press) * 0.35) * 0.62;
    node.press += node.pressV;
    if (Math.abs(pressTarget - node.press) < 0.002 && Math.abs(node.pressV) < 0.002) {
      node.press = pressTarget;
      node.pressV = 0;
    }

    // 点开时的一次弹跳（半个正弦波）
    let hop = 0;
    if (node.hopAt) {
      const t = (now - node.hopAt) / HOP_MS;
      if (t >= 1) node.hopAt = 0;
      else hop = Math.sin(Math.PI * t);
    }

    // 新条目进场
    if (node.enter && now >= node.enterAt) {
      node.enter *= ENTER_DECAY;
      if (node.enter < 0.01) node.enter = 0;
    }

    // 位移缓动回 0
    node.dx = Math.abs(node.dx) < 0.4 ? 0 : node.dx * SLIDE_DECAY;
    node.dy = Math.abs(node.dy) < 0.4 ? 0 : node.dy * SLIDE_DECAY;

    const resting =
      !node.influence && !node.press && !hop && !node.enter && !node.dx && !node.dy;
    if (resting) {
      node.el.style.transform = '';
      node.el.style.opacity = '';
      continue;
    }
    busy = true;
    const scale =
      (1 + boostScale * node.influence) *
      (1 - PRESS_SCALE * node.press + HOP_SCALE * hop) *
      (1 - 0.35 * node.enter);
    const lift = BOOST_LIFT * node.influence + HOP_LIFT * hop;
    node.el.style.transform =
      `translate(${node.dx.toFixed(2)}px, ${(-lift + node.dy).toFixed(2)}px) scale(${scale.toFixed(3)})`;
    node.el.style.opacity = node.enter ? (1 - 0.8 * node.enter).toFixed(3) : '';
  }
  // 全部静止且鼠标不在 Dock 上就停掉循环，等下次交互再唤醒。
  // 常驻 60fps 空转会把合成器一直占着，别的动画（弹窗、菜单）容易被挤得一顿一顿。
  if (busy || pointer) {
    requestAnimationFrame(tick);
  } else {
    ticking = false;
  }
}

function ensureTick() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(tick);
}

ensureTick();

// ---------------------------------------------------------------- 拖入
//
// 拖到**文件夹筐**图标上 = 放进那个筐；拖到 Dock 其它地方 = 加到 Dock 上。
// （领导问过"新建文件夹后怎么往里面添加东西"，这是最顺手的那个入口。）

function basketUnderPointer(target) {
  const el = target && target.closest ? target.closest('.dock-item') : null;
  if (!el) return null;
  return nodes.find((node) => node.el === el && node.entry.type === 'basket') || null;
}

function markDropTarget(basket) {
  for (const node of nodes) node.el.classList.toggle('droptarget', node === basket);
}

// 往筐里放完东西后，在名字那一行闪一下「＋N」当作回执
function flashCaption(node, text) {
  if (!node || !node.caption) return;
  const cap = node.caption;
  cap.textContent = text;
  cap.classList.add('flash');
  clearTimeout(node.flashTimer);
  node.flashTimer = setTimeout(() => {
    cap.textContent = displayName(node.entry);
    cap.classList.remove('flash');
  }, 1200);
}

document.addEventListener('dragover', (event) => {
  if (event.dataTransfer.types.includes('text/deskbasket-index')) return;
  event.preventDefault();
  markDropTarget(basketUnderPointer(event.target));
});
document.addEventListener('dragleave', (event) => {
  // 只有真的离开窗口才取消高亮（在条目之间移动也会触发 dragleave）
  if (!event.relatedTarget) markDropTarget(null);
});
document.addEventListener('drop', async (event) => {
  if (event.dataTransfer.types.includes('text/deskbasket-index')) return;
  event.preventDefault();
  const basket = basketUnderPointer(event.target);
  markDropTarget(null);
  const paths = api.pathsFromFiles(event.dataTransfer.files);
  if (!paths.length) return;
  if (!basket) {
    await api.addDockPaths(paths);
    return;
  }
  const result = await api.addPathsToBasket(basket.entry.id, paths);
  if (!result) return;
  flashCaption(basket, '＋' + result.added);
  if (!reduceMotion) {
    basket.hopAt = performance.now();
    ensureTick();
  }
});

// ---------------------------------------------------------------- 状态同步

api.onStateChanged((state) => {
  applyRuntimeFlags(state);
  refresh();
});

refresh();
