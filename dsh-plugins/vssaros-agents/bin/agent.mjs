#!/usr/bin/env node
/**
 * vssaros-agent — 离线管理 VsSaros Agent（list / show / create / export / import）。
 *
 * 为什么离线就够：agent 的唯一真源是 `<agentsRoot>/<id>/.agent.md`（Host 每次页面请求都会增量
 * 同步 preset）⇒ 这些命令**不需要 Host 在线**，也不碰 dsh 数据库。要在运行中的会话里换人格、
 * 看委派那些，走页面/HTTP API（`/x/agents/api/*`）。
 *
 * 用法：
 *   vssaros-agent list   [--json]
 *   vssaros-agent show   <id|名称> [--json]
 *   vssaros-agent create --name <名称> [--id <id>] [--persona <文本> | --persona-stdin]
 *                        [--description <t>] [--role <标签>] [--icon <emoji>]
 *                        [--model <provider/model>] [--model-assignment <provider/model>]
 *                        [--memory-chars <N>] [--memory-mode session|live]
 *                        [--skills a,b] [--tools x,y] [--json]
 *   vssaros-agent export <id> [-o <file.zip>] [--no-memory] [--json]
 *   vssaros-agent import <file.zip> [--overwrite] [--json]
 *   vssaros-agent import-bot <file.zip|目录> [--id <id>] [--name <名称>] [--model <p/m>]
 *                        [--model-assignment <p/m>] [--overwrite] [--dry-run] [--json]
 *                        （从 DeepSeekBot/BotHarness 的 PersonaBot 导入：SOUL.md→正文，
 *                          MEMORY.md→memory/，bot.json→name/bio/role；详见 lib/importDsb.js）
 *
 * 公共选项：
 *   --agents-root <dir>   默认 $VSSAROS_AGENTS_ROOT，否则 <home>/.vssaros/agents
 *   --data-root <dir>     `<dataRoot>/exports/` 落盘位置；默认取 agentsRoot 的上级目录
 *   --home <dir>          等价于 --agents-root <dir>/agents --data-root <dir>
 *
 * 退出码：0 成功 / 1 业务错误（找不到、已存在、包坏了、校验不过…）/ 2 用法错误
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { createAgentFromDraft } from '../lib/create.js';
import { botFromSoulText, botFromTobSource, importDsbBot } from '../lib/importDsb.js';
import { memoryDirOf, safeMemoryFileName } from '../lib/memory.js';
import { exportAgent, importAgent } from '../lib/pack.js';
import { scanAgents } from '../lib/store.js';

function fail(message, code = 2) {
	console.error(message);
	process.exit(code);
}

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
	console.log('用法：vssaros-agent list|show|create|export|import [...]（细节见 bin/agent.mjs 头注释）');
	process.exit(argv.length ? 0 : 2);
}

const command = argv[0];
const rest = argv.slice(1);
const flags = new Set();
const values = new Map();
const positional = [];
const VALUE_FLAGS = new Set([
	'-o', '--out', '--name', '--id', '--persona', '--description', '--role', '--icon',
	'--model', '--model-assignment', '--memory-chars', '--memory-mode', '--skills', '--tools',
	'--agents-root', '--data-root', '--home', '--from-tob',
]);
for (let i = 0; i < rest.length; i++) {
	const arg = rest[i];
	if (VALUE_FLAGS.has(arg)) {
		values.set(arg, rest[++i] ?? '');
	} else if (arg.startsWith('-')) {
		flags.add(arg);
	} else {
		positional.push(arg);
	}
}

const home = process.env.USERPROFILE || process.env.HOME || homedir();
const homeArg = values.get('--home') ?? '';
const agentsRoot = resolve(values.get('--agents-root') || (homeArg ? join(homeArg, 'agents') : (process.env.VSSAROS_AGENTS_ROOT || join(home, '.vssaros', 'agents'))));
const dataRoot = resolve(values.get('--data-root') || (homeArg || dirname(agentsRoot)));
const config = { agentsRoot, dataRoot };
// ⚠ 2026-10-19 用户实际踩到：CLI 默认写 `~/.vssaros/agents`（生产），但**开发实例**扫的是
//   `~/.vssaros-dev/agents`（`--user-data-dir` 决定）⇒ 导入"成功"了，侧栏却看不到。
//   这里在"没显式指定根 + 检测到 dev 根"时给一句提示（走 stderr，不污染 --json 的 stdout）。
if (!values.get('--agents-root') && !homeArg && existsSync(join(home, '.vssaros-dev', 'agents'))) {
	const devRoot = join(home, '.vssaros-dev', 'agents');
	console.error(`提示：检测到开发实例的 agent 目录 ${devRoot}`);
	console.error(`      本命令默认用的是 ${agentsRoot}（生产）。要导进 dev 实例请加：--agents-root "${devRoot}"`);
}
const json = flags.has('--json');
const printJson = (value) => console.log(JSON.stringify(value, null, 2));

/** 读一个 agent 的记忆文件清单（读不到 ⇒ 空；不抛）。 */
async function memoryFilesOf(id) {
	const dir = memoryDirOf(config, id);
	try {
		const names = (await readdir(dir)).sort();
		const out = [];
		for (const raw of names) {
			const safe = safeMemoryFileName(raw);
			if (!safe || safe !== raw) {
				continue;
			}
			const info = await stat(join(dir, safe));
			out.push({ name: safe, bytes: info.size });
		}
		return out;
	} catch {
		return [];
	}
}

