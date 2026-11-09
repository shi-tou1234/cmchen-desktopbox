'use strict';

// Dock 空白处鼠标穿透的「接线」单测：只读两边的最终源码文本，不启 Electron。
//
// 这条链路有三个"删掉就静默坏掉"的点，靠肉眼守不住，所以钉在这里：
//   ① setIgnoreMouseEvents 的 forward 选项——删了窗口照样穿透，但页面再也收不到 mousemove，
//      命中测试永远测不到图标，Dock 从此点不动（而且没有任何报错）；
//   ② dock:interactive 只认 Dock 那一页的 webContents——不校验的话任何渲染进程都能把
//      Dock 改成"吃鼠标"，把桌面又盖回去；
//   ③ 拖拽守卫——穿透的窗口在 OLE 眼里不存在，删了它，往 Dock 上拖文件会直接掉到桌面。
//
// 真正的鼠标行为（穿不穿、点不点得动）属于真机验证，见提交说明里的实测记录。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_DIR = path.join(__dirname, '..', 'src', 'main');
const MAIN_SOURCE = fs.readFileSync(path.join(MAIN_DIR, 'main.js'), 'utf8');
const PRELOAD_SOURCE = fs.readFileSync(path.join(MAIN_DIR, 'preload.js'), 'utf8');
const DOCK_RENDERER = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'dock.js'),
  'utf8'
);

