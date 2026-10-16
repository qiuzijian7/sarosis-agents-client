// @vssaros/dsh-workflow — store（主机侧 I/O）：扫工作流目录、读 workflow.json 与 sessions.json。只读。
//
// 位置（真源 `workflowStorageService.ts` + 真机核对）：`<数据根>/workflows/<workflowId>/workflow.json`，
// 同目录还有 `sessions.json`（该工作流跑过的会话索引）与 `sessions/<sessionId>/`（产物）。
// 工作区级还有 `<workspace>/.sarosworkspace/workflows/`——Host 进程未必可达，v0 不覆盖（如实记录）。

import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseWorkflow } from './core/workflow.js';
// 写侧（README 5.62）：锁 + 原子写 —— 与 IDE 侧 `agentStudio/common/fileWriteLock.ts` 同一套协议 ✓
import { FILE_LOCK_STALE_MS, FILE_LOCK_WAIT_MS, acquireFileLock, atomicWriteFile, lockFileFor } from './lock.js';

export function dataRootOf(config) {
	const configured = typeof config?.dataRoot === 'string' ? config.dataRoot.trim() : '';
	if (configured) {
		return configured;
	}
	const fromEnv = typeof process.env.VSSAROS_DATA_ROOT === 'string' ? process.env.VSSAROS_DATA_ROOT.trim() : '';
	return fromEnv || join(homedir(), '.vssaros');
}

export function workflowsRootOf(config) {
	const configured = typeof config?.workflowsRoot === 'string' ? config.workflowsRoot.trim() : '';
	return configured || join(dataRootOf(config), 'workflows');
}

/**
 * `<workflowsRoot>/<id>/workflow.json`；id 不合法时 `null`（调用方如实报错，不猜 ✗）。
 *
 * ⚠ **必须**挡住路径穿越：`id` 来自工具参数 ⇒ **模型可控** ✓。放行 `../../x` 之类，等于让 worker 线程
 * 去读工作流目录之外的任意 JSON ✓（`runWorkflowLoad` 拿到的就是一个"读任意文件"的原语 ✗）。所以只允许
 * 非空、不含 `/`、`\`、`..` 的 id ✓。
 */
export function workflowFilePathOf(config, id) {
	const clean = typeof id === 'string' ? id.trim() : '';
	if (!clean || clean === '.' || clean.includes('..') || clean.includes('/') || clean.includes('\\')) {
		return null;
	}
	return join(workflowsRootOf(config), clean, 'workflow.json');
}

/**
 * `sessions.json` 的**语义**索引（README 5.116 / 数据面 C 组）。
 *
 * 真源 = IDE 侧 `agentStudio/common/workflowSessions.ts` 的 `IWorkflowSessionMeta`（**读源码 + 真机核对** ✓）：
 * `{ id, workflowId, name, chatSessionId?, createdAt, updatedAt, runCount, lastRunAt? }` ✓。
 * ⚠ 此前这里只数了个**条数** ✗，注释还写着"形态未知，不猜字段名" ✓ —— 结果是编排历史在 dsh 侧**等于不可见** ✗
 *（哪个会话、跑过几次、最近一次是什么时候，全读不出来 ✓）。
 *
 * ⚠ 但仍然**防御性** ✓（这条不能丢）：只有在**类型真的对得上**时才给语义字段 ✓；形态不认识 ⇒
 * **退回只给 `count`** ✓ —— 与旧行为逐字一致 ✓（版本不认识 / 外部工具改过 / 将来改结构，
 * 都不会让页面或工具**报错或说谎** ✓）。
 */
async function sessionsInfoOf(dir) {
	let raw;
	try {
		raw = JSON.parse(await readFile(join(dir, 'sessions.json'), { encoding: 'utf8' }));
	} catch {
		return { count: undefined };
	}
	// 兜底计数（旧行为**一字不改** ✓：至少要数得对 ✓）
	const arrays = raw && typeof raw === 'object' && !Array.isArray(raw)
		? Object.values(raw).filter(Array.isArray) : [];
	const count = Array.isArray(raw) ? raw.length
		: (arrays.length === 1 ? arrays[0].length
			: (raw && typeof raw === 'object' ? Object.keys(raw).length : 0));
	if (!Array.isArray(raw)) {
		return { count };
	}
	// 语义 ①：**全部**元素都读得出 `runCount` 才给总数 ✓（一半认识一半不认识 ⇒ 宁可不说 ✗）
	const metas = raw.filter(item => item !== null && typeof item === 'object');
	const runs = metas.length === raw.length && metas.every(m => Number.isFinite(m.runCount))
		? metas.reduce((sum, m) => sum + m.runCount, 0) : undefined;
	// 语义 ②：最近一次（按 `updatedAt` ✓ —— 与 IDE 列表排序同口径 ✓）
	const dated = metas.filter(m => Number.isFinite(m.updatedAt) && typeof m.name === 'string');
	const latest = dated.length ? dated.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0] : undefined;
	return {
		count,
		...(runs === undefined ? {} : { runs }),
		...(latest ? { latestName: latest.name } : {}),
		...(latest && typeof latest.lastRunAt === 'string' ? { latestRunAt: latest.lastRunAt } : {}),
	};
}

