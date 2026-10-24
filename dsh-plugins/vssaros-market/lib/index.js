// @vssaros/dsh-market — 「工作台商城」的 **Host 半**（目录服务 + 安装/卸载通道）。
//
// ── 这个插件是什么 ──────────────────────────────────────────────────────────
// 工作台商城（界面在 `vssaros-chat-surface/lib/client.market.js`）需要三件**它自己没有**的东西：
//   ① **目录**（catalog）：市场里有哪些工作台、谁做的、什么版本、从哪来 —— 现在是**一份数据**，
//      不是界面里写死的清单（写在界面里 ⇒ 上架一个工作台要改代码 + 发版 ✗）。
//   ② **安装通道**：装一个目录里的工作台 ⇒ 解析发布源（npm / GitHub Release / GitHub 源码）
//      ＋ 校验，再转交 Host 自己的 `pluginManager`（不自己造第二套装包语义 ✓）。
//   ③ **安装态**：哪些已装 ⇒ 问 `pluginManager`（真数据，不猜）＋ 本机的市场安装记录。
//
// 路由（都在 `/x/market` 前缀下）：
//   · `GET  /x/market/api/catalog`        —— 目录（?force=1 强刷 / ?cache=1 只读缓存）
//   · `GET  /x/market/api/market-installs` —— 市场安装记录 ＋ 已装包名
//   · `POST /x/market/api/install`         —— 装一个目录条目（body: `{ id }`）
//   · `POST /x/market/api/uninstall`       —— 卸一个目录条目（body: `{ id }`）
//
// ── 目录来源（两层，逐层降级，**每层都如实标注**）──────────────────────────────
//   ① **公开市场目录**（默认 `https://market.dshdesktop.com/index.json`，可用
//      `config.catalogUrl` / 环境变量 `VSSAROS_MARKET_CATALOG_URL` 覆盖）：
//      15 分钟内存缓存 ＋ 磁盘快照 ＋ 读失败回落（标 `stale`）—— 与 dsh-desktop 同款语义。
//   ② **随包兜底目录**（`catalog/index.json`）：远程读不到时的降级（默认是**空目录**：
//      市场内容是别人的上游产物，随包冻结一份只会过期 ⇒ 空 ＋ 如实提示更诚实 ✓）。
//
// ⚠ 目录**只读**：这个插件不写工作台代码，只读目录 + 转交安装/卸载给官方 pluginManager ✓。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { bindFoundation, foundation } from './foundationRef.js';
import {
	DEFAULT_CATALOG_URL, catalogResponse, categoriesFor, mergeWorkbenches, normalizeCatalog, withInstallState,
} from './catalog.js';
import { createRemoteReader } from './remoteCatalog.js';
import { MarketInstallError, resolveInstallTarget } from './installTargets.js';
import { incompatibleMessage, inspectPackage, mergePolicies, normalizePolicy, policyVerdict } from './inspect.js';

export const name = 'vssaros-market';
export const inject = [];

const ROUTE_PREFIX = '/x/market';
/** 本包名（`ide.request` 的 pluginId：IDE 按它的清单 `vssaros.ideCapabilities` 授权）。 */
const PLUGIN_PACKAGE = '@vssaros/dsh-market';
/**
 * 经 IDE 安装的等待预算：用户确认（IDE 侧最多 60s）+ `dsh plugin add`（IDE 侧上限 5 分钟）。
 * 与 IDE 侧 `ideRequestTimeoutMs('workbenches','install')` 配套，必须**不短于**它。
 */
const IDE_INSTALL_TIMEOUT_MS = 8 * 60 * 1000;
/** 兼容性结论缓存（`<数据根>/market/compat.json`；键 = `id@version`，值里带运行时版本）。 */
const COMPAT_FILE = 'compat.json';
/** 随包兜底目录（协议 v2；默认空目录）。 */
const SEED_URL = new URL('../catalog/index.json', import.meta.url);
/** 随包策略（产品方下发的停用 / 允许名单）。 */
const POLICY_URL = new URL('../catalog/policy.json', import.meta.url);

