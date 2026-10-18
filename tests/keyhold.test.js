'use strict';

// 「按住即抬」这条链路的纯逻辑单测（node --test，不碰 Electron）。
//
// 钉住三件事：
//   ①组合键 → Win32 键码的翻译表（写错一个键码，功能就悄悄按了别的键，而且只有真机能发现）；
//   ②报数协议的解析（PowerShell 那行报数认不出来时必须返回 null 而不是"没按着"，
//     否则一次进程起不来就会被当成松手）；
//   ③main.js 里那几处"按住期间不许往下压 / 松手要还回去"的接线（用源码文本钉住，
//     与 tests/launch.test.js 钉判读标记同一个路子）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const keyHold = require('../src/main/keyHold');
const store = require('../src/main/store');

const VK = keyHold.VK;

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');

// 只取 keyHold.js 里那段 PowerShell 脚本文本：断言打在这上面，失败时不会把整个文件
// （几千行中文注释）倒进错误输出里
function scriptSource() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'keyHold.js'), 'utf8');
  const from = source.indexOf('const SCRIPT = `');
  const to = source.indexOf('\n`;', from);
  return source.slice(from, to);
}

// 按名字截出一个函数的函数体（数括号，遇到第一个配平的 } 为止）
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

// ------------------------------------------------------------------ 组合键 → 键码

test('组合键：修饰键用通用 VK，Win 键左右两侧都收进来', () => {
  assert.deepStrictEqual(keyHold.keyGroups('Ctrl+Alt+Space'), [
    [VK.CONTROL],
    [VK.MENU],
    [VK.SPACE]
  ]);
  // 一个组合键只回答"哪些键要按着"，组内是"任一按着就算"：左 Win 与右 Win 都得算
  assert.deepStrictEqual(keyHold.keyGroups('Super+F13'), [[VK.LWIN, VK.RWIN], [0x7c]]);
  assert.deepStrictEqual(keyHold.keyGroups('Shift+Alt+7'), [[VK.SHIFT], [VK.MENU], [0x37]]);
  assert.deepStrictEqual(keyHold.keyGroups('CmdOrCtrl+Space'), [[VK.CONTROL], [VK.SPACE]]);
});

test('组合键：功能键 F1～F24 的 VK 必须连续', () => {
  assert.deepStrictEqual(keyHold.keyGroups('F1'), [[0x70]]);
  assert.deepStrictEqual(keyHold.keyGroups('F9'), [[0x78]]);
  assert.deepStrictEqual(keyHold.keyGroups('F13'), [[0x7c]]);
  assert.deepStrictEqual(keyHold.keyGroups('F24'), [[0x87]]);
  assert.deepStrictEqual(keyHold.keyGroups('F25'), [], 'F25 不存在，不能瞎给一个键码');
  assert.deepStrictEqual(keyHold.keyGroups('f13'), [[0x7c]], '大小写不敏感');
});

test('组合键：字母/数字/标点都落在各自那段 VK 上', () => {
  assert.deepStrictEqual(keyHold.keyGroups('A'), [[0x41]]);
  assert.deepStrictEqual(keyHold.keyGroups('z'), [[0x5a]]);
  assert.deepStrictEqual(keyHold.keyGroups('0'), [[0x30]]);
  assert.deepStrictEqual(keyHold.keyGroups('9'), [[0x39]]);
  assert.deepStrictEqual(keyHold.keyGroups('`'), [[0xc0]]);
  assert.deepStrictEqual(keyHold.keyGroups(';'), [[VK.SEMICOLON]]);
  assert.deepStrictEqual(keyHold.keyGroups('Ctrl+Plus'), [[VK.CONTROL], [VK.EQUAL]]);
});

