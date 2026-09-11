'use strict';

// 本轮功能（UI/动画/健壮性）的纯逻辑单测：主题、减弱动画、筐配色、弹窗尺寸、多显示器选屏、设置备份。
// 与 core.test.js 同一套路：只测不依赖 Electron 的纯函数与 store（用测试钩子注入临时目录）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../src/main/store');
const baskets = require('../src/main/baskets');
const dockmodel = require('../src/main/dockmodel');
const theme = require('../src/main/theme');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deskbasket-feat-'));
}

function withRoot(dir, fn) {
  store.__setRootForTests(dir);
  try {
    return fn();
  } finally {
    store.__setRootForTests(null);
  }
}

// ---------------------------------------------------------------- 主题：壁纸亮度 → 深浅色（#1）

test('主题解析：auto 按亮度切，拿不到亮度退回深色；dark/light 强制', () => {
  assert.strictEqual(theme.resolveTheme('dark', 250), 'dark', '手动深色时亮度不算数');
  assert.strictEqual(theme.resolveTheme('light', 10), 'light', '手动浅色时同理');
  assert.strictEqual(theme.resolveTheme('auto', 200), 'light', '亮壁纸走浅色');
  assert.strictEqual(theme.resolveTheme('auto', 60), 'dark', '暗壁纸走深色');
  assert.strictEqual(theme.resolveTheme('auto', null), 'dark', '读不到壁纸退回深色（历史行为）');
  assert.strictEqual(theme.resolveTheme('auto', NaN), 'dark');
});

test('主题：亮度阈值边界与合法取值', () => {
  assert.ok(theme.THEME_MODES.includes('auto'));
  assert.strictEqual(theme.resolveTheme('auto', theme.LIGHT_THRESHOLD), 'light');
  assert.strictEqual(theme.resolveTheme('auto', theme.LIGHT_THRESHOLD - 1), 'dark');
});

test('感知亮度：纯黑=0、纯白≈255、非法输入=null', () => {
  const rgba = (r, g, b, n) => {
    const buf = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i += 1) {
      buf[i * 4] = r;
      buf[i * 4 + 1] = g;
      buf[i * 4 + 2] = b;
      buf[i * 4 + 3] = 255;
    }
    return buf;
  };
  assert.strictEqual(theme.luminanceFromRgba(rgba(0, 0, 0, 4), 2, 2), 0);
  assert.ok(Math.abs(theme.luminanceFromRgba(rgba(255, 255, 255, 4), 2, 2) - 255) < 0.001);
  // 绿比蓝"亮"（人眼权重），加权结果应落在两者之间
  assert.ok(
    theme.luminanceFromRgba(rgba(0, 255, 0, 1), 1, 1) >
      theme.luminanceFromRgba(rgba(0, 0, 255, 1), 1, 1)
  );
  assert.strictEqual(theme.luminanceFromRgba(null, 2, 2), null);
  assert.strictEqual(theme.luminanceFromRgba(Buffer.alloc(3), 2, 2), null, '缓冲比像素数小：判非法');
});

test('配置：theme_mode 默认 auto，非法值回退', () => {
  assert.strictEqual(store.DEFAULTS.theme_mode, 'auto');
  assert.strictEqual(store.mergedSettings({}).theme_mode, 'auto');
  assert.strictEqual(store.mergedSettings({ theme_mode: 'light' }).theme_mode, 'light');
  assert.strictEqual(store.mergedSettings({ theme_mode: '花哨' }).theme_mode, 'auto');
});

// ---------------------------------------------------------------- 减弱动画开关（#7）

test('配置：reduce_motion 默认关，非布尔值回退默认', () => {
  assert.strictEqual(store.DEFAULTS.reduce_motion, false);
  assert.strictEqual(store.mergedSettings({}).reduce_motion, false);
  assert.strictEqual(store.mergedSettings({ reduce_motion: true }).reduce_motion, true);
  assert.strictEqual(store.mergedSettings({ reduce_motion: 'yes' }).reduce_motion, false);
});

