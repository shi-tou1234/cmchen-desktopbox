'use strict';

// 天气：Open-Meteo（免费、免注册、不需要 API Key）＋ WMO 天气代码译成中文。
//
// 为什么取数放主进程：各页面的 CSP 是 default-src 'self'，渲染层根本发不出网络请求。
// 主进程取回来存成一份快照再广播，页面（Dock 的气温、悬浮卡片）只管画。
//
// 这里只用 node:https，不引任何依赖；译码/解析/排版算尺寸全是纯函数，
// 取数那一层用注入的 request 换掉，所以 node --test 能直接把整条链路测完。

const https = require('node:https');

const GEOCODE_ENDPOINT = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
// 设置里没填城市时的自动定位：ipwho.is 免费、免注册、不要 Key，只回英文城市名，
// 拿到名字再交给 Open-Meteo 换成中文名与精确坐标（见 resolveAutoPlace）
const IP_LOOKUP_ENDPOINT = 'https://ipwho.is/?lang=zh';

const DEFAULT_CITY = '北京';
const CITY_MAX = 24;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 256 * 1024;   // 正常响应几 KB，超过就是出事了
const FORECAST_DAYS = 6;                 // 今天 ＋ 未来 5 天

// WMO 4677 天气代码 → 中文说法 ＋ 图形种类（图形由渲染层 weather-icons.js 画）。
// night 是夜间说法，只有「晴 / 晴间多云」需要区分（其余说法昼夜一样）。
const WMO_CODES = {
  0: { text: '晴', night: '晴', icon: 'clear', nightIcon: 'clear-night' },
  1: { text: '晴间多云', night: '晴间多云', icon: 'mostly-clear', nightIcon: 'mostly-clear-night' },
  2: { text: '多云', icon: 'partly-cloudy' },
  3: { text: '阴', icon: 'overcast' },
  45: { text: '有雾', icon: 'fog' },
  48: { text: '雾凇', icon: 'fog' },
  51: { text: '小毛毛雨', icon: 'drizzle' },
  53: { text: '毛毛雨', icon: 'drizzle' },
  55: { text: '大毛毛雨', icon: 'drizzle' },
  56: { text: '冻毛毛雨', icon: 'drizzle' },
  57: { text: '强冻毛毛雨', icon: 'drizzle' },
  61: { text: '小雨', icon: 'rain' },
  63: { text: '中雨', icon: 'rain' },
  65: { text: '大雨', icon: 'rain' },
  66: { text: '冻雨', icon: 'rain' },
  67: { text: '强冻雨', icon: 'rain' },
  71: { text: '小雪', icon: 'snow' },
  73: { text: '中雪', icon: 'snow' },
  75: { text: '大雪', icon: 'snow' },
  77: { text: '米雪', icon: 'snow' },
  80: { text: '阵雨', icon: 'showers' },
  81: { text: '强阵雨', icon: 'showers' },
  82: { text: '暴雨', icon: 'showers' },
  85: { text: '阵雪', icon: 'snow-showers' },
  86: { text: '强阵雪', icon: 'snow-showers' },
  95: { text: '雷阵雨', icon: 'thunder' },
  96: { text: '雷阵雨夹冰雹', icon: 'thunder' },
  99: { text: '强雷暴夹冰雹', icon: 'thunder' }
};

const UNKNOWN = { text: '未知', icon: 'unknown' };

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// ------------------------------------------------------------------ 纯逻辑

// 天气代码 + 昼夜 → { text, icon }
function describeCode(code, isDay = true) {
  const entry = WMO_CODES[Number(code)];
  if (!entry) return { ...UNKNOWN };
  if (!isDay && entry.nightIcon) return { text: entry.night || entry.text, icon: entry.nightIcon };
  return { text: entry.text, icon: entry.icon };
}

function round1(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 10) / 10;
}

