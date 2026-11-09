'use strict';

// 筐的磁盘落地（3.3.0 起）：每个筐在磁盘上有一个**真实文件夹**（默认 E:\文件筐\<筐名>\），
// 加进来的文件会被**移动**进去，从此归筐所有 —— 原始位置删掉也照样打得开。
//
// 这是对早期「只登记路径、绝不移动文件」的一次明确改变，所以边界写清楚，别含糊：
//   · 会移动：加入筐时把文件（或整个文件夹）搬进筐目录；
//   · 只复制、不移动：同一个文件还被 Dock 或别的筐引用着（搬走会把那边弄坏）；
//   · 移动的实现：同盘文件用排他硬链接再移除源名称；跨盘先复制、**校验通过**再删源文件；
//   · 校验不过 → 保留原文件、删掉我们自己刚复制出来的半成品，如实报错。源文件被占用
//     （比如正在运行的程序）也一样：副本已经在筐里，原文件留着并说明。
//   · 全程不删用户的文件：唯一一次 unlink/rm 出现在"移动的第二步"，且必然在移动路径上；
//     移出筐、删筐都只动清单，磁盘上一个字节不动。

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const platform = require('./platform');

// 各平台的默认筐目录（Windows: E:\文件筐；mac/Linux 见 platform.js）
const DEFAULT_DIR = platform.defaultBasketDir();

// Windows 文件名里的非法字符与保留名
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const NAME_MAX = 48;   // 筐名本身限长 24，这里留足 " (10)" 这类后缀的富余

// 路径比较用的键：绝对化 + 去掉末尾斜杠 + 小写（Windows 不区分大小写）
function keyOf(target) {
  const value = String(target === undefined || target === null ? '' : target).trim();
  if (!value) return '';
  return path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
}

function samePath(a, b) {
  const left = keyOf(a);
  return Boolean(left) && left === keyOf(b);
}

// child 是不是在 parent 里面（含 parent 本身）
function isInside(parent, child) {
  const outer = keyOf(parent);
  const inner = keyOf(child);
  if (!outer || !inner) return false;
  return inner === outer || inner.startsWith(outer + path.sep);
}

function sameVolume(a, b) {
  return path.parse(path.resolve(a)).root.toLowerCase() === path.parse(path.resolve(b)).root.toLowerCase();
}

// 筐名 → 能当文件夹名的字符串（非法字符换成空格，去掉结尾的点和空格，保留名兜底）
function sanitizeFolderName(raw) {
  const cleaned = String(raw === undefined || raw === null ? '' : raw)
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  const short = cleaned.slice(0, NAME_MAX).trim();
  if (!short || RESERVED.test(short)) return '筐';
  return short;
}