test('组合键：判不出"什么时候松开"的组合键一律给空数组（功能整体关掉，而不是猜一个键）', () => {
  assert.deepStrictEqual(keyHold.keyGroups(''), []);
  assert.deepStrictEqual(keyHold.keyGroups(null), []);
  assert.deepStrictEqual(keyHold.keyGroups('   '), []);
  assert.deepStrictEqual(keyHold.keyGroups('Ctrl'), [], '只有修饰键：按着就是按着，判不出边沿');
  assert.deepStrictEqual(keyHold.keyGroups('Ctrl+Alt+Shift'), []);
  assert.deepStrictEqual(keyHold.keyGroups('Ctrl+'), [], '"Ctrl+" 是没写完的组合键');
  assert.deepStrictEqual(keyHold.keyGroups('Ctrl+Nope'), [], '不认识的键名不能当成某个键去问系统');
  assert.deepStrictEqual(keyHold.keyGroups('Ctrl+Ctrl+Space'), [[VK.CONTROL], [VK.CONTROL], [VK.SPACE]]);
});

test('组合键：串给 PowerShell 的规格要能原样读回来', () => {
  assert.strictEqual(keyHold.specFor('Ctrl+Alt+Space'), '11,12,20');
  assert.strictEqual(keyHold.specFor('Super+F13'), '5B|5C,7C');
  assert.strictEqual(keyHold.specFor('乱写的'), '');
  for (const combo of ['Ctrl+Alt+Space', 'Super+F13', 'Shift+F1', 'Ctrl+Alt+Shift+D']) {
    const groups = keyHold.keyGroups(combo);
    assert.deepStrictEqual(
      keyHold.chordFromSpec(keyHold.specFor(combo)),
      groups,
      `${combo} 的规格读回来必须还是同一组键`
    );
  }
  assert.deepStrictEqual(keyHold.chordFromSpec(''), []);
  assert.deepStrictEqual(keyHold.chordFromSpec('11,oops'), [], '规格里有非数字就整份作废');
});

test('按住判定：整组键全按着才算按住（这正是 PowerShell 里那段循环的判据）', () => {
  const groups = keyHold.keyGroups('Ctrl+Alt+Space');
  const down = (...vks) => (vk) => vks.includes(vk);
  assert.strictEqual(keyHold.isChordDown(groups, down(VK.CONTROL, VK.MENU, VK.SPACE)), true);
  assert.strictEqual(keyHold.isChordDown(groups, down(VK.CONTROL, VK.MENU)), false, '少一个就不算');
  assert.strictEqual(keyHold.isChordDown(groups, down(VK.CONTROL, VK.MENU, 0x41)), false);
  assert.strictEqual(keyHold.isChordDown([], down(VK.SPACE)), false, '空规格永远不算按住');
  assert.strictEqual(keyHold.isChordDown(groups, down()), false, '一个都没按不算');
  // Win 键组是"任一"：左 Win 按着就够了（这条必须带着主键问——"Super" 单独是判不出边沿的）
  const superChord = keyHold.keyGroups('Super+F13');
  assert.strictEqual(keyHold.isChordDown(superChord, down(VK.LWIN, 0x7c)), true);
  assert.strictEqual(keyHold.isChordDown(superChord, down(VK.RWIN, 0x7c)), true);
  assert.strictEqual(keyHold.isChordDown(superChord, down(VK.LWIN)), false, '少了主键不算');
});

// ------------------------------------------------------------------ 报数协议

test('报数：一行认得出状态，认不出的一律 null（null 交给看门狗，不能当成"松手了"）', () => {
  assert.strictEqual(keyHold.parseReport(`${keyHold.MARKER}HELD`), 'HELD');
  assert.strictEqual(keyHold.parseReport(`${keyHold.MARKER}IDLE`), 'IDLE');
  assert.strictEqual(keyHold.parseReport(`  ${keyHold.MARKER}held\r\n`), 'HELD', '前后空白与大小写都要容得下');
  assert.strictEqual(keyHold.parseReport(`${keyHold.MARKER}NONE`), 'NONE');
  assert.strictEqual(keyHold.parseReport('HELD'), null, '少标记行 = 别的进程混进来了');
  assert.strictEqual(keyHold.parseReport(`${keyHold.MARKER}WAT`), null);
  assert.strictEqual(keyHold.parseReport(''), null);
  assert.strictEqual(keyHold.parseReport(null), null);
});

