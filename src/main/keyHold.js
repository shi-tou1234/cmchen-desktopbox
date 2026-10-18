'use strict';

// 「按住某个组合键」需要知道它**什么时候松开**——globalShortcut 只在按下那一刻回调一次，
// 没有 keyup 回调，而"按住即抬起、松手落回"这个功能整个成败都在松手那一拍
// （Electron 也没有键盘钩子 API，拿不到 LL 钩子）。
//
// 能问的只有 Win32：GetAsyncKeyState 报的是**此刻物理按键是否按着**（最高位 0x8000）。
// 左右两侧的修饰键用通用 VK 一次覆盖（VK_SHIFT / VK_CONTROL / VK_MENU 左右都算；
// Win 键没有通用 VK，左键位 LWIN 与右键位 RWIN 都查，任一按着就算）。
//
// 做法与 mouseState.js 同形：起一个 PowerShell 小循环，每 POLL_MS 判一次整组键，
// **只在结果翻转时**往 stdout 写一行 `DESKBASKET_KEYS HELD` / `DESKBASKET_KEYS IDLE`
// （首帧必写：主进程起进程时键可能已经松了，得由这份首帧告诉它"已经结束了"）。
//
// 起不来 / 报数过期 / 非 Windows 一律当"问不到"：调用方（main.js 的 peek 看门狗）按超时
// 把 Dock 放回原位，绝不会把它卡在置顶状态。协议与解析全部拆成不依赖 Electron 的纯函数，可直接单测。

const { spawn } = require('node:child_process');
const fs = require('node:fs');

// 固定字面量：不按 PATH 挑可执行文件，避免被换成别的程序（与 mouseState / windowLayer 一致）
const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

const MARKER = 'DESKBASKET_KEYS ';
const POLL_MS = 40;          // 采样间隔：40ms 的延迟人眼读不出来，再密只是白烧 CPU
const HEARTBEAT_POLLS = 10;  // 连着这么多拍没翻转也要重报一次同一个状态（约 400ms，见下面）
const LINE_FRESH_MS = 900;   // 超过这么久没收到新行 = 报数过期，当"问不到"
const IDLE_STOP_MS = 30000;  // 松手后再过这么久收进程：留着比每次重付一遍 Add-Type 编译便宜
// 修饰键按下边沿的"保质期"：超过这么久之前按下的修饰键不算真按着（治幽灵键，见 SCRIPT 里那段）
const MODIFIER_FRESH_MS = 3000;

// Win32 虚拟键码（只列用得到的）。字母 A–Z = 0x41 起、数字 0–9 = 0x30 起、F1–F24 = 0x70 起，
// 标点与字母键共用 VK（`;` 和 `:` 都是 VK_OEM_1）——这正好是我们要的：判的是"那个物理键按着没有"。
const VK = {
  BACKSPACE: 0x08,
  TAB: 0x09,
  ENTER: 0x0d,
  SHIFT: 0x10,
  CONTROL: 0x11,
  MENU: 0x12,      // Alt
  CAPSLOCK: 0x14,
  ESCAPE: 0x1b,
  SPACE: 0x20,
  PAGEUP: 0x21,
  PAGEDOWN: 0x22,
  END: 0x23,
  HOME: 0x24,
  LEFT: 0x25,
  UP: 0x26,
  RIGHT: 0x27,
  DOWN: 0x28,
  PRINTSCREEN: 0x2c,
  INSERT: 0x2d,
  DELETE: 0x2e,
  LWIN: 0x5b,
  RWIN: 0x5c,
  NUMLOCK: 0x90,
  SCROLLLOCK: 0x91,
  SEMICOLON: 0xbb,   // ; :
  EQUAL: 0xbb,       // = +
  COMMA: 0xbc,       // , <
  MINUS: 0xbd,       // - _
  PERIOD: 0xbe,      // . >
  SLASH: 0xbf,       // / ?
  BACKQUOTE: 0xc0,   // ` ~
  LBRACKET: 0xdb,    // [ {
  BACKSLASH: 0xdc,   // \ |
  RBRACKET: 0xdd,    // ] }
  QUOTE: 0xde        // ' "
};

