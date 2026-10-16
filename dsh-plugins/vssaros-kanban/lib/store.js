// @vssaros/dsh-kanban — store（主机侧 I/O）：读 / 原子写 / 写者串行 / 文件锁 / 冲突重试。
//
// 单写者口径（方案 6.8 + G4）与它的诚实边界：
// - 进程内：模块级串行队列（等价于 IDE 侧 `_withTasks` 的写队列），同一 Host 内绝不并发写。
// - 跨进程：`<taskboard.json>.lock` 独占创建（`wx`），按 mtime 年龄破门（持有者崩了不会自己删锁）；
//   等待上限与过期阈值可经 config 调（`lockWaitMs` / `lockStaleMs`）。
// - 写入原子：临时文件 + rename（IDE 侧也是原子写，后缀 `.vsctmp`；这里用 `.vsaros-tmp` 区分）。
// - 丢更新防护：读时记 stamp（mtime:size），写前重新比对；不一致说明有别的写者插进来了 → 重做。
//   ✅ **两侧都进锁了**（README 5.65）：IDE 侧 `agentTaskBoardService._atomicWriteFile` 也取这**同一把**
//   `<file>.lock`（`taskboard.json` 与 `boards.json` 都经它 ✓）⇒ 本层的 CAS 从此是**第二道保险** ✓，
//   不再是唯一防线 ✓。
//   ⚠️ 仍有的边界：用户手工编辑 / 外部脚本不取锁 ⇒ CAS 依然有意义 ✓；破门只看 mtime ✗。
//   ℹ️ `owns` 声明与所有权开关（engine=dsh 时旧模块**完全不写**）**仍未实现** ✗ —— 现在靠"两侧共用一把锁"
//   保证不丢更新 ✓，而不是靠"停写" ✓（归属已可由 `common/dshPluginActivation.ts` 的 `resolveWriteOwnership` 派生 ✓）。

import { mkdir, open, readFile, readdir, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseBoards, parseTaskboard, serializeTaskboard } from './core/taskboard.js';

export const TASKBOARD_FILE = 'taskboard.json';
/** 看板**元数据**（有哪些板、叫什么）—— IDE 写，dsh **只读** ✓（README 5.117）。 */
export const BOARDS_FILE = 'boards.json';
const DEFAULT_LOCK_WAIT_MS = 5000;
const DEFAULT_LOCK_STALE_MS = 15000;
const DEFAULT_RETRIES = 3;

/**
 * 数据根。优先级：行配置 `config.dataRoot` → 环境变量 `VSSAROS_DATA_ROOT` → `~/.vssaros`。
 * VsSaros 的数据根可被设置改动（`.vssaros` / `.vssaros-dev`）：改过时由 VsSaros 经 `--patch`
 * 覆盖本行 config 注入（与 bridge 注入 pipe/token 同一机制）。
 */
export function dataRootOf(config) {
	const configured = typeof config?.dataRoot === 'string' ? config.dataRoot.trim() : '';
	if (configured) {
		return configured;
	}
	const fromEnv = typeof process.env.VSSAROS_DATA_ROOT === 'string' ? process.env.VSSAROS_DATA_ROOT.trim() : '';
	return fromEnv || join(homedir(), '.vssaros');
}

export function taskboardPath(config) {
	return join(dataRootOf(config), TASKBOARD_FILE);
}

export function lockPath(config) {
	return `${taskboardPath(config)}.lock`;
}

/**
 * 工作区 id。**必须拿到**才能建卡：IDE 的 `getTasks(workspaceId)` 会按它过滤，
 * 空/错值的卡片在看板界面里不可见（只能靠直接读 JSON 发现）。
 * 优先级：工具参数 → `config.workspaceId`（VsSaros 经 `--patch` 注入）→ 环境变量。
 */
export function workspaceIdOf(config) {
	const fromConfig = typeof config?.workspaceId === 'string' ? config.workspaceId.trim() : '';
	if (fromConfig) {
		return fromConfig;
	}
	const fromEnv = typeof process.env.VSSAROS_WORKSPACE_ID === 'string' ? process.env.VSSAROS_WORKSPACE_ID.trim() : '';
	return fromEnv;
}

/** 文件指纹：`mtimeMs:size`；不存在时 `absent`。 */
async function fingerprintOf(file) {
	try {
		const st = await stat(file);
		return `${st.mtimeMs}:${st.size}`;
	} catch (e) {
		return e?.code === 'ENOENT' ? 'absent' : `unknown:${e?.code ?? 'err'}`;
	}
}