test('报数要带心跳：按住期间循环不能一声不吭（否则主进程会误判"问不到"）', () => {
  // 真机踩过的坑：只报翻转的话，按住 3 秒后 Dock 自己落回桌面层、图标还在但点不动，
  // 因为主进程拿"多久没收到新行"当进程存活信号，按住期间一条新行都没有。
  // 治法是心跳——同一个状态每隔 HEARTBEAT_POLLS 拍再报一次。
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'keyHold.js'), 'utf8');
  assert.match(
    source,
    /\$sinceReport -ge \$\{HEARTBEAT_POLLS\}/,
    '脚本里必须有心跳分支（翻转之外的定期重报）'
  );
  assert.match(source, /\$sinceReport \+= 1/, '没到心跳间隔时要计数');
  assert.ok(
    keyHold.HEARTBEAT_POLLS * keyHold.POLL_MS < keyHold.LINE_FRESH_MS,
    '心跳间隔必须明显小于"报数过期"阈值，否则按住期间照样会被误判成问不到'
  );
  // 心跳不能变成重复触发：publish 只在三态**翻转**时调
  const publishAt = source.indexOf("if (state === 'HELD' && before !== 'HELD'");
  assert.match(
    source.slice(publishAt, publishAt + 220),
    /^if \(state === 'HELD' && before !== 'HELD' && canTrigger\(\)\) publish\(true\);\s*\n\s*else if \(before && isHeldState\(before\) && state === 'IDLE'\) publish\(false\);/,
    '抬起只在进入 HELD 时发、松手只在掉到 IDLE 时发；心跳那一路不许 notify'
  );
});

test('默认：选的不是系统保留的那几组', () => {
  // 系统留给自己的是 Win+E / Win+D / Win+R 这类**不带 Ctrl** 的组合，以及 Win+Ctrl+Q、
  // Win+Ctrl+K 这几个少数派；输入法的中英切换是 Ctrl+Space / Shift+Space；
  // Ctrl+Esc / Ctrl+Alt+Del / Ctrl+Shift+Esc / Alt+Tab 是系统级。
  // 默认这一组（Ctrl+Win+Z）哪一类都不属于，也不该是各家软件的"退出/关窗"键。
  const def = store.DEFAULTS.dock_peek_hotkey;
  assert.ok(
    !/^(Ctrl\+(Space|Escape)|Win\+|Super\+|Command\+|Ctrl\+Alt\+(Del|Delete)|Ctrl\+Shift\+Escape|Alt\+(Tab|F4))/i.test(def),
    `默认组合键撞上了系统/输入法的保留键：${def}`
  );
  assert.doesNotMatch(def, /^Ctrl\+[QW]$/i, '"退出/关窗"类按键键不当默认');
});

