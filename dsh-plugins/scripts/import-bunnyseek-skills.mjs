// 把 bunnyseek 的项目技能（`.bunnyseek/skills/<name>/`）导入到我们的用户技能库。
//
// 为什么落到**用户技能库**而不是随包 `resources/.agents/skills/`：
//   这些技能正文写满了特定 UE 项目的路径、作弊命令、TAPD 字段名 —— 它是"某个项目的操作手册"，
//   不是产品能力。随包会让所有用户的每轮技能索引都多出十几行（索引是每轮注入的）。
//
// 默认 **dry-run**（只报告，不写盘）。真的要装才加 `--apply`。
//
// 用法：
//   node dsh-plugins/scripts/import-bunnyseek-skills.mjs --from G:/CustomWorkspaces/AIProjects/bunnyseek
//   node dsh-plugins/scripts/import-bunnyseek-skills.mjs --from <...> --to dev --apply
//   node dsh-plugins/scripts/import-bunnyseek-skills.mjs --from <...> --to all --apply --include-missing
//
// 参数：
//   --from <path>         bunnyseek 仓库根（必须显式给，不猜路径）
//   --to dev|prod|all     目标数据根（dev = ~/.vssaros-dev，prod = ~/.vssaros）；默认只报告
//   --apply               真的写盘（缺省只打印计划）
//   --include-missing     连"引用了本环境不存在的工具"的技能也装（默认跳过）
//   --force               目标已存在时覆盖（默认跳过，避免盖掉用户改过的版本）

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { dshToolNames, replaceToolRefs, scanToolRefs, TOOL_MAP } from './skill-tool-map.mjs';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const valueOf = name => {
	const index = args.indexOf(`--${name}`);
	return index >= 0 ? args[index + 1] : '';
};

const from = valueOf('from');
const to = valueOf('to') || '';
const apply = flag('apply');
const includeMissing = flag('include-missing');
const force = flag('force');

if (!from) {
	console.error('缺少 --from <bunnyseek 仓库根>（不猜路径：猜错会把别人的技能装进你的库）');
	process.exit(2);
}
const sourceRoot = join(from, '.bunnyseek', 'skills');
if (!existsSync(sourceRoot)) {
	console.error(`找不到技能目录：${sourceRoot}`);
	process.exit(2);
}

const TARGET_ROOTS = {
	dev: join(homedir(), '.vssaros-dev', 'skills'),
	prod: join(homedir(), '.vssaros', 'skills'),
};
if (!to) {
	console.log('（未指定 --to ⇒ 只报告，不写盘。加 --to dev|prod|all --apply 才真的安装）\n');
}
const targets = to === 'all' ? [TARGET_ROOTS.dev, TARGET_ROOTS.prod] : to ? [TARGET_ROOTS[to]].filter(Boolean) : [];
if (to && targets.length === 0) {
	console.error(`--to 只接受 dev / prod / all，收到 ${JSON.stringify(to)}`);
	process.exit(2);
}

const dshTools = dshToolNames();

/**
 * 补 `displayName`：技能页会对"缺 displayName"的技能逐条提示，迁进来 10 个就刷 10 行。
 * 取值用正文一级标题里 `—`/`-` 之前那段（`# Screenshot — multi-monitor…` → `Screenshot`），
 * 拿不到就退回目录名。
 */
function withDisplayName(text, name) {
	const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!front || /^displayName\s*:/m.test(front[1])) {
		return text;
	}
	const title = /^#\s+(.+)$/m.exec(text.slice(front[0].length));
	let label = (title?.[1] ?? name).split(/[—–]/)[0].replace(/^[^\p{L}\p{N}]+/u, '').trim();
	if (!label) {
		label = name;
	}
	const quoted = `"${label.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
	return text.replace(front[0], `---\n${front[1]}\ndisplayName: ${quoted}\n---`);
}

const rows = [];

for (const name of readdirSync(sourceRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)) {
	const dir = join(sourceRoot, name);
	const skillFile = join(dir, 'SKILL.md');
	if (!existsSync(skillFile)) {
		rows.push({ name, action: 'skip', why: '没有 SKILL.md' });
		continue;
	}
	const raw = readFileSync(skillFile, 'utf8');
	const rewritten = withDisplayName(replaceToolRefs(raw), name);
	const { referenced, dangling } = scanToolRefs(rewritten, dshTools);
	const missing = dangling.filter(tool => TOOL_MAP[tool] === null || TOOL_MAP[tool] === undefined);
	// 目标已存在的判定取第一个目标根（多目标时只要有一处已存在就按"已存在"处理，避免覆盖一半）。
	const existed = targets.some(root => existsSync(join(root, name, 'SKILL.md')));
	let action = 'install';
	let why = '';
	if (missing.length && !includeMissing) {
		action = 'skip';
		why = `缺工具：${missing.join(', ')}（--include-missing 可强行安装）`;
	} else if (existed && !force) {
		action = 'skip';
		why = '目标已存在（--force 覆盖）';
	}
	rows.push({ name, dir, action, why, renamed: raw !== rewritten, referenced, missing, rewritten });
}

const install = rows.filter(row => row.action === 'install');
const skipped = rows.filter(row => row.action !== 'install');

console.log(`源：${sourceRoot}`);
console.log(`技能 ${rows.length} 个｜可安装 ${install.length}｜跳过 ${skipped.length}｜本环境工具 ${dshTools.size} 个\n`);

for (const row of rows) {
	const flags = [
		row.renamed ? '工具名已改写' : '',
		row.referenced?.length ? `引用 ${row.referenced.length} 个工具` : '',
	].filter(Boolean).join('；');
	console.log(`${row.action === 'install' ? '✓' : '·'} ${row.name}${flags ? `　${flags}` : ''}${row.why ? `　[${row.why}]` : ''}`);
}

if (!apply) {
	console.log('\n（dry-run）确认无误后加 --to dev|prod|all --apply 执行。');
	process.exit(0);
}
if (targets.length === 0) {
	console.error('--apply 需要同时给 --to dev|prod|all');
	process.exit(2);
}

let written = 0;
for (const row of install) {
	for (const root of targets) {
		const dir = join(root, row.name);
		mkdirSync(dir, { recursive: true });
		// 整目录复制（含 sections/ 与脚本）：技能正文里会引用同目录的资源文件。
		cpSync(row.dir, dir, { recursive: true, force: true });
		// 只改 SKILL.md 的工具名（其它文件是素材/脚本，工具名不适用）。
		const skillFile = join(dir, 'SKILL.md');
		writeFileSync(skillFile, row.rewritten, 'utf8');
		written += 1;
	}
}
console.log(`\n已写入 ${written} 个技能目录（目标 ${targets.length} 处）。`);
console.log('⚠ 生效条件：Host 只在自己重启/技能根变化时重扫技能 ⇒ 需要重启 Host（IDE 卡着的话就是整个 app 重启）。');
console.log('⚠ 回滚：删掉同名目录即可（本脚本不写任何注册表/清单，纯目录）。');