/** 读一份策略文件；读不到或坏了 ⇒ null（坏文件记告警，不当成"不限制"之外的任何东西）。 */
function readPolicyFile(url, warn) {
	try {
		const raw = JSON.parse(readFileSync(url, 'utf8'));
		return raw?.version === 1 ? normalizePolicy(raw) : null;
	} catch (e) {
		if (e?.code !== 'ENOENT' && warn) { warn(`策略文件读不了（${String(url)}）：${String(e?.message ?? e)}`); }
		return null;
	}
}
/** 当前生效的策略（随包 ∪ 本机 `<数据根>/market/policy.json`；每次读，改了即生效）。 */
export function currentPolicy(config, warn) {
	const root = dataRootOf(config);
	return mergePolicies(readPolicyFile(POLICY_URL, warn), root ? readPolicyFile(`${root}/market/policy.json`, warn) : null);
}
/** 远程目录的环境变量名（config 优先）。 */
const CATALOG_URL_ENV = 'VSSAROS_MARKET_CATALOG_URL';
/** 市场安装记录文件名（放在数据根下 ⇒ 换 profile 不串号 ✓）。 */
const INSTALLS_FILE = 'market-installs.json';

/** 读随包兜底目录；读不到 ⇒ null（**不编造**，界面会如实说「目录不可用」）。 */
export function readSeedCatalog() {
	try {
		return normalizeCatalog(JSON.parse(readFileSync(SEED_URL, 'utf8')));
	} catch (e) {
		(typeof console !== 'undefined' ? console : { warn() { } }).warn(`[vssaros-market] 随包兜底目录读不到：${String(e?.message ?? e)}`);
		return null;
	}
}

/** 远程目录地址：config → env → **默认公开市场**。 */
export function catalogUrlOf(config) {
	const fromConfig = typeof config?.catalogUrl === 'string' ? config.catalogUrl.trim() : '';
	if (fromConfig) { return fromConfig; }
	const fromEnv = typeof process.env[CATALOG_URL_ENV] === 'string' ? process.env[CATALOG_URL_ENV].trim() : '';
	return fromEnv || DEFAULT_CATALOG_URL;
}

