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

export const name = 'vssaros-market';
export const inject = [];

const ROUTE_PREFIX = '/x/market';
/** 随包兜底目录（协议 v2；默认空目录）。 */
const SEED_URL = new URL('../catalog/index.json', import.meta.url);
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
		return buildResponse({
			workbenches,
			categories: [...(seed?.categories ?? []), ...(remote?.categories ?? [])],
			source,
			error,
			installed,
			installedCatalogIds: Object.keys(installs),
		});
	}

	/** 目录里找一个条目（按 id）。 */
	async function findEntry(id) {
		const body = await collect({ force: false });
		return body.workbenches.find(entry => entry.id === id) ?? null;
	}

	async function install(id) {
		const mgr = pluginManagerOf(ctx);
		if (!mgr) { return { ok: false, error: '插件管理器不可用（Host 里没有 pluginManager）', code: 'install_unavailable' }; }
		const entry = await findEntry(id);
		if (!entry) { return { ok: false, error: `目录里没有这个工作台：${id}`, code: 'not_listed' }; }
		if (!entry.installable || !entry.distribution) {
			return { ok: false, error: '这个条目没有可安装的发布源', code: 'no_distribution' };
		}
		const requestId = `vssaros-market-${Date.now()}`;
		let target = null;
		try {
			// 解析安装目标（下载 ＋ 校验 ＋ 落临时包）—— 失败就是失败，**不换来源** ✗
			target = await resolveInstallTarget(entry);
		} catch (e) {
			const code = e instanceof MarketInstallError ? e.code : 'install_target_failed';
			return { ok: false, error: String(e?.message ?? e), code };
		}
		try {
			const res = await mgr.installBundle(target.pluginSpec, { requestId });
			const changed = res?.changed === true;
			if (changed) {
				const installs = await readInstalls(config);
				installs[entry.id] = {
					pluginName: target.expectedPluginName,
					version: target.expectedVersion,
					source: entry.distribution.type,
					installedAt: new Date().toISOString(),
				};
				await writeInstalls(config, installs);
			}
			return { ok: true, id: entry.id, ...shapeChange(res, target.pluginSpec, { requestId }) };
		} catch (e) {
			return { ok: false, error: String(e?.message ?? e), code: 'install_failed' };
		} finally {
			try { await target.cleanup(); } catch { /* 临时目录删不掉不影响结果 */ }
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
			if (res?.changed === true) {
				delete installs[id];
				await writeInstalls(config, installs);
			}
			return { ok: true, id, ...shapeChange(res, record.pluginName) };
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

