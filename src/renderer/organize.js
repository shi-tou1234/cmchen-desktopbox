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
  hidden: '隐藏/系统文件',
  excluded: '符合排除规则'
};

let plan = null;
let chosen = new Set();          // 本轮勾选的类 id
let executed = false;
let busy = false;
function renderRules() {
  const host = el('rulesList'); host.replaceChildren();
  for (const rule of plan.rules || []) addRuleRow(rule);
  el('excludeRules').value = (plan.exclude || []).join('\n');
  el('previousUndo').style.display = plan.undoable ? '' : 'none';
  el('forgetPrevious').dataset.confirm = ''; el('forgetPrevious').textContent = '保留结果，结束上次撤销记录';
}
function addRuleRow(rule = {}) {
  const row = document.createElement('div'); row.className = 'rule-row'; row.style.cssText = 'display:grid;grid-template-columns:18px repeat(3,minmax(0,1fr)) repeat(3,24px);align-items:center;gap:4px;margin:6px 0';
  for (const [key, placeholder] of [['extensions','扩展名：pdf,docx'], ['keyword','文件名包含（可空）'], ['target','目标筐名称']]) {
    const input = document.createElement('input'); input.dataset.key = key; input.placeholder = placeholder; input.value = rule[key] || ''; input.maxLength = key === 'target' ? 24 : 160; input.style.cssText = 'width:100%;min-width:0;box-sizing:border-box'; row.append(input);
  }
  const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = rule.enabled !== false; enabled.dataset.key = 'enabled'; enabled.title = '启用规则'; row.prepend(enabled);
  for (const [label, direction] of [['↑', -1], ['↓', 1]]) {
    const button = document.createElement('button'); button.textContent = label; button.style.padding = '4px'; button.title = '调整优先级';
    button.onclick = () => { const sibling = direction < 0 ? row.previousElementSibling : row.nextElementSibling; if (sibling) { if (direction < 0) row.parentNode.insertBefore(row, sibling); else row.parentNode.insertBefore(sibling, row); } }; row.append(button);
  }
  const remove = document.createElement('button'); remove.textContent = '×'; remove.style.padding = '4px'; remove.title = '删除规则'; remove.onclick = () => row.remove(); row.append(remove); el('rulesList').append(row);
}
async function reloadPlan() { plan = await api.organizePlan(); chosen.clear(); executed = false; renderPlan(); renderRules(); }
async function undoNow() {
  if (busy) return;
  busy = true; el('btnUndo').disabled = true; el('undoPrevious').disabled = true;
  try {
    const result = await api.organizeUndo();
    await reloadPlan();
    el('note').textContent = '已撤回 ' + result.done + ' 项；待处理 ' + result.remaining + ' 项。' + (result.failed || []).map(f => f.name + '：' + f.reason).join('；');
    el('note').title = el('note').textContent;
  } catch (error) { el('note').textContent = '撤销失败：' + error.message; }
  finally { busy = false; el('undoPrevious').disabled = false; refreshGo(); }
}


function closeWindow() {
  if (busy) return;
  window.close();
}

function renderPlan() {
  el('btnGo').textContent = '开始整理'; el('btnCancel').style.display = ''; el('btnCancel').disabled = false;
  el('btnUndo').style.display = 'none';
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
  el('btnGo').disabled = total === 0 || plan.undoable || busy;
  el('note').textContent = total
    ? '将把 ' + total + ' 个文件按类搬进各自的筐（文件移入目标筐；重名自动编号，不覆盖；可撤销）'
    : '勾选至少一类再开始';
}

async function execute() {
  if (busy) return; busy = true;
  el('btnClose').disabled = true; el('rulesPanel').inert = true;
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
  } finally { busy = false; el('btnClose').disabled = false; el('rulesPanel').inert = false; if (!executed) el('btnGo').disabled = false; }
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
    for (const problem of [...result.failed, ...(result.notes || [])]) {
      const detail = document.createElement('div');
      detail.className = 'warn';
      detail.style.fontSize = '11px';
      detail.textContent = '  · ' + problem.name + '：' + problem.reason;
      row.append(detail);
    }
    box.append(row);
  }
  main.append(box);
  el('previousUndo').style.display = 'none';
  el('btnGo').textContent = '完成';
  el('btnGo').disabled = false;

  el('btnCancel').style.display = 'none';
  const undoable = outcome.undoable && anyMoved;
  el('btnUndo').style.display = '';
  el('btnUndo').disabled = !undoable;
  el('note').textContent = undoable
    ? '整理完成。反悔了就点「撤销整理」，文件会原路搬回桌面。'
    : '整理完成。';
  el('btnUndo').onclick = undoNow;
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
    await reloadPlan();
  } catch (error) {
    el('note').textContent = '扫描失败：' + (error && error.message || error);
    el('note').className = 'note error';
  }
})();

el('addRule').onclick = () => addRuleRow();
el('saveRules').onclick = async () => {
  if (busy) return;
  const rules = [...document.querySelectorAll('.rule-row')].map(row => Object.fromEntries([...row.querySelectorAll('input')].map(input => [input.dataset.key, input.type === 'checkbox' ? input.checked : input.value])));
  if (rules.some(r => !r.target.trim() || (!r.extensions.trim() && !r.keyword.trim()))) { el('note').textContent = '每条规则需填写目标筐，以及扩展名或关键词。'; return; }
  try { plan = await api.organizeRules(rules, el('excludeRules').value.split(/\r?\n/)); chosen.clear(); executed = false; renderPlan(); renderRules(); }
  catch (error) { el('note').textContent = '保存失败：' + error.message; }
};
el('undoPrevious').onclick = undoNow;
el('forgetPrevious').onclick = async () => {
  if (busy) return;
  if (el('forgetPrevious').dataset.confirm !== 'yes') { el('forgetPrevious').dataset.confirm = 'yes'; el('forgetPrevious').textContent = '再次点击确认结束（不移动文件）'; return; }
  await api.organizeForgetUndo(); await reloadPlan();
};