test('松手只看主键：修饰键的异步状态会自己抖，抖一下不等于松手', () => {
  // 真机踩到的第二个坑：按住 Ctrl+Win+Z 时，Win 键的状态会掉出几百毫秒（开始菜单/
  // 徽标预览在抢它），而 Z 还稳稳按着。早期版本要求"整组键同时按着"才算按住，
  // 于是按住 3 秒就被判成松手、Dock 自己落回——用户报"图标出来了却点不动"。
  assert.strictEqual(keyHold.mainGroupIndex('Ctrl+Win+Z'), 2, '主键 Z 在第 3 组');
  assert.strictEqual(keyHold.mainGroupIndex('Ctrl+Alt+G'), 2);
  assert.strictEqual(keyHold.mainGroupIndex('F13'), 0, '单键组合：主键就是第 1 组');
  assert.strictEqual(keyHold.mainGroupIndex('Z+Ctrl'), 0, '修饰键写在后面也能找对');
  assert.strictEqual(keyHold.mainGroupIndex('Ctrl+Alt'), -1, '没有主键就没有松手判据');
  assert.strictEqual(keyHold.mainGroupIndex(''), -1);

  // 'HELD' 与 'LOOSE' 都算"还按着"，只有 'IDLE' 才是松手
  assert.strictEqual(keyHold.isHeldState('HELD'), true);
  assert.strictEqual(keyHold.isHeldState('LOOSE'), true, '修饰键掉了但主键还在 = 还在按住');
  assert.strictEqual(keyHold.isHeldState('IDLE'), false);
  assert.strictEqual(keyHold.isHeldState('NONE'), false);
  assert.strictEqual(keyHold.parseReport(`${keyHold.MARKER}LOOSE`), 'LOOSE');

  // 脚本必须真的按主键判松手，别又写回"整组键同时按着"
  const script = scriptSource();
  assert.match(
    script,
    /if \(-not \$down\[\$mainIndex\]\) \{/,
    '脚本的 IDLE 判定必须只看主键那一组'
  );
  assert.match(script, /DESKBASKET_KEY_MAIN/, '主键组号要通过环境变量传给脚本');
  // 仍然要认 HELD（整组全按着）与 LOOSE（主键按着、修饰键掉了）的区别
  assert.match(script, /\$state = 'HELD'/);
  assert.match(script, /\$state = 'LOOSE'/);
});

test('报数里带着观测细节：抬起那一刻要能说出系统当时看见了哪几个键', () => {
  // 用户报"按 Ctrl+Z 也会把 Dock 抬起来"，而注入测出来完全正常——差在真键盘那一刻
  // GetAsyncKeyState 到底看见了什么。日志里只有"抬起了一次"是查不出这件事的，
  // 所以脚本必须把每组按没按着、按下的边沿有多老一并报上来。
  const detail = keyHold.parseReportDetail(
    `${keyHold.MARKER}HELD d=111 age=120,80,340`
  );
  assert.deepStrictEqual(detail.down, [true, true, true], 'd=111 → 三组此刻全按着');
  assert.deepStrictEqual(detail.ages, [120, 80, 340], 'age 按组给，毫秒');

  // 老版本没这串字段（或者行被截断）时要老实说"没有"，不能拿 undefined 凑
  assert.strictEqual(keyHold.parseReportDetail(`${keyHold.MARKER}IDLE`), null);
  assert.strictEqual(keyHold.parseReportDetail('随便一行'), null);

  // 状态词后面跟着细节，parseReport 仍只取第一个词（别把整行当状态）
  assert.strictEqual(
    keyHold.parseReport(`${keyHold.MARKER}HELD d=111 age=1,2,3`),
    'HELD',
    '带细节的行也要解析出状态'
  );

  // 拼成人话：给键名 + 此刻按没按 + 边沿年龄
  const groups = keyHold.keyGroups('Ctrl+Win+Z');
  const text = keyHold.describeReport(detail, groups);
  assert.match(text, /^ctrl=down\/120ms /, '第一组是 Ctrl，120ms 前按下的');
  assert.match(text, /win\/rwin=down\/80ms /, '第二组是 Win（左右两个键位合成一组）');
  assert.match(text, /Z=down\/340ms$/, '第三组是主键 Z（字母键码按大写字母记，和键帽一致）');
  assert.strictEqual(keyHold.describeReport(null, groups), '');

  // 有组没按着时也要说出来（那正是"幽灵键没按、所以不该触发"的现场）
  const loose = keyHold.parseReportDetail(`${keyHold.MARKER}LOOSE d=011 age=5,9000,300`);
  assert.match(
    keyHold.describeReport(loose, groups),
    /ctrl=up\/5ms win\/rwin=down\/9000ms Z=down\/300ms/,
    'Win 键的边沿已经 9 秒了（早过期），这行就是幽灵状态的现场证据'
  );

  // 脚本必须真的把这两串报上来
  const script = scriptSource();
  assert.match(script, /\$age \+= \(\$now - \$lastEdge\[\$i\]\)/, '每组都要算出边沿年龄');
  assert.match(script, /' d=' \+ \(\$down -join ''\) \+ ' age=' \+ \(\$age -join ','\)/,
    '报数行要带上 d= 与 age=');

  // main.js 抬起时要把这行打出来，否则采集了没人看
  assert.match(
    functionBody(MAIN_SOURCE, 'onPeekKeyState'),
    /console\.log\(`\[peek\] 侦察观测：\$\{seen\}`\)/,
    '侦察触发起抬起时必须打出它看见了什么'
  );
});

test('接线：抬起靠两条路合起来——热键消息零延迟、轮询不漏发', () => {
  // 真机实测过三件事，缺一不可：
  //   ① WM_HOTKEY 会漏发：注入同一组键，上一轮触发、下一轮 0 次，注册日志一直好好地在那儿；
  //   ② 轮询（GetAsyncKeyState）不会漏，但会被幽灵修饰键骗出假组合（按 Ctrl+Z 却抬起）；
  //   ③ 因此轮询必须留着当触发源，并由 keyHold 的"边沿新鲜度"规则挡住幽灵键。
  const register = functionBody(MAIN_SOURCE, 'registerPeekHotkey');
  assert.match(
    register,
    /keyHold\.setTriggerEnabled\(true\)/,
    '热键注册成功与否，轮询都要留着当触发源（WM_HOTKEY 会漏发）'
  );
  assert.match(
    register,
    /globalShortcut\.register\(combo, \(\) => beginPeek\('热键'\)\)/,
    '热键回调要标明来源，日志里能看出是"热键"还是"按键侦察"到的'
  );
  assert.match(
    register,
    /keyHold\.keepRunning\(peekSpec\(\), peekMainIndex\(\)\)/,
    '注册热键时必须同时把按键侦察循环拉起来（常驻）'
  );
  assert.match(register, /keyHold\.stop\(\)/, '功能关掉时要把侦察循环收掉');
  assert.match(
    functionBody(MAIN_SOURCE, 'beginPeek'),
    /if \(peekHeld\) return;/,
    'beginPeek 必须幂等：两条路都会为同一次按下报一次'
  );
  assert.match(
    functionBody(MAIN_SOURCE, 'onPeekKeyState'),
    /beginPeek\('按键侦察'\)/,
    '轮询触发起抬起时要在日志里标明来源'
  );
  // keyHold 侧：轮询默认可触发；脚本要有"修饰键边沿新鲜度"
  assert.strictEqual(keyHold.canTrigger(), true, '轮询是可靠的那条路，默认就该能触发');
  const script = scriptSource();
  assert.match(
    script,
    /if \(\$d -and -not \$wasDown\[\$i\]\) \{ \$lastEdge\[\$i\] = \$now \}/,
    '修饰键按下时要记下边沿时刻'
  );
  assert.match(
    script,
    /\$allDown -and \$allFresh/,
    'HELD 要求全按着**且修饰键边沿都还在保质期内**（幽灵键的边沿早过期了）'
  );
  assert.ok(
    keyHold.MODIFIER_FRESH_MS >= 1000,
    '保质期至少要覆盖一次正常按键（人手再慢也在一秒内按下三个键）'
  );
  assert.ok(
    keyHold.MODIFIER_FRESH_MS < 10000,
    `保质期 ${keyHold.MODIFIER_FRESH_MS}ms 太长，幽灵键能撑那么久不露馅`
  );
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'keyHold.js'), 'utf8');
  const publishAt = source.indexOf("if (state === 'HELD' && before !== 'HELD'");
  assert.match(
    source.slice(publishAt, publishAt + 120),
    /^if \(state === 'HELD' && before !== 'HELD' && canTrigger\(\)\) publish\(true\);/,
    '抬起由轮询在 canTrigger() 为真时发出'
  );
});

