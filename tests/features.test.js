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
    '示例筐'
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

// ---------------------------------------------------------------- 天气（Dock 上的天气图标）

const weather = require('../src/main/weather');

test('天气：WMO 代码译成中文与图形，昼/夜只影响晴天', () => {
  assert.deepStrictEqual(weather.describeCode(0, true), { text: '晴', icon: 'clear' });
  assert.deepStrictEqual(weather.describeCode(0, false), { text: '晴', icon: 'clear-night' });
  assert.strictEqual(weather.describeCode(3, true).text, '阴');
  assert.strictEqual(weather.describeCode(61, true).text, '小雨');
  assert.strictEqual(weather.describeCode(95, false).text, '雷阵雨', '阵雨类昼夜说法一样');
  assert.strictEqual(weather.describeCode(99, true).icon, 'thunder');
  // 认不出的代码给「未知」而不是空白/抛错（新代码不该让整块天气画不出来）
  assert.deepStrictEqual(weather.describeCode(12345, true), { text: '未知', icon: 'unknown' });
  assert.deepStrictEqual(weather.describeCode(undefined, true), { text: '未知', icon: 'unknown' });
});

test('天气：今天/明天/后天按当地日期算，之后报周几', () => {
  assert.strictEqual(weather.dayLabel('2026-09-12', '2026-09-12'), '今天');
  assert.strictEqual(weather.dayLabel('2026-09-13', '2026-09-12'), '明天');
  assert.strictEqual(weather.dayLabel('2026-09-14', '2026-09-12'), '后天');
  // 2026-09-12 是周六 → 09-17 是周四
  assert.strictEqual(weather.dayLabel('2026-09-17', '2026-09-12'), '周四');
  // 跨月/跨年不吃时区：日期一律按 UTC 解析，不会整块挪一天
  assert.strictEqual(weather.dayLabel('2027-01-01', '2026-12-31'), '明天');
  // 坏日期不抛，回空串
  assert.strictEqual(weather.dayLabel('不是日期', '2026-09-12'), '');
});

test('天气：地理编码响应解析出坐标，找不到城市回 null', () => {
  const place = weather.parseGeocode({
    results: [
      {
        name: '北京',
        latitude: 39.9075,
        longitude: 116.39723,
        country: '中国',
        admin1: '北京市'
      }
    ]
  });
  assert.strictEqual(place.latitude, 39.9075);
  assert.strictEqual(place.longitude, 116.39723);
  assert.strictEqual(place.label, '北京 北京市 中国');
  assert.strictEqual(weather.parseGeocode({ results: [] }), null);
  assert.strictEqual(weather.parseGeocode(null), null);
  assert.strictEqual(weather.parseGeocode({ results: [{ name: 'x' }] }), null, '缺坐标不算有效结果');
  // 城市名与省/国家重名时不重复写（「北京 北京 中国」→「北京 中国」）
  assert.strictEqual(
    weather.parseGeocode({ results: [{ name: '上海', admin1: '上海', country: '中国', latitude: 1, longitude: 2 }] })
      .label,
    '上海 中国'
  );
});

