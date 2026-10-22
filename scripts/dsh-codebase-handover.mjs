#!/usr/bin/env node
// 甲档·所有权交接的**操作台**（2026-10-20 用户拍板）。
//
// 交接的含义（三键一起才成立，见 `src/vs/.../common/dshCli.ts::renderCodebaseOverlay`）：
//   `indexTarget: workspace` ⇒ dsh 写 `<ws>/.codebase-memory/` 并自称 `producer: 'vssaros-dsh'`
//                              ⇒ **IDE 见它就不扫描、不落盘**（只读 + 变化即重载）；
//   `indexWatch: true`       ⇒ dsh 常驻保鲜（不开 = 交接后没人更新图 ✗）；
//   `indexMaxFiles: 20000`   ⇒ watcher 每次运行的扫描预算（小于源文件数会把全量图缩掉 ✗）。
//
// ⚠ **交接的第一次建图必须由本脚本（或显式 `codebase_index`）完成**，不能等 watcher：
//   watcher 的首次运行只有增量预算，会拿小图覆盖 IDE 的完整图；插件里已有安全闸
//   （`indexService.handoverNeedsInitialBuild`）会拦住它并打一条 warn ✓。
//
// 用法：
//   node scripts/dsh-codebase-handover.mjs --status                 # 只看现状（谁产的图 / 多少节点 / watch）
//   node scripts/dsh-codebase-handover.mjs --build                  # 首次全量建图（treesitter + 2 万文件预算）
//   node scripts/dsh-codebase-handover.mjs --build --parser regex   # 快档（只想要文件级/顶层符号时）
//   node scripts/dsh-codebase-handover.mjs --self-test              # 自证（临时夹具，不碰真机）
//
// ⚠ `--build` **会写工作区的 `.codebase-memory/`**（甲档的全部意义），并对 IDE 产生"让路"效果：
//   从那一刻起 IDE 不再索引这个工作区，图由 dsh（Host 里的插件）保鲜。要回退：删掉插件行那三键，
//   再删 `<ws>/.codebase-memory/`（或跑 `codebase_delete_project --which both`）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PLUGIN = path.join(REPO, 'dsh-plugins', 'vssaros-codebase', 'lib', 'index.js');

/** 交接档的插件配置（与覆盖层同口径；`indexMaxFiles` 是 watcher 的扫描预算 ✓）。 */
export const HANDOVER_CONFIG = { indexTarget: 'workspace', indexWatch: true, indexMaxFiles: 20000 };

function argValue(flag) {
	const index = process.argv.indexOf(flag);
	return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--') ? process.argv[index + 1] : undefined;
}

/** 最小假 ctx：够插件 `apply` 用（页面/桥/提示词都可缺，工具注册是必须的 ✓）。 */
export function fakeContext(plugin) {
	const tools = new Map();
	const services = {
		tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name); }, get: name => tools.get(name) },
		webServer: { register: () => () => {} },
		connection: { requestRejection: () => undefined },
		vssarosBridge: { callIDE: async () => ({ ok: true }) },
		systemPrompt: { section: () => () => {}, getSectionOrder: () => 100 },
	};
	const make = (declared) => new Proxy({ effect: fn => fn(), on: () => {}, inject: (deps, cb) => cb(make(new Set([...declared, ...deps]))) }, {
		get: (target, prop) => {
			if (prop in target) { return target[prop]; }
			const name = String(prop);
			if (!(name in services)) { throw new Error(`未知属性：${name}`); }
			if (!declared.has(name)) { throw new Error(`未声明服务：${name}`); }
			return services[name];
		},
	});
	return { ctx: make(new Set(plugin.inject ?? [])), tools };
}

/** 现状：工作区清单（谁产的 / 多少节点）+ dsh 影子目录有没有东西。 */
export function statusOf(workspaceRoot) {
	const dir = path.join(workspaceRoot, '.codebase-memory');
	const artifactPath = path.join(dir, 'artifact.json');
	const out = { workspaceRoot, artifactPath, artifact: undefined, graphBytes: undefined, shadowHint: 'dsh 自己的产物看 index-status（本脚本不猜 DSH_HOME）' };
	if (fs.existsSync(artifactPath)) {
		try {
			const manifest = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
			out.artifact = {
				nodes: manifest.node_count, edges: manifest.edge_count, project: manifest.project,
				producer: manifest.producer ?? '(无 ⇒ IDE 产的)',
				savedAt: Number.isFinite(manifest.saved_at) ? new Date(manifest.saved_at).toLocaleString('zh-CN', { hour12: false }) : '?',
			};
		} catch (error) {
			out.artifact = { error: String(error?.message ?? error) };
		}
		const graph = path.join(dir, 'graph.db.zst');
		if (fs.existsSync(graph)) { out.graphBytes = fs.statSync(graph).size; }
	}
	return out;
}

