'use strict';

// 页面内右键菜单：不在页面里自绘，而是请主进程弹 **原生菜单**。
//
// 以前是在页面里画一个 position:fixed 的 div，问题是它长在窗口内部：
// Dock 窗口只有 99px 高，菜单有 4~6 项（约 130~160px），必然被窗口裁掉——
// 表现就是「右键后菜单位置和内容显示不全」。原生菜单不受窗口尺寸限制，
// 位置、键盘操作、点击外部关闭都由系统处理。
//
// 用法不变：
//   const picked = await showContextMenu([{key:'open', label:'打开'}, ...], event);
// 返回被选中的 key，取消则返回 null。

(function () {
  window.showContextMenu = function showContextMenu(items, event) {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return Promise.resolve(null);
    const x = event && Number.isFinite(event.clientX) ? Math.round(event.clientX) : undefined;
    const y = event && Number.isFinite(event.clientY) ? Math.round(event.clientY) : undefined;
    return window.deskbasket.popupMenu(list, x, y);
  };
})();
