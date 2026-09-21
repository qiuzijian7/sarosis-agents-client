/*---------------------------------------------------------------------------------------------
 *  服务器配置 — HTTP KV
 *
 *  agentmemory 通过本地 HTTP KV server 持久化状态。iii-engine WebSocket 主通道已放弃：
 *  iii-sdk 依赖 Node-only 的 `ws` 模块，无法被 esbuild 打进 capability-plugin 的 browser ESM bundle。
 *
 *  ★ 端口隔离（2026-09-16 用户裁决 / 09-19 落地）：
 *    「安装版（~/.vssaros）」与「dev（~/.vssaros-dev）」是两个 app 形态、各有一份数据目录，
 *    端口此前都写死 3111 ⇒ 后启动的一方 `EADDRINUSE` 崩溃，且会**静默复用对方的网关**
 *    （dev 的记忆读写落进生产库）。现规则：**安装版 3111 / dev 3112**。
 *    ⚠ 本文件的端口规则必须与主进程 `CodeApplication._resolveAgentMemoryPort()` **保持一致**；
 *      主进程是唯一真源，两个工程的代码无法共享 ⇒ 改一处必须改另一处。
 *
 *  ★ 渲染侧怎么知道自己是哪个端口（2026-09-19 真机实测后定为 dataDir 认领）：
 *    渲染进程里**没有 `process`**（CDP 实测 `hasProcess:false`）⇒ 主进程写在
 *    `process.env.AGENTMEMORY_URL` 的端口**读不到**；`env['VSCODE_DEV']` 同理读不到，
 *    依赖它的推导分支也是死的。因此由宿主（`agentStudio.contribution.ts` 的
 *    `_injectAgentMemoryEndpoint()`）探测 `/health` 的 `dataDir`，与**本窗口 userDataPath**
 *    比对后写 `globalThis.__SAROS_AGENTMEMORY_URL__`；属于其他数据目录的地址写进
 *    `globalThis.__SAROS_AGENTMEMORY_FOREIGN__`，本文件把它们**从候选中剔除**。
 *--------------------------------------------------------------------------------------------*/

const DEFAULT_HTTP_URL = 'http://127.0.0.1:3111';
/** dev 形态的默认端口（见文件头「端口隔离」）。 */
const DEV_HTTP_URL = 'http://127.0.0.1:3112';
export const REQUEST_TIMEOUT_MS = 5000;

/** 探测成功后锁定的基址（优先级最高）。 */
let _resolvedBase: string | null = null;

/**
 * 实测探测成功时锁定基址（由 `probeGateway()` 调用）。
 * 这是**最强兜底** —— 即便渲染侧读不到任何环境变量，只要有一个网关在监听，就能用对地址。
 */
export function setResolvedServerBase(url: string): void {
	_resolvedBase = url.replace(/\/+$/, '');
}

/**
 * 宿主注入的网关地址（见文件头「渲染侧怎么知道自己是哪个端口」）。
 * 这是渲染侧**唯一**能真正拿到端口的通道，故优先级仅次于"实测探测锁定"。
 */
function hostInjectedUrl(): string | null {
	const v = (globalThis as { __SAROS_AGENTMEMORY_URL__?: unknown }).__SAROS_AGENTMEMORY_URL__;
	return typeof v === 'string' && v.length > 0 ? v.replace(/\/+$/, '') : null;
}

/** 宿主探到的「属于其他数据目录」的地址：本窗口必须**排除**，否则会读写到另一形态的库。 */
const _foreignBases: Set<string> = new Set();
function hostForeignBases(): Set<string> {
	const v = (globalThis as { __SAROS_AGENTMEMORY_FOREIGN__?: unknown }).__SAROS_AGENTMEMORY_FOREIGN__;
	const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
	for (const x of list) {
		_foreignBases.add(x.replace(/\/+$/, ''));
	}
	return _foreignBases;
}

/** 运行时标记为异己（checkHealth 校验 dataDir 失败时调用）。 */
function markForeign(base: string): void {
	_foreignBases.add(base.replace(/\/+$/, ''));
}

/** 宿主告知的「本窗口该连哪份数据」（归一化后）；未注入则不做校验。 */
function hostWantDataDir(): string | null {
	const v = (globalThis as { __SAROS_AGENTMEMORY_WANT_DATADIR__?: unknown }).__SAROS_AGENTMEMORY_WANT_DATADIR__;
	return typeof v === 'string' && v.length > 0 ? v : null;
}