test('天气：预报响应解析出当前天气与每天的最高/最低温', () => {
  const parsed = weather.parseForecast({
    timezone: 'Asia/Shanghai',
    current: {
      time: '2026-09-12T12:30',
      temperature_2m: 26.4,
      apparent_temperature: 28.1,
      relative_humidity_2m: 40,
      weather_code: 2,
      is_day: 1
    },
    daily: {
      time: ['2026-09-12', '2026-09-13'],
      weather_code: [2, 61],
      temperature_2m_max: [27.6, 24.2],
      temperature_2m_min: [18.4, 17.1]
    }
  });
  assert.strictEqual(parsed.current.temperature, 26.4);
  assert.strictEqual(parsed.current.feelsLike, 28.1);
  assert.strictEqual(parsed.current.humidity, 40);
  assert.strictEqual(parsed.current.text, '多云');
  assert.strictEqual(parsed.current.date, '2026-09-12', '当地日期要给出来：算今天/明天要用');
  assert.strictEqual(parsed.days.length, 2);
  assert.deepStrictEqual(parsed.days[1], {
    date: '2026-09-13',
    code: 61,
    text: '小雨',
    icon: 'rain',
    max: 24.2,
    min: 17.1
  });
  // 关键字段缺失当坏数据处理：宁可显示"取不到"，也别画一张半截的预报
  assert.strictEqual(weather.parseForecast({ current: {}, daily: { time: [] } }), null);
  assert.strictEqual(weather.parseForecast({ current: { temperature_2m: 20 } }), null);
  assert.strictEqual(weather.parseForecast(null), null);
});

test('天气：Dock 图标下那行字是实时气温＋天气，没数据时留空', () => {
  assert.strictEqual(weather.dockCaption({ current: { temperature: 26.4, text: '多云' } }), '26° 多云');
  assert.strictEqual(weather.dockCaption({ current: { temperature: -3.6, text: '小雪' } }), '-4° 小雪');
  assert.strictEqual(weather.dockCaption({ current: { temperature: 20, text: '' } }), '20°');
  assert.strictEqual(weather.dockCaption({ current: null }), '');
  assert.strictEqual(weather.dockCaption(null), '');
});

test('天气：请求地址带上城市/坐标与天数，卡片高度随天数走', () => {
  const geo = weather.geocodeUrl('北京');
  assert.ok(geo.startsWith(weather.GEOCODE_ENDPOINT + '?'));
  assert.ok(geo.includes('format=json') && geo.includes('count=1'));
  assert.strictEqual(decodeURIComponent(geo.split('name=')[1].split('&')[0]), '北京');
  // 城市名里的特殊字符必须编码，不能拼进 URL
  assert.ok(weather.geocodeUrl('a&b=c').includes('a%26b%3Dc'));
  // 空城市退回默认城市，不至于请求一个空名字
  assert.strictEqual(weather.geocodeUrl('  '), weather.geocodeUrl(weather.DEFAULT_CITY));
  const url = weather.forecastUrl(39.9, 116.4);
  assert.ok(url.includes('latitude=39.9') && url.includes('longitude=116.4'));
  assert.ok(url.includes('forecast_days=' + weather.FORECAST_DAYS));

  const few = weather.cardSize(2);
  const many = weather.cardSize(6);
  assert.strictEqual(few.width, weather.CARD_WIDTH);
  assert.strictEqual(many.height - few.height, 4 * weather.CARD_ROW);
  assert.strictEqual(weather.cardSize(0).height, weather.cardSize(1).height, '至少留一行');
  assert.ok(weather.cardSize(99).height <= weather.CARD_HEAD + 7 * weather.CARD_ROW + weather.CARD_PAD);
});