/** 读看板。文件不存在不是错误（首启形态）：返回空数组 + missing 路径。 */
/**
 * 读 `boards.json`（**只读** ✓，README 5.117 / 数据面 C 组）。
 *
 * 为什么要有它 ✓：`taskboard.json` 里的任务带 `boardId` ✓，而"**有哪些 boardId、叫什么**"只登记在
 * `boards.json` 里 ✓ —— IDE 写它 ✓、dsh 此前**只字不提** ✗ ⇒ 模型能按 boardId 过滤，却**查不到有哪些**
 * ✗（与 5.116 那条"承诺与实现分叉"同形 ✓）。
 *
 * ⚠ **只读** ✓（与 `taskboard.json` 不同：那条有写路径 ✓，这条**没有** ✗ —— 建板/改名是 IDE 的 UI 动作 ✓）。
 * 文件不存在 ⇒ `{ boards: [] }` ✓（不是错误 ✓：只说明"还没建过板"，`default` 永远存在 ✓）。
 * 文件在但读不懂 ⇒ 带上 `error` ✓（如实说，不猜 ✗）。
 */
export async function readBoards(config) {
	const file = join(dataRootOf(config), BOARDS_FILE);
	let text;
	try {
		text = await readFile(file, { encoding: 'utf8' });
	} catch (e) {
		if (e?.code === 'ENOENT') {
			return { boards: [] };
		}
		return { boards: [], error: `boards.json 读取失败：${String(e?.message ?? e)}` };
	}
	return parseBoards(text);
}

// ── dsh 任务镜像（**只读**）───────────────────────────────────────────────────────────
// ★ 2026-10-14（P1「两份任务真相」的最小解）：dsh 的 `todos` 会话投影是**模型的任务清单**
//   （主人 `@deepseek-ai/dsh-tool-todo`），与我们自己的 `taskboard.json` 是**两份真相**。拍板口径是
//   "dsh 为准、看板只**只读镜像**" ⇒ 这里读它，`board.js` 以**镜像卡**渲染：
//     · 镜像卡**不带** `data-task-id` / `data-kanban-grab` ⇒ 客户端**天然**既拖不动、也开不了详情
//       （页面的写口 `/api/move` 只认 taskboard 里的 id ⇒ 看板**没有**多出任何写路径 ✓）；
//     · 读不到（没跑过 dsh 会话 / 没有缓存）**不是错误**：返回空 + 一行说明 ✓（与 `readBoards` 同口径 ✓）。

/**
 * dsh 家目录：`config.dshHome` → 环境变量 `DSH_HOME`（VsSaros 起 Host 时会设）→ `~/.dsh`。
 *
 * ⚠ 与 `vssaros-dashboard/lib/store.js:16-23` **逐字同形** —— 仓里这类"契约共享、实现各自一份"的拷贝
 *   由 `check-host-config.mjs` 的一致性守卫约束 ✓（改一处必须同步另一处 ✓）。
 */
export function dshHomeOf(config) {
	const configured = typeof config?.dshHome === 'string' ? config.dshHome.trim() : '';
	if (configured) {
		return configured;
	}
	const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
	return fromEnv || join(homedir(), '.dsh');
}

/** dsh 的会话投影缓存目录（dsh 自己的 checkpoint：`<DSH_HOME>/storages/session_projcache/sessions`）。 */
export function projCacheDirOf(config) {
	return join(dshHomeOf(config), 'storages', 'session_projcache', 'sessions');
}

/**
 * 投影单元里的**列表值**：`{ val: { head } }` 是**分片链**（逐段 `previous` 前插还原 ✓）；
 * `val: null` / 键缺席 = **从未写过**（⚠ 与"空清单"是两件事，见 `dsh-tool-todo` 的类型注释 ✓）。
 */
function listValueOf(row) {
	const value = row?.val;
	if (!value || typeof value !== 'object') { return []; }
	const parts = [];
	for (let node = value.head; node && typeof node === 'object'; node = node.previous) {
		if (!Array.isArray(node.values)) { break; }
		parts.unshift(...node.values);
	}
	return parts;
}