test('按键状态：没在跑就是"问不到"，poll 不得凭空报出按住', () => {
  const now = Date.now();
  const cold = keyHold.poll(now);
  assert.strictEqual(cold.known, false);
  assert.strictEqual(cold.held, false);
  assert.strictEqual(cold.active, false);
});

test('按键状态：stop 幂等（will-quit 里会停一次，异常路径可能再停一次）', () => {
  assert.doesNotThrow(() => {
    keyHold.stop();
    keyHold.stop();
  });
  assert.strictEqual(keyHold.poll(Date.now()).active, false);
});

// ------------------------------------------------------------------ 默认值

test('默认：两个热键不能是同一个（同一个组合键只能挂一个回调）', () => {
  assert.strictEqual(store.DEFAULTS.dock_peek_hotkey, 'Ctrl+Win+Z', '默认按住即抬的热键');
  assert.ok(store.DEFAULTS.dock_peek_hotkey, '按住即抬默认开着');
  assert.notStrictEqual(
    store.DEFAULTS.dock_peek_hotkey,
    store.DEFAULTS.dock_hotkey,
    '默认不能与 Dock 唤出热键（F9）撞车'
  );
  assert.ok(
    keyHold.specFor(store.DEFAULTS.dock_peek_hotkey),
    '默认组合键必须认得出来'
  );
  // 默认值选的不是系统保留的那几组：Windows 留给自己的是 Win+*、Ctrl+Esc、Ctrl+Alt+Del、
  // Ctrl+Shift+Esc、Alt+Tab 这些；输入法用的是 Ctrl+Space / Win+Space / Win+Ctrl+Space。
  assert.ok(
    !/^(Ctrl\+(Space|Escape)|Win\+|Super\+|Command\+|Ctrl\+Shift\+Escape)/i.test(
      store.DEFAULTS.dock_peek_hotkey
    ),
    `默认组合键撞上了系统/输入法的保留键：${store.DEFAULTS.dock_peek_hotkey}`
  );
  // 默认必须落在左手那排键上（右手要留给鼠标）：Ctrl(小指) + Win(拇指) + Z(小指侧)
  assert.deepStrictEqual(keyHold.keyGroups(store.DEFAULTS.dock_peek_hotkey), [
    [VK.CONTROL],
    [VK.LWIN, VK.RWIN],
    [0x5a]
  ]);
  // Win 键的三种写法都要认：Electron 只在文档里写了 Super/Meta，但实测 'Win' 也收，
  // 用户在设置框里怎么打都不该被判成"认不出来的组合键"而悄悄退回默认值
  for (const alias of ['Ctrl+Win+Z', 'Ctrl+Super+Z', 'Ctrl+Meta+Z', 'Ctrl+windows+Z']) {
    assert.deepStrictEqual(
      keyHold.keyGroups(alias),
      [[VK.CONTROL], [VK.LWIN, VK.RWIN], [0x5a]],
      `${alias} 应当与默认写法等价`
    );
  }
  // 零冲突的备选随时能用（要带 F13 的键盘，但只要改一个设置项就能换过去）
  assert.deepStrictEqual(keyHold.keyGroups('F13'), [[0x7c]]);
});

