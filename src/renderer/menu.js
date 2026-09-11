'use strict';

// 页面内右键菜单：不在页面里自绘，也不再用系统原生菜单。
//
// 历史：最早在页面里画 position:fixed 的 div，Dock 窗口只有 100px 高，菜单必然被裁掉
// （「右键后菜单位置和内容显示不全」）；后来改成请主进程弹**原生菜单**，裁剪问题没了，
// 但它挂在不聚焦的 Dock 窗口上时**点别处关不掉**，还收不到键盘。
//
// 现在是第三种：主进程开一个尺寸刚好的自绘菜单窗——失焦即关（点别的窗口/桌面就消失）、
// 方向键 + 回车可选、Esc 取消，动画也归我们自己控制。
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
    return window.deskbasket.openMenu(list, x, y);
  };
})();
