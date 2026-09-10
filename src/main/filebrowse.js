'use strict';

// 文件浏览纯逻辑：面包屑、上一级、目录列举、分批。
// 只读：只用 fs.readdirSync(withFileTypes)，绝不创建/删除/改名/写属性。
// 所有异常都转成中文提示返回，不往上抛。

const fs = require('node:fs');
const path = require('node:path');

const CHUNK_SIZE = 300;
const ERROR_PERMISSION = '没有权限读取这个目录';
const ERROR_NOT_FOUND = '目录不存在或已经被移走';
const ERROR_NOT_DIR = '这不是一个目录';
const ERROR_UNREADABLE = '读不了这个目录（系统错误码 %s）';

function isRoot(target) {
  if (!target) return true;
  const normalized = path.normalize(target);
  const parsed = path.parse(normalized);
  return parsed.root === normalized;
}

function parentOf(target) {
  if (!target || isRoot(target)) return null;
  const parent = path.dirname(path.normalize(target));
  if (!parent || parent === target) return null;
  return parent;
}

function breadcrumbParts(target) {
  if (!target) return [];
  const normalized = path.normalize(target);
  const parsed = path.parse(normalized);
  const parts = [{ label: parsed.root || normalized, path: parsed.root || normalized }];
  const rest = normalized.slice(parsed.root.length);
  if (!rest) return parts;
  let current = parsed.root;
  for (const piece of rest.split(path.sep)) {
    if (!piece) continue;
    current = path.join(current, piece);
    parts.push({ label: piece, path: current });
  }
  return parts;
}

function sortEntries(entries) {
  return entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

function errorText(error) {
  if (!error) return ERROR_UNREADABLE.replace('%s', '未知');
  if (error.code === 'EACCES' || error.code === 'EPERM') return ERROR_PERMISSION;
  if (error.code === 'ENOENT') return ERROR_NOT_FOUND;
  if (error.code === 'ENOTDIR') return ERROR_NOT_DIR;
  return ERROR_UNREADABLE.replace('%s', error.errno ?? '未知');
}

// 单个条目读不到（权限/链接失效）就跳过它，不影响整个目录的展示
function listEntries(target) {
  if (!target) return { entries: [], error: ERROR_NOT_FOUND };
  let stat;
  try {
    stat = fs.statSync(target);
  } catch (error) {
    return { entries: [], error: errorText(error) };
  }
  if (!stat.isDirectory()) return { entries: [], error: ERROR_NOT_DIR };

  let dirents;
  try {
    dirents = fs.readdirSync(target, { withFileTypes: true });
  } catch (error) {
    return { entries: [], error: errorText(error) };
  }

  const entries = [];
  for (const dirent of dirents) {
    let isDir = dirent.isDirectory();
    if (dirent.isSymbolicLink()) {
      try {
        isDir = fs.statSync(path.join(target, dirent.name)).isDirectory();
      } catch (_) {
        continue;
      }
    }
    entries.push({
      name: dirent.name,
      path: path.join(target, dirent.name),
      isDir
    });
  }
  return { entries: sortEntries(entries), error: null };
}

function chunked(sequence, size = CHUNK_SIZE) {
  const step = size > 0 ? size : CHUNK_SIZE;
  const out = [];
  for (let index = 0; index < sequence.length; index += step) {
    out.push(sequence.slice(index, index + step));
  }
  return out;
}

module.exports = {
  CHUNK_SIZE,
  ERROR_NOT_DIR,
  ERROR_NOT_FOUND,
  ERROR_PERMISSION,
  ERROR_UNREADABLE,
  breadcrumbParts,
  chunked,
  errorText,
  isRoot,
  listEntries,
  parentOf,
  sortEntries
};