/**
 * 读"dsh 任务镜像"：把各会话的 `todos` 投影**扁平成镜像卡**。
 *
 * @returns `{ mirrors: {sessionId, sessionTitle, content, status}[], note: string }`
 *   `note` 非空 = **读不到的原因** ⇒ 页面**如实显示** ✓（绝不静默当作"没有任务" ✗ —— 那正是
 *   "两份真相"最容易骗人的地方 ✓）。
 */
export async function readDshTodoMirrors(config, { limit = 40, sessions = 80 } = {}) {
	const dir = projCacheDirOf(config);
	let files;
	try {
		files = (await readdir(dir)).filter(f => f.endsWith('.json'));
	} catch (e) {
		if (e?.code === 'ENOENT') { return { mirrors: [], note: '还没有 dsh 投影缓存（这台机器还没跑过 dsh 会话）' }; }
		return { mirrors: [], note: `dsh 投影缓存读不到：${String(e?.message ?? e)}` };
	}
	if (!files.length) { return { mirrors: [], note: 'dsh 投影缓存是空的' }; }
	// 只取**最近**的若干个会话（按 mtime 倒序）；会话内部保持投影顺序（= 模型写的顺序，不重排 ✗）
	const stamped = [];
	for (const file of files) {
		try {
			stamped.push({ file, at: (await stat(join(dir, file))).mtimeMs });
		} catch { /* 取不到时间就跳过这个文件 ✓ */ }
	}
	stamped.sort((a, b) => b.at - a.at);
	const mirrors = [];
	for (const { file } of stamped.slice(0, sessions)) {
		let record;
		try {
			record = JSON.parse(await readFile(join(dir, file), 'utf8'))?.record;
		} catch { continue; }
		const rows = record?.rows ?? {};
		const items = listValueOf(rows.todos);
		if (!items.length) { continue; }   // `null`（从未写过）与空表都**不**产出镜像卡 ✓
		const sessionId = String(record?.identity?.sessionId ?? file.replace(/\.json$/, ''));
		const rawTitle = rows.title?.val;
		const sessionTitle = typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : '';
		for (const item of items) {
			const content = typeof item?.content === 'string' ? item.content.trim() : '';
			const status = String(item?.status ?? '');
			if (!content || !['pending', 'in_progress', 'completed'].includes(status)) { continue; }
			mirrors.push({ sessionId, sessionTitle, content, status });
			if (mirrors.length >= limit) { return { mirrors, note: '' }; }
		}
	}
	return { mirrors, note: '' };
}

export async function readTaskboard(config, signal) {
	const file = taskboardPath(config);
	let text;
	try {
		text = await readFile(file, { encoding: 'utf8', signal });
	} catch (e) {
		if (e?.code === 'ENOENT') {
			return { tasks: [], missing: file, fingerprint: 'absent' };
		}
		throw new Error(`看板数据读取失败（${file}）：${e?.message ?? e}`);
	}
	let tasks;
	try {
		tasks = parseTaskboard(text);
	} catch (e) {
		throw new Error(`${e?.message ?? e}（${file}）`);
	}
	return { tasks, fingerprint: await fingerprintOf(file) };
}

/** 原子写：临时文件 + rename。失败时清掉临时文件，不留垃圾。 */
async function atomicWrite(file, text) {
	const tmp = `${file}.${process.pid}.vsaros-tmp`;
	try {
		await writeFile(tmp, text, 'utf8');
		await rename(tmp, file);
	} catch (e) {
		await unlink(tmp).catch(() => {});
		throw e;
	}
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 心跳间隔（毫秒）：协议 v2 的一部分，必须**明显小于** `staleMs` ✓（与 workflow / IDE 侧同值 ✓）。 */
const DEFAULT_LOCK_HEARTBEAT_MS = 2000;

/** pid 是否还活着：`true` 活 / `false` 死 / `undefined` 不知道（退回只看 mtime ✓）。 */
function isPidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) {
		return undefined;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM = 活着但没权限（活着 ✓）；ESRCH = 不存在（死了 ✓）；其它 ⇒ 不知道 ✓
		return e?.code === 'EPERM' ? true : (e?.code === 'ESRCH' ? false : undefined);
	}
}

/**
 * 独占创建锁文件；返回释放函数（释放时停掉心跳 ✓）。
 *
 * **协议 v2**（README 5.67；与 `vssaros-workflow/lib/lock.js`、IDE 侧 `agentStudio/common/fileWriteLock.ts` 同款）：
 *   · 持锁期间每 `heartbeatMs` 刷新锁文件 mtime ⇒ "卡死但仍在跑"的持有者不会被误破门 ✓；
 *   · 破门 ＝ mtime 过期 **且** 持有者进程已不在（pid 读不出来 ⇒ 退回只看 mtime ✓）；
 *   · **持有者还活着 ⇒ 绝不破门** ✗（它可能只是慢 ⇒ 等到超时并如实报错 ✓）。
 */
