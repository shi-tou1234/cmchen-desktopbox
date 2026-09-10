'use strict';

// 页面内的右键菜单：Electron 的无边框窗口里 window.prompt / window.confirm 不可靠，
// 所以自己画一个。用法：
//   const picked = await showContextMenu([{key:'open', label:'打开'}, ...], event);
// 返回被选中的 key，取消则返回 null。

(function () {
  let host = null;

  function ensureHost() {
    if (host) return host;
    host = document.createElement('div');
    host.id = 'ctx-host';
    host.style.cssText = [
      'position:fixed',
      'z-index:9999',
      'min-width:150px',
      'padding:4px',
      'border-radius:9px',
      'background:rgba(26,28,36,0.97)',
      'border:1px solid rgba(255,255,255,0.16)',
      'box-shadow:0 8px 24px rgba(0,0,0,0.45)',
      'font:12px/1.4 "Microsoft YaHei",system-ui,sans-serif',
      'color:#eceef3',
      'display:none'
    ].join(';');
    document.body.append(host);
    return host;
  }

  function hide() {
    if (host) host.style.display = 'none';
  }

  window.showContextMenu = function showContextMenu(items, event) {
    return new Promise((resolve) => {
      const box = ensureHost();
      box.innerHTML = '';
      for (const item of items) {
        if (item.separator) {
          const line = document.createElement('div');
          line.style.cssText = 'height:1px;margin:4px 6px;background:rgba(255,255,255,0.12)';
          box.append(line);
          continue;
        }
        const row = document.createElement('div');
        row.textContent = item.label;
        row.style.cssText = 'padding:5px 10px;border-radius:6px;cursor:pointer;white-space:nowrap';
        row.addEventListener('mouseenter', () => {
          row.style.background = 'rgba(255,255,255,0.16)';
        });
        row.addEventListener('mouseleave', () => {
          row.style.background = 'transparent';
        });
        row.addEventListener('click', () => {
          hide();
          resolve(item.key);
        });
        box.append(row);
      }

      const x = Math.min(event.clientX, window.innerWidth - 170);
      const y = Math.min(event.clientY, window.innerHeight - 20 - items.length * 26);
      box.style.left = Math.max(4, x) + 'px';
      box.style.top = Math.max(4, y) + 'px';
      box.style.display = 'block';

      const dismiss = (ev) => {
        if (box.contains(ev.target)) return;
        hide();
        document.removeEventListener('mousedown', dismiss, true);
        resolve(null);
      };
      setTimeout(() => document.addEventListener('mousedown', dismiss, true), 0);
    });
  };
})();
