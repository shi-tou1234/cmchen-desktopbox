'use strict';

// IPC 对称性检查：preload 里每个 ipcRenderer.invoke/send 的通道，主进程都必须注册
// 对应的 ipcMain.handle/on。死通道（主进程零注册）曾混进来过——window:drag-start、
// 以及渲染层零调用被删掉的 file:list 的 preload 侧——这个测试用**两边的最终源码文本**
// 做差集，防止它们复活（主进程侧可能由并行改动调整，所以以文本为准、正则只取字面量通道名，
// 写得宽一点别太脆）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');

// 显式白名单：确实允许「只发不收」的通道放这里（目前没有；留空位给以后）
const WHITELIST = [];

// 通道名都是字面量（单/双引号都认），允许括号后换行缩进
function channels(src, patterns) {
  const found = new Set();
  for (const re of patterns) {
    for (const m of src.matchAll(re)) found.add(m[1]);
  }
  return found;
}

const preloadChannels = channels(preloadSrc, [
  /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g,
  /ipcRenderer\.send\(\s*['"]([^'"]+)['"]/g
]);

const mainChannels = channels(mainSrc, [
  /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g,
  /ipcMain\.on\(\s*['"]([^'"]+)['"]/g,
  // 可信发送方校验的通道走 guardHandle(channel, handler)——它内部调
  // ipcMain.handle(channel, …)，通道名以字面量出现在 guardHandle( 后面
  /guardHandle\(\s*['"]([^'"]+)['"]/g
]);

test('preload 用到的每个 IPC 通道，主进程都已注册（invoke/send 对 handle/on）', () => {
  const missing = [...preloadChannels]
    .filter((name) => !mainChannels.has(name) && !WHITELIST.includes(name))
    .sort();
  assert.deepStrictEqual(
    missing,
    [],
    'preload 里有主进程没注册的死通道：' + missing.join(', ')
  );
});

test('通道抽取本身有效（防正则写脆了静默取空集，测试假绿）', () => {
  assert.ok(preloadChannels.size > 0, '应能从 preload.js 抽出 invoke/send 通道');
  assert.ok(mainChannels.size > 0, '应能从 main.js 抽出 handle/on 通道');
  // 两边各拿一个已知的请求-应答通道当锚点：任一端改了抽取逻辑都先在这里红
  //（state:changed 是主进程 webContents.send 广播、不进 ipcMain 注册集，不在比对范围）
  assert.ok(preloadChannels.has('state:get'), 'preload 应抽到 state:get');
  assert.ok(mainChannels.has('state:get'), 'main 应抽到 state:get');
  assert.ok(preloadChannels.has('basket:add'), 'preload 应抽到 basket:add');
  assert.ok(mainChannels.has('basket:add'), 'main 应抽到 basket:add');
  // guardHandle 是注册通道的第二种写法，也要抽得到，否则差集会漏掉这类通道
  assert.ok(mainChannels.has('basket:trash'), 'main 应抽到 basket:trash（guardHandle 注册）');
});