export async function acquireLock(file, { waitMs, staleMs, heartbeatMs = DEFAULT_LOCK_HEARTBEAT_MS }) {
	const content = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			const handle = await open(file, 'wx');
			await handle.writeFile(content);
			await handle.close();
			const timer = setInterval(() => {
				const now = new Date();
				utimes(file, now, now).catch(() => {});
			}, Math.max(50, heartbeatMs));
			timer.unref?.();
			return async () => {
				clearInterval(timer);
				await unlink(file).catch(() => {});
			};
		} catch (e) {
			if (e?.code !== 'EEXIST') {
				throw new Error(`看板写锁创建失败（${file}）：${e?.message ?? e}`);
			}
			let ageMs;
			try {
				ageMs = Date.now() - (await stat(file)).mtimeMs;
			} catch {
				continue; // 锁刚好被释放：立刻重试
			}
			let pid;
			try {
				const raw = JSON.parse(await readFile(file, { encoding: 'utf8' }));
				pid = Number.isInteger(raw?.pid) ? raw.pid : undefined;
			} catch {
				pid = undefined;
			}
			const alive = pid === undefined ? undefined : isPidAlive(pid);
			// 破门：**过期且持有者已不在**（或无从得知）才动手 ✓；活着 ⇒ 绝不 ✗
			if (ageMs > staleMs && alive !== true) {
				await unlink(file).catch(() => {});
				continue;
			}
			if (Date.now() > deadline) {
				const holder = pid === undefined ? '持有者未知' : (alive === true ? `持有者进程 ${pid} 仍在运行` : `持有者 ${pid} 已不在（但锁文件删不掉？）`);
				throw new Error(`看板文件正被另一个写者占用（${file}，已等待 ${waitMs}ms；${holder}）。若确认无其它进程在写，删除该锁文件后重试。`);
			}
			await delay(100);
		}
	}
}

/** 模块级串行队列：同一进程内的写请求排队（等价 IDE `_withTasks` 的写队列）。 */
let queue = Promise.resolve();
function serialized(task) {
	const run = queue.then(task, task);
	queue = run.then(() => {}, () => {});
	return run;
}

/**
 * 读-改-写：加锁 → 读（带指纹）→ `mutator(tasks)` → 指纹未变则原子写回，否则重做。
 * `mutator` 返回 `{ tasks: 新数组, value: 工具返回值 }`；抛错则整体放弃（不写）。
 *
 * 锁参数取自 **config**（`lockWaitMs` / `lockStaleMs`，即插件行的 config，也是文档里的口径），
 * `options` 只放调用期的东西（`signal` / `retries`）；`options` 里的同名锁参数作为兜底覆盖。
 */
export async function mutateTaskboard(config, mutator, options = {}) {
	const pick = (key, fallback) => {
		if (Number.isInteger(options[key])) {
			return options[key];
		}
		return Number.isInteger(config?.[key]) ? config[key] : fallback;
	};
	const waitMs = pick('lockWaitMs', DEFAULT_LOCK_WAIT_MS);
	const staleMs = pick('lockStaleMs', DEFAULT_LOCK_STALE_MS);
	const retries = Number.isInteger(options.retries) ? options.retries : DEFAULT_RETRIES;
	const file = taskboardPath(config);
	await mkdir(dirname(file), { recursive: true });
	return serialized(async () => {
		const release = await acquireLock(lockPath(config), { waitMs, staleMs });
		try {
			for (let attempt = 1; attempt <= retries; attempt++) {
				const { tasks, fingerprint } = await readTaskboard(config, options.signal);
				const { tasks: next, value } = await mutator(tasks);
				if (!Array.isArray(next)) {
					throw new Error('mutator 必须返回 { tasks, value }');
				}
				if (await fingerprintOf(file) !== fingerprint) {
					continue; // 读与写之间有别的写者动了文件 → 重做，避免丢更新
				}
				await atomicWrite(file, serializeTaskboard(next));
				return value;
			}
			throw new Error(`看板文件在写入期间被其它写者反复改动，已放弃（${file}）`);
		} finally {
			await release();
		}
	});
}
