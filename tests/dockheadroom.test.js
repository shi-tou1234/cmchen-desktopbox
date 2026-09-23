'use strict';

// 顶部余量的回归锁（U-1）：悬停放大/点击弹跳不能把图标顶出窗口上沿——
// dock.html 是 overflow:hidden，越界部分直接被裁掉。
//
// 几何（dock.html 里 transform-origin 是 bottom center）：
// 条目高 (图标 + 名字行) 按 scale 从底边向上长，再叠上抬升像素。
// 最坏情况 = dock_magnify 拉到上限（store 的 DOCK_MAGNIFY_MAX=100 → 整整 2 倍）
// × 点击弹跳再放大 10%，抬升 = HOP_LIFT 22 + BOOST_LIFT 10。
// dockmodel 里那几个抬升常量是照抄 renderer/dock.js 的，这里用字面值核几何本身。

const test = require('node:test');
const assert = require('node:assert');

const dockmodel = require('../src/main/dockmodel');

test('顶部余量罩住最坏情况：放大到上限 + 弹跳抬升不越过窗口上沿', () => {
  for (const icon of [24, 48, 128]) {
    const layout = dockmodel.dockLayout(1, icon, 1920, 8);
    // 单行时：窗口顶边到条目本征上沿之间的全部空间（顶部余量 + 行距空隙 + 内边距）
    const slack = layout.height - (icon + dockmodel.DOCK_CAPTION_H);
    // 最坏情况向上长多少：条目从底边中心放大 (1+1)×(1+0.1)=2.2 倍 → 上沿多出 1.2 倍条目高，再加抬升
    const worst = (icon + dockmodel.DOCK_CAPTION_H) * 1.2 + 22 + 10;
    assert.ok(
      slack >= worst,
      `图标 ${icon}px：余量 ${slack}px 盖不住最坏情况 ${worst}px`
    );
  }
});

test('余量跟随当前 dock_magnify：40% 档盖住自己的最坏情况，且比 100% 档矮（少挡点击）', () => {
  for (const icon of [24, 48, 128]) {
    const m = 40;
    const layout = dockmodel.dockLayout(1, icon, 1920, 8, m);
    const item = icon + dockmodel.DOCK_CAPTION_H;
    const slack = layout.height - item;
    // 40% 档的最坏情况：放大 (1.4)×弹跳(1.1)=1.54 倍 → 上沿多出 0.54 倍条目高，再加抬升
    const worst40 = item * (1.4 * 1.1 - 1) + 22 + 10;
    assert.ok(
      slack >= worst40,
      `图标 ${icon}px：40% 档余量 ${slack}px 盖不住 ${worst40}px`
    );
    // 同一图标下，按当前档位算出的窗口必须比按 100% 上限算的矮
    const layoutMax = dockmodel.dockLayout(1, icon, 1920, 8);
    assert.ok(
      layout.height < layoutMax.height,
      `图标 ${icon}px：40% 档高度 ${layout.height} 应小于 100% 档 ${layoutMax.height}`
    );
  }
});

test('dockHeadroom 输入防御：0 取最小、坏输入按上限兜底', () => {
  const min = dockmodel.dockHeadroom(48, 0);
  const max = dockmodel.dockHeadroom(48);
  assert.ok(min < max, '0% 应比不传（上限）矮');
  assert.strictEqual(dockmodel.dockHeadroom(48, NaN), max, 'NaN 按上限兜底');
  assert.strictEqual(dockmodel.dockHeadroom(48, -5), dockmodel.dockHeadroom(48, 0), '负数夹到 0');
  assert.strictEqual(dockmodel.dockHeadroom(48, 999), max, '超上限夹到上限');
});