test('滑出回弹缓动：两端精确，中段有克制的一次过冲', () => {
  assert.strictEqual(dockmodel.easeOutBack(0), 0);
  assert.strictEqual(dockmodel.easeOutBack(1), 1);
  const samples = [];
  for (let t = 0; t <= 1.0001; t += 0.05) samples.push(dockmodel.easeOutBack(t));
  assert.ok(samples.some((v) => v > 1), 'easeOutBack 必须会冲过目标');
  const max = Math.max(...samples);
  assert.ok(max > 1 && max < 1.2, `过冲幅度要克制，实际 ${max}`);
});

// ---------------------------------------------------------------- 筐配色（#2）

test('筐颜色：缺色的按 id 稳定分配，一批之内不重色', () => {
  const list = baskets.normalizeBaskets([{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }]);
  for (const basket of list) {
    assert.ok(/^#[0-9a-f]{6}$/.test(basket.color), `合法 hex：${basket.color}`);
  }
  assert.strictEqual(new Set(list.map((b) => b.color)).size, 3, '三个筐三个色');
  // 稳定：同样的 id 集合重新分配得到同样的颜色
  const again = baskets.normalizeBaskets([{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }]);
  assert.deepStrictEqual(again.map((b) => b.color), list.map((b) => b.color));
});

test('筐颜色：已有的合法颜色原样保留；非法的重新分配', () => {
  const list = baskets.normalizeBaskets([
    { id: 'b1', color: '#123456' },
    { id: 'b2', color: 'red' },
    { id: 'b3', color: '#ABCDEF' }
  ]);
  assert.strictEqual(list[0].color, '#123456');
  assert.ok(/^#[0-9a-f]{6}$/.test(list[1].color));
  assert.strictEqual(list[2].color, '#abcdef', '统一小写存');
  // 删掉一个筐，留下来的颜色不变（按 id 分配，不依赖顺序）
  const kept = baskets.normalizeBaskets([
    { id: 'b1', color: list[0].color },
    { id: 'b3', color: list[2].color }
  ]);
  assert.strictEqual(kept[0].color, list[0].color);
  assert.strictEqual(kept[1].color, list[2].color);
});

test('筐颜色：新建的筐立刻拿到一个没被占用的颜色', () => {
  const { baskets: list, basket } = baskets.createBasket(
    baskets.normalizeBaskets([{ id: 'b1' }, { id: 'b2' }]),
    '硬件工具'
  );
  assert.ok(/^#[0-9a-f]{6}$/.test(basket.color));
  assert.ok(!list.slice(0, 2).some((b) => b.color === basket.color));
});

// ---------------------------------------------------------------- 弹窗尺寸持久化（#3）

test('配置：弹窗尺寸默认 480×460，越界夹到边界而不是丢回默认', () => {
  assert.strictEqual(store.DEFAULTS.popup_width, 480);
  assert.strictEqual(store.DEFAULTS.popup_height, 460);
  const huge = store.mergedSettings({ popup_width: 99999, popup_height: 10 });
  assert.strictEqual(huge.popup_width, store.POPUP_WIDTH_MAX);
  assert.strictEqual(huge.popup_height, store.POPUP_HEIGHT_MIN);
  const legal = store.mergedSettings({ popup_width: 640, popup_height: 520 });
  assert.strictEqual(legal.popup_width, 640);
  assert.strictEqual(legal.popup_height, 520);
});

// ---------------------------------------------------------------- 多显示器选屏（#9）

test('选屏：primary 取主屏，下标越界回主屏，指定下标取那块', () => {
  const displays = [
    { bounds: { x: 1920, y: 0, width: 1280, height: 1024 }, primary: false },
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, primary: true }
  ];
  assert.strictEqual(dockmodel.pickDisplay(displays, 'primary').primary, true);
  assert.strictEqual(dockmodel.pickDisplay(displays, 0), displays[0]);
  assert.strictEqual(dockmodel.pickDisplay(displays, 9), displays[1], '越界回主屏');
  assert.strictEqual(dockmodel.pickDisplay(null, 'primary'), null);
});

test('选屏：mouse 取光标所在那块；光标不在任何屏内退回主屏', () => {
  const displays = [
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, primary: true },
    { bounds: { x: 1920, y: 0, width: 1280, height: 1024 }, primary: false }
  ];
  assert.strictEqual(dockmodel.pickDisplay(displays, 'mouse', { x: 100, y: 500 }), displays[0]);
  assert.strictEqual(dockmodel.pickDisplay(displays, 'mouse', { x: 2500, y: 500 }), displays[1]);
  assert.strictEqual(dockmodel.pickDisplay(displays, 'mouse', { x: 9999, y: 9999 }), displays[0]);
});

test('配置：dock_display 认 primary/mouse/非负整数，其它回 primary', () => {
  assert.strictEqual(store.DEFAULTS.dock_display, 'primary');
  assert.strictEqual(store.mergedSettings({ dock_display: 'mouse' }).dock_display, 'mouse');
  assert.strictEqual(store.mergedSettings({ dock_display: 2 }).dock_display, 2);
  assert.strictEqual(store.mergedSettings({ dock_display: -1 }).dock_display, 'primary');
  assert.strictEqual(store.mergedSettings({ dock_display: 1.5 }).dock_display, 'primary');
  assert.strictEqual(store.mergedSettings({ dock_display: '副屏' }).dock_display, 'primary');
});

// ---------------------------------------------------------------- 设置备份轮换（#14）

test('备份：第二次保存前会把上一份好文件留成 .bak', () => {
  const dir = tmpdir();
  withRoot(dir, () => {
    store.saveSettings({ icon_size: 64 });      // 第一次：没有旧文件，不留备份
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['settings.json']);
    store.saveSettings({ icon_size: 72 });      // 第二次：把 icon_size=64 那份留成 .bak
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['settings.json', 'settings.json.bak']);
    const bak = JSON.parse(fs.readFileSync(store.backupPath(), 'utf8'));
    assert.strictEqual(bak.icon_size, 64, '备份里必须是上一份');
  });
});

