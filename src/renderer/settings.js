'use strict';

const api = window.deskbasket;
const ACCENT_LABELS = {
  acrylic: '磨砂玻璃（Win11 系统材质，推荐）',
  blur: '轻量模糊',
  off: '完全透明（不磨砂）'
};
const THEME_LABELS = {
  auto: '自动（按桌面壁纸亮度切换）',
  dark: '深色（浅色字，适合深色壁纸/磨砂）',
  light: '浅色（深色字，适合浅色壁纸）'
};

let settings = null;
let displays = [];         // 主进程随 state 广播的显示器列表（#9）
let selectedBasketId = null;
let loading = true;
// 天气快照（主进程随 weather:changed 推）：设置面板里显示"哪个城市、现在几度、什么时候更新的"
let weatherState = null;

// 系统虚拟项的固定顺序：Dock 上就是这个次序（此电脑 → 回收站 → 天气）
const SPECIAL_ORDER = [
  ['windows', 'specialWindows'],
  ['thispc', 'specialThisPc'],
  ['recyclebin', 'specialRecycle'],
  ['weather', 'specialWeather']
];

const el = (id) => document.getElementById(id);

// 正在输入的框不被 render 回写：state:changed 由**任何**窗口触发都会走到这里，
// 用户还打到一半时把值刷回存储值会直接丢输入（城市 / 收录来源目录 / 筐的文件目录三个文本框）
function setUnfocused(id, value) {
  const input = el(id);
  if (document.activeElement === input) return;   // 焦点在它自己身上：保持用户输入
  input.value = value;
}

function flash(text) {
  el('hint').textContent = text;
}

function renderBaskets() {
  const host = el('basketList');
  host.innerHTML = '';
  for (const basket of settings.baskets) {
    const row = document.createElement('div');
    row.className = 'basket-row' + (basket.id === selectedBasketId ? ' selected' : '');
    // 筐主色的圆点：和 Dock 上那个文件夹图标同色，设置里能一眼对上（#2）
    if (basket.color) {
      const dot = document.createElement('span');
      dot.className = 'basket-swatch';
      dot.style.background = basket.color;
      row.append(dot);
    }
    const label = document.createElement('span');
    label.textContent =
      basket.name + '（' + basket.items.length + ' 项）' + (basket.visible === false ? ' · 已隐藏' : '');
    row.append(label);
    row.addEventListener('click', () => {
      selectedBasketId = basket.id;
      renderBaskets();
      el('basketName').value = basket.name;
    });
    host.append(row);
  }
  if (!settings.baskets.length) {
    host.textContent = '还没有文件夹，点「新建文件夹」建一个';
  }
  if (!selectedBasketId && settings.baskets.length) {
    selectedBasketId = settings.baskets[0].id;
    el('basketName').value = settings.baskets[0].name;
  }
  renderBasketCandidates();
}

// 桌面条目的勾选清单：一次能勾一堆，不用反复开文件对话框。
// 图标走 api.getIcon（与 Dock / 弹窗同一条链路：.lnk 由 shell 给不带小箭头的原图）。
// 「数据变了才重建」：快照没变就不动 DOM——正在勾的复选框不会被别的窗口触发的 render 刷掉焦点。
let lastBasketKey = null;
async function renderBasketCandidates() {
  const host = el('basketCandidateList');
  if (!selectedBasketId) {
    if (lastBasketKey !== 'none') {
      lastBasketKey = 'none';
      host.innerHTML = '';
      host.textContent = '先在上面选一个文件夹';
    }
    return;
  }
  let rows = [];
  try {
    rows = await api.basketCandidates(selectedBasketId);
  } catch (_) {
    rows = [];
  }
  // 快照带上筐 id：换了筐即使行数据碰巧一样也要重画
  const key = selectedBasketId + ' ' + JSON.stringify(rows);
  if (key === lastBasketKey) return;   // 数据没变：清单保持原样（焦点、滚动都还在）
  lastBasketKey = key;
  host.innerHTML = '';
  if (!rows.length) {
    host.textContent = '来源目录里没有条目';
    return;
  }
  for (const row of rows) {
    const line = document.createElement('label');
    line.className = 'shortcut-row';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = row.inBasket;
    box.addEventListener('change', async () => {
      // 移出时用筐里那一份的实际路径（文件搬进筐目录后路径就变了）
      if (box.checked) await api.addPaths(selectedBasketId, [row.path]);
      else await api.removeItem(selectedBasketId, row.itemPath || row.path);
      flash((box.checked ? '已加进筐：' : '已移出筐：') + row.name.replace(/\.(lnk|url)$/i, ''));
      // 刷新面板（筐的计数、Dock 上的名字）
      await refresh();
    });

    const icon = document.createElement('img');
    icon.alt = '';
    api.getIcon(row.path, 24).then((url) => {
      if (url) icon.src = url;
    });

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = row.name.replace(/\.(lnk|url)$/i, '');

    const state = document.createElement('span');
    state.className = 'state';
    state.textContent = row.inBasket ? '在这个筐里' : '';

    line.append(box, icon, name, state);
    host.append(line);
  }
}

