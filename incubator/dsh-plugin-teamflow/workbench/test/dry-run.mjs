/**
 * P2 · 等价于 `check_local_workbench({path})` 的干跑：不安装、不弹确认、不写盘、不需要控制桥。
 *
 * 直接 import 本仓 `vssaros-workbenches/lib/localInstall.js` 的同一套校验器
 * （规范 doc/workbench-development-standard.md §7 说它与安装用同一套结构校验）。
 * 用法：node test/dry-run.mjs [.tgz 绝对路径]
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	inspectWorkbenchArchive, auditWorkbenchEntries,
} from '../../../../dsh-plugins/vssaros-workbenches/lib/localInstall.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const archive = process.argv[2] || join(ROOT, `${pkg.name}-${pkg.version}.tgz`);

const inspected = await inspectWorkbenchArchive(readFileSync(archive));
const audit = auditWorkbenchEntries(inspected);
const guideVersion = '<插件版本>/<内容 sha256 前 8 位>';

console.log(`包：${inspected.name}@${inspected.version}`);
console.log(`身份：${audit.identity || '(未识别)'}`);
console.log(`文件：${inspected.entries.length} 个 / ${inspected.totalBytes} 字节（压缩 ${inspected.archiveBytes} 字节）`);
console.log(`客户端入口：${inspected.hasClient ? '在包里' : '缺失'}`);
console.log(`规范版本口径：${guideVersion}（本次只校验包结构，未取 GET /development-guide）`);
for (const w of audit.warnings) console.log(`  ! ${w}`);
for (const c of audit.capabilities) console.log(`  · 能力：${c.label}`);
for (const e of audit.errors) console.error(`  ✗ ${e}`);

if (audit.errors.length) {
	console.error(`\n[dry-run] ok:false（${audit.errors.length} 个错误）— 未安装`);
	process.exit(1);
}
console.log(`\n[dry-run] ok:true（结构 + 静态审计通过）— 未安装；这不等于装上能跑`);
