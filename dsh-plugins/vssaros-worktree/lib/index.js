// @vssaros/dsh-worktree — dsh Host 侧的 worktree **唯一 git 状态真源**（P1，2026-11-17）。
//
// 架构（方案 B：一套 git 源，以 dsh 侧为准）：
//   dsh 页面 chip / IDE WorktreeViewPane / 模型 create_worktree 工具
//     → IDE 主进程 DshHostHttp('/x/worktree/api/*')
//     → 本插件 → 官方 ctx.worktrees.create/restore + ctx.workingDirectory.set（会话事实）
//               或 ctx.subprocess 里被 sandbox.confine 约束的 git（列举/删除/lock/prune）
//     → revision 化快照 → IDE renderer 只读缓存 → PushWorktrees → 页面
//
// ★ 单一真源纪律：所有 `git worktree *` 都在这个 Host 进程里执行，且复用官方的
//   `.agents/worktrees` 目录池与沙箱策略；IDE 侧只允许读本快照 + 发意图。
//   官方服务已经处理了 confine / 路径校验 / 目录池 / `plugin:worktree/created` 记录 /
//   `workingDirectory.set`，我们**不重复实现创建**，只补官方没有的 list/remove/lock/prune。
//
// 参考（bundled runtime 0.2.2-rc.2）：
//   · `dsh-experimental-worktree/src/index.ts:159,190,251-286` → create / restore / 序列
//   · `dsh-experimental-worktree/src/process.ts:22-27,128-153`  → GIT_ENV / spawnCommand
//   · `dsh-experimental-worktree/src/removal.ts:99-142`          → worktree remove 序列
//   · `dsh-experimental-worktree/src/projection.ts:9-10`         → plugin:worktree/created
//   · `dsh-working-directory/src/index.ts:188-195`               → set(agent, path)
//   · `dsh-agent/src/index.ts:576-582`                           → agents.get(sessionId) === Agent
//   · `dsh-session/src/index.ts:66-79`                           → session/event（全局 feed）
//   · 路由范式：`vssaros-agents/lib/index.js:1519-1531`（`requestRejection` 必须首行）

import path from 'node:path';

export const name = 'vssaros-worktree';

const PLUGIN_ID = '@vssaros/dsh-worktree';
const ROUTE_PREFIX = '/x/worktree';
const API_PREFIX = `${ROUTE_PREFIX}/api`;
/** 与官方 `WorktreeService.static Config.directory` 的默认值一致（不导出常量，只能约定复用）。 */
const POOL = '.agents/worktrees';
const MAX_OUTPUT_BYTES = 65_536;
const GRACE_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/** 清掉继承的 Git 选择器（照抄官方 `process.ts:22-27`）。 */
const GIT_ENV = Object.fromEntries([
	'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
	'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
	'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
	'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
].map(key => [key, undefined]));

const WRITE_ENDPOINTS = [
	'create', 'enter', 'remove', 'restore', 'lock', 'unlock', 'prune', 'checkpoint', 'git',
];

/**
 * P2：IDE 主进程的 `vscode:execGit` 整体转发到本插件 ⇒ 这个进程是**唯一执行 git 的进程**。
 * 白名单覆盖 WorktreeService / WorktreeCheckpointServiceImpl / gitCommitService 的全部子命令；
 * 拒绝 `-c` / `--exec` / `--config-env` / `--upload-pack`（防止覆盖我们固定的安全参数或拉起任意程序）。
 * spawn 不走 shell（参数字面量），所以这里主要是收缩能力面而不是防命令注入。
 */
const GIT_SAFE_SUBCOMMANDS = new Set([
	'worktree', 'status', 'show-ref', 'rev-parse', 'rev-list', 'remote', 'log', 'symbolic-ref',
	'branch', 'config', 'check-ignore', 'fetch', 'reset', 'clean', 'submodule', 'push', 'add',
	'write-tree', 'commit-tree', 'update-ref', 'for-each-ref', 'restore', 'diff', 'commit',
	'fsmonitor', 'check-ref-format', 'ls-files', 'cat-file',
]);