function render() {
  loading = true;
  el('accent').innerHTML = '';
  for (const [key, label] of Object.entries(ACCENT_LABELS)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = label;
    el('accent').append(option);
  }
  el('accent').value = settings.accent_mode;
  el('iconSize').value = settings.icon_size;
  el('dockEnabled').checked = settings.dock_enabled;
  el('dockAlways').checked = !settings.dock_auto_hide;
  el('dockIconSize').value = settings.dock_icon_size;
  el('dockMagnify').value = settings.dock_magnify;
  el('dockBottomGap').value = settings.dock_bottom_gap;
  setUnfocused('sourceDir', settings.shortcuts_dir || '');
  setUnfocused('basketDir', settings.basket_dir || '');
  el('dockCount').textContent =
    'Dock 现有 ' + settings.dock_items.length + ' 个快捷方式 ＋ ' +
    (settings.dock_specials || []).length + ' 个系统图标（开始菜单/此电脑/回收站/天气）＋ ' +
    settings.baskets.filter((b) => b.visible !== false).length + ' 个文件夹' +
    '；自动收录来源目录里的 .lnk / .url / .exe，也可直接拖进去';
  renderTheme();
  renderDockDisplay();
  renderSpecials();
  renderWeather();
  el('reduceMotion').checked = Boolean(settings.reduce_motion);
  renderBaskets();
  renderShortcuts();
  loading = false;
  // 托盘菜单改「开机自启动」后 persist 也会广播 state:changed：并进这条 render 路径顺带刷新
  // 自启状态（fire-and-forget，初始化同样经 render()，不用再单独调一次）
  refreshAutostart();
}

// Dock 上的系统图标（此电脑 / 回收站 / 天气）：勾上就摆到 Dock 上，取消就撤下来
function renderSpecials() {
  const on = new Set(settings.dock_specials || []);
  for (const [id, boxId] of SPECIAL_ORDER) el(boxId).checked = on.has(id);
}

function specialsFromBoxes() {
  return SPECIAL_ORDER.filter(([, boxId]) => el(boxId).checked).map(([id]) => id);
}

// 天气那一块：城市输入框 ＋ 一行状态（解析到的城市、现在几度、什么时候更新的）
function renderWeather() {
  setUnfocused('weatherCity', settings.weather_city || '');
  const state = weatherState;
  let text;
  if (!state || !state.current) {
    text = state && state.error ? '取天气失败：' + state.error : '天气读取中…';
  } else {
    const place = (state.place && state.place.label) || state.city;
    const when = new Date(state.updatedAt);
    const pad = (n) => String(n).padStart(2, '0');
    text =
      place + (state.auto ? '（自动定位）' : '') +
      '　现在 ' + Math.round(state.current.temperature) + '° ' + state.current.text +
      '　（' + pad(when.getHours()) + ':' + pad(when.getMinutes()) + ' 更新）';
    if (state.ok === false && state.error) text += '　上次刷新失败，显示的是旧数据';
  }
  // 系统里没有「天气」应用（被卸载/精简系统）：点图标会退到网页版，这里先说清楚
  if (state && state.installed === false) text += '　· 没找到系统「天气」应用，点图标会打开网页版';
  el('weatherInfo').textContent = text;
}

// 主题（#1）：配色深浅；auto 由主进程按壁纸亮度解析
function renderTheme() {
  const host = el('themeMode');
  host.innerHTML = '';
  for (const [key, label] of Object.entries(THEME_LABELS)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = label;
    host.append(option);
  }
  host.value = settings.theme_mode || 'auto';
}