// 修饰键 → VK 组（一组里是"任一按着就算"：Win 键左右两侧各一个码）
const MODIFIER_GROUPS = {
  ctrl: [VK.CONTROL],
  control: [VK.CONTROL],
  alt: [VK.MENU],
  option: [VK.MENU],
  shift: [VK.SHIFT],
  super: [VK.LWIN, VK.RWIN],
  meta: [VK.LWIN, VK.RWIN],
  // Win / Windows 键的常见写法。Electron 只在文档里写了 Super/Meta，但实测 'Win'、
  // 'Super'、'Meta' 三种写法它都收；这里三种都认，用户在设置里怎么打都不至于"打错"
  win: [VK.LWIN, VK.RWIN],
  windows: [VK.LWIN, VK.RWIN],
  cmd: [VK.LWIN, VK.RWIN],
  command: [VK.LWIN, VK.RWIN],
  cmdorctrl: [VK.CONTROL],
  commandorcontrol: [VK.CONTROL]
};

const NAMED_KEYS = {
  space: [VK.SPACE],
  tab: [VK.TAB],
  enter: [VK.ENTER],
  return: [VK.ENTER],
  escape: [VK.ESCAPE],
  esc: [VK.ESCAPE],
  backspace: [VK.BACKSPACE],
  delete: [VK.DELETE],
  insert: [VK.INSERT],
  printscreen: [VK.PRINTSCREEN],
  up: [VK.UP],
  down: [VK.DOWN],
  left: [VK.LEFT],
  right: [VK.RIGHT],
  home: [VK.HOME],
  end: [VK.END],
  pageup: [VK.PAGEUP],
  pagedown: [VK.PAGEDOWN],
  capslock: [VK.CAPSLOCK],
  numlock: [VK.NUMLOCK],
  scrolllock: [VK.SCROLLLOCK],
  plus: [VK.EQUAL]     // Electron 里 "+" 这个键写作 Plus
};

const PUNCTUATION = {
  ';': VK.SEMICOLON,
  ':': VK.SEMICOLON,
  '=': VK.EQUAL,
  '+': VK.EQUAL,
  ',': VK.COMMA,
  '<': VK.COMMA,
  '-': VK.MINUS,
  _: VK.MINUS,
  '.': VK.PERIOD,
  '>': VK.PERIOD,
  '/': VK.SLASH,
  '?': VK.SLASH,
  '`': VK.BACKQUOTE,
  '~': VK.BACKQUOTE,
  '[': VK.LBRACKET,
  '{': VK.LBRACKET,
  '\\': VK.BACKSLASH,
  '|': VK.BACKSLASH,
  ']': VK.RBRACKET,
  '}': VK.RBRACKET,
  "'": VK.QUOTE,
  '"': VK.QUOTE
};

// 组合键里的一段 → VK 组；认不出来返回 null
function keyGroupOf(part) {
  const text = String(part === undefined || part === null ? '' : part).trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  const modifier = MODIFIER_GROUPS[lower];
  if (modifier) return modifier.slice();
  const named = NAMED_KEYS[lower];
  if (named) return named.slice();
  const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/.exec(lower);
  if (functionKey) return [0x6f + Number(functionKey[1])];
  if (lower.length === 1 && lower >= 'a' && lower <= 'z') return [0x40 + (lower.charCodeAt(0) - 0x60)];
  if (text.length === 1 && text >= '0' && text <= '9') return [0x30 + Number(text)];
  if (PUNCTUATION[text] !== undefined) return [PUNCTUATION[text]];
  return null;
}