/** 扫工作流根：每个子目录一个 `workflow.json`。坏文件带原因、不丢其它工作流。 */
export async function listWorkflows(config, { limit = 200 } = {}) {
	const root = workflowsRootOf(config);
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (e) {
		if (e?.code === 'ENOENT') {
			return { workflows: [], errors: [], root, missing: root };
		}
		throw new Error(`工作流根目录读取失败（${root}）：${e?.message ?? e}`);
	}
	const workflows = [];
	const errors = [];
	for (const entry of entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))) {
		if (workflows.length >= limit) {
			break;
		}
		const dir = join(root, entry.name);
		const file = join(dir, 'workflow.json');
		try {
			const info = await stat(file);
			if (info.size > 20_000_000) {
				errors.push(`${entry.name}：workflow.json 过大（${info.size} 字节），跳过`);
				continue;
			}
		} catch {
			errors.push(`${entry.name}：没有 workflow.json`);
			continue;
		}
		const parsed = parseWorkflow(await readFile(file, { encoding: 'utf8' }), { id: entry.name });
		if (parsed.error) {
			errors.push(`${entry.name}：${parsed.error}`);
			continue;
		}
		parsed.workflow.dir = dir;
		// `sessionCount` **保留** ✓（页面行、工具 schema/投影、探针**三处消费者**都在读它 ✓）；
		// 语义另放 `sessions` ✓（README 5.116）—— 不认识形态时它与旧行为完全相同 ✓。
		const sessions = await sessionsInfoOf(dir);
		parsed.workflow.sessions = sessions;
		parsed.workflow.sessionCount = sessions.count;
		workflows.push(parsed.workflow);
	}
	return { workflows, errors, root };
}

/** 读一个工作流（按 id）。 */
export async function readWorkflow(config, id) {
	const { workflows, errors, root } = await listWorkflows(config, { limit: 1000 });
	const found = workflows.find(workflow => workflow.id === id || workflow.fileId === id);
	if (!found) {
		return { error: errors.find(e => e.startsWith(id)) ?? `没有这个工作流：${id}（目录 ${root}）` };
	}
	return { workflow: found };
}

// ─── 写侧（README 5.62）────────────────────────────────────────────────────────
// 队列① 选项 C 的第二半：把**线性步骤层**的写搬过来。范围**刻意小**：只动 `workflow.json` 的
// **元信息字段**（name / description / tags）✓；节点图 / 边 / `sessions.json` / 目录结构一律不碰 ✗
// —— 那是画布编辑器与 `WorkflowStorageService` 的地盘 ✓。
//
// 写法与看板 `mutateTaskboard` 逐条对齐（`vssaros-kanban/lib/store.js:152-179`）：
//   同进程串行队列 → **取锁** → 读 + 记指纹（mtime:size）→ mutator → **写前重比指纹**（CAS，不一致就重做）
//   → 原子写（tmp + rename）→ **释放锁**（finally ✓）。
//
// ✅ **两侧都进锁了**（README 5.63）：IDE 侧 `workflowStorageService` 的 `workflow.json` 写点
// （create / save）与 `sessions.json` 都取了**同一把** `<file>.lock` ✓ ⇒ 本层的指纹 CAS 从此是
// **第二道保险**（防"没走锁的历史路径"与 IDE 之外的写者 ✓），而不再是唯一防线 ✓。
// ⚠ 仍有的边界：用户手工编辑 / 外部脚本当然不取锁 ⇒ CAS 依然有意义 ✓；破门仍只看 mtime ✗（5.61 ✓）。

/** 文件指纹：`mtimeMs:size`（与看板同款 —— 用于"读-改-写"之间的 CAS ✓）。 */
async function fingerprintOf(file) {
	const info = await stat(file);
	return `${Math.round(info.mtimeMs)}:${info.size}`;
}

/** 模块级串行队列：同进程内的写请求排队（避免自己跟自己抢锁 ✓）。 */
let writeQueue = Promise.resolve();
function serialized(task) {
	const next = writeQueue.then(task, task);
	writeQueue = next.catch(() => undefined);
	return next;
}