// 'YYYY-MM-DD' → 当天零点的时间戳（按 UTC 解析，避开本地时区把日期挪一天）
function dayStamp(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

// 这一天的说法：今天 / 明天 / 后天 / 周几
function dayLabel(dateStr, todayStr) {
  const stamp = dayStamp(dateStr);
  if (stamp === null) return '';
  const today = dayStamp(todayStr);
  if (today !== null) {
    const offset = Math.round((stamp - today) / 86400000);
    if (offset === 0) return '今天';
    if (offset === 1) return '明天';
    if (offset === 2) return '后天';
  }
  return WEEKDAYS[new Date(stamp).getUTCDay()];
}

// 地理编码响应 → { name, label, latitude, longitude }；找不到城市返回 null
function parseGeocode(payload) {
  const hit = payload && Array.isArray(payload.results) ? payload.results[0] : null;
  if (!hit) return null;
  const latitude = Number(hit.latitude);
  const longitude = Number(hit.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const name = String(hit.name || '').trim();
  // 「北京 · 北京市 · 中国」这类重复项去掉，只留能区分城市的：名字 → 省/州 → 国家
  const parts = [];
  for (const raw of [name, hit.admin1, hit.country]) {
    const text = String(raw || '').trim();
    if (!text || parts.includes(text)) continue;
    parts.push(text);
  }
  return { name, label: parts.join(' ') || name, latitude, longitude };
}

// 预报响应 → { current, days, timezone }；关键字段缺失返回 null（当作坏数据，别画出半截）
function parseForecast(payload) {
  const current = payload && payload.current;
  const daily = payload && payload.daily;
  if (!current || !daily || !Array.isArray(daily.time)) return null;
  const temperature = round1(current.temperature_2m);
  if (temperature === null) return null;

  const isDay = Number(current.is_day) !== 0;
  const code = Number(current.weather_code);
  const describe = describeCode(code, isDay);

  const days = [];
  for (let i = 0; i < daily.time.length; i += 1) {
    const value = Number(daily.weather_code ? daily.weather_code[i] : NaN);
    const dayCode = Number.isFinite(value) ? value : code;
    const dayText = describeCode(dayCode, true);
    days.push({
      date: String(daily.time[i]),
      code: dayCode,
      text: dayText.text,
      icon: dayText.icon,
      max: round1(daily.temperature_2m_max ? daily.temperature_2m_max[i] : null),
      min: round1(daily.temperature_2m_min ? daily.temperature_2m_min[i] : null)
    });
  }

  return {
    current: {
      temperature,
      feelsLike: round1(current.apparent_temperature),
      humidity: Number.isFinite(Number(current.relative_humidity_2m))
        ? Number(current.relative_humidity_2m)
        : null,
      code,
      isDay,
      text: describe.text,
      icon: describe.icon,
      // 当地日期（'YYYY-MM-DD'）：算「今天/明天」要拿它当基准，
      // 用本机日期在天不亮或跨时区时会差一天
      date: String(current.time || '').slice(0, 10)
    },
    days,
    timezone: String(payload.timezone || '')
  };
}

// Dock 图标下面那行小字：'26°' ／ '26° 多云'（没数据就退回条目名）
function dockCaption(snapshot) {
  const current = snapshot && snapshot.current;
  if (!current || current.temperature === null || current.temperature === undefined) return '';
  const degree = Math.round(current.temperature) + '°';
  const text = String(current.text || '').trim();
  return text ? degree + ' ' + text : degree;
}

function geocodeUrl(city) {
  const query = String(city || '').trim().slice(0, CITY_MAX) || DEFAULT_CITY;
  const params = new URLSearchParams({
    name: query,
    count: '1',
    language: 'zh',
    format: 'json'
  });
  return `${GEOCODE_ENDPOINT}?${params.toString()}`;
}

function forecastUrl(latitude, longitude) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min',
    timezone: 'auto',
    forecast_days: String(FORECAST_DAYS)
  });
  return `${FORECAST_ENDPOINT}?${params.toString()}`;
}

// 悬浮卡片的窗口尺寸：城市一行 ＋ 当前温度一大块 ＋ 分隔线，然后每天一行。
// 窗口尺寸建窗时就要定下来（无边框窗口不能自动适应内容），所以这里算准。
const CARD_WIDTH = 272;
const CARD_HEAD = 96;
const CARD_ROW = 26;
const CARD_PAD = 10;