function functionBody(source, name) {
  const at = source.indexOf(`function ${name}(`);
  if (at < 0) return '';
  let depth = 0;
  let opened = false;
  for (let i = at; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') {
      depth += 1;
      opened = true;
      continue;
    }
    if (ch === '}' && opened) {
      depth -= 1;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  return '';
}

test('setDockClickThrough：必须带 forward，否则页面收不到 mousemove、Dock 点不动', () => {
  const body = functionBody(MAIN_SOURCE, 'setDockClickThrough');
  assert.ok(body, 'setDockClickThrough 函数体没找到');
  assert.match(body, /setIgnoreMouseEvents\(\s*want\s*,\s*\{\s*forward:\s*true\s*\}/);
  // 状态记在窗口对象上：Dock 关掉再开是新窗口，挂模块变量会误判成"已经设过了"而跳过
  assert.ok(body.includes('__ignoreMouse'), '穿透状态要记在窗口对象上，不能记模块变量');
});

test('Dock 建好就默认穿透（空白处不挡桌面）', () => {
  const body = functionBody(MAIN_SOURCE, 'createDockWindow');
  assert.ok(body, 'createDockWindow 函数体没找到');
  assert.ok(body.includes('setDockClickThrough(true)'), 'Dock 窗口就绪后要落一次穿透');
});

test('命中测试的通道：只认 Dock 那一页，且拖拽期间不许改回穿透', () => {
  const at = MAIN_SOURCE.indexOf("ipcMain.on('dock:interactive'");
  assert.ok(at > 0, '没注册 dock:interactive');
  const body = MAIN_SOURCE.slice(at, at + 600);
  assert.ok(body.includes('event.sender !== dockWindow.webContents'), '要校验发送方是 Dock 页面');
  assert.ok(body.includes('dockDragHeld()'), '拖拽期间不能被页面的判定改回穿透');
  assert.ok(body.includes('setDockClickThrough(!interactive)'), '在条目上就接回鼠标');
});

test('拖拽守卫：按住左键又动过 + 光标在图标行里 → 接回鼠标当落点', () => {
  const body = functionBody(MAIN_SOURCE, 'dockDragHeld');
  assert.ok(body, 'dockDragHeld 函数体没找到');
  assert.ok(body.includes('dockDragArmed'), '判据是"这一轮按住期间动过"（纯点击不算拖拽）');
  assert.ok(body.includes('dockRowBounds'), '落点只认图标行，不能拿整窗矩形（顶上那条空白带不算 Dock）');

  // arm / 解除都跟着 mouseState 走：穿透窗口自己收不到 mousedown，只能问系统
  const tick = functionBody(MAIN_SOURCE, 'tickDockClickThrough');
  assert.ok(tick.includes('mouseState.poll'), '要问全局鼠标状态');
  assert.match(tick, /if \(!mouse\.held\)\s*dockDragArmed = false/, '一松手就解除');
  assert.match(tick, /dockPointerMoving\)\s*dockDragArmed = true/, '按住期间动过才 arm');
});

test('dockRowBounds：从窗口矩形里刨掉悬停放大余量', () => {
  const body = functionBody(MAIN_SOURCE, 'dockRowBounds');
  assert.ok(body, 'dockRowBounds 函数体没找到');
  assert.ok(body.includes('dockHeadroom'), '要用 dockHeadroom 刨掉顶上那条空白带');
  assert.ok(body.includes('DOCK_DROP_PAD'), '行上沿留一点容错');
  // 高度必须是"窗口底 - 行顶"，别把整窗高度抄下来
  assert.match(body, /height:\s*Math\.max\(0,\s*bounds\.y \+ bounds\.height - top\)/);
});

test('渲染层：图标行外不接受落点（dragover 不 preventDefault、drop 直接返回）', () => {
  assert.ok(DOCK_RENDERER.includes('function inDropRow'), '缺 inDropRow');
  assert.ok(DOCK_RENDERER.includes('function itemRowRect'), '缺 itemRowRect');
  // 空 Dock 也要能接（只有一条提示带）：不能因为 nodes 为空就把落点全拒了
  assert.match(
    DOCK_RENDERER,
    /if \(!nodes\.length\)[\s\S]{0,200}return \{ left: 0, right: width/,
    '空 Dock 的条目区要按底部提示带兜底'
  );
  const over = DOCK_RENDERER.slice(DOCK_RENDERER.indexOf("document.addEventListener('dragover'"));
  const overBody = over.slice(0, over.indexOf("document.addEventListener('dragleave'"));
  assert.match(overBody, /if \(!inDropRow\(event\.clientX, event\.clientY\)\)[\s\S]*return;/, 'dragover 要先判行');
  assert.ok(
    overBody.indexOf('inDropRow') < overBody.indexOf('event.preventDefault()'),
    '先判行再 preventDefault：行外不能变成投放区'
  );
  const dropAt = DOCK_RENDERER.indexOf("document.addEventListener('drop', async");
  assert.ok(dropAt > 0, '没找到拖入落点的 drop 处理');
  const dropBody = DOCK_RENDERER.slice(dropAt, dropAt + 400);
  assert.match(dropBody, /if \(!inDropRow\(event\.clientX, event\.clientY\)\)/, 'drop 也要兜一道');
});

test('每拍补一次命中测试：指针静止、窗口滑到它底下时也得认得出', () => {
  const body = functionBody(MAIN_SOURCE, 'tickDockClickThrough');
  assert.ok(body, 'tickDockClickThrough 函数体没找到');
  assert.ok(body.includes('sendDockPointer'), '要把光标位置推给页面');
  // 光标不在窗口里：直接回到穿透（页面收不到 mouseleave 的场合兜底）
  assert.match(body, /if \(!inside\)[\s\S]*setDockClickThrough\(true\)/);
  assert.ok(body.includes('mouseState.ensureRunning'), '靠近 Dock 时把鼠标侦察拉起来');
  assert.ok(body.includes('scheduleIdleStop'), '离开后交回闲置回收（别常驻一个 PowerShell）');
  // 节流：spawn 失败时每 80ms 试一次会变成起进程风暴
  assert.ok(body.includes('dockWatchAt'), 'ensureRunning 要节流');
});

test('定时器接上了，退出时也收掉了', () => {
  assert.ok(MAIN_SOURCE.includes('startDockClickThrough();'), 'bootstrap 里没启动命中测试');
  assert.ok(
    /will-quit[\s\S]*clearInterval\(dockHitTimer\)/.test(MAIN_SOURCE),
    '退出前要清掉命中测试的定时器'
  );
});

test('preload 把两个方向都暴露出来了', () => {
  assert.ok(PRELOAD_SOURCE.includes("ipcRenderer.send('dock:interactive'"), '页面 → 主进程：命中判定');
  assert.ok(PRELOAD_SOURCE.includes("ipcRenderer.on('dock:pointer'"), '主进程 → 页面：光标位置');
  assert.ok(PRELOAD_SOURCE.includes('setDockInteractive'), '缺 setDockInteractive');
  assert.ok(PRELOAD_SOURCE.includes('onDockPointerProbe'), '缺 onDockPointerProbe');
});

test('渲染层命中测试：认的是 .dock-item，状态不变不重复上报', () => {
  assert.ok(DOCK_RENDERER.includes('elementFromPoint'), '要用 elementFromPoint 做命中测试');
  assert.ok(DOCK_RENDERER.includes("closest('.dock-item')"), '命中的必须是条目本身');
  const body = functionBody(DOCK_RENDERER, 'reportPointerOverItem');
  assert.ok(body, 'reportPointerOverItem 函数体没找到');
  assert.ok(body.includes('next === pointerOverItem'), '状态没变就别发 IPC（mousemove 很密）');
  assert.ok(body.includes('api.setDockInteractive'), '判定要报给主进程');
});

test('渲染层：指针离开窗口 / 主进程报 null 时都要复位成穿透', () => {
  assert.match(
    DOCK_RENDERER,
    /mouseleave[\s\S]{0,200}trackPointer\(null, null\)/,
    'mouseleave 要复位命中判定'
  );
  const at = DOCK_RENDERER.indexOf('api.onDockPointerProbe');
  assert.ok(at > 0, '没订阅 dock:pointer');
  const body = DOCK_RENDERER.slice(at, at + 900);
  assert.match(body, /if \(!point\)[\s\S]*reportPointerOverItem\(false\)/, '收到 null 要复位');
  // 刚有过 mousemove 就别采信：主进程那一拍送的是上一刻的位置，拿它盖会闪
  assert.ok(body.includes('lastMoveAt'), '要用 lastMoveAt 挡住过期位置');
});