try {
	if (command === 'list') {
		const scan = await scanAgents(agentsRoot);
		const rows = scan.agents.map((a) => ({
			id: a.id,
			name: a.name,
			...(a.role ? { role: a.role } : {}),
			...(a.model ? { model: a.model } : {}),
			...(a.modelAssignment ? { modelAssignment: a.modelAssignment } : {}),
			...(a.memoryMode ? { memoryMode: a.memoryMode } : {}),
		}));
		if (json) {
			printJson({ agentsRoot, count: rows.length, agents: rows, errors: scan.errors });
		} else {
			console.log(`agentsRoot: ${agentsRoot}`);
			for (const row of rows) {
				console.log(`${row.id.padEnd(24)} ${String(row.name).padEnd(16)} ${row.model ?? '(默认模型)'}`);
			}
			console.log(`\n共 ${rows.length} 个`);
			for (const err of scan.errors ?? []) {
				console.error(`! ${err}`);
			}
		}
		process.exit(0);
	}

	if (command === 'show') {
		const want = String(positional[0] ?? '').trim();
		if (!want) {
			fail('缺少 id 或名称：vssaros-agent show <id|名称>');
		}
		const scan = await scanAgents(agentsRoot);
		const agent = scan.agents.find((a) => a.id === want) ?? scan.agents.find((a) => a.name === want);
		if (!agent) {
			fail(`没有这个 agent：${want}（可先 list 看 id）`, 1);
		}
		const memory = await memoryFilesOf(agent.id);
		const detail = {
			id: agent.id,
			name: agent.name,
			file: agent.file,
			...(agent.description ? { description: agent.description } : {}),
			...(agent.role ? { role: agent.role } : {}),
			...(agent.icon ? { icon: agent.icon } : {}),
			...(agent.model ? { model: agent.model } : {}),
			...(agent.modelAssignment ? { modelAssignment: agent.modelAssignment } : {}),
			memoryMode: agent.memoryMode ?? 'session',
			...(agent.memoryChars !== undefined ? { memoryChars: agent.memoryChars } : {}),
			personaChars: String(agent.persona ?? '').length,
			skills: agent.skills ?? [],
			tools: agent.tools ?? [],
			...(agent.workspaces ? { workspaces: agent.workspaces } : {}),
			memoryFiles: memory,
		};
		if (json) {
			printJson(detail);
		} else {
			console.log(`${detail.name}（${detail.id}）`);
			console.log(`  定义    ${detail.file}`);
			if (detail.role) { console.log(`  角色    ${detail.role}`); }
			console.log(`  模型    ${detail.model ?? '(跟随默认)'}${detail.modelAssignment ? ` · 委派 ${detail.modelAssignment}` : ''}`);
			console.log(`  记忆    ${detail.memoryMode === 'live' ? '实时刷新' : '会话内冻结'}${detail.memoryChars !== undefined ? `，上限 ${detail.memoryChars} 字符` : ''}；${detail.memoryFiles.length} 个文件`);
			console.log(`  人格    ${detail.personaChars} 字符${detail.skills.length ? ` · 技能 ${detail.skills.join(', ')}` : ''}`);
			if (detail.tools.length) { console.log(`  工具    ${detail.tools.join(', ')}`); }
			for (const f of detail.memoryFiles) {
				console.log(`    - ${f.name} (${f.bytes}B)`);
			}
		}
		process.exit(0);
	}

	if (command === 'create') {
		const name = String(values.get('--name') ?? '').trim();
		if (!name) {
			fail('缺少名称：vssaros-agent create --name <名称> [--persona-stdin]');
		}
		let persona = values.get('--persona') ?? '';
		if (flags.has('--persona-stdin')) {
			const chunks = [];
			for await (const chunk of process.stdin) {
				chunks.push(chunk);
			}
			persona = Buffer.concat(chunks).toString('utf8');
		}
		const listOf = (value) => String(value ?? '').split(',').map((x) => x.trim()).filter(Boolean);
		const draft = {
			name,
			id: String(values.get('--id') ?? '').trim(),
			description: values.get('--description') ?? '',
			icon: values.get('--icon') ?? '',
			role: values.get('--role') ?? '',
			model: values.get('--model') ?? '',
			modelAssignment: values.get('--model-assignment') ?? '',
			memoryChars: values.get('--memory-chars') ?? undefined,
			memoryMode: values.get('--memory-mode') ?? '',
			skills: listOf(values.get('--skills')),
			tools: listOf(values.get('--tools')),
			persona,
		};
		const created = await createAgentFromDraft(config, draft);
		if (json) {
			printJson({ ok: true, ...created });
		} else {
			console.log(`已创建 ${created.name}（${created.id}）→ ${created.file}`);
			console.log(`preset: ${created.presetId}（Host 下次页面请求时注册；不想等就重开一次 Agents 页）`);
			for (const warning of created.warnings ?? []) {
				console.log(`! ${warning}`);
			}
		}
		process.exit(0);
	}

	if (command === 'export') {
		const id = positional[0];
		if (!id) {
			fail('缺少 agent id：vssaros-agent export <id> [-o out.zip]');
		}
		const pack = await exportAgent(config, id, { includeMemory: !flags.has('--no-memory') });
		const target = values.get('-o') || values.get('--out')
			? resolve(values.get('-o') || values.get('--out'))
			: join(dataRoot, 'exports', pack.fileName);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, pack.buffer);
		if (json) {
			printJson({ id: pack.id, name: pack.name, path: target, bytes: pack.bytes, memoryFiles: pack.memoryFiles });
		} else {
			console.log(`已导出 ${pack.name}（${pack.id}）→ ${target}`);
			console.log(`大小 ${pack.bytes} 字节${pack.memoryFiles.length ? `，含记忆 ${pack.memoryFiles.length} 个文件` : ''}`);
		}
		process.exit(0);
	}

	if (command === 'import-bot') {
		// 三种来源（一个命令全覆盖）：
		//   · `.zip`  → DSB Bot 包（PersonaBot 记忆仓库）
		//   · 目录    → 解开的 Bot 仓库
		//   · `.md`   → **纯人设文件**（Tob 这种"源码里一段字符串"的也能先存成 md 再导）
		//   · `--from-tob <DSB 仓根>` → 直接从 DSB 源码里抽 Tob 的 persona（一次性迁移便利）
		const tobRepo = values.get('--from-tob') || '';
		const src = tobRepo || positional[0];
		if (!src) {
			fail('缺少来源：vssaros-agent import-bot <file.zip|目录|人设.md> [--from-tob <DSB仓根>] [--id x] [--dry-run]');
		}
		let source;
		if (tobRepo) {
			const repo = resolve(tobRepo);
			const svc = join(repo, 'packages', 'core', 'src', 'tob', 'service.ts');
			if (!existsSync(svc)) {
				fail(`没找到 ${svc}\n（--from-tob 要指向 DeepSeekBot 仓根；也可以把 persona 存成 .md，再用 import-bot 导入）`, 1);
			}
			source = botFromTobSource(await readFile(svc, 'utf8'));
		} else {
			const abs = resolve(src);
			const info = await stat(abs).catch(() => null);
			if (!info) {
				fail(`找不到：${abs}`, 1);
			}
			if (info.isDirectory()) {
				source = abs;
			} else {
				const buf = await readFile(abs);
				source = /\.(md|markdown)$/i.test(abs)
					? botFromSoulText(buf.toString('utf8'), { name: values.get('--name') || undefined, fileName: basename(abs) })
					: buf;
			}
		}
		const result = await importDsbBot(config, source, {
			id: values.get('--id') || undefined,
			name: values.get('--name') || undefined,
			model: values.get('--model') || undefined,
			modelAssignment: values.get('--model-assignment') || undefined,
			overwrite: flags.has('--overwrite'),
			dryRun: flags.has('--dry-run'),
		});
		if (json) {
			printJson(result);
		} else if (result.dryRun) {
			console.log(`[dry-run] 将创建 ${result.name}（${result.id}）· ${result.mode}`);
			console.log('--- .agent.md ---');
			console.log(result.agentMd.trimEnd());
			console.log('--- memory ---');
			for (const f of result.memoryFiles) {
				console.log(`  ${f.name}  ← ${f.from}  (${f.bytes}B)`);
			}
			if (result.skipped.length) {
				console.log('--- 未导入 ---');
				for (const s of result.skipped) {
					console.log(`  ${s.path}（${s.reason}）`);
				}
			}
			for (const w of result.warnings) {
				console.log(`! ${w}`);
			}
		} else {
			console.log(`${result.mode === 'created' ? '已导入' : '已覆盖'} ${result.name}（${result.id}）→ ${join(agentsRoot, result.id)}`);
			if (result.memoryFiles.length) {
				console.log(`记忆 ${result.memoryFiles.length} 个：${result.memoryFiles.join(', ')}`);
			}
			for (const r of result.renamed ?? []) {
				console.log(`  路径拍平：${r}`);
			}
			for (const w of result.warnings ?? []) {
				console.log(`! ${w}`);
			}
			console.log('（preset 会在 Host 下次页面请求时增量注册；不想等就重开一次 Agents 页）');
		}
		process.exit(0);
	}

	if (command === 'import') {
		const file = positional[0];
		if (!file) {
			fail('缺少包路径：vssaros-agent import <file.zip> [--overwrite]');
		}
		const buffer = await readFile(resolve(file));
		const result = await importAgent(config, buffer, { overwrite: flags.has('--overwrite') });
		if (json) {
			printJson(result);
		} else {
			console.log(`${result.mode === 'created' ? '已导入' : '已覆盖'} ${result.name}（${result.id}）→ ${join(agentsRoot, result.id)}`);
			if (result.memoryFiles.length) {
				console.log(`记忆 ${result.memoryFiles.length} 个文件：${result.memoryFiles.join(', ')}`);
			}
			console.log('（preset 会在 Host 下次页面请求时增量注册；不想等就重开一次 Agents 页）');
		}
		process.exit(0);
	}

	fail(`未知命令：${command}（支持 list / show / create / export / import）`);
} catch (e) {
	const message = String(e?.message ?? e);
	if (json) {
		printJson({ error: message });
	} else {
		console.error(`失败：${message}`);
	}
	process.exit(1);
}