test('默认：dock_peek_hotkey 也走字符串归一（超长截断、非字符串回默认）', () => {
  const def = store.DEFAULTS.dock_peek_hotkey;
  const merged = store.mergedSettings({ dock_peek_hotkey: `  ${def}  ` });
  assert.strictEqual(merged.dock_peek_hotkey, def);
  assert.strictEqual(
    store.mergedSettings({ dock_peek_hotkey: 'x'.repeat(80) }).dock_peek_hotkey.length,
    40
  );
  assert.strictEqual(store.mergedSettings({ dock_peek_hotkey: 7 }).dock_peek_hotkey, def);
});

// ------------------------------------------------------------------ 主进程接线

test('接线：按住期间自动收起与层级复位都得让路', () => {
  // 这两条漏一条，按住热键时 Dock 每 180ms 就被 tickDockAutoHide 按"鼠标不在"收回去，
  // 或者被换屏/改设置那几条路重新埋回桌面层——症状都是"按了没反应"
  assert.match(
    functionBody(MAIN_SOURCE, 'tickDockAutoHide'),
    /if \(peekHeld\) return;/,
    '自动收起的每一拍都必须先看 peekHeld'
  );
  assert.match(
    functionBody(MAIN_SOURCE, 'applyDockLayerMode'),
    /if \(peekHeld\)[\s\S]*setDockTopmost\(true\)/,
    '按住的层级不能被 applyDockLayerMode 压回桌面层'
  );
});