function printStatus(status) {
	console.log(`工作区：${status.workspaceRoot}`);
	if (!status.artifact) { console.log('  清单：不存在（从没索引过）'); return; }
	if (status.artifact.error) { console.log('  清单读失败：', status.artifact.error); return; }
	const a = status.artifact;
	console.log(`  清单：${a.nodes ?? '?'} 节点 / ${a.edges ?? '?'} 边 · 项目 ${a.project ?? '?'} · 保存于 ${a.savedAt}`);
	console.log(`  生产者：${a.producer}${a.producer === 'vssaros-dsh' ? '（dsh ✓ 交接已生效：IDE 会让路）' : '（IDE ✗ 交接未生效：IDE 仍在产图）'}`);
	if (status.graphBytes) { console.log(`  图谱文件：${(status.graphBytes / 1024 / 1024).toFixed(2)} MB`); }
}

// ─── 自证：交接闸的两种输入必须分开 ────────────────────────────────────────────
async function selfTest(plugin) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-handover-selftest-'));
	const ideWs = path.join(tmp, 'ide-owned');
	const ours = path.join(tmp, 'dsh-owned');
	const empty = path.join(tmp, 'empty');
	for (const root of [ideWs, ours, empty]) { fs.mkdirSync(path.join(root, '.codebase-memory'), { recursive: true }); }
	fs.writeFileSync(path.join(ideWs, '.codebase-memory', 'artifact.json'), JSON.stringify({ node_count: 201576, edge_count: 493864 }));
	fs.writeFileSync(path.join(ours, '.codebase-memory', 'artifact.json'), JSON.stringify({ node_count: 10, producer: 'vssaros-dsh' }));
	fs.writeFileSync(path.join(empty, '.codebase-memory', 'artifact.json'), JSON.stringify({ node_count: 0 }));

	const cases = [];
	const check = (label, ok, detail = '') => { cases.push({ label, ok, detail }); };

	const guard = await import(pathToFileURL(path.join(REPO, 'dsh-plugins', 'vssaros-codebase', 'lib', 'indexService.js')).href);
	const blockedIde = await guard.handoverNeedsInitialBuild(ideWs);
	check('IDE 产的图（20 万节点、无 producer）⇒ watcher 必须被拦', typeof blockedIde === 'string' && blockedIde.includes('201576'), String(blockedIde));
	check('dsh 自己产的图 ⇒ 放行（增量正常）', (await guard.handoverNeedsInitialBuild(ours)) === undefined, '');
	check('空制品（0 节点）⇒ 放行（没有可毁的东西）', (await guard.handoverNeedsInitialBuild(empty)) === undefined, '');
	check('工作区没有清单 ⇒ 放行', (await guard.handoverNeedsInitialBuild(path.join(tmp, 'nope'))) === undefined, '');

	const status = statusOf(ideWs);
	check('status 读得出 producer=IDE（无字段）', status.artifact?.producer === '(无 ⇒ IDE 产的)' && status.artifact.nodes === 201576, JSON.stringify(status.artifact));

	fs.rmSync(tmp, { recursive: true, force: true });
	for (const item of cases) { console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.label}${item.ok ? '' : `  :: ${item.detail}`}`); }
	const failed = cases.filter(item => !item.ok).length;
	console.log(failed === 0 ? `\n自证通过（${cases.length}/${cases.length}）` : `\n${failed} 条失败`);
	process.exitCode = failed === 0 ? 0 : 1;
}

// ─── 主入口 ───────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
	const plugin = await import(pathToFileURL(PLUGIN).href);
	const workspaceRoot = path.resolve(argValue('--workspace') ?? process.cwd());

	if (process.argv.includes('--self-test')) {
		await selfTest(plugin);
	} else if (process.argv.includes('--build')) {
		const parser = argValue('--parser') ?? 'treesitter';
		const maxFiles = Number(argValue('--max-files') ?? 20000) || 20000;
		console.log(`首次建图（甲档）：workspace=${workspaceRoot}\n  parser=${parser} maxFiles=${maxFiles} indexTarget=${HANDOVER_CONFIG.indexTarget}\n`);
		const before = statusOf(workspaceRoot);
		printStatus(before);
		console.log('\n建图中（会写工作区的 .codebase-memory/，IDE 将让路）…');
		const live = fakeContext(plugin);
		plugin.apply(live.ctx, { workspaceRoot, ...HANDOVER_CONFIG });
		const tool = live.tools.get('codebase_index');
		if (!tool) { console.error('✗ 插件里找不到 codebase_index'); process.exit(1); }
		const started = Date.now();
		try {
			const value = await tool.execute({ parser, maxFiles }, { signal: AbortSignal.timeout(30 * 60 * 1000) });
			const text = (tool.output.render({ parser, maxFiles }, value) ?? []).map(part => part?.text ?? '').join('\n');
			console.log(`\n完成（${Math.round((Date.now() - started) / 1000)}s）：\n${text}`);
		} catch (error) {
			console.error(`\n✗ 建图失败：${String(error?.message ?? error)}`);
			process.exitCode = 1;
			process.exit();
		}
		console.log('');
		printStatus(statusOf(workspaceRoot));
	} else {
		printStatus(statusOf(workspaceRoot));
		if (!process.argv.includes('--status')) {
			console.log('\n（只读。要完成交接的首次建图：`--build`；要先看语义：读本文件头注释）');
		}
	}
}
