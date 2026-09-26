'use strict';

// 一键整理桌面 · 预览窗逻辑（1.4.0）：
// 载荷来自 organize:plan（分类/建筐决策都在主进程的纯逻辑里），这里只负责「让用户看得
// 明白、确认得放心」：每类一张卡（色点=届时 Dock 上的筐色、目标、文件清单、勾选），
// 执行后展示逐类结果并提供撤销。

const api = window.deskbasket;
const el = (id) => document.getElementById(id);

const REASONS = {
  dir: '文件夹（保持原位）',
  missing: '文件已不存在',
  registered: '已在 Dock 或别的筐里',
  hidden: '隐藏/系统文件'
};

let plan = null;
let chosen = new Set();          // 本轮勾选的类 id
let executed = false;

function closeWindow() {
  window.close();
}

function renderPlan() {
  const main = el('main');
  main.innerHTML = '';
  el('sub').textContent = plan.root ? '整理目标：' + plan.root : '';
  if (plan.error) {
    el('note').textContent = plan.error;
    el('note').className = 'note error';
    el('btnGo').disabled = true;
    return;
  }
  if (!plan.groups.length) {
    const empty = document.createElement('div');
    empty.className = 'result';
    empty.innerHTML = '桌面上没有凑够一类 2 个的可整理文件，' +
      '已经是很整齐的状态。新文件落进来之后再点一次就好。';
    main.append(empty);
    el('btnGo').disabled = true;
    renderSkipped(main);
    return;
  }
  for (const group of plan.groups) {
    chosen.add(group.id);
    const card = document.createElement('div');
    card.className = 'group';
    card.dataset.id = group.id;

    const head = document.createElement('div');
    head.className = 'ghead';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = group.color || '#8a93a6';
    const name = document.createElement('span');
    name.className = 'gname';
    name.textContent = group.name;
    const count = document.createElement('span');
    count.className = 'gcount';
    count.textContent = group.count + ' 个文件';
    const target = document.createElement('span');
    target.className = 'gtarget';
    target.textContent = group.action === 'reuse'
      ? '并入已有筐「' + (group.basketName || group.name) + '」'
      : '新建筐「' + group.name + '」';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'check';
    check.checked = true;
    check.addEventListener('change', () => {
      if (check.checked) chosen.add(group.id);
      else chosen.delete(group.id);
      card.classList.toggle('off', !check.checked);
      refreshGo();
    });
    head.append(dot, name, count, target, check);

    const files = document.createElement('div');
    files.className = 'files';
    for (const item of group.items) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = item.name;
      chip.title = item.path;
      files.append(chip);
    }
    if (group.more > 0) {
      const more = document.createElement('span');
      more.className = 'more';
      more.textContent = '…等 ' + group.count + ' 个';
      files.append(more);
    }
    card.append(head, files);
    main.append(card);
  }
  renderSkipped(main);
  refreshGo();
}

function renderSkipped(main) {
  if (!plan.skipped || !plan.skipped.length) return;
  const box = document.createElement('details');
  box.className = 'skipbox';
  const summary = document.createElement('summary');
  summary.textContent = '还有 ' + plan.skipped.length + ' 个不会动（点开看原因）';
  const list = document.createElement('div');
  for (const item of plan.skipped) {
    const row = document.createElement('div');
    row.textContent = item.name + ' —— ' + (REASONS[item.reason] || item.reason);
    list.append(row);
  }
  box.append(summary, list);
  main.append(box);
}

function refreshGo() {
  const total = plan.groups
    .filter((g) => chosen.has(g.id))
    .reduce((sum, g) => sum + g.count, 0);
  el('btnGo').disabled = total === 0;
  el('note').textContent = total
    ? '将把 ' + total + ' 个文件按类搬进各自的筐（文件会移动进筐的文件夹，可撤销）'
    : '勾选至少一类再开始';
}

async function execute() {
  el('btnGo').disabled = true;
  el('btnCancel').disabled = true;
  el('note').textContent = '正在整理…（文件移动可能要几秒）';
  const groups = plan.groups.filter((g) => chosen.has(g.id));
  try {
    const outcome = await api.organizeExecute(groups);
    executed = true;
    renderResult(outcome);
  } catch (error) {
    el('note').textContent = '整理失败：' + (error && error.message || error);
    el('note').className = 'note error';
    el('btnCancel').disabled = false;
  }
}

function renderResult(outcome) {
  const main = el('main');
  main.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'result';
  let anyMoved = false;
  for (const result of outcome.results || []) {
    const row = document.createElement('div');
    const movedText = result.moved
      ? '移入 ' + result.moved
      : '';
    const copiedText = result.copied ? '复制 ' + result.copied : '';
    const how = [movedText, copiedText].filter(Boolean).join('、') || '登记 ' + result.added;
    row.innerHTML = '<b>' + escapeHtml(result.name) + '</b>：' + escapeHtml(how) +
      '，现 ' + result.total + ' 项' + (result.failed.length ? '，<span class="warn">失败 ' + result.failed.length + '</span>' : '');
    if (result.moved) anyMoved = true;
    for (const problem of result.failed) {
      const detail = document.createElement('div');
      detail.className = 'warn';
      detail.style.fontSize = '11px';
      detail.textContent = '  · ' + problem.name + '：' + problem.reason;
      row.append(detail);
    }
    box.append(row);
  }
  main.append(box);
  el('btnGo').textContent = '完成';
  el('btnGo').disabled = false;
  el('btnGo').onclick = closeWindow;
  el('btnCancel').style.display = 'none';
  const undoable = outcome.undoable && anyMoved;
  el('btnUndo').style.display = '';
  el('btnUndo').disabled = !undoable;
  el('note').textContent = undoable
    ? '整理完成。反悔了就点「撤销整理」，文件会原路搬回桌面。'
    : '整理完成。';
  el('btnUndo').onclick = async () => {
    el('btnUndo').disabled = true;
    el('note').textContent = '正在撤回…';
    try {
      const undone = await api.organizeUndo();
      el('note').textContent = '已搬回 ' + undone.done + ' 个文件' +
        (undone.skipped ? '，' + undone.skipped + ' 个因原位被占/文件丢失跳过' : '');
      el('btnUndo').style.display = 'none';
    } catch (error) {
      el('note').textContent = '撤销失败：' + (error && error.message || error);
      el('note').className = 'note error';
    }
  };
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

el('btnGo').addEventListener('click', () => { if (!executed) execute(); else closeWindow(); });
el('btnCancel').addEventListener('click', closeWindow);
el('btnClose').addEventListener('click', closeWindow);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeWindow();
});

(async () => {
  try {
    plan = await api.organizePlan();
    renderPlan();
  } catch (error) {
    el('note').textContent = '扫描失败：' + (error && error.message || error);
    el('note').className = 'note error';
  }
})();