// Dock 在哪块屏（#9）：主显示器 / 跟随鼠标 / 逐台列出（>1 块屏才有意义）
function renderDockDisplay() {
  const host = el('dockDisplay');
  host.innerHTML = '';
  const addOption = (value, label) => {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = label;
    host.append(option);
  };
  addOption('primary', '主显示器');
  addOption('mouse', '跟随鼠标所在屏');
  for (const display of displays) {
    if (display.primary) continue;
    addOption(display.index, `显示器 ${display.index + 1}（${display.label}）`);
  }
  const current = settings.dock_display;
  const match = [...host.options].find((option) => option.value === String(current));
  host.value = match ? String(current) : 'primary';
  host.disabled = displays.length <= 1 && current === 'primary';   // 单屏时没的选，灰掉别误导
}

// 快捷方式候选清单：桌面上可收录的条目，勾选＝加入 Dock、取消＝移除。
// 图标走 api.getIcon（和 Dock 同一条链路：.lnk 由 shell 给原图，不带 Windows 小箭头）。
// 与筐候选清单同理：快照（行数据＋别名）没变就不重建 DOM，保住正在勾的复选框的焦点。
let lastShortcutKey = null;
async function renderShortcuts() {
  const host = el('shortcutList');
  let rows = [];
  try {
    rows = await api.dockCandidates();
  } catch (_) {
    rows = [];
  }
  // 行里没有别名，改名后行数据不变但显示名要变——所以把 dock_aliases 也编进快照
  const key = JSON.stringify(rows) + ' ' + JSON.stringify(settings.dock_aliases || {});
  if (key === lastShortcutKey) return;   // 数据没变：清单保持原样（焦点、滚动都还在）
  lastShortcutKey = key;
  host.innerHTML = '';
  if (!rows.length) {
    host.textContent = '来源目录里没有可收录的 .lnk / .url / .exe';
    return;
  }
  for (const row of rows) {
    const line = document.createElement('label');
    line.className = 'shortcut-row';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = row.onDock;
    box.addEventListener('change', async () => {
      if (box.checked) await api.addDockPaths([row.path]);
      else await api.removeDockItem(row.path);
      flash((box.checked ? '已加入 Dock：' : '已从 Dock 移除：') + row.name);
      await renderShortcuts();
    });

    const icon = document.createElement('img');
    icon.alt = '';
    api.getIcon(row.path, 24).then((url) => {
      if (url) icon.src = url;
    });

    const name = document.createElement('span');
    name.className = 'name';
    const alias = (settings.dock_aliases || {})[row.path] || '';
    const fileLabel = row.name.replace(/\.(lnk|url)$/i, '');
    name.textContent = alias || fileLabel;
    if (alias) name.title = fileLabel + '（显示名：' + alias + '）';

    const state = document.createElement('span');
    state.className = 'state';
    state.textContent = row.onDock ? '在 Dock 上' : '';

    line.append(box, icon, name);

    // 在 Dock 上的条目才能改名：改的是显示名（别名），磁盘上的文件名一个字都不动
    if (row.onDock) {
      const rename = document.createElement('button');
      rename.className = 'btn';
      rename.type = 'button';
      rename.textContent = '改名';
      rename.addEventListener('click', (event) => {
        // 这行是个 <label>：不拦下来，点「改名」会连带把复选框也切换了
        event.preventDefault();
        event.stopPropagation();
        api.openRename({ kind: 'shortcut', path: row.path });
      });
      line.append(rename);
    }

    line.append(state);
    host.append(line);
  }
}

async function push(patch, message) {
  if (loading) return;
  settings = await api.updateSettings(patch);
  render();
  if (message) flash(message);
}

el('accent').addEventListener('change', (event) => {
  push({ accent_mode: event.target.value }, '磨砂模式已切换');
});
el('themeMode').addEventListener('change', (event) => {
  push({ theme_mode: event.target.value }, '配色主题已切换');
});
el('reduceMotion').addEventListener('change', (event) => {
  push({ reduce_motion: event.target.checked }, event.target.checked ? '已减弱动画' : '动画已恢复');
});
el('dockDisplay').addEventListener('change', (event) => {
  const raw = event.target.value;
  const value = raw === 'primary' || raw === 'mouse' ? raw : Number(raw);
  push({ dock_display: value }, 'Dock 已换到所选显示器');
});
el('iconSize').addEventListener('change', (event) => {
  push({ icon_size: Number(event.target.value) }, '文件夹弹窗图标大小已更新');
});
el('dockEnabled').addEventListener('change', (event) => {
  push({ dock_enabled: event.target.checked }, event.target.checked ? 'Dock 已显示' : 'Dock 已隐藏');
});
el('dockIconSize').addEventListener('change', (event) => {
  push({ dock_icon_size: Number(event.target.value) }, 'Dock 图标大小已更新');
});
el('dockAlways').addEventListener('change', (event) => {
  push(
    { dock_auto_hide: !event.target.checked },
    event.target.checked ? 'Dock 改为常驻显示' : 'Dock 改为自动收起'
  );
});
el('dockMagnify').addEventListener('change', (event) => {
  push({ dock_magnify: Number(event.target.value) }, '悬停放大程度已更新');
});
el('dockBottomGap').addEventListener('change', (event) => {
  push({ dock_bottom_gap: Number(event.target.value) }, 'Dock 离底边的距离已更新');
});