test('天气：取数走注入的 request，城市→坐标→预报串成一条链', async () => {
  const calls = [];
  const request = (url) => {
    calls.push(url);
    if (url.startsWith(weather.GEOCODE_ENDPOINT)) {
      return Promise.resolve({ results: [{ name: '北京', latitude: 39.9, longitude: 116.4, country: '中国' }] });
    }
    return Promise.resolve({
      current: { time: '2026-09-12T12:00', temperature_2m: 26, weather_code: 0, is_day: 1 },
      daily: { time: ['2026-09-12'], weather_code: [0], temperature_2m_max: [28], temperature_2m_min: [18] }
    });
  };
  const result = await weather.fetchWeather('北京', request);
  assert.strictEqual(calls.length, 2, '先查坐标再取预报');
  assert.ok(calls[0].startsWith(weather.GEOCODE_ENDPOINT));
  assert.ok(calls[1].startsWith(weather.FORECAST_ENDPOINT));
  assert.strictEqual(result.place.name, '北京');
  assert.strictEqual(result.current.temperature, 26);
  assert.strictEqual(result.current.icon, 'clear');
  assert.strictEqual(result.days[0].max, 28);

  // 查不到城市要报错（页面据此显示"取不到"，而不是画一张空白卡）
  await assert.rejects(() => weather.fetchWeather('不存在的地方', () => Promise.resolve({ results: [] })),
    /找不到城市/);
  // 有坐标就直接取预报，不再地理编码
  const again = [];
  await weather.fetchForecast({ latitude: 1, longitude: 2 }, (url) => {
    again.push(url);
    return Promise.resolve({
      current: { time: '2026-09-12T12:00', temperature_2m: 20, weather_code: 3 },
      daily: { time: ['2026-09-12'], weather_code: [3], temperature_2m_max: [22], temperature_2m_min: [15] }
    });
  });
  assert.strictEqual(again.length, 1);
  assert.ok(again[0].startsWith(weather.FORECAST_ENDPOINT));
});

test('配置：weather_city 压缩空白并限长，坏值回空串（= 用默认城市）', () => {
  assert.strictEqual(store.normalizeCity('  上海  '), '上海');
  assert.strictEqual(store.normalizeCity('New   York'), 'New York');
  assert.strictEqual(store.normalizeCity('x'.repeat(100)).length, weather.CITY_MAX);
  assert.strictEqual(store.normalizeCity(42), '');
  assert.strictEqual(store.normalizeCity(null), '');
  assert.strictEqual(store.mergedSettings({ weather_city: '  广州 ' }).weather_city, '广州');
  assert.strictEqual(store.mergedSettings({}).weather_city, '');
});

test('天气：没填城市时按 IP 定位，并把英文城市名换成中文', async () => {
  const calls = [];
  const request = (url) => {
    calls.push(url);
    if (url.startsWith('https://ipwho.is')) {
      return Promise.resolve({
        success: true,
        city: 'Hangzhou',
        region: 'Zhejiang Sheng',
        country: 'China',
        latitude: 30.29,
        longitude: 120.16
      });
    }
    // 地理编码：英文名交给 Open-Meteo 换中文
    return Promise.resolve({
      results: [{ name: '杭州', admin1: '浙江省', country: '中国', latitude: 30.27, longitude: 120.15 }]
    });
  };
  const place = await weather.resolveAutoPlace(request);
  assert.strictEqual(calls.length, 2);
  assert.ok(calls[0].startsWith(weather.IP_LOOKUP_ENDPOINT));
  assert.strictEqual(place.label, '杭州 浙江省 中国', 'Dock 上要写中文地名');
  assert.strictEqual(place.auto, true);
  assert.strictEqual(place.latitude, 30.27, '坐标以地理编码为准（比 IP 更准）');

  // IP 服务挂了：抛错，由上层折进快照显示"取不到"，不能让整块天气崩掉
  await assert.rejects(
    () => weather.resolveAutoPlace(() => Promise.resolve({ success: false })),
    /定位失败/
  );
  // 地理编码查不到这个名字（生僻地名）：退回 IP 给的坐标，宁可名字是英文
  const fallback = await weather.resolveAutoPlace((url) =>
    url.startsWith('https://ipwho.is')
      ? Promise.resolve({ success: true, city: 'Xyzzy', country: 'Nowhere', latitude: 1, longitude: 2 })
      : Promise.resolve({ results: [] })
  );
  assert.strictEqual(fallback.label, 'Xyzzy Nowhere');
  assert.strictEqual(fallback.auto, true);
  // 没有城市名但有坐标：直接用坐标
  const bare = await weather.parseIpLocation({ success: true, latitude: 3, longitude: 4 });
  assert.strictEqual(bare.name, '');
  assert.strictEqual(weather.parseIpLocation({ success: true, city: 'X' }), null, '没坐标不算有效定位');
});