/**
 * **读-改-写**一个 `workflow.json`。
 *
 * `mutator(workflow, raw)` 必须返回 `{ text, value }`：`text` 是**完整的新文件内容** ✓
 * —— 怎么改由调用方决定，本函数不猜字段 ✗（也不会替调用方保留未知字段：那是 mutator 的责任 ✓）。
 *
 * @returns `{ value, attempts, file }`；`attempts > 1` 说明撞上过并发写者并重做过 ✓
 */
export async function mutateWorkflow(config, id, mutator, options = {}) {
	const file = workflowFilePathOf(config, id);
	if (!file) {
		throw new Error(`工作流 id 形态不合法：${String(id)}（不允许空、'.'、'..'、'/'、'\\'）`);
	}
	const waitMs = Number.isInteger(options.lockWaitMs) ? options.lockWaitMs
		: (Number.isInteger(config?.lockWaitMs) ? config.lockWaitMs : FILE_LOCK_WAIT_MS);
	const staleMs = Number.isInteger(options.lockStaleMs) ? options.lockStaleMs
		: (Number.isInteger(config?.lockStaleMs) ? config.lockStaleMs : FILE_LOCK_STALE_MS);
	const retries = Number.isInteger(options.retries) ? options.retries : 3;
	return serialized(async () => {
		await mkdir(dirname(file), { recursive: true });
		const release = await acquireFileLock(lockFileFor(file), { waitMs, staleMs, label: '工作流定义' });
		try {
			for (let attempt = 1; attempt <= retries; attempt += 1) {
				let raw;
				let fingerprint;
				try {
					raw = await readFile(file, { encoding: 'utf8' });
					fingerprint = await fingerprintOf(file);
				} catch (e) {
					throw new Error(`读不到 workflow.json（${file}）：${e?.message ?? e}`);
				}
				const parsed = parseWorkflow(raw, { id });
				if (parsed.error) {
					throw new Error(`workflow.json 解析失败（${file}）：${parsed.error}`);
				}
				const produced = await mutator(parsed.workflow, raw);
				if (!produced || typeof produced.text !== 'string') {
					throw new Error('mutator 必须返回 { text, value }');
				}
				if (await fingerprintOf(file) !== fingerprint) {
					continue; // 有别的写者插进来了 ⇒ 重做（CAS ✓）
				}
				await atomicWriteFile(file, produced.text);
				return { value: produced.value, attempts: attempt, file };
			}
			throw new Error(`工作流正被别的写者频繁改动（${file}，已重试 ${retries} 次）`);
		} finally {
			await release();
		}
	});
}

/** 结构改写时**不许**留在节点顶层的键（内容要进 `data` ✓，照 IDE 真源 ✓）。
 *  ⚠ **导出**（2026-10-12）：`workflow_get_schema` 要把这条规则**讲给模型听** ✓，而它必须与这里**逐条一致** ✗
 *  —— `p3-10` 拿本常量与 schema 目录互相对账 ✓（写侧加键而目录没跟上 ⇒ 红 ✓）。 */
export const NODE_META_KEYS = new Set(['id', 'type', 'position', 'parentId', 'style', 'data', 'name']);

/** 真源里的类型别名：对外 schema 宣称的 `branch` / `condition` 在引擎里不存在 ✓ ⇒ 落库前归一成 `ifElse` ✓。
 *  ⚠ 同样**导出**给 schema 目录对账 ✓（真源 IDE 的 schema 把 `branch` 当**真名**宣称 ✗ —— 那是照抄会教错的那一处 ✓）。 */
// ⚠ **三项**（README 5.121）：真源 `workflowExecutionService.ts:47` 的 `NODE_TYPE_ALIASES` 还含
// `ifelse` ✓（全小写那种写法，模型很爱写 ✓）—— 此前这里只有两项 ✗ ⇒ 模型写 `type: 'ifelse'` 时
// dsh 写侧**原样落库** ✓（引擎读时仍会归一 ✓，所以不报错 ✗，但两边的归一结果就不同了 ✓）。
// 三方（真源 ⇄ dsh）由 `dshHarness/test/common/dshWorkflowNodeContractParity.test.ts` 钉住 ✓。
export const NODE_TYPE_ALIASES = { branch: 'ifElse', condition: 'ifElse', ifelse: 'ifElse' };

/**
 * 归一化一次 `workflow_apply` 的入参（**照 IDE 真源** ✓：`workflowTools.ts` 的 `workflow_apply` handler）：
 *   · 必须有 Start 与 End 节点 ✓（少一个 ⇒ 引擎跑不起来 ✓，与其写完才发现不如**先拒** ✓）；
 *   · 节点类型别名归一 ✓；
 *   · 模型常把 `label`/`agentId`/… 放在节点**顶层** ✗ ⇒ 挪进 `data` ✓（否则引擎读不到 ✓）。
 * @returns {{ nodes: object[], connections: object[], fixups: string[] }}
 */