/** 与宿主同一套归一化：Windows 大小写不敏感、分隔符可能混用。 */
function normalizePath(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * HTTP KV server 地址。优先级：
 *   ⓪ 实测探测锁定的地址（最强证据）
 *   ① 宿主按 dataDir 认领后注入的地址（`__SAROS_AGENTMEMORY_URL__`）—— 渲染侧的正常路径
 *   ② `AGENTMEMORY_URL`（`process.env`；渲染进程通常没有 `process` ⇒ 实际很少命中，
 *      保留以兼容扩展宿主/Node 等有 `process` 的环境，以及测试）
 *   ③ 按 `VSCODE_DEV` 推导（同上，渲染侧一般读不到）
 *   ④ 3111（安装版默认）
 */
export function serverBase(): string {
	if (_resolvedBase) return _resolvedBase;
	const host = hostInjectedUrl();
	if (host) return host;
	const env = (globalThis as { process?: { env?: Record<string, string> } })?.process?.env;
	const envUrl = env?.['AGENTMEMORY_URL'];
	if (typeof envUrl === 'string' && envUrl.length > 0) return envUrl.replace(/\/+$/, '');
	if (env?.['VSCODE_DEV']) return DEV_HTTP_URL;
	return DEFAULT_HTTP_URL;
}

/**
 * 候选基址（按可信度排序，已去重）：供探测失败时逐个尝试。
 *
 * ⚠ **一旦地址被"明确给定"就只返回它自己**，绝不再猜别的端口 —— 否则会连到
 * **另一个形态**的网关（dev 连上安装版的库 = 跨环境串味，正是端口隔离要解决的问题）。
 * "明确给定"的两种情形：
 *   ① 宿主按 dataDir 认领成功（`__SAROS_AGENTMEMORY_URL__`）；
 *   ② `AGENTMEMORY_URL` 被显式设置（测试/用户指定）。
 * 只有在「毫无信息」时才退回"推导值 + 另一端口"兜底，且**剔除已确认属于其他数据目录的地址**
 * （宿主在认领失败时仍会留下 `__SAROS_AGENTMEMORY_FOREIGN__` —— 例如本窗口网关还在启动，
 *  而安装版的网关已在 3111 监听，此时宁可探测失败也**不能**去连 3111）。
 */
export function serverBaseCandidates(): string[] {
	const host = hostInjectedUrl();
	if (host) return [host];
	const env = (globalThis as { process?: { env?: Record<string, string> } })?.process?.env;
	const explicit = env?.['AGENTMEMORY_URL'];
	if (typeof explicit === 'string' && explicit.length > 0) return [explicit.replace(/\/+$/, '')];
	const foreign = hostForeignBases();
	const list = [...new Set([serverBase(), DEV_HTTP_URL, DEFAULT_HTTP_URL])].filter(u => !foreign.has(u));
	// 极端情况（两个端口都被判为异己）⇒ 至少留一个探测目标，否则扩展会永久 fast-fail。
	return list.length > 0 ? list : [serverBase()];
}

/**
 * 健康检查。
 * @param base 可选基址；缺省用 `serverBase()`（探测场景需要显式传候选地址）。
 */
export async function checkHealth(base?: string): Promise<boolean> {
	const target = base ?? serverBase();
	try {
		// 已确认属于其他数据目录 ⇒ 直接跳过，不浪费一次探测，也杜绝误连。
		if (hostForeignBases().has(target.replace(/\/+$/, ''))) {
			return false;
		}
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 3000);
		const resp = await fetch(`${target}/health`, { signal: ctrl.signal });
		clearTimeout(timer);
		if (!resp.ok) {
			return false;
		}
		// ★ 身份校验：只看响应码无法判断「连的是不是自己的库」。
		// 多开/跨形态时端口上可能是别人的网关，此处比对 /health 返回的 dataDir，
		// 不一致即判不可达并标记异己 —— 让「躲开」从宿主的一次性快照变成每次探测都生效。
		const want = hostWantDataDir();
		if (want) {
			try {
				const body = await resp.json() as { dataDir?: string };
				if (typeof body?.dataDir === 'string' && body.dataDir.length > 0) {
					if (normalizePath(body.dataDir) !== normalizePath(want)) {
						markForeign(target);
						return false;
					}
				}
			} catch { /* 旧版网关无 json body ⇒ 退化为仅看响应码 */ }
		}
		return true;
	} catch {
		return false;
	}
}