// 重名时顺延：名字 (2)、名字 (3)…（目录里已有的、别的筐已经占了的都算占用）
// taken 可以是数组也可以是 Set —— 调用方两种都在用
function uniqueName(name, taken) {
  const list = taken instanceof Set ? Array.from(taken) : taken || [];
  const used = new Set(list.map((item) => String(item).toLowerCase()));
  const text = String(name);
  if (!used.has(text.toLowerCase())) return text;
  const ext = path.extname(text);
  const stem = ext ? text.slice(0, -ext.length) : text;
  for (let index = 2; index < 999; index += 1) {
    const candidate = `${stem} (${index})${ext}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem} (${process.pid})${ext}`;
}

// 这条已登记的条目该怎么办：
//   inside  已经躺在筐目录里了，不用动
//   missing 源文件不在了（保留登记，页面上显示成"找不到"）
//   copy    还被 Dock / 别的筐引用着 → 复制一份进筐，别把那边弄坏
//   move    搬进筐
function moveDecision({ item, dir, protectKeys, exists = true } = {}) {
  if (!item) return { action: 'missing' };
  if (dir && isInside(dir, item)) return { action: 'inside' };
  if (exists === false) return { action: 'missing' };
  if (protectKeys && protectKeys.has(keyOf(item))) return { action: 'copy' };
  return { action: 'move' };
}

// 一棵树的指纹：{ 相对路径: 文件大小 }，目录记为 -1。校验"复制得对不对"就比对两张表。
function snapshotTree(root, io = fs) {
  const table = {};
  const walk = (current, prefix) => {
    let names = [];
    try {
      const listed = io.readdirSync(current);
      names = Array.isArray(listed) ? listed : [];
    } catch (error) {
      throw new Error('无法读取目录 ' + current + '：' + errorText(error));
    }
    for (const name of names) {
      const full = path.join(current, name);
      const rel = prefix ? prefix + '/' + name : name;
      let stat = null;
      try {
        // lstat：不跟随符号链接/联接点——目录环会无限递归；两端按链接本身记录、校验依然对称
        stat = io.lstatSync ? io.lstatSync(full) : io.statSync(full);
      } catch (error) {
        throw new Error('无法读取文件属性 ' + full + '：' + errorText(error));
      }
      if (stat.isSymbolicLink && stat.isSymbolicLink()) throw new Error('跨盘校验不支持符号链接/联接点：' + full);
      if (stat.isDirectory()) {
        table[rel] = -1;
        walk(full, rel);
      } else {
        table[rel] = stat.size;
      }
    }
  };
  const stat = io.lstatSync ? io.lstatSync(root) : io.statSync(root);
  if (stat.isSymbolicLink && stat.isSymbolicLink()) throw new Error('跨盘校验不支持符号链接/联接点：' + root);
  if (stat.isDirectory()) {
    table[''] = -1;
    walk(root, '');
  } else {
    table[''] = stat.size;
  }
  return table;
}

// 两张指纹表不一样就返回原因（空串 = 一致）。少一项、多一项、大小对不上都算不一致。
function compareTrees(want, got) {
  const wantKeys = Object.keys(want);
  for (const key of wantKeys) {
    if (!(key in got)) return `缺少 ${key || '(根)'}`;
    if (got[key] !== want[key]) {
      return want[key] === -1 ? `${key} 不是目录` : `${key} 大小不一致（${want[key]} → ${got[key]}）`;
    }
  }
  for (const key of Object.keys(got)) {
    if (!(key in want)) return `多出 ${key || '(根)'}`;
  }
  return '';
}

function errorText(error) {
  return String((error && error.message) || error || '未知错误');
}

// 删掉"我们自己刚建出来的"东西：只在移动/复制路径上调用，且路径必然是本函数刚选的空位
function dropQuietly(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (_) {
    /* 清理失败不影响结论：调用方已经准备如实报错了 */
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 改名用：Windows 文件名里不能出现的字符换成空格、去掉结尾的点和空格；
// 保留名（con / nul / com1…）即使带扩展名也不行，加前缀绕开。返回空串 = 名字不合法。
function sanitizeFileName(raw) {
  const cleaned = String(raw === undefined || raw === null ? '' : raw)
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  const short = cleaned.slice(0, 120).trim();
  if (!short) return '';
  const stem = short.includes('.') ? short.slice(0, short.indexOf('.')) : short;
  if (RESERVED.test(stem)) return '文件-' + short;
  return short;
}

// 筐目录里给这个文件名找一个空位（磁盘上已经有的名字都算占用）
function targetInDir(dir, baseName) {
  const taken = fs.readdirSync(dir);
  return path.join(dir, uniqueName(baseName || '文件', taken));
}

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 65536 })) hash.update(chunk);
  return hash.digest('hex');
}

// 串行流式校验：大文件不整份读入内存，大小相同而内容不同也不会放行。
async function verifyCopy(src, dest, before) {
  const after = snapshotTree(src);
  let problem = compareTrees(before, after) || compareTrees(before, snapshotTree(dest));
  if (problem) return problem;
  for (const [rel, size] of Object.entries(before)) {
    if (size === -1) continue;
    const a = rel ? path.join(src, rel) : src;
    const b = rel ? path.join(dest, rel) : dest;
    const first = await digest(a);
    if (first !== await digest(b) || first !== await digest(a)) return '文件内容变化或不一致：' + (rel || path.basename(src));
  }
  return compareTrees(before, snapshotTree(src));
}