export function normalizeApplyArgs(nodes, connections) {
	if (!Array.isArray(nodes)) { throw new Error('nodes 必须是数组（全部节点；含 Start 与 End）。'); }
	if (!Array.isArray(connections)) { throw new Error('connections 必须是数组（全部连线；可为空数组）。'); }
	const fixups = [];
	for (const node of nodes) {
		if (!node || typeof node !== 'object') { throw new Error('nodes 里有非对象项（每个节点都要是 { id, type, position, data }）。'); }
		const alias = typeof node.type === 'string' ? NODE_TYPE_ALIASES[node.type] : undefined;
		if (alias) { node.type = alias; fixups.push(`type ${alias}`); }
		const data = (node.data && typeof node.data === 'object' && !Array.isArray(node.data)) ? node.data : (node.data = {});
		for (const key of Object.keys(node)) {
			if (NODE_META_KEYS.has(key)) { continue; }
			data[key] = node[key];
			delete node[key];
			fixups.push(`data.${key}`);
		}
	}
	const hasStart = nodes.some(n => n.type === 'start' || n.id === 'start');
	const hasEnd = nodes.some(n => n.type === 'end' || n.id === 'end');
	if (!hasStart || !hasEnd) { throw new Error('工作流必须同时有 Start 与 End 节点（缺一个引擎就跑不起来）。'); }
	return { nodes, connections, fixups };
}

/**
 * `workflow_apply`：用一整份节点图 + 连线**替换**工作流（照 IDE 真源 ✓ 它叫 "create or replace" ✓）。
 *
 * ⚠ 为什么不能直接调 `mutateWorkflow` 了事 ✗：那个原语**要求文件已存在** ✓（它先读再改 ✓）——
 *   而真源允许"新建"。⇒ 存在的走 `mutateWorkflow`（拿锁 + 指纹 CAS + 原子写 ✓），
 *   不存在的走一条**同锁**的创建路径 ✓（并发建同一个 id 时不会互相覆盖 ✓）。
 *
 * @returns `{ value: { id, created, bytes, fixups, attempts } }`
 */
export async function applyWorkflow(config, id, { nodes, connections, name, description }) {
	const normalized = normalizeApplyArgs(nodes, connections);
	const file = workflowFilePathOf(config, id);
	if (!file) { throw new Error(`工作流 id 形态不合法：${String(id)}（不允许空、'.'、'..'、'/'、'\\'）`); }
	const { existsSync } = await import('node:fs');
	if (!existsSync(file)) {
		// 新建：一样走锁 + 原子写 ✓（不写空目录半成品 ✓）
		return serialized(async () => {
			await mkdir(dirname(file), { recursive: true });
			const release = await acquireFileLock(lockFileFor(file), { waitMs: FILE_LOCK_WAIT_MS, staleMs: FILE_LOCK_STALE_MS, label: '工作流定义' });
			try {
				if (existsSync(file)) { throw new Error(`工作流 ${id} 刚被别的写者创建了（请先 workflow_get 看现状再改）`); }
				const now = Date.now();
				const doc = {
					id,
					name: typeof name === 'string' && name.trim() ? name.trim() : id,
					...(typeof description === 'string' ? { description } : {}),
					nodes: normalized.nodes,
					connections: normalized.connections,
					createdAt: now,
					updatedAt: now,
					version: '1.0',
				};
				const text = `${JSON.stringify(doc, null, 2)}\n`;
				await atomicWriteFile(file, text);
				return { value: { id, created: true, bytes: Buffer.byteLength(text, 'utf8'), fixups: normalized.fixups, attempts: 1 } };
			} finally {
				await release();
			}
		});
	}
	const out = await mutateWorkflow(config, id, (_workflow, raw) => {
		// ⚠ 保留**原始文档里的其它键**（tags / isActive / workspaceId / 画布样式… ✓）——
		//   只替换 nodes / connections（+ 显式给了 name/description 才动它们 ✓），
		//   否则"改个图"会把元数据清光 ✗（那比不改更糟 ✓）。
		const doc = JSON.parse(raw);
		doc.nodes = normalized.nodes;
		doc.connections = normalized.connections;
		if (typeof name === 'string' && name.trim()) { doc.name = name.trim(); }
		if (typeof description === 'string') { doc.description = description; }
		doc.updatedAt = Date.now();
		const text = `${JSON.stringify(doc, null, 2)}\n`;
		return { text, value: { id, created: false, bytes: Buffer.byteLength(text, 'utf8'), fixups: normalized.fixups } };
	});
	return { value: { ...out.value, attempts: out.attempts } };
}