// Electron 加速键字符串（'Ctrl+Win+Z'）→ 按住判据用的 VK 组数组。
// 返回 [] 表示"这个组合键没法判按住"：空串、只有修饰键（永远按着，判不出边沿）、
// 或者有不认识的键（宁可整个功能关掉，也不要拿着一个错的键码去问系统）。
function keyGroups(accelerator) {
  const text = String(accelerator === undefined || accelerator === null ? '' : accelerator).trim();
  if (!text) return [];
  const groups = [];
  let hasMainKey = false;
  for (const part of text.split('+')) {
    const group = keyGroupOf(part);
    if (!group) {
      // 分隔符本身（"Ctrl+" 尾巴那个空的、"Plus" 之外的悬空 '+'）跳过，其余一律判为不认识
      if (!String(part).trim()) continue;
      return [];
    }
    groups.push(group);
    if (!isModifierGroup(group)) hasMainKey = true;
  }
  if (!groups.length || !hasMainKey) return [];
  return groups;
}

function isModifierGroup(group) {
  return (group || []).every((vk) => Object.values(MODIFIER_GROUPS).some((mods) => mods.includes(vk)));
}

// 主键（那个非修饰键）在组数组里的下标；没有主键时返回 -1。
// 松手判定只看它：修饰键的异步状态会自己抖（Win 键最明显，真机实测按住时会掉几百毫秒），
// 拿"整组键同时按着"当按住的条件会在抖动那一拍误判成松手。
function mainGroupIndex(accelerator) {
  const groups = keyGroups(accelerator);
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    if (!isModifierGroup(groups[i])) return i;
  }
  return -1;
}

// 组 → 给 PowerShell 的紧凑写法：'5B|5C,7C'（逗号分隔各组，竖线分隔组内的候选）
function specFor(accelerator) {
  return keyGroups(accelerator)
    .map((group) => group.map((vk) => vk.toString(16).toUpperCase()).join('|'))
    .join(',');
}

// specFor 的逆运算（键码是十六进制）。给测试用（也顺手把"串出来的东西还能原样读回去"钉住）
function chordFromSpec(spec) {
  const text = String(spec === undefined || spec === null ? '' : spec).trim();
  if (!text) return [];
  const groups = [];
  for (const part of text.split(',')) {
    const group = [];
    for (const item of part.split('|')) {
      const n = Number.parseInt(item.trim(), 16);
      if (!Number.isInteger(n) || n <= 0) return [];
      group.push(n);
    }
    if (group.length) groups.push(group);
  }
  return groups;
}

// 整组键是不是**此刻全按着**（组内任一按着就算该组满足）。纯函数，判定判据全在这里
function isChordDown(groups, isDown) {
  if (!groups || !groups.length) return false;
  return groups.every((group) => group.some((vk) => Boolean(isDown(vk))));
}