test('接线：抬起要把收着的一起滑出来，落回要把层级还回去', () => {
  const begin = functionBody(MAIN_SOURCE, 'beginPeek');
  assert.match(begin, /setDockTopmost\(true\)/, '抬起必须置顶');
  assert.match(begin, /slideDockTo\(dockTargetGeometry\(\)\)/, '收着的 Dock 要先滑出来');
  assert.match(begin, /keyHold\.ensureRunning\(/, '抬起时要把按键状态侦察进程叫起来（松手靠它）');
  const end = functionBody(MAIN_SOURCE, 'endPeek');
  assert.match(end, /if \(!peekHeld\) return;/, '落回必须幂等：两路报数说同一件事时不能反复收');
  assert.match(end, /applyDockLayerMode\(\)/, '松手要把层级还回设置该有的样子（常驻＝下沉桌面层）');
  assert.match(end, /slideDockTo\(dockHiddenGeometry\(\)\)/, '按住前是收起态的，松手就滑回去');
});

test('接线：松手要连着报两拍才落回（异步状态抖一下不能让 Dock 在手里闪）', () => {
  const handler = functionBody(MAIN_SOURCE, 'onPeekKeyState');
  assert.match(
    handler,
    /setTimeout\([\s\S]*endPeek\('松手'\)[\s\S]*PEEK_RELEASE_CONFIRM_MS/,
    '松手必须过确认窗口才落回'
  );
  assert.match(handler, /if \(!peekHeld \|\| peekReleaseTimer\) return;/, '连着报两拍之间只起一个定时器');
  // 抬起那一侧不许有确认窗口：按下必须零延迟到位
  assert.doesNotMatch(
    functionBody(MAIN_SOURCE, 'beginPeek'),
    /PEEK_RELEASE_CONFIRM_MS/,
    '抬起不能走确认窗口（否则按下会慢 120ms）'
  );
  assert.match(functionBody(MAIN_SOURCE, 'beginPeek'), /cancelPeekRelease\(\)/);
});

test('接线：换键/关掉/与 F9 撞车时都要把上一个注册摘掉（不摘就一直生效）', () => {
  const peek = functionBody(MAIN_SOURCE, 'registerPeekHotkey');
  assert.match(peek, /combo === dockCombo/, '与唤出热键撞车要让位');
  assert.match(
    peek,
    /if \(peekHotkeyRegistered !== combo\) unregisterPeekHotkey\('热键已换'\)/,
    '换键前必须摘掉上一个'
  );
  assert.match(peek, /unregisterPeekHotkey\(combo \? '与 Dock 唤出热键相同' : '已关闭'\)/, '关掉/撞车也要摘');
  // 唤出热键那一侧同一个毛病以前就有：改键不摘旧注册，F9 会一直按旧的生效
  const dock = functionBody(MAIN_SOURCE, 'registerDockHotkey');
  assert.match(dock, /dockHotkeyRegistered !== combo[\s\S]*globalShortcut\.unregister\(dockHotkeyRegistered\)/);
});

test('接线：空串（＝关掉这个功能）不能被当成"写错了"退回默认', () => {
  const patch = functionBody(MAIN_SOURCE, 'applySettingsPatch');
  assert.match(
    patch,
    /if \(settings\.dock_peek_hotkey && !keyHold\.specFor\(/,
    '判据里必须先短路掉空串：否则设置面板里清空这一框会被悄悄改回默认值'
  );
});

test('接线：Dock 被关掉时先把 peek 落回，不留一个没有窗口的"按住中"', () => {
  const body = functionBody(MAIN_SOURCE, 'syncDock');
  const endAt = body.indexOf('endPeek(');
  const destroyAt = body.indexOf('destroy()');
  assert.ok(endAt >= 0, 'syncDock 销毁 Dock 前要 endPeek');
  assert.ok(destroyAt > endAt, 'endPeek 得排在 destroy 之前');
});

test('接线：设置面板能改这两个热键（白名单里有），退出时侦察进程要收掉', () => {
  const whitelist = MAIN_SOURCE.slice(MAIN_SOURCE.indexOf('SETTINGS_PATCH_KEYS'));
  assert.match(
    whitelist,
    /'dock_peek_hotkey'/,
    '设置面板改不了按住即抬的热键 = 白名单漏了这个键'
  );
  assert.match(whitelist, /'dock_hotkey'/, '唤出热键同理');
  const quit = MAIN_SOURCE.slice(MAIN_SOURCE.indexOf("app.on('will-quit'"));
  assert.match(quit, /keyHold\.stop\(\)/, '退出时不收按键侦察进程会留一个孤儿 PowerShell');
  assert.match(quit, /peekGuardTimer/, 'peek 看门狗的定时器也要收');
});