// 幽灵 JS 扫描 + 可选删除脚本
// 用法:
//   node references/ghost-scan.mjs            # 仅扫描报告
//   node references/ghost-scan.mjs --delete   # 删除「同名 .ts 并存」的幽灵 .js
//
// 判据: src/vs 下的 .js 且同目录存在同名 .ts → 幽灵（tsc 误 emit 产物）。
// 仓库自带的纯 .js（无同名 .ts）是合法资源，绝不删。
//
// 注意: 不依赖 git（避免邻近项目 .git/index.lock 触发 sandbox 拦截）。
//       删除前请先杀掉 Code-OSS 与 watch 进程树解锁 out。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src', 'vs');
const DO_DELETE = process.argv.includes('--delete');

let totalJs = 0;
let ghostJs = 0;
let deleted = 0;
const ghostList = [];

function walk(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full);
    } else if (e.isFile() && e.name.endsWith('.js')) {
      totalJs++;
      const tsTwin = full.slice(0, -3) + '.ts';
      if (fs.existsSync(tsTwin)) {
        ghostJs++;
        ghostList.push(full);
        if (DO_DELETE) {
          try { fs.unlinkSync(full); deleted++; } catch (err) { console.error('删除失败', full, err.message); }
        }
      }
    }
  }
}

walk(SRC);

console.log('src/vs 下 .js 总数:', totalJs);
console.log('幽灵 js（同名 .ts 并存）:', ghostJs);
console.log('纯 .js（无 .ts，合法）:', totalJs - ghostJs);
if (DO_DELETE) console.log('已删除:', deleted);
console.log('--- 前 30 个样本 ---');
for (const g of ghostList.slice(0, 30)) console.log('  ', g.slice(ROOT.length + 1));

// 抽查关键文件 const enum 是否健康（在 out 里）
const targets = [
  'platform/configuration/common/configurationRegistry.js',
];
console.log('--- out 关键产物检查 ---');
for (const rel of targets) {
  const p = path.join(ROOT, 'out', 'vs', rel);
  if (!fs.existsSync(p)) { console.log(rel, ': out 中不存在'); continue; }
  const c = fs.readFileSync(p, 'utf8');
  const enumName = path.basename(rel, '.js'); // 仅示意
  console.log(rel,
    '| 含 var ConfigurationScope:', c.includes('var ConfigurationScope'),
    '| 含 export {:', c.includes('export {'),
    '| 内联坏特征:', c.includes('ConfigurationScope.WINDOW */'));
}