// 系统图标（此电脑 / 回收站 / 天气）：整份列表交回主进程（顺序固定，天气总在回收站旁边）
for (const [, boxId] of SPECIAL_ORDER) {
  el(boxId).addEventListener('change', () => {
    push({ dock_specials: specialsFromBoxes() }, 'Dock 上的系统图标已更新');
  });
}

// 天气城市：回车/失焦时提交；主进程收到就重新地理编码并立刻取一次天气
el('weatherCity').addEventListener('change', async (event) => {
  await push({ weather_city: String(event.target.value || '').trim() }, '城市已更新，正在取天气…');
  // 自己这次提交的回写要立刻看得见：render 里 setUnfocused 会跳过仍持有焦点的本框（去空格等归一化结果）
  el('weatherCity').value = settings.weather_city || '';
});
el('btnWeatherRefresh').addEventListener('click', async () => {
  weatherState = await api.refreshWeather();
  renderWeather();
  flash('天气已刷新');
});

// 收录来源目录：手输（change 在失焦/回车时触发）与「浏览…」「用回桌面」殊途同归。
// push 里会 render()——但渲染层的回写会跳过仍持有焦点的输入框（见 setUnfocused，
// 防别的窗口的 state:changed 刷掉正在打的字），所以这里提交完自己同步一次：
// 非法路径被主进程回退成系统桌面时，输入框照样看得见回退结果。
async function applySourceDir(raw) {
  await push({ shortcuts_dir: raw });
  el('sourceDir').value = settings.shortcuts_dir || '';
  if (raw && !settings.shortcuts_dir) flash('这个路径无效（需要绝对路径），已回退系统桌面');
  else if (settings.shortcuts_dir) flash('收录来源已切换，自动收录现在看：' + settings.shortcuts_dir);
  else flash('已改回系统桌面');
}

el('sourceDir').addEventListener('change', (event) => {
  applySourceDir(String(event.target.value || '').trim());
});
el('btnPickDir').addEventListener('click', async () => {
  const picked = await api.pickSourceDir();
  if (!picked) return;
  await applySourceDir(picked);
});
el('btnUseDesktop').addEventListener('click', () => applySourceDir(''));

// 筐的文件目录：只影响之后新建的筐（老筐的目录已经建好了，不去搬它，免得把文件挪来挪去）
el('basketDir').addEventListener('change', async (event) => {
  const raw = String(event.target.value || '').trim();
  await push({ basket_dir: raw });
  // 同 applySourceDir：本框还持有焦点，render 不回写，这里自己同步归一化结果
  el('basketDir').value = settings.basket_dir || '';
  if (raw && !settings.basket_dir) flash('这个路径无效（需要绝对路径），已回退默认目录');
  else flash('筐的文件目录已改成：' + settings.basket_dir);
});
el('btnPickBasketDir').addEventListener('click', async () => {
  const picked = await api.pickSourceDir('baskets');
  if (!picked) return;
  await push({ basket_dir: picked });
  el('basketDir').value = settings.basket_dir || '';
  flash('筐的文件目录已改成：' + settings.basket_dir);
});

el('btnPick').addEventListener('click', async () => {
  const items = await api.pickDockFiles();
  flash('已加入 Dock，现有 ' + items.length + ' 个快捷方式');
  await refresh();
});

el('basketName').addEventListener('change', async (event) => {
  const basket = settings.baskets.find((item) => item.id === selectedBasketId);
  if (!basket) return;
  const trimmed = event.target.value.trim().slice(0, 24);
  if (!trimmed || trimmed === basket.name) {
    event.target.value = basket.name;
    return;
  }
  await api.updateBasket({ id: basket.id, name: trimmed });
  await refresh();
  flash('已改名');
});