const SCRIPT = `
$ErrorActionPreference = 'Stop'

$sig = @'
using System;
using System.Runtime.InteropServices;

public static class DeskBasketKeys {
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);
}
'@
Add-Type -TypeDefinition $sig

$groups = @()
foreach ($part in ($env:DESKBASKET_KEY_GROUPS -split ',')) {
    $codes = @()
    foreach ($item in ($part -split '\\|')) {
        # 键码是十六进制（'5B|5C,7C' 就是这个形状）——按十进制读会把 0x20 读成 0x14（CapLock），
        # 于是"按住空格"变成"按住大写锁定"，功能看起来没反应
        $n = -1
        try { $n = [Convert]::ToInt32($item.Trim(), 16) } catch { $n = -1 }
        if ($n -gt 0) { $codes += $n }
    }
    if ($codes.Count -gt 0) { $groups += ,$codes }
}
if ($groups.Count -eq 0) {
    [Console]::Out.WriteLine('${MARKER}NONE')
    [Console]::Out.Flush()
    exit
}

$last = ''
$sinceReport = 0

# 主键（那个非修饰键）的组号。**松手只看它**——修饰键的异步状态会自己抖：真机实测按住
# Ctrl+Win+Z 时 Win 键的状态会掉出几百毫秒（开始菜单/徽标预览在抢它），那时 Z 还稳稳按着，
# 人显然还在"按住"。早期版本要求整组键同时按着才算按着，于是按住 3 秒就被当成松手、
# Dock 自己落回桌面层（用户报"图标出来了却点不动"）。
$mainIndex = [int]$env:DESKBASKET_KEY_MAIN
if ($mainIndex -lt 0 -or $mainIndex -ge $groups.Count) { $mainIndex = $groups.Count - 1 }

function Down($codes) {
    foreach ($vk in $codes) {
        # 取最高位 0x8000 = "此刻按着"。别用最低位 0x0001：那是"上一次调用之后按过"的
        # 锁存位，这个循环每 40ms 自己查一次，等于每次把自己上一轮置起的锁存位吃掉——
        # 按住不放也永远报不出来（mouseState 那边踩过这个坑）。
        if (([DeskBasketKeys]::GetAsyncKeyState([int]$vk) -band 0x8000) -ne 0) { return $true }
    }
    return $false
}

# 修饰键的"新鲜度"：只有**最近 ${MODIFIER_FRESH_MS} 毫秒内亲眼看见它从抬起变成按下**，
# 才算此刻真的有人按着它。治的是 Win 键的幽灵状态——单独点一下 Win（开始菜单把那次按键吃掉）
# 之后 GetAsyncKeyState(LWIN) 还会有一阵子报"按着"，这时候按 Ctrl+Z 就被凑成整组键，
# 于是"按 Ctrl+Z 也会把 Dock 抬起来"（用户报过一次）。
# 为什么用"边沿新鲜度"而不是"是否见过按下过"：真按一次组合键时三个键的边沿都落在一秒之内，
# 而幽灵键那个"按下"发生在不知道多久以前——几秒后就过期了，不再冒充。
$wasDown = @{}
$lastEdge = @{}
for ($i = 0; $i -lt $groups.Count; $i++) {
    $wasDown[$i] = (Down $groups[$i])
    $lastEdge[$i] = -1000000      # 从没见它按下过 = 永远不新鲜
}

$sw = [Diagnostics.Stopwatch]::StartNew()
while ($true) {
    $now = [int]$sw.ElapsedMilliseconds
    $down = @()
    $age = @()
    $allDown = $true
    $allFresh = $true
    for ($i = 0; $i -lt $groups.Count; $i++) {
        $d = Down $groups[$i]
        if ($d -and -not $wasDown[$i]) { $lastEdge[$i] = $now }   # up → down 的边沿
        $wasDown[$i] = $d
        $down += $d
        $age += ($now - $lastEdge[$i])
        if (-not $d) { $allDown = $false }
        if ($i -ne $mainIndex -and ($now - $lastEdge[$i]) -gt ${MODIFIER_FRESH_MS}) { $allFresh = $false }
    }

    if (-not $down[$mainIndex]) {
        $state = 'IDLE'
    } elseif ($allDown -and $allFresh) {
        $state = 'HELD'
    } else {
        # 主键按着、但修饰键掉了或早就不新鲜了 = 人还在按住（LOOSE），不许当成松手，
        # 更不许当成"用户按下了组合键"
        $state = 'LOOSE'
    }
    # 翻转时立刻报，另外每隔 ${HEARTBEAT_POLLS} 拍把同一个状态再报一次（心跳）。
    # 心跳不是冗余：主进程用"多久没收到新行"判断这个进程还活着、按住还在继续。
    # 只报翻转的话，按住期间整个循环一声不吭——真机上按 3 秒就被当成"问不到按键状态"
    # 而强制落回（明明键还按着），心跳就是治这个的。
    if ($state -ne $last -or $sinceReport -ge ${HEARTBEAT_POLLS}) {
        # 带上观测细节（ASCII：PowerShell 走管道时非 ASCII 会被改写）。d= 每组此刻按没按着，
        # age= 每组"按下边沿"距今多少毫秒（幽灵键的 age 会很大，真按一次则三个都很小）。
        # 报障时缺的就是这个：只说"抬起了一次"看不出系统当时到底看见了哪几个键。
        [Console]::Out.WriteLine('${MARKER}' + $state + ' d=' + ($down -join '') + ' age=' + ($age -join ','))
        [Console]::Out.Flush()
        $last = $state
        $sinceReport = 0
    } else {
        $sinceReport += 1
    }
    Start-Sleep -Milliseconds ${POLL_MS}
}
`;