function json(res, status, body) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
	const chunks = [];
	for await (const chunk of req) { chunks.push(chunk); }
	const text = Buffer.concat(chunks).toString('utf8').trim();
	return text ? JSON.parse(text) : {};
}

/** 绝对路径（Windows 盘符 / UNC / POSIX），并拒绝控制字符。 */
function isSafePath(value) {
	if (typeof value !== 'string' || value.length === 0 || value.length > 1024) { return false; }
	if (/[\u0000-\u001f]/.test(value)) { return false; }
	return path.isAbsolute(value);
}

/** 与官方 `relativePath` 同口径：拒绝 `\`、`:`、空段、`.`、`..`，且不能以 `-` 开头。 */
function isSafeName(value) {
	if (typeof value !== 'string' || value.length === 0 || value.length > 128) { return false; }
	if (value.includes('\\') || value.includes(':') || value.startsWith('-')) { return false; }
	return value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');
}

function contains(parent, child) {
	const root = path.resolve(parent);
	const target = path.resolve(child);
	return target === root || target.startsWith(root + path.sep);
}

function isSessionId(value) {
	return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

/** `git worktree list --porcelain` → 只读展示记录（字段与 IDE `IDshWorktreeOption` 同形）。 */
function parsePorcelain(stdout) {
	const out = [];
	let current = null;
	for (const line of stdout.split(/\r?\n/)) {
		if (line.startsWith('worktree ')) {
			if (current) { out.push(current); }
			current = { path: line.slice(9), name: '', branch: undefined, isMain: false, detached: false, locked: false, prunable: false };
		} else if (!current) {
			continue;
		} else if (line.startsWith('HEAD ')) {
			current.name = line.slice(5, 12);
		} else if (line.startsWith('branch ')) {
			current.branch = line.slice(7).replace(/^refs\/heads\//, '');
			current.name = current.branch;
		} else if (line === 'detached') {
			current.detached = true;
		} else if (line.startsWith('locked')) {
			current.locked = true;
		} else if (line.startsWith('prunable')) {
			current.prunable = true;
		} else if (line === 'bare') {
			current.bare = true;
		}
	}
	if (current) { out.push(current); }
	if (out.length > 0) { out[0].isMain = true; }
	return out;
}

/**
 * 在调用会话的既有沙箱策略下执行一条 git 命令。
 * 形态照抄官方 `process.ts:128-153`：`resolveExecutable` → `sandbox.confine` → `subprocess.spawn`
 * （`danger-full-access` 必须跳过 confine）→ `done` / `collected` → `terminate` + `waitForExit`。
 */
async function spawnGit(svc, { cwd, args, session, timeoutMs = DEFAULT_TIMEOUT_MS, env = {} }) {
	const ctx = svc.ctx;
	if (!ctx || !svc.subprocess || !svc.sandbox || !svc.sandboxPolicy) {
		throw new Error('vssaros-worktree：Host 的 subprocess/sandbox/sandboxPolicy 服务未就绪（官方 bundle 未启用？）');
	}
	const signal = AbortSignal.timeout(timeoutMs);
	const policy = svc.sandboxPolicy.resolve(session ? { session } : {});
	const program = await svc.subprocess.resolveExecutable('git', undefined, signal);
	const command = [program, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
		...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []), ...args];
	const wrapped = policy.mode === 'danger-full-access'
		? command
		: (await svc.sandbox.confine(command, { ...policy, mode: policy.mode }, signal)).argv;
	const child = svc.subprocess.spawn({
		argv: wrapped,
		cwd,
		env: { ...GIT_ENV, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_NO_LAZY_FETCH: '1', ...env },
		signal,
		graceMs: GRACE_MS,
		stdio: { stdin: 'ignore', stdout: { maxBytes: MAX_OUTPUT_BYTES }, stderr: { maxBytes: MAX_OUTPUT_BYTES } },
	});
	try {
		const outcome = await child.done;
		const captured = child.collected;
		const stdout = captured?.stdout?.readFrom(0) ?? { text: '', lossy: false };
		const stderr = captured?.stderr?.readFrom(0) ?? { text: '' };
		if (stdout.lossy || stderr.lossy) { throw new Error('vssaros-worktree：git 输出超过 maxOutputBytes'); }
		return {
			stdout: stdout.text,
			stderr: stderr.text,
			exitCode: outcome.exitCode ?? -1,
			signal: outcome.signal ?? null,
		};
	} finally {
		child.terminate();
		await child.waitForExit();
	}
}

/** 写路径：非零退出即抛（create / remove / lock / prune 依赖这个失败出口）。 */
async function runGit(svc, options) {
	const r = await spawnGit(svc, options);
	if (r.exitCode !== 0) {
		throw new Error(`git ${options.args.join(' ')} 失败 (${r.signal ?? r.exitCode})：${r.stderr.trim()}`);
	}
	return r.stdout;
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx, config = {}) {
	// ── 权威状态容器 ────────────────────────────────────────────────────────
	let revision = 0;
	let lastChange = 0;
	let worktrees = [];
	let roots = [];
	let currentDirectory = null;

	/** 三个独立 inject：任一官方服务缺席都只让对应能力降级，不让整包 pending。 */
	const svc = {
		ctx: null, agents: null, sessions: null,
		worktrees: null, workingDirectory: null,
		subprocess: null, sandbox: null, sandboxPolicy: null,
	};

	const snapshot = () => ({
		source: 'dsh',
		plugin: PLUGIN_ID,
		revision,
		lastChange,
		ready: !!svc.worktrees && !!svc.workingDirectory && !!svc.subprocess,
		worktrees,
		roots,
		currentDirectory,
	});

	const service = {
		version: 2,
		plugin: PLUGIN_ID,
		snapshot,
		/** 任何一次 git/会话事实变化都要递增 revision：IDE 侧靠 `?since=N` 判断要不要重拉。 */
		noteChange(change = {}) {
			if (change && typeof change === 'object') {
				if (Array.isArray(change.worktrees)) { worktrees = change.worktrees; }
				if (Array.isArray(change.roots)) { roots = change.roots; }
				if (typeof change.currentDirectory === 'string') { currentDirectory = change.currentDirectory; }
			}
			revision += 1;
			lastChange = Date.now();
			return snapshot();
		},
		capabilities() {
			return {
				read: ['health', 'snapshot'],
				write: WRITE_ENDPOINTS.filter(e => e !== 'checkpoint'),
				writeReady: !!svc.worktrees && !!svc.workingDirectory && !!svc.subprocess,
				officialRuntime: !!svc.worktrees,
				officialWorkingDirectory: !!svc.workingDirectory,
				agentRegistry: !!svc.agents,
				gitRuntime: !!svc.subprocess,
			};
		},
	};
	ctx.provide('vssarosWorktree', service);

	ctx.inject(['agents', 'sessions'], child => child.effect(() => {
		svc.ctx = child;
		svc.agents = child.agents;
		svc.sessions = child.sessions;
		return () => { svc.ctx = null; svc.agents = null; svc.sessions = null; };
	}));
	ctx.inject(['worktrees', 'workingDirectory'], child => child.effect(() => {
		svc.ctx = svc.ctx ?? child;
		svc.worktrees = child.worktrees;
		svc.workingDirectory = child.workingDirectory;
		return () => { svc.worktrees = null; svc.workingDirectory = null; };
	}));
	ctx.inject(['subprocess', 'sandbox', 'sandboxPolicy'], child => child.effect(() => {
		svc.ctx = svc.ctx ?? child;
		svc.subprocess = child.subprocess;
		svc.sandbox = child.sandbox;
		svc.sandboxPolicy = child.sandboxPolicy;
		return () => { svc.subprocess = null; svc.sandbox = null; svc.sandboxPolicy = null; };
	}));

	// ── 会话事件：模型自己调 `create_worktree` 时也会经 `working-directory/change` 通知到这里。
	// 事件是 session log 的全局 feed（`dsh-session/src/index.ts:66-79`），不是 Cordis 顶层事件名。
	// 只依赖这一条就能覆盖「模型创建 → IDE/页面列表同步」，无需解析 plugin record。
	ctx.effect(() => {
		const dispose = ctx.on('session/event', (_session, event) => {
			if (event && event.type === 'working-directory/change' && typeof event.data?.cwd === 'string') {
				service.noteChange({ currentDirectory: event.data.cwd });
			}
		});
		return () => { try { dispose(); } catch { /* Cordis 卸载时可能已自动回收 */ } };
	});

	/**
	 * 取会话事实：热会话直接 `agents.get(sessionId)`（Agent.id === Session.id）。
	 * 页面桥命令拿不到 sessionId ⇒ 允许缺省，取第一个在运行的会话作为执行上下文
	 * （官方服务需要 Agent 只是为了拿当前目录与沙箱策略，不承载业务归属）。
	 */
	function requireSession(sessionId) {
		if (sessionId !== undefined && !isSessionId(sessionId)) { throw new Error('vssaros-worktree：sessionId 非法'); }
		const id = sessionId ?? svc.agents?.list?.()?.[0]?.id;
		if (!id) { throw new Error('vssaros-worktree：没有运行中的会话，无法取得执行上下文'); }
		const agent = svc.agents?.get(id);
		const session = svc.sessions?.get(id);
		if (!agent) { throw new Error(`vssaros-worktree：会话 ${id} 不在运行态（拿不到 Agent）`); }
		return { agent, session };
	}

	/** 写端点的公共输入校验：目标路径必须落在 `root/.agents/worktrees/` 池内。 */
	function poolTarget(body) {
		if (!isSafePath(body.root)) { throw new Error('vssaros-worktree：root 必须是绝对路径'); }
		if (!isSafePath(body.path)) { throw new Error('vssaros-worktree：path 必须是绝对路径'); }
		const root = path.resolve(body.root);
		const target = path.resolve(body.path);
		if (!contains(root, target)) { throw new Error('vssaros-worktree：path 不在 root 内'); }
		if (!contains(path.join(root, POOL), target)) {
			throw new Error(`vssaros-worktree：path 不在官方目录池 ${POOL} 内（拒绝任意路径）`);
		}
		return { root, target };
	}

	// ── HTTP 契约面 ────────────────────────────────────────────────────────
	ctx.inject(['webServer', 'connection'], page => page.effect(() => page.webServer.register({
		kind: 'prefix',
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			const rejected = page.connection.requestRejection(req);
			if (rejected) {
				res.writeHead(rejected, { 'content-type': 'text/plain; charset=utf-8' });
				res.end(String(rejected));
				return;
			}
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			const pathname = url.pathname;

			if (pathname === `${API_PREFIX}/health` && req.method === 'GET') {
				json(res, 200, { ok: true, plugin: PLUGIN_ID, version: service.version, ...service.capabilities(), snapshotRevision: revision });
				return;
			}

			// revision 化快照：`root` 是 IDE 上报的仓库根；git list 在 Host 沙箱内执行。
			if (pathname === `${API_PREFIX}/snapshot` && req.method === 'GET') {
				const root = url.searchParams.get('root');
				const sessionId = url.searchParams.get('session') ?? undefined;
				if (root && !isSafePath(root)) { json(res, 400, { ok: false, error: 'INVALID_ROOT' }); return; }
				try {
					let list = [];
					if (root) {
						// 只读列举也要带会话策略：`sandboxPolicy.resolve({})` 的授权根是部署默认目录，
						// 会把 IDE 仓库根挡在 confine 之外。页面/IDE 未给 session 时取第一个运行会话。
						const { session } = requireSession(sessionId);
						list = parsePorcelain(await runGit(svc, { cwd: path.resolve(root), args: ['worktree', 'list', '--porcelain'], session }));
						service.noteChange({ worktrees: list, roots: [path.resolve(root)] });
					}
					json(res, 200, { ...snapshot(), ...(url.searchParams.has('since') ? { since: Number(url.searchParams.get('since')) || 0 } : {}) });
				} catch (e) {
					json(res, 200, { ...snapshot(), ok: false, error: String(e?.message ?? e) });
				}
				return;
			}

			const endpoint = WRITE_ENDPOINTS.find(n => pathname === `${API_PREFIX}/${n}`);
			if (endpoint && req.method === 'POST') {
				let body;
				try { body = await readJsonBody(req); } catch { json(res, 400, { ok: false, error: 'INVALID_JSON' }); return; }
				try {
					const result = await dispatchWrite(endpoint, body);
					json(res, 200, { ok: true, endpoint, result, ...snapshot() });
				} catch (e) {
					json(res, endpoint === 'checkpoint' ? 501 : 400, {
						ok: false, endpoint, error: String(e?.message ?? e), snapshotRevision: revision,
					});
				}
				return;
			}

			json(res, 404, { ok: false, error: 'NOT_FOUND', pathname });
		},
	})));

	async function dispatchWrite(endpoint, body) {
		if (endpoint === 'checkpoint') {
			throw new Error('NOT_IMPLEMENTED：checkpoint 基线/回滚尚未从 IDE 侧迁到 Host（P2）；当前不得回落本地 git');
		}
		const { agent, session } = requireSession(body.sessionId);
		// 页面桥命令只带 name / path，不知道 IDE 仓库根 ⇒ 用该会话的原始项目根补齐
		// （与官方 `sandboxPolicy.resolve({session}).workspaceRoot` 同源）。
		if (body.root === undefined && typeof session?.header?.cwd === 'string') {
			body.root = session.header.cwd;
		}

		// ── P2：IDE 主进程 `vscode:execGit` 的唯一落点 ──────────────────────
		// WorktreeService / WorktreeCheckpointServiceImpl / gitCommitService 的所有 git
		// 命令都经这里执行 ⇒ IDE 侧不再 spawn git，git 真源只有 dsh Host 这一处。
		if (endpoint === 'git') {
			const args = body.args;
			if (!Array.isArray(args) || args.length === 0 || args.length > 32 || !GIT_SAFE_SUBCOMMANDS.has(args[0])) {
				throw new Error('git 子命令不在白名单内');
			}
			for (const a of args) {
				if (typeof a !== 'string' || a.length > 512 || /[\u0000-\u001f]/.test(a)
					|| a === '-c' || a.startsWith('--exec') || a === '--config-env' || a.startsWith('--upload-pack')) {
					throw new Error('git 参数不合法');
				}
			}
			if (!isSafePath(body.cwd)) { throw new Error('cwd 必须是绝对路径'); }
			// 授权根与官方 `sandboxPolicy.resolve({session}).workspaceRoot` 同源。
			const root = session?.header?.cwd;
			if (typeof root === 'string' && isSafePath(root) && !contains(path.resolve(root), path.resolve(body.cwd))) {
				throw new Error('cwd 不在会话授权根内');
			}
			const env = {};
			// checkpoint 用隔离索引写快照；只放行这一个键（与 IDE 侧 GIT_ENV_WHITELIST 同口径）。
			if (body.env && typeof body.env === 'object' && typeof body.env.GIT_INDEX_FILE === 'string'
				&& isSafePath(body.env.GIT_INDEX_FILE)) {
				env.GIT_INDEX_FILE = body.env.GIT_INDEX_FILE;
			}
			const timeoutMs = typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs)
				? Math.min(600_000, Math.max(1_000, body.timeoutMs)) : 30_000;
			const r = await spawnGit(svc, { cwd: path.resolve(body.cwd), args, session, timeoutMs, env });
			// 只读命令（status / rev-parse / worktree list …）**不递增 revision**：IDE 侧轮询靠它判断
			// 要不要重推页面，若每次 git 读都递增会造成大量无意义刷新。
			const mutating = (args[0] === 'worktree' && ['add', 'remove', 'prune', 'lock', 'unlock'].includes(args[1]))
				|| ['reset', 'clean', 'push', 'add', 'commit-tree', 'update-ref', 'restore', 'commit', 'fetch', 'submodule'].includes(args[0]);
			if (mutating) { service.noteChange(); }
			return { success: r.exitCode === 0, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
		}

		if (endpoint === 'create') {
			if (!svc.worktrees) { throw new Error('官方 worktree 运行时未就绪（bundle 未启用？）'); }
			const args = {};
			if (body.name !== undefined) {
				if (!isSafeName(body.name)) { throw new Error('name 不是合法的分支名'); }
				args.name = body.name;
			}
			if (body.from !== undefined) {
				if (typeof body.from !== 'string' || body.from.length === 0 || body.from.length > 256) { throw new Error('from 非法'); }
				args.from = body.from;
			}
			// 官方 `create` 会顺带把**调用会话**的 workingDirectory 切到新检出目录；而 IDE 侧
			// `switchWorktree` 仍是「新开会话到该目录」的产品语义 ⇒ 创建后把原会话 cwd 恢复，
			// 避免两边对同一会话的目录认知分叉（模型自己调 create_worktree 不走本端点，不受影响）。
			const before = session && svc.workingDirectory ? svc.workingDirectory.get(session) : undefined;
			const created = await svc.worktrees.create(agent, args, AbortSignal.timeout(DEFAULT_TIMEOUT_MS));
			if (before && svc.workingDirectory && created.path !== before) {
				try { await svc.workingDirectory.set(agent, before, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)); }
				catch { /* 恢复失败只留诊断：创建已成功，不能把成功包装成失败 */ }
			}
			service.noteChange();
			return created;
		}

		if (endpoint === 'restore') {
			if (!svc.worktrees) { throw new Error('官方 worktree 运行时未就绪'); }
			const r = body.record;
			if (!r || !isSafePath(r.path) || !isSafePath(r.repositoryRoot) || !isSafeName(r.branch)
				|| typeof r.baseCommit !== 'string' || !/^[0-9a-f]{7,40}$/.test(r.baseCommit)) {
				throw new Error('restore 记录形状不合法');
			}
			const restored = await svc.worktrees.restore(agent, {
				path: r.path, branch: r.branch, baseCommit: r.baseCommit, repositoryRoot: r.repositoryRoot,
			}, AbortSignal.timeout(DEFAULT_TIMEOUT_MS));
			service.noteChange();
			return restored;
		}

		if (endpoint === 'enter') {
			if (!svc.workingDirectory) { throw new Error('官方 workingDirectory 服务未就绪'); }
			if (!isSafePath(body.path)) { throw new Error('path 必须是绝对路径'); }
			// 允许「切回主仓 root 本身」或「进入官方池内的检出目录」，不接受池外任意路径。
			if (body.root !== undefined) {
				if (!isSafePath(body.root)) { throw new Error('root 必须是绝对路径'); }
				const root = path.resolve(body.root);
				const target = path.resolve(body.path);
				if (!contains(root, target)) { throw new Error('path 不在 root 内'); }
				if (target !== root && !contains(path.join(root, POOL), target)) {
					throw new Error(`path 既不是主仓也不是官方目录池 ${POOL} 内的检出目录`);
				}
			}
			const cwd = await svc.workingDirectory.set(agent, path.resolve(body.path), AbortSignal.timeout(DEFAULT_TIMEOUT_MS));
			service.noteChange({ currentDirectory: cwd });
			return { cwd };
		}

		if (endpoint === 'remove') {
			// 官方语义：不带 --force、不删分支（README.zh.md:89、removal.ts:105）。
			if (body.force === true || body.deleteBranch === true) {
				throw new Error('拒绝：官方 worktree 语义不带 force、不删分支；请在 IDE 侧用带确认的独立命令');
			}
			const { root } = poolTarget(body);
			await runGit(svc, { cwd: root, args: ['worktree', 'remove', '--', body.path], session, timeoutMs: 60_000 });
			service.noteChange();
			return { removed: body.path, retained: true };
		}

		if (endpoint === 'lock' || endpoint === 'unlock') {
			const { root } = poolTarget(body);
			const args = endpoint === 'lock'
				? ['worktree', 'lock', ...(typeof body.reason === 'string' ? ['--reason', body.reason.slice(0, 200)] : []), '--', body.path]
				: ['worktree', 'unlock', '--', body.path];
			await runGit(svc, { cwd: root, args, session });
			service.noteChange();
			return { ok: true };
		}

		if (endpoint === 'prune') {
			if (!isSafePath(body.root)) { throw new Error('root 必须是绝对路径'); }
			await runGit(svc, { cwd: path.resolve(body.root), args: ['worktree', 'prune'], session });
			service.noteChange();
			return { ok: true };
		}

		throw new Error(`未知端点：${endpoint}`);
	}
}