/** Host 的插件管理器（缺席 ⇒ 如实说「不可用」，不静默装不上）。 */
export function pluginManagerOf(ctx) {
	try {
		const mgr = ctx?.reflect?.get?.('pluginManager', false);
		if (mgr) { return mgr; }
	} catch { /* 探针假 ctx */ }
	try {
		return ctx?.get?.('pluginManager') ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * 已装的包名（来自 `pluginManager`）。
 *
 * ⚠ 名字有两种形态：完整包名（`@vssaros/dsh-kb`）与去 scope 的短名（`dsh-kb`）⇒ 两种都收进来，
 *    匹配时两种都试（否则「装了却显示成没装」这种最难受的错位会出现 ✗）。
 */
export async function installedNames(ctx) {
	const mgr = pluginManagerOf(ctx);
	if (!mgr) { return []; }
	const out = [];
	const push = (value) => {
		const name = String(value ?? '').trim();
		if (!name) { return; }
		out.push(name);
		const slash = name.indexOf('/');
		if (slash >= 0) { out.push(name.slice(slash + 1)); }
	};
	try {
		if (typeof mgr.listBundles === 'function') {
			const bundles = await mgr.listBundles();
			for (const bundle of Array.isArray(bundles) ? bundles : []) { push(bundle?.name); }
		}
	} catch { /* 读不到就只剩另一路 */ }
	try {
		if (typeof mgr.listPlugins === 'function') {
			const rows = await mgr.listPlugins();
			for (const row of Array.isArray(rows) ? rows : []) { push(row?.moduleName); }
		}
	} catch { /* 读不到就如实少一路 */ }
	return out;
}

/** 市场安装记录（`{<目录 id>: {pluginName, version, source, installedAt}}`）。 */
export async function readInstalls(config) {
	const path = installsPathOf(config);
	if (!path) { return {}; }
	try {
		const saved = JSON.parse(readFileSync(path, 'utf8'));
		return saved?.version === 1 && saved.installs && typeof saved.installs === 'object' ? saved.installs : {};
	} catch (e) {
		if (e?.code === 'ENOENT') { return {}; }
		return {};
	}
}

/** 写市场安装记录（临时文件 → rename ⇒ 不会写坏半份 ✗）。 */
export async function writeInstalls(config, installs) {
	const path = installsPathOf(config);
	if (!path) { return false; }
	try {
		mkdirSync(dirname(path), { recursive: true });
		const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ version: 1, installs }, null, 2)}\n`);
		renameSync(temporary, path);
		return true;
	} catch {
		return false;
	}
}

/** 目录读完之后，装上「安装态」并组装响应体。 */
export function buildResponse({ workbenches, categories, source, error, installed, installedCatalogIds }) {
	const withState = withInstallState(workbenches, { installedNames: installed, installedCatalogIds });
	return catalogResponse({
		workbenches: withState,
		categories: categoriesFor(withState, categories),
		source,
		error,
	});
}

function readBody(req, limit = 256 * 1024) {
	return new Promise((resolveBody, reject) => {
		let buf = '';
		req.on('data', chunk => {
			buf += chunk;
			if (buf.length > limit) { req.destroy(); reject(new Error('请求体过大')); }
		});
		req.on('end', () => resolveBody(buf));
		req.on('error', reject);
	});
}

/** dsh 的写操作结果 ⇒ 我们往外抛的形状（只搬界面用得上的字段）。 */
function shapeChange(res, fallbackTarget, extra) {
	return {
		changed: !!res?.changed,
		application: res?.application ?? null,
		stage: res?.stage ?? null,
		target: res?.target ?? fallbackTarget,
		...(res?.error?.code ? { error: res.error.code } : {}),
		...(res?.error?.diagnostic ? { diagnostic: String(res.error.diagnostic).slice(0, 400) } : {}),
		...(res?.warnings?.length ? { warnings: res.warnings.slice(0, 8).map(w => String(w).slice(0, 200)) } : {}),
		...(res?.bundle ? { bundle: String(res.bundle) } : {}),
		...(res?.pendingBuilds?.length ? { pendingBuilds: res.pendingBuilds.slice(0, 32).map(String) } : {}),
		...(extra?.requestId ? { requestId: extra.requestId } : {}),
	};
}

export function apply(ctx, config = {}) {
	/** 记一条告警（有 ctx.logger 就用它 ⇒ 进 Host 日志；没有就退到 console）。 */
	const warn = (message) => {
		try {
			if (typeof ctx?.logger === 'function') { ctx.logger('vssaros-market').warn(message); return; }
		} catch { /* 探针假 ctx */ }
		console.warn(`[vssaros-market] ${message}`);
	};
	// 共享运行时服务（数据根：磁盘快照与安装记录落在那儿）—— **可选**：拿不到就不落盘（功能不受影响）。
	{
		let ready = null;
		try { ready = ctx.get?.('vssarosFoundation') ?? ctx.vssarosFoundation ?? null; } catch { /* 探针假 ctx */ }
		if (ready) { bindFoundation(ready); }
		ctx.inject(['vssarosFoundation'], child => {
			let svc = null;
			try { svc = child.vssarosFoundation ?? null; } catch { /* 探针假 ctx */ }
			if (svc) { bindFoundation(svc); }
		});
	}

	const seed = readSeedCatalog();
	// IDE 控制桥（**可选**注入）：在 ⇒ 安装走 IDE 主进程那条可靠通道；不在 ⇒ 回落 Host 的 pluginManager。
	const state = { bridge: null };
	ctx.inject(['vssarosBridge'], scope => {
		state.bridge = scope.vssarosBridge ?? null;
		return () => { state.bridge = null; };
	});
	const remoteUrl = catalogUrlOf(config);
	let reader = null;
	try {
		reader = createRemoteReader({ url: remoteUrl, cachePath: snapshotPathOf(config) });
	} catch (e) {
		warn(`远程目录不可用：${String(e?.message ?? e)}`);
	}

	/** 组一份目录（公开市场 ＋ 随包兜底 ＋ 安装态）。 */
	async function collect({ force = false, cachedOnly = false } = {}) {
		let remote = null;
		let source = { origin: 'bundled', url: '', stale: false, fetchedAt: 0 };
		let error = null;
		if (reader) {
			try {
				const result = await reader({ force, cachedOnly });
				remote = result.catalog;
				source = { origin: 'remote', url: remoteUrl, stale: result.stale === true, fetchedAt: result.fetchedAt || 0 };
				if (result.stale && result.error) { error = result.error; }
			} catch (e) {
				error = String(e?.message ?? e);
			}
		}
		// 随包兜底**在前**：它是"本机明确知道的东西"，不该被远程目录覆盖
		// （远程目录负责**新增**市场条目 ⇒ id 不同，不会撞 ✓）。
		const workbenches = mergeWorkbenches(seed?.workbenches ?? [], remote?.workbenches ?? []);
		const installed = await installedNames(ctx);
		const installs = await readInstalls(config);
		const runtimeVersion = String(process.env.VSSAROS_DSH_RUNTIME_VERSION ?? '').trim();
		const body = buildResponse({
			workbenches: withCompatibility(workbenches, readCompatibility(config), runtimeVersion),
			categories: [...(seed?.categories ?? []), ...(remote?.categories ?? [])],
			source,
			error,
			installed,
			installedCatalogIds: Object.keys(installs),
		});
		// 装上的包名（界面据此把目录条目与**已注册的工作台**对上 ⇒ 卡片才有「打开」）；策略停用的标出来
		const policy = currentPolicy(config, warn);
		body.workbenches = body.workbenches.map(entry => {
			const next = installs[entry.id]?.pluginName ? { ...entry, installedPackage: installs[entry.id].pluginName } : { ...entry };
			const verdict = policyVerdict(policy, entry.id);
			if (!verdict.allowed) { next.policy = { allowed: false, reason: verdict.reason }; }
			return next;
		});
		return body;
	}

	/** 目录里找一个条目（按 id）。 */
	async function findEntry(id) {
		const body = await collect({ force: false });
		return body.workbenches.find(entry => entry.id === id) ?? null;
	}

	async function install(id) {
		const entry = await findEntry(id);
		if (!entry) { return { ok: false, error: `目录里没有这个工作台：${id}`, code: 'not_listed' }; }
		if (!entry.installable || !entry.distribution) {
			return { ok: false, error: '这个条目没有可安装的发布源', code: 'no_distribution' };
		}
		// ★ 2026-10-22（第 4 步）：策略先于一切网络动作 —— 停用的连下载都不做
		const verdict = policyVerdict(currentPolicy(config, warn), entry.id);
		if (!verdict.allowed) { return { ok: false, id: entry.id, code: 'blocked_by_policy', error: verdict.reason }; }
		const bridge = state.bridge;
		const mgr = pluginManagerOf(ctx);
		if (!bridge && !mgr) { return { ok: false, error: '没有可用的安装通道（IDE 控制桥与 Host 插件管理器都不在）', code: 'install_unavailable' }; }
		let target = null;
		try {
			// 解析安装目标（下载 ＋ 校验 ＋ 解包）—— 失败就是失败，**不换来源** ✗
			target = await resolveInstallTarget(entry, { packagesRoot: packagesRootOf(config) });
		} catch (e) {
			const code = e instanceof MarketInstallError ? e.code : 'install_target_failed';
			return { ok: false, error: String(e?.message ?? e), code };
		}
		try {
			// ★ 2026-10-22：装之前先检查（与 Host 启动同一个兼容判据 / 宿主单例 / 工作台形态）
			const report = await inspectPackage(target.manifest, { files: target.files });
			await rememberCompatibility(config, entry, report.compatibility);
			if (report.compatibility.status === 'incompatible') {
				return { ok: false, id: entry.id, code: 'incompatible_runtime', error: incompatibleMessage(report.compatibility), compatibility: report.compatibility };
			}
			if (report.blocked.length) {
				return { ok: false, id: entry.id, code: 'host_singleton', error: report.blocked.join('；'), warnings: report.warnings };
			}
			let result;
			if (bridge) {
				result = await installViaIde(bridge, entry, target, report);
			} else {
				result = await installViaHost(mgr, target);
			}
			if (!result.ok) { return { id: entry.id, ...result, warnings: report.warnings }; }
			const installs = await readInstalls(config);
			installs[entry.id] = {
				pluginName: target.expectedPluginName,
				version: result.version || target.expectedVersion,
				source: entry.distribution.type,
				via: result.via,
				installedAt: new Date().toISOString(),
			};
			await writeInstalls(config, installs);
			// 新装的插件要等 Host 重启才进组合（运行中的进程不热加载新包）⇒ 如实告诉界面
			return { ok: true, id: entry.id, via: result.via, changed: result.changed !== false, version: installs[entry.id].version, restartRequired: true, warnings: report.warnings };
		} catch (e) {
			return { ok: false, error: String(e?.message ?? e), code: 'install_failed' };
		} finally {
			try { await target.cleanup(); } catch { /* 临时目录删不掉不影响结果 */ }
		}
	}

	/**
	 * 主通道：经控制桥请 **IDE 主进程**安装（`ide.request{capability:'workbenches', op:'install'}`）。
	 * 为什么不直接用 Host 的 pluginManager：它在全新 profile 上会剪树并 `operation-error`（README 4.86），
	 * 而 IDE 那条（暂存进 profile + `dsh plugin add`）与随包插件同源、已验证；IDE 侧还会**向用户要一次确认**，
	 * 并且装完会刷新 IDE 的插件列表（ActivityBar / 插件中心）。
	 */
	async function installViaIde(bridge, entry, target, report) {
		const params = {
			op: 'install',
			id: entry.id,
			title: String(entry.name || entry.id),
			source: entry.distribution.type,
			name: target.expectedPluginName,
			version: target.expectedVersion,
			...(target.dir ? { dir: target.dir } : { spec: target.pluginSpec }),
			...(report.warnings.length ? { warnings: report.warnings.slice(0, 6) } : {}),
			// 服务端能力审计（静态扫描；null = 看不到包内容）—— IDE 确认框逐条列出
			capabilities: report.capabilities === null ? null : report.capabilities.map(c => c.label),
		};
		let reply;
		try {
			reply = await bridge.callIDE('ide.request', { capability: 'workbenches', pluginId: PLUGIN_PACKAGE, params }, { timeoutMs: IDE_INSTALL_TIMEOUT_MS });
		} catch (e) {
			return { ok: false, code: 'install_failed', error: `IDE 安装通道出错：${String(e?.message ?? e)}`, via: 'ide' };
		}
		if (!reply || reply.ok === false) {
			const declined = reply?.declined === true;
			return { ok: false, code: declined ? 'declined' : 'install_failed', error: String(reply?.error ?? reply?.text ?? 'IDE 没有回执'), via: 'ide' };
		}
		return { ok: true, via: 'ide', changed: reply.changed !== false, version: reply.version };
	}

	/** 回落通道：Host 自己的 pluginManager。**如实**判结果：`application:failed` / 带错误码 = 失败。 */
	async function installViaHost(mgr, target) {
		const requestId = `vssaros-market-${Date.now()}`;
		const res = await mgr.installBundle(target.pluginSpec, { requestId });
		const shaped = shapeChange(res, target.pluginSpec, { requestId });
		if (shaped.application === 'failed' || shaped.application === 'cancelled' || res?.error) {
			const firstLine = shaped.diagnostic ? shaped.diagnostic.split('\n').find(l => l.trim())?.trim() : '';
			return { ...shaped, ok: false, via: 'host', code: 'install_failed', errorCode: shaped.error ?? null, error: `安装没有成功（${shaped.error || shaped.application || 'unknown'}）${firstLine ? '：' + firstLine : ''}` };
		}
		if (shaped.pendingBuilds?.length) {
			return { ...shaped, ok: false, via: 'host', code: 'pending_builds', error: `这个包要运行构建脚本（${shaped.pendingBuilds.join(', ')}），需要先在插件中心批准` };
		}
		return { ok: true, via: 'host', changed: shaped.changed, version: target.expectedVersion };
	}

	/** 只做检查、不装（详情页"检查兼容性"用；结论写进缓存 ⇒ 目录卡片也能标出）。 */
	async function check(id) {
		const entry = await findEntry(id);
		if (!entry) { return { ok: false, error: `目录里没有这个工作台：${id}`, code: 'not_listed' }; }
		if (!entry.installable || !entry.distribution) { return { ok: false, error: '这个条目没有可安装的发布源', code: 'no_distribution' }; }
		const verdict = policyVerdict(currentPolicy(config, warn), entry.id);
		if (!verdict.allowed) { return { ok: false, id: entry.id, code: 'blocked_by_policy', error: verdict.reason }; }
		let target = null;
		try {
			target = await resolveInstallTarget(entry);
			const report = await inspectPackage(target.manifest, { files: target.files });
			await rememberCompatibility(config, entry, report.compatibility);
			return { ok: true, id: entry.id, ...report };
		} catch (e) {
			return { ok: false, error: String(e?.message ?? e), code: e instanceof MarketInstallError ? e.code : 'check_failed' };
		} finally {
			try { await target?.cleanup(); } catch { /* 临时目录删不掉不影响结果 */ }
		}
	}

	async function uninstall(id) {
		const mgr = pluginManagerOf(ctx);
		if (!mgr) { return { ok: false, error: '插件管理器不可用（Host 里没有 pluginManager）', code: 'uninstall_unavailable' }; }
		const installs = await readInstalls(config);
		const record = installs[id];
		if (!record?.pluginName) {
			return { ok: false, error: '这个工作台不是从工作台市场装的（没有安装记录）', code: 'no_install_record' };
		}
		try {
			const res = await mgr.removeBundle(record.pluginName);
			const shaped = shapeChange(res, record.pluginName);
			if (shaped.application === 'failed' || res?.error) {
				return { ...shaped, ok: false, id, code: 'uninstall_failed', errorCode: shaped.error ?? null, error: `卸载没有成功（${shaped.error || shaped.application}）` };
			}
			delete installs[id];
			await writeInstalls(config, installs);
			return { ...shaped, ok: true, id, restartRequired: true };
		} catch (e) {
			return { ok: false, error: String(e?.message ?? e), code: 'uninstall_failed' };
		}
	}

	ctx.inject(['webServer', 'connection'], webCtx => webCtx.effect(() => webCtx.webServer.register({
		kind: 'prefix',
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			const rejected = webCtx.connection.requestRejection(req);
			if (rejected) {
				res.writeHead(rejected, { 'content-type': 'text/plain; charset=utf-8' });
				res.end(String(rejected));
				return;
			}
			const url = new URL(req.url ?? '/', 'http://localhost');
			const json = (status, body) => {
				res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
				res.end(JSON.stringify(body));
			};
			try {
				if (url.pathname === `${ROUTE_PREFIX}/api/catalog` && req.method === 'GET') {
					const force = url.searchParams.get('force') === '1';
					const cachedOnly = url.searchParams.get('cache') === '1';
					json(200, await collect({ force, cachedOnly }));
					return;
				}
				if (url.pathname === `${ROUTE_PREFIX}/api/market-installs` && req.method === 'GET') {
					const installs = await readInstalls(config);
					json(200, { installs, installed: await installedNames(ctx) });
					return;
				}
				if (url.pathname === `${ROUTE_PREFIX}/api/install` && req.method === 'POST') {
					const body = JSON.parse((await readBody(req)) || '{}');
					const id = String(body?.id ?? '').trim();
					if (!id) { json(400, { ok: false, error: '缺 id' }); return; }
					json(200, await install(id));
					return;
				}
				if (url.pathname === `${ROUTE_PREFIX}/api/uninstall` && req.method === 'POST') {
					const body = JSON.parse((await readBody(req)) || '{}');
					const id = String(body?.id ?? '').trim();
					if (!id) { json(400, { ok: false, error: '缺 id' }); return; }
					json(200, await uninstall(id));
					return;
				}
				if (url.pathname === `${ROUTE_PREFIX}/api/check` && req.method === 'GET') {
					const id = String(url.searchParams.get('id') ?? '').trim();
					if (!id) { json(400, { ok: false, error: '缺 id' }); return; }
					json(200, await check(id));
					return;
				}
				json(404, { error: `unknown market route: ${url.pathname}` });
			} catch (e) {
				json(500, { ok: false, error: String(e?.message ?? e) });
			}
		},
	})));
}

/** 磁盘快照路径：`<数据根>/market/catalog-snapshot.json`（拿不到数据根 ⇒ 不落盘）。 */
function snapshotPathOf(config) {
	const root = dataRootOf(config);
	if (!root) { return undefined; }
	return `${root}/market/catalog-snapshot.json`;
}

/**
 * Release 包的**持久**解包目录：`<数据根>/market/packages/`。
 * 为什么持久：装进 profile 后若源目录消失，下次 pnpm 解析会因 `file:` 悬空而整树失败 ✗。拿不到数据根 ⇒ 退回临时目录。
 */
function packagesRootOf(config) {
	const root = dataRootOf(config);
	return root ? `${root}/market/packages` : undefined;
}

/** 兼容性结论缓存：读。 */
export function readCompatibility(config) {
	const root = dataRootOf(config);
	if (!root) { return {}; }
	try {
		const saved = JSON.parse(readFileSync(`${root}/market/${COMPAT_FILE}`, 'utf8'));
		return saved?.version === 1 && saved.entries && typeof saved.entries === 'object' ? saved.entries : {};
	} catch { return {}; }
}

/** 兼容性结论缓存：写一条（`unknown` 不缓存 —— 那不是结论）。 */
async function rememberCompatibility(config, entry, compatibility) {
	const root = dataRootOf(config);
	if (!root || !compatibility || compatibility.status === 'unknown') { return; }
	const entries = readCompatibility(config);
	entries[`${entry.id}@${entry.version}`] = { ...compatibility, checkedAt: new Date().toISOString() };
	try {
		const path = `${root}/market/${COMPAT_FILE}`;
		mkdirSync(dirname(path), { recursive: true });
		const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
		renameSync(temporary, path);
	} catch { /* 缓存写不了不影响安装 */ }
}

/** 把缓存的兼容性结论挂到目录条目上（只认**同一运行时版本**下的结论）。 */
export function withCompatibility(workbenches, cache, runtimeVersion) {
	return workbenches.map(entry => {
		const hit = cache[`${entry.id}@${entry.version}`];
		if (!hit || (runtimeVersion && hit.runtimeVersion && hit.runtimeVersion !== runtimeVersion)) { return entry; }
		return { ...entry, compatibility: { status: hit.status, runtimeVersion: hit.runtimeVersion, requirements: hit.requirements ?? {} } };
	});
}

/** 市场安装记录路径：`<数据根>/market/market-installs.json`。 */
function installsPathOf(config) {
	const root = dataRootOf(config);
	if (!root) { return undefined; }
	return `${root}/market/${INSTALLS_FILE}`;
}

/** 数据根（共享运行时服务给的；拿不到 ⇒ undefined）。 */
function dataRootOf(config) {
	try {
		const root = foundation().dataRootOf(config);
		if (!root) { return undefined; }
		return String(root).replace(/[\\/]+$/, '');
	} catch {
		return undefined;
	}
}

