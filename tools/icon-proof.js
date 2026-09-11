'use strict';

// 取证：对桌面上每个快捷方式跑一遍 shellIcons，把图标存成 PNG，
// 并报告耗时与哪些拿不到。纯 node，不需要 Electron。
//   node tools/icon-proof.js          正常取证
//   node tools/icon-proof.js --diag   额外打印 PowerShell 侧的逐条报错

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const shellIcons = require('../src/main/shellIcons');

const DESKTOP = path.join(os.homedir(), 'Desktop');
const OUT = path.resolve(__dirname, '..', 'docs', 'icon-proof');
const DIAG = process.argv.includes('--diag');

function collect() {
  return fs
    .readdirSync(DESKTOP)
    .filter((name) => /\.(lnk|url|exe)$/i.test(name))
    .sort((a, b) => a.localeCompare(b, 'zh'))
    .map((name) => path.join(DESKTOP, name));
}

async function diagnose(targets) {
  console.log('--- PowerShell 逐条诊断 ---');
  const result = await shellIcons.runPowerShell(targets, shellIcons.ICON_PX);
  const rows = shellIcons.parseRows(result.stdout);
  console.log(`返回 ${rows.length} 条；stderr 前 200 字：${JSON.stringify(result.stderr.slice(0, 200))}`);
  for (const row of rows) {
    console.log(`${row.png ? 'OK   ' : 'EMPTY'} ${row.err ? '[' + row.err + '] ' : ''}${path.basename(row.path)}`);
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const file of fs.readdirSync(OUT)) {
    if (file.endsWith('.png')) fs.unlinkSync(path.join(OUT, file));
  }

  const targets = collect();
  console.log(`桌面可收录条目 ${targets.length} 个`);

  if (DIAG) await diagnose(targets);

  const started = Date.now();
  const urls = await Promise.all(targets.map((target) => shellIcons.iconDataUrl(target)));
  const elapsed = Date.now() - started;

  const manifest = [];
  targets.forEach((target, index) => {
    const url = urls[index] || '';
    const name = path.basename(target);
    if (url) {
      const buffer = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
      fs.writeFileSync(path.join(OUT, `${String(index).padStart(2, '0')}.png`), buffer);
      manifest.push({ index, name, bytes: buffer.length });
      if (!DIAG) console.log(`OK    ${String(index).padStart(2, '0')} ${String(buffer.length).padStart(6)}B  ${name}`);
    } else {
      manifest.push({ index, name, bytes: 0 });
      if (!DIAG) console.log(`EMPTY ${String(index).padStart(2, '0')}             ${name}`);
    }
  });

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  const empty = manifest.filter((row) => !row.bytes).length;
  console.log(`\n耗时 ${elapsed} ms；有图标 ${manifest.length - empty} 个，无图标 ${empty} 个`);
}

main().catch((error) => {
  console.error('取证失败:', error);
  process.exit(1);
});