test('备份：主文件坏了自动从 .bak 恢复；备份也坏才回默认', () => {
  const dir = tmpdir();
  withRoot(dir, () => {
    store.saveSettings({ icon_size: 64, dock_items: ['C:\\d\\QQ.lnk'] });
    store.saveSettings({ icon_size: 72 });
    // 主文件被写坏（模拟断电/手改坏）
    fs.writeFileSync(store.settingsPath(), '{ 这不是合法 JSON');
    const loaded = store.loadSettings();
    assert.strictEqual(loaded.icon_size, 64, '应回退到 .bak 里那份');
    assert.strictEqual(loaded.dock_items.length, 1);
    // 备份也坏：回默认，且不抛
    fs.writeFileSync(store.backupPath(), '也不是 JSON');
    const fallback = store.loadSettings();
    assert.strictEqual(fallback.icon_size, store.DEFAULTS.icon_size);
  });
});

test('备份：坏文件被回退后，下一次保存会修好主文件且备份仍是好的', () => {
  const dir = tmpdir();
  withRoot(dir, () => {
    store.saveSettings({ icon_size: 60 });
    store.saveSettings({ icon_size: 70 });      // .bak = 60
    fs.writeFileSync(store.settingsPath(), '{坏');
    const loaded = store.loadSettings();        // → 60
    store.saveSettings(loaded);                 // 保存 60；此时主文件是好的 → .bak 也该是 60
    assert.strictEqual(store.loadSettings().icon_size, 60);
    assert.strictEqual(JSON.parse(fs.readFileSync(store.backupPath(), 'utf8')).icon_size, 60);
  });
});
