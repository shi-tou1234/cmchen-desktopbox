'use strict';

const api = window.deskbasket;
const params = new URLSearchParams(location.search);
const input = document.getElementById('renameInput');
const hint = document.getElementById('renameHint');
let done = false;

input.value = params.get('value') || '';
// 快捷方式改的是"别名"，磁盘上的文件名一个字都不动；筐本来就没有对应的磁盘名字
hint.textContent =
  params.get('kind') === 'basket' ? '只改这个筐的名字，桌面文件不动' : '只改 Dock 上的显示名，文件名不动';

async function commit() {
  if (done) return;
  done = true;
  await api.commitRename(input.value.trim());
}

async function cancel() {
  if (done) return;
  done = true;
  await api.cancelRename();
}

document.getElementById('btnOk').addEventListener('click', commit);
document.getElementById('btnCancel').addEventListener('click', cancel);
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    commit();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    cancel();
  }
});

// 窗口显示出来再聚焦，否则焦点会被别处抢走
window.addEventListener('focus', () => {
  input.focus();
  input.select();
});
input.focus();
input.select();