// 把 src 落到 destDir 里去。mode='move'：同盘文件排他硬链接，跨盘先复制、
// 逐层校验名字与大小、通过才删源；mode='copy'：只复制，源文件一个字节不动。
// 失败时只清理"这次刚建出来的半成品"，源文件永远保留，原因写进 error。
// 返回 { ok, action:'move'|'copy', dest, note } 或 { ok:false, error }。
let placementQueue = Promise.resolve();
function placeInto(destDir, src, options = {}) {
  const job = placementQueue.then(() => placeIntoNow(destDir, src, options));
  placementQueue = job.catch(() => {});
  return job;
}
async function placeIntoNow(destDir, src, { mode = 'move', exactName, onPrepared } = {}) {
  if (!src || !fs.existsSync(src)) return { ok: false, error: '源文件不存在' };
  let dest;
  try {
    if (exactName && (path.basename(exactName) !== exactName || exactName === '.' || exactName === '..')) throw new Error('目标文件名无效');
    dest = exactName ? path.join(destDir, exactName) : targetInDir(destDir, path.basename(src));
    if (fs.existsSync(dest)) return { ok: false, error: '目标已存在，未覆盖' };
    if (isInside(src, dest)) return { ok: false, error: '不能移入自身或子目录' };
  } catch (error) { return { ok: false, error: errorText(error) }; }

  // 文件同盘用排他硬链接 + unlink，目标被并发占用也绝不覆盖。目录走校验复制。
  if (mode === 'move' && sameVolume(src, destDir)) {
    try {
      const stat = await fs.promises.lstat(src);
      if (stat.isFile()) {
        await fs.promises.link(src, dest);
        const linked = await fs.promises.lstat(dest);
        const current = await fs.promises.lstat(src);
        if (linked.ino !== current.ino || linked.dev !== current.dev || linked.ino !== stat.ino) return { ok: true, action: 'copy', dest, note: '源文件已被替换，保留源位置供核对' };
        if (onPrepared) {
          try { await onPrepared({ from: src, to: dest }); }
          catch (error) { return { ok: true, action: 'copy', dest, note: '恢复记录保存失败，源文件保留：' + errorText(error) }; }
        }
        try { await fs.promises.unlink(src); }
        catch (error) { return { ok: true, action: 'copy', dest, note: '原文件保留：' + errorText(error) }; }
        return { ok: true, action: 'move', dest };
      }
    } catch (error) {
      if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EACCES'].includes(error.code)) return { ok: false, error: errorText(error) };
    }
  }

  let before;
  try {
    before = snapshotTree(src);
  } catch (error) { return { ok: false, error: errorText(error) }; }
  let owned = false;
  try {
    const stat = await fs.promises.stat(src);
    if (stat.isDirectory()) {
      await fs.promises.mkdir(dest);
      owned = true;
      for (const name of await fs.promises.readdir(src)) {
        await fs.promises.cp(path.join(src, name), path.join(dest, name), { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
      }
    } else {
      await fs.promises.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
      owned = true;
    }
  } catch (error) {
    // EEXIST = 目标位被并发操作抢先占了：那不是我们的半成品，绝不能删
    if (owned) dropQuietly(dest);
    return { ok: false, error: errorText(error) };
  }

  let problem = '';
  try {
    problem = await verifyCopy(src, dest, before);
  } catch (error) {
    problem = errorText(error);
  }
  if (problem) {
    dropQuietly(dest);   // 半成品是我们刚建的，删掉；源文件一个字节没动
    return { ok: false, error: '复制校验没过：' + problem };
  }

  if (mode === 'copy') return { ok: true, action: 'copy', dest };
  // 恢复日志必须在删除源文件前落盘；保存失败时保留两份。
  if (onPrepared) {
    try { await onPrepared({ from: src, to: dest }); }
    catch (error) { return { ok: true, action: 'copy', dest, note: '恢复记录保存失败，源文件保留：' + errorText(error) }; }
  }

  try {
    await fs.promises.rm(src, { recursive: true, force: false });
  } catch (error) {
    // 源文件被占用之类：副本已经在了，原文件留着，如实说明
    return { ok: true, action: 'copy', dest, note: '原文件没能删掉（' + errorText(error) + '）' };
  }
  return { ok: true, action: 'move', dest };
}

// 把一个文件/文件夹弄进筐目录（"加进筐"的入口：被 Dock/别的筐引用着的只复制）。
// 返回 { action:'move'|'copy'|'inside'|'missing'|'failed', src, dest, note, error }
async function moveInto(dir, src, { protect } = {}) {
  if (!src) return { action: 'missing', src };
  if (isInside(dir, src)) return { action: 'inside', src, dest: src };
  if (!fs.existsSync(src)) return { action: 'missing', src };
  const mode = protect && protect.has(keyOf(src)) ? 'copy' : 'move';
  const result = await placeInto(dir, src, { mode });
  if (!result.ok) return { action: 'failed', src, error: result.error };
  return {
    action: result.action,
    src,
    dest: result.dest,
    ...(result.note ? { note: result.note } : {})
  };
}

module.exports = {
  DEFAULT_DIR,
  NAME_MAX,
  compareTrees,
  errorText,
  placeInto,
  sanitizeFileName,
  ensureDir,
  isInside,
  keyOf,
  moveDecision,
  moveInto,
  samePath,
  sameVolume,
  sanitizeFolderName,
  snapshotTree,
  targetInDir,
  verifyCopy,
  uniqueName
};