el('btnVisible').addEventListener('click', async () => {
  const basket = settings.baskets.find((item) => item.id === selectedBasketId);
  if (!basket) return;
  const merged = { id: basket.id, visible: basket.visible === false };
  await api.updateBasket(merged);
  await refresh();
  flash(merged.visible ? '这个文件夹已显示在 Dock 上' : '这个文件夹已从 Dock 隐藏');
});

el('btnAddFiles').addEventListener('click', () => addToBasket('files'));
el('btnAddDirs').addEventListener('click', () => addToBasket('dirs'));

async function addToBasket(mode) {
  if (!selectedBasketId) return;
  const result = await api.pickBasketFiles(selectedBasketId, mode);
  if (!result) return;
  // 对话框里点了「取消」：主进程返回 canceled，什么都没发生，别报「没有新增」误导。
  //（该字段尚未落地时此分支不触发，自然降级为下面的计数提示）
  if (result.canceled === true) {
    flash('已取消');
    return;
  }
  await refresh();
  // 回执按主进程的真实动作说：缺省 mode='move'，文件默认是**移进**筐的文件夹
  //（措辞对照 popup.js 的 addStatus；下面 prune 那条「只清登记，磁盘文件未动」语义不同，别动）
  const moved = Number(result.moved) || 0;
  const copied = Number(result.copied) || 0;
  const bad = (result.failed || []).length;
  const how = moved ? '（已移进筐的文件夹）' : copied ? '（Dock 也在用，复制了一份）' : '';
  if (!result.added && !bad) {
    flash('没有新增（已在这个筐里的会跳过）');
    return;
  }
  let text = '已加入 ' + (result.added || 0) + ' 项' + how + '，共 ' + result.total + ' 项';
  if (bad) text += '；' + bad + ' 项没能移进去（原文件留在原处）';
  flash(text);
}

el('btnPrune').addEventListener('click', async () => {
  const result = await api.pruneMissing(selectedBasketId);
  await refresh();
  flash('已清理 ' + ((result && result.removed) || 0) + ' 个失效项（只清登记，磁盘文件未动）');
});

el('btnNew').addEventListener('click', async () => {
  const created = await api.createBasket();
  selectedBasketId = created && created.id;
  await refresh();
  flash('已在 Dock 新建一个文件夹');
});

el('btnDelete').addEventListener('click', async () => {
  const basket = settings.baskets.find((item) => item.id === selectedBasketId);
  if (!basket) return;
  await api.deleteBasket(basket.id);
  selectedBasketId = null;
  await refresh();
  flash('已删除这个文件夹的登记，里面的文件一个都没动');
});

el('btnReset').addEventListener('click', async () => {
  // 主进程按 DEFAULTS 重置设置窗口里能调的全部项；筐、Dock 条目、开机自启不受影响
  settings = await api.resetSettings();
  render();
  flash('已恢复默认设置（筐和桌面上的文件不动）');
});

el('autostart').addEventListener('change', async (event) => {
  if (loading) return;
  await api.setAutostart(event.target.checked);
  await refreshAutostart();
  flash(event.target.checked ? '开机自启已打开' : '开机自启已关闭');
});

async function refreshAutostart() {
  const info = await api.getAutostart();
  el('autostart').checked = info.enabled;
  el('autostartInfo').textContent = info.supported
    ? (process.platform === 'win32'
        ? '当前注册表内容：' + (info.command || '（未启用）')
        : (info.enabled ? '已开启（跟随系统登录）' : '未开启'))
    : '当前平台不支持';
}

async function refresh() {
  const state = await api.getState();
  settings = state.settings;
  displays = state.displays || [];
  weatherState = await api.getWeather().catch(() => null);
  render();
}

el('btn-close').addEventListener('click', () => api.closeWindow());
api.onStateChanged((payload) => {
  settings = payload.settings;
  if (payload.displays) displays = payload.displays;
  render();
});

// 天气刷新（15 分钟一次 / 点了「立即刷新」）：只更新那一行状态文字
api.onWeatherChanged((state) => {
  weatherState = state;
  renderWeather();
});

(async () => {
  // 初始化只需取一次状态：render() 里已并入 refreshAutostart()（C-3），不再重复调
  await refresh();
})();