// 一行报数 → 'HELD' | 'LOOSE' | 'IDLE' | 'NONE'（组合键不可用）；不认识的行返回 null。
// 状态后面可能跟着观测细节（`d=110 age=120,80,340`），只取第一个词当状态。
function parseReport(line) {
  const text = String(line === undefined || line === null ? '' : line).trim();
  const at = text.indexOf(MARKER);
  if (at < 0) return null;
  const state = text.slice(at + MARKER.length).trim().split(/\s+/)[0].toUpperCase();
  return state === 'HELD' || state === 'LOOSE' || state === 'IDLE' || state === 'NONE' ? state : null;
}

// 报数里的观测细节（每组此刻按没按着 + 按下边沿的年龄），取出来给人看
function parseReportDetail(line) {
  const text = String(line === undefined || line === null ? '' : line);
  const at = text.indexOf(MARKER);
  if (at < 0) return null;
  const m = /\sd=(\d+)\s+age=(-?\d+(?:,-?\d+)*)/.exec(text.slice(at));
  if (!m) return null;
  return {
    down: m[1].split('').map((c) => c === '1'),
    ages: m[2].split(',').map((n) => Number.parseInt(n, 10))
  };
}

// 修饰键与 Win 键的标签：NAMED_KEYS 只管具名键（空格、回车那些），修饰键不在里面，
// 但日志里恰恰最该看清的是"Win 键按了多久"。
const VK_LABELS = {
  [VK.SHIFT]: 'shift',
  [VK.CONTROL]: 'ctrl',
  [VK.MENU]: 'alt',
  [VK.LWIN]: 'win',
  [VK.RWIN]: 'rwin'
};

// 虚拟键码 → 好读的标签（纯 ASCII：PowerShell 管道会改写非 ASCII，标签在 JS 这边拼）
function vkLabel(vk) {
  const code = Number(vk);
  if (VK_LABELS[code]) return VK_LABELS[code];
  if (code >= 0x41 && code <= 0x5a) return String.fromCharCode(code);
  if (code >= 0x30 && code <= 0x39) return String(code - 0x30);
  if (code >= 0x70 && code <= 0x87) return `F${code - 0x6f}`;
  const hit = Object.entries(NAMED_KEYS).find(([, codes]) => codes[0] === code);
  return hit ? hit[0] : `0x${code.toString(16).toUpperCase()}`;
}

// 把观测细节拼成人话：'ctrl=down/120ms win=down/80ms z=down/340ms'
// 报障时最缺的就是这句——它能一眼分出"Win 键是幽灵按着"（win 的 age 很大）与"真按了"（都很小）。
function describeReport(detail, groups = []) {
  if (!detail || !Array.isArray(detail.down)) return '';
  return groups
    .map((group, i) => {
      const name = group.map(vkLabel).join('/');
      const state = detail.down[i] ? 'down' : 'up';
      const age = Number.isFinite(detail.ages[i]) ? detail.ages[i] : '?';
      return `${name}=${state}/${age}ms`;
    })
    .join(' ');
}

// 'HELD' / 'LOOSE' 都算"还按着"，'IDLE' 才是松手
function isHeldState(state) {
  return state === 'HELD' || state === 'LOOSE';
}