function cardSize(dayCount) {
  const rows = Math.max(1, Math.min(7, Number(dayCount) || 0));
  return { width: CARD_WIDTH, height: CARD_HEAD + rows * CARD_ROW + CARD_PAD };
}

// ------------------------------------------------------------------ 取数

// 取一个 JSON。失败一律抛错（上层把错误折进快照，不弹窗、不打断任何操作）。
function requestJson(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    let request;
    try {
      request = https.get(
        url,
        { headers: { accept: 'application/json', 'user-agent': 'DeskBasket' } },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            fail(new Error('HTTP ' + response.statusCode));
            return;
          }
          const chunks = [];
          let size = 0;
          response.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              request.destroy();
              fail(new Error('响应过大'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            if (settled) return;
            settled = true;
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (_) {
              reject(new Error('响应不是合法 JSON'));
            }
          });
        }
      );
    } catch (error) {
      fail(error);
      return;
    }
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      fail(new Error('请求超时'));
    });
    request.on('error', fail);
  });
}

// 城市名 → 经纬度（同一个城市在进程里只查一次，见 main.js 的缓存）
async function resolveCity(city, request = requestJson) {
  const query = String(city || '').trim().slice(0, CITY_MAX) || DEFAULT_CITY;
  const place = parseGeocode(await request(geocodeUrl(query)));
  if (!place) throw new Error(`找不到城市「${query}」`);
  return place;
}

// IP 定位响应 → { name, label, latitude, longitude }（只认成功且带坐标的响应）
function parseIpLocation(payload) {
  if (!payload || payload.success === false) return null;
  const latitude = Number(payload.latitude);
  const longitude = Number(payload.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const parts = [];
  for (const raw of [payload.city, payload.region, payload.country]) {
    const text = String(raw || '').trim();
    if (!text || parts.includes(text)) continue;
    parts.push(text);
  }
  return {
    name: String(payload.city || '').trim(),
    label: parts.join(' '),
    latitude,
    longitude
  };
}

// 设置里没填城市时的自动定位：IP → 城市名 → Open-Meteo 地理编码。
// 多这一步是因为 ipwho.is 只回英文（Hangzhou / Zhejiang Sheng），
// 而 Dock 卡片上写「杭州 浙江省 中国」才像个中文程序。
// 地理编码查不到（生僻地名）就退回 IP 给的坐标，宁可名字是英文，也要有天气。
async function resolveAutoPlace(request = requestJson) {
  const fromIp = parseIpLocation(await request(IP_LOOKUP_ENDPOINT));
  if (!fromIp) throw new Error('定位失败（IP 服务没有返回坐标）');
  if (fromIp.name) {
    try {
      const named = await resolveCity(fromIp.name, request);
      return { ...named, auto: true };
    } catch (_) {
      /* 名字查不到就用 IP 的坐标继续 */
    }
  }
  return { ...fromIp, auto: true };
}

// 有了坐标就只取预报（城市没换时省掉一次地理编码）
async function fetchForecast(place, request = requestJson) {
  const parsed = parseForecast(await request(forecastUrl(place.latitude, place.longitude)));
  if (!parsed) throw new Error('天气数据格式不对');
  return parsed;
}

// 一次完整取数：城市 → 坐标 → 当前天气 ＋ 未来几天
async function fetchWeather(city, request = requestJson) {
  const place = await resolveCity(city, request);
  return { place, ...(await fetchForecast(place, request)) };
}

module.exports = {
  CARD_HEAD,
  CARD_PAD,
  CARD_ROW,
  CARD_WIDTH,
  CITY_MAX,
  DEFAULT_CITY,
  FORECAST_DAYS,
  GEOCODE_ENDPOINT,
  FORECAST_ENDPOINT,
  IP_LOOKUP_ENDPOINT,
  REQUEST_TIMEOUT_MS,
  WMO_CODES,
  cardSize,
  dayLabel,
  describeCode,
  dockCaption,
  fetchForecast,
  fetchWeather,
  forecastUrl,
  geocodeUrl,
  parseForecast,
  parseGeocode,
  parseIpLocation,
  requestJson,
  resolveAutoPlace,
  resolveCity
};