// 轮询能不能当"抬起"的触发源。
//
// 默认**可以**，而且这才是可靠的那条路：`globalShortcut`（WM_HOTKEY）在真机上会漏发
// ——注入实测同一组键上一轮触发、下一轮 0 次（注册日志一直好好地在那儿，纯粹是消息没来），
// 只靠它会出现"按住没反应"。
//
// 那为什么不让它单独管触发？因为轮询读的是 `GetAsyncKeyState`，它分不出"真的按着"和
// "幽灵状态"：单独点一下 Win（开始菜单把那次按键吃掉）之后 LWIN 还会报一阵子"按着"，
// 那段时间里按 Ctrl+Z 就被凑成整组键、Dock 被平白抬起来（用户报过一次）。
// 治法在 SCRIPT 里：修饰键的"按下边沿"有保质期（`MODIFIER_FRESH_MS`）——幽灵键那个边沿发生在
// 不知道多久以前，早就过期；真按一次组合键时三个键的边沿都在一秒之内。
// 两条路合起来：WM_HOTKEY 零延迟、且不会被幽灵键骗；轮询不漏、且被新鲜度规则护住。
// 两条都到时 beginPeek 是幂等的，重复触发没有副作用。
let triggerEnabled = true;

function setTriggerEnabled(enabled) {
  triggerEnabled = Boolean(enabled);
}

function canTrigger() {
  return triggerEnabled;
}

// 最近一次报数附带的观测细节（'d=...' / 'age=...'），主进程抬起时拿它写日志
function lastDetail() {
  return latestDetail;
}

// 心跳与状态分开：心跳那一路只更新时间戳（lastLineAt），不通知调用方。
// 所以 publish 的次数只看状态翻转，按住期间不会把 beginPeek 空转几百次。

let child = null;
let latest = null;
let latestDetail = null;
let lastLineAt = 0;
let startedAt = 0;
let buffer = '';
let idleTimer = null;
let announced = false;
let permanent = false;
let runningSpec = '';
const handlers = new Set();

// 'HELD' / 'IDLE' → 通知（去重，同一状态连报不重复喊）；'NONE' 与解析失败 → 通知 null（= 问不到）
function publish(state) {
  for (const handler of [...handlers]) {
    try {
      handler(state);
    } catch (_) {
      /* 调用方自己兜底：功能照旧，不该因为一个 handler 出错把这条链路带走 */
    }
  }
}

function forget(proc) {
  if (child !== proc) return;
  child = null;
  latest = null;
  lastLineAt = 0;
  runningSpec = '';
}

function stop() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const proc = child;
  child = null;
  latest = null;
  lastLineAt = 0;
  startedAt = 0;
  buffer = '';
  runningSpec = '';
  if (!proc) return;
  try {
    proc.kill();
  } catch (_) {
    /* 可能已经退出 */
  }
}

// 起一个按键侦察循环。spec 用 specFor 算出来的 '5B|5C,7C' 这种；空串 = 关掉。
// mainIndex 是主键的组号（松手只看它，见 mainGroupIndex）；已经在跑且盯的是同一组键就复用。
function ensureRunning(spec, mainIndex = -1) {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const want = String(spec || '').trim();
  if (!want) {
    stop();
    return false;
  }
  if (child) {
    if (runningSpec === want) return true;
    stop();   // 组合键换了：旧进程盯的键码已经没用了
  }
  if (process.platform !== 'win32' || !fs.existsSync(POWERSHELL_EXE)) return false;
  let proc;
  try {
    proc = spawn(
      POWERSHELL_EXE,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(SCRIPT, 'utf16le').toString('base64')
      ],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          ...process.env,
          DESKBASKET_KEY_GROUPS: want,
          DESKBASKET_KEY_MAIN: String(Number.isInteger(mainIndex) ? mainIndex : -1)
        }
      }
    );
  } catch (_) {
    return false;
  }
  child = proc;
  startedAt = Date.now();
  runningSpec = want;
  buffer = '';
  if (!announced) {
    announced = true;
    console.log('[peek] 起了按键侦察进程（按住/松手判定用，随应用退出）');
  }
  proc.stdout.on('data', (chunk) => {
    if (child !== proc) return;
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const state = parseReport(line);
      if (!state) continue;
      if (state === 'NONE') {
        console.log('[peek] 侦察进程说这组键码不可用');
        publish(null);
        continue;
      }
      lastLineAt = Date.now();
      // 把这一行附带的观测细节（每组按没按着 + 边沿年龄）留住：报障时全靠它判断
      // "Win 键是幽灵按着"还是"人真按了"。心跳也会刷新它，抬起那一刻读到的是最新值。
      latestDetail = parseReportDetail(line);
      // 三态各管一件事，别把它们混成"按着/没按着"两个值：
      //   HELD  （整组键全按着）→ **抬起**：这才是"用户真的按下了组合键"的那一刻；
      //   LOOSE （主键按着、修饰键掉了）→ 什么也不发，人还在按住，Win 键抖一下不该摇他；
      //   IDLE  → **落回**：主键松了。
      // 早期版本只有 HELD/IDLE 两个值，于是修饰键一抖就被当成松手；再早一点把 HELD 当成
      // "还按着"持续发，又会在 LOOSE 上误触发（那时用户可能只是单按了主键）。
      const before = latest;
      latest = state;
      if (state === 'HELD' && before !== 'HELD' && canTrigger()) publish(true);
      else if (before && isHeldState(before) && state === 'IDLE') publish(false);
    }
  });
  // 进程出问题就"问不到"：主进程的超时看门狗会把 Dock 放回原位（不会卡在置顶）
  proc.on('error', (error) => {
    console.log(`[peek] 侦察进程出错：${String((error && error.message) || error)}`);
    forget(proc);
    publish(null);
  });
  proc.on('close', () => {
    const was = child === proc;
    forget(proc);
    if (was) publish(null);
  });
  return true;
}

// 松手之后收进程（与 mouseState 同一取舍：下次按住随时要重来一遍，留着比每次重付编译便宜）
function scheduleIdleStop() {
  if (permanent) return;   // globalShortcut 注册失败时的兜底模式：常驻，不再收
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    stop();
  }, IDLE_STOP_MS);
}

// 常驻模式：抬起判定是主路（系统不一定把 WM_HOTKEY 送到我们窗口，真机上实测过
// "注册日志还在、消息就是不来"），所以这个循环从启动就挂着，不能靠 scheduleIdleStop 收。
// 功能关掉时调用方显式 stop()。
function keepRunning(spec, mainIndex = -1) {
  permanent = true;
  return ensureRunning(spec, mainIndex);
}

function onChange(handler) {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

// 取当前状态（带 at：这份报数是什么时候到的）。问不到时 known=false、held=false，
// 调用方据此走超时兜底而不是当成"用户还按着"。
function poll(now = Date.now()) {
  if (child && latest && now - lastLineAt <= LINE_FRESH_MS) {
    return { active: true, known: true, held: isHeldState(latest), at: lastLineAt };
  }
  if (child && !latest && now - startedAt < LINE_FRESH_MS) {
    return { active: true, known: false, held: false, grace: true, at: 0 };
  }
  return { active: Boolean(child), known: false, held: false, grace: false, at: 0 };
}

module.exports = {
  HEARTBEAT_POLLS,
  IDLE_STOP_MS,
  LINE_FRESH_MS,
  MARKER,
  MODIFIER_FRESH_MS,
  MODIFIER_GROUPS,
  POLL_MS,
  VK,
  canTrigger,
  chordFromSpec,
  describeReport,
  ensureRunning,
  isChordDown,
  isHeldState,
  keepRunning,
  keyGroupOf,
  keyGroups,
  lastDetail,
  mainGroupIndex,
  onChange,
  parseReport,
  parseReportDetail,
  poll,
  scheduleIdleStop,
  setTriggerEnabled,
  specFor,
  stop
};