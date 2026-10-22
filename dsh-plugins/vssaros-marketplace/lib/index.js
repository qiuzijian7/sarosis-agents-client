// @vssaros/dsh-marketplace — Host 半（2026-10-22）：商城工作台的**页面 + 数据 + 逻辑**。
//
// ★ 设计纪律（与 @vssaros/dsh-market 的分工）：
//   - `vssaros-market` = **第三方工作台目录**（dsh 公开市场）⇒ 装的是别人的包；
//   - `vssaros-marketplace` = **自营商城**（我们的服务端）⇒ agent / skill / 工作台 / 工作流 四类商品。
//   => 两条数据源、两条能力（`workbenches` vs `marketplace`），互不覆盖 ✓。
//
// ★★ 2026-10-22 架构修正（用户质疑「商城数据/逻辑都该在 dsh 侧，为什么要反向调用」后）：
//   上一版把 list/detail/installed 也经 `ide.request` 打到 IDE ⇒ **违背方向** ✗。
//   取证后：当初那三条理由里只有一条成立
//     ① 「商城 JWT 在 IDE 进程 ⇒ Host 没票据」——**错**：dsh 侧有独立 TOF 登录（`tof_signin`，
//        票据在 `ctx.credentials`）+ Node fetch ⇒ `POST /auth/tof` 就能换 JWT ✓（见 marketClient.js）
//     ② 「装工作台包必须走主进程 `dsh plugin add`」——**成立**（且装完要重启 Host，Host 不能自杀重启）
//     ③ 「落盘/刷新都在 IDE 侧」——**一半错**：目录是同一处（数据根），dsh 侧本来就在写
//   ⇒ **现在的分工**：
//     · dsh 侧自持：认证、list / detail / installed（只读面，本文件 + marketClient.js）
//     · IDE 侧只剩：workbench 包的装/卸（要 `dsh plugin add` + 重启 Host）
//       以及（S2 完成后）skill 的"刷新"通知 —— 因为 IDE 侧 `skillRegistry` 没有文件监听
//   ⇒ 「IDE 桥不在」时，**浏览仍然可用** ✓（真机可验：停桥后 list 照样出数据）

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMarketClient, dataRootOf } from './marketClient.js';
import { readInstalled, removeInstalled, upsertInstalled } from './installedLedger.js';
import { installBundle, sha256Of, uninstallBundle } from './installers.js';
import { PUBLISHABLE_KINDS, deletePackage, deleteVersion, publishVersion } from './publisher.js';
import { listPublishables } from './localResources.js';

/** 插件包名（与 package.json 一致；也是 ide.request 的 pluginId => 必须与清单里的 ideCapabilities 对上 ✓）。 */
const PLUGIN_PACKAGE = '@vssaros/dsh-marketplace';

/** 页面路由前缀。 */
const ROUTE_PREFIX = '/x/marketplace';

/** 转发给 IDE 的超时（读类给短档，写类给长档 —— 安装可能几分钟 ✓）。 */
const READ_TIMEOUT_MS = 60_000;
const WRITE_TIMEOUT_MS = 8 * 60_000;

/** 商城商品类型（与服务端 packages/kinds.ts 同口径）。 */
const KINDS = ['agent', 'skill', 'mcp', 'knowledge', 'workflow', 'workbench'];

/** 能力层支持的 op（与 IDE 侧 marketplaceAction 同口径）。 */
const OPS = ['list', 'detail', 'installed', 'install', 'uninstall', 'upgrade', 'publish', 'deletePackage', 'deleteVersion'];

/** 写类 op（需要用户确认 => 走长超时）。 */
const WRITE_OPS = new Set(['install', 'uninstall', 'upgrade', 'publish', 'deletePackage', 'deleteVersion']);

/** dsh 侧**自持**的只读 op（认证 + HTTP + 本地台账，不碰 IDE 桥 ✓）。 */
const LOCAL_OPS = new Set(['list', 'detail', 'installed', 'publishables']);

/**
 * dsh 侧**自持**的写 op（S2）：skill / workflow 的安装、升级、卸载。
 *
 * ★ 为什么这三类能自持：它们落的就是数据根，dsh 侧本来就在写
 *   （`skill_manage` / `applyWorkflow`）⇒ 下载 + 解包 + 落盘 + 台账全在本地完成 ✓。
 * ★ 仍在 IDE 侧（无法消除）：`workbench`（要 `dsh plugin add` + 重启 Host）、
 *   `agent`（要生成 `.agent.md`，格式真源在 IDE 侧；等包格式统一后再搬）、
 *   以及 `publish` / `delete*`（发布要调 IDE 侧的打包与上传链，S2c 再搬）。
 */
const LOCAL_WRITE_KINDS = new Set(['skill', 'workflow']);

export async function apply(ctx, config) {
	/** IDE 控制桥（可选注入）：**只有 workbench 的装/卸**还需要它 ✓。 */
	const state = { bridge: null, credentials: null, market: null, dataRoot: null };
	ctx.inject(['vssarosBridge'], scope => {
		state.bridge = scope.vssarosBridge ?? null;
		return () => { state.bridge = null; };
	});
	// 凭据服务（取 TOF 票据 / 存商城 JWT）。**可选注入**：不在就等页面报"没有登录态"，
	// 而不是让整个插件 pending（历史教训：静态 inject 缺服务会让插件永久 pending ✗）。
	ctx.inject(['credentials'], scope => {
		state.credentials = scope.credentials ?? null;
		state.market = null;
		return () => { state.credentials = null; state.market = null; };
	});
	// 数据根（台账 + 未来的安装落点）：经 foundation 收口（与其它模块同一份口径 ✓）。
	ctx.inject(['vssarosFoundation'], scope => {
		try {
			state.dataRoot = dataRootOf(config);
		} catch {
			state.dataRoot = null;
		}
		return () => { state.dataRoot = null; };
	});

	/** 懒建商城客户端（凭据服务晚于 apply 才注入 ⇒ 不能在这里同步建）。 */
	function market() {
		if (!state.credentials) {
			throw new Error('dsh 侧拿不到凭据服务（ctx.credentials）⇒ 无法读取登录态');
		}
		if (!state.market) {
			state.market = createMarketClient({ credentials: state.credentials, config, log: (line) => console.log(line) });
		}
		return state.market;
	}

	/**
	 * dsh 侧**自持**的三个只读 op（不碰 IDE 桥 ✓）。
	 *
	 * @param {string} op
	 * @param {object} params
	 */
	async function runLocal(op, params) {
		if (op === 'publishables') { return listLocalPublishables(); }
		if (op === 'list') {
			const res = await market().list({
				...(params.kind ? { kind: String(params.kind) } : {}),
				...(params.q ? { q: String(params.q) } : {}),
				...(params.category ? { category: String(params.category) } : {}),
				...(params.scope ? { scope: String(params.scope) } : {}),
				...(typeof params.limit === 'number' ? { pageSize: params.limit } : {}),
			});
			// 台账（同一份 installed-packages.json）⇒ 让页面标出"已安装 / 可升级"
			const installed = state.dataRoot ? await readInstalled(state.dataRoot) : [];
			const installedByKey = new Map(installed.map(e => [`${e.kind}:${e.storeId}`, e.version]));
			return {
				ok: true,
				total: res.total,
				items: res.items.map(pkg => ({
					id: pkg.id,
					kind: pkg.kind,
					slug: pkg.slug,
					name: pkg.name,
					version: pkg.latest_version ?? pkg.version ?? '',
					description: pkg.description ?? '',
					author: pkg.author_name ?? '',
					category: pkg.category ?? '',
					icon: pkg.icon ?? '',
					tags: Array.isArray(pkg.tags) ? pkg.tags : [],
					status: pkg.status ?? 'active',
					distributionType: pkg.distribution_type ?? 'bundle',
					distribution: pkg.distribution_meta ?? null,
					permissions: pkg.permissions ?? null,
					installedVersion: installedByKey.get(`${pkg.kind}:${pkg.slug}`) ?? '',
				})),
			};
		}
		if (op === 'detail') {
			const slug = String(params.slug ?? '');
			const pkg = await market().detail(slug);
			return {
				ok: true,
				id: pkg.id,
				kind: pkg.kind,
				slug: pkg.slug,
				name: pkg.name,
				version: pkg.latest_version ?? '',
				description: pkg.description ?? '',
				author: pkg.author_name ?? pkg.author?.display_name ?? pkg.author?.username ?? '',
				category: pkg.category ?? '',
				icon: pkg.icon ?? '',
				tags: Array.isArray(pkg.tags) ? pkg.tags : [],
				status: pkg.status ?? 'active',
				distributionType: pkg.distribution_type ?? 'bundle',
				distribution: pkg.distribution_meta ?? null,
				permissions: pkg.permissions ?? null,
				versions: (Array.isArray(pkg.versions) ? pkg.versions : []).map(v => ({
					id: v.id,
					version: v.version,
					changelog: v.changelog ?? '',
					sha256: v.sha256 ?? '',
					size: v.asset_size ?? 0,
					isLatest: v.is_latest === true,
					manifest: v.manifest ?? null,
				})),
			};
		}
		// installed：本地台账 + 升级检查（全是 dsh 侧自己的 HTTP ✓）
		const entries = state.dataRoot ? await readInstalled(state.dataRoot) : [];
		if (entries.length === 0) { return { ok: true, total: 0, items: [] }; }
		let updatable = new Map();
		try {
			const updates = await market().checkUpgrades(entries.map(e => ({ kind: e.kind, storeId: e.storeId, version: e.version })));
			updatable = new Map(updates.map(u => [`${u.kind}:${u.storeId}`, String(u.latest ?? '')]));
		} catch (e) {
			// 升级检查失败**不阻断**已安装列表（列表本身仍有用 ✓）
			console.warn(`[marketplace] installed: 升级检查失败（不影响列表）：${String(e?.message ?? e)}`);
		}
		return {
			ok: true,
			total: entries.length,
			items: entries.map(e => {
				const latest = updatable.get(`${e.kind}:${e.storeId}`) ?? '';
				return {
					id: e.storeId,
					kind: e.kind,
					slug: e.storeId,
					name: e.storeId,
					version: e.version,
					description: '',
					latestVersion: latest,
					upgradable: Boolean(latest),
					installedAt: e.installedAt,
				};
			}),
		};
	}

	/**
	 * 列出**本地可发布**的资源（`<数据根>/skills/*` 与 `workflows/*`）。
	 *
	 * 为什么需要：发布表单要让用户从"本机真实存在的资源"里挑，而不是手打 id
	 * （手打一个不存在的 id ⇒ 报错"本地没有这个资源"，体验差且容易错）✓
	 */
	async function listLocalPublishables() {
		const dataRoot = state.dataRoot;
		if (!dataRoot) { throw new Error('dsh 侧拿不到数据根 ⇒ 列不出本地资源'); }
		const items = await listPublishables(dataRoot);
		return { ok: true, total: items.length, items };
	}

	/**
	 * dsh 侧**自持**的写 op（S2）：skill / workflow 的 install / upgrade / uninstall。
	 *
	 * 流程：商城拿版本 → 下载 tar.gz（带 JWT）→ sha256 校验 → 解包 → 落盘 → 写台账 ✓
	 * 全程在 Host 进程内完成，**不经过 IDE 桥**。
	 *
	 * @param {'install'|'upgrade'|'uninstall'} op
	 * @param {object} params
	 */
	async function runLocalWrite(op, params) {
		const dataRoot = state.dataRoot;
		if (!dataRoot) {
			throw new Error('dsh 侧拿不到数据根（vssarosFoundation 未绑定）⇒ 无法落盘');
		}
		const kind = String(params.kind ?? '');
		const slug = String(params.slug ?? '');
		if (!LOCAL_WRITE_KINDS.has(kind)) {
			throw new Error(`这一类（${kind}）不能由 dsh 侧安装：只有 ${[...LOCAL_WRITE_KINDS].join(' / ')} 能自持`);
		}
		if (!slug) { throw new Error(`marketplace.${op} 需要 slug`); }

		if (op === 'uninstall') {
			const { targetDir } = await uninstallBundle({ dataRoot, kind, storeId: slug });
			await removeInstalled(dataRoot, kind, slug);
			return { ok: true, changed: true, targetDir };
		}

		// install / upgrade：先确定版本与下载地址
		const detailPkg = await market().detail(slug);
		const versions = Array.isArray(detailPkg?.versions) ? detailPkg.versions : [];
		const wanted = String(params.version ?? '').trim();
		const versionRow = wanted
			? versions.find(v => v.version === wanted)
			: versions.find(v => v.is_latest === true) ?? versions[0];
		if (!versionRow) {
			throw new Error(`「${slug}」没有可用版本${wanted ? `（找不到 ${wanted}）` : ''}`);
		}
		const gzBuffer = await downloadVersion(slug, versionRow.version);
		// sha256 校验（服务端登记了就必须对得上 —— 不对就是包被换过/传坏了 ✗）
		const expected = String(versionRow.sha256 ?? '').trim();
		if (expected && expected !== sha256Of(gzBuffer)) {
			throw new Error(`「${slug}」v${versionRow.version} 的 sha256 对不上（包可能损坏或被替换）`);
		}
		const installed = await installBundle({
			dataRoot,
			kind,
			storeId: slug,
			version: versionRow.version,
			gzBuffer,
			upgrade: op === 'upgrade',
		});
		await upsertInstalled(dataRoot, { kind, storeId: slug, version: versionRow.version });
		// skill 装完**必须**让 IDE 侧技能库重读（它没有文件监听 ✗）——
		// best-effort：刷不过**不让安装失败**（文件已经落好了），但要把原因报出来 ✓
		const reloadNote = kind === 'skill' ? await reloadIdeSkills() : undefined;
		return {
			ok: true,
			changed: true,
			version: versionRow.version,
			fileCount: installed.fileCount,
			...(installed.backup ? { backup: installed.backup } : {}),
			...(reloadNote ? { skillsReload: reloadNote } : {}),
		};
	}

	/**
	 * 让 IDE 侧技能库重读磁盘（**唯一**还需要反向调用的只读动作）。
	 *
	 * 为什么必须借 IDE：`skillRegistryService` **没有文件监听**，只有显式 `reload()` 才能
	 * 看见 dsh 侧刚写的目录 ⇒ 不通知就"装好了但技能列表里没有" ✗。
	 * best-effort：失败只回报原因，**不阻断安装**（文件已经落好，用户可手动重启）✓
	 */
	async function reloadIdeSkills() {
		const bridge = state.bridge;
		if (!bridge) { return 'skipped: IDE 控制桥不在（重启 IDE 后技能会自然加载）'; }
		try {
			const reply = await bridge.callIDE('ide.request', {
				capability: 'marketplace',
				pluginId: PLUGIN_PACKAGE,
				params: { op: 'reloadSkills' },
			}, { timeoutMs: READ_TIMEOUT_MS });
			if (reply?.ok === false) { return `failed: ${String(reply.error ?? 'IDE 拒绝了刷新')}`; }
			return 'ok';
		} catch (e) {
			return `failed: ${String(e?.message ?? e)}`;
		}
	}

	/** 下载某个版本的本体（带 JWT；Node 侧直接拿 Buffer ✓）。 */
	async function downloadVersion(slug, version) {
		return market().download(`/packages/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/download`);
	}

	/**
	 * dsh 侧**自持**的发布/下架（S2c）。
	 *
	 * @param {'publish'|'deletePackage'|'deleteVersion'} op
	 * @param {object} params
	 */
	async function runLocalPublish(op, params) {
		const dataRoot = state.dataRoot;
		if (!dataRoot) {
			throw new Error('dsh 侧拿不到数据根（vssarosFoundation 未绑定）⇒ 无法打包发布');
		}
		const m = market();
		const slug = String(params.slug ?? params.localId ?? '');
		if (op === 'deletePackage') {
			return deletePackage({ market: m, slug });
		}
		if (op === 'deleteVersion') {
			return deleteVersion({ market: m, slug, version: String(params.version ?? '') });
		}
		// publish
		const kind = String(params.kind ?? '');
		if (!PUBLISHABLE_KINDS.includes(kind)) {
			throw new Error(`这一类（${kind}）不走 bundle 发布：只有 ${PUBLISHABLE_KINDS.join(' / ')} 能由 dsh 侧打包发布`);
		}
		const localId = String(params.localId ?? slug);
		const version = String(params.version ?? '').trim();
		if (!version) { throw new Error('publish 需要 version'); }
		return publishVersion({
			market: m,
			dataRoot,
			kind,
			localId,
			version,
			changelog: String(params.changelog ?? ''),
			meta: {},
		});
	}

	/**
	 * 自持性自检（★ 2026-10-22，供真机验收 / 排障）。
	 *
	 * 回答三个问题：**IDE 桥在不在**、**票据从哪来**、**能不能自己换到 JWT**。
	 * 用途：证明「浏览不再依赖反向调用」——桥 `absent` 时 `list` 仍然出数据 ✓。
	 */
	async function selfCheck() {
		const report = {
			ok: true,
			bridge: state.bridge ? 'present' : 'absent',
			credentials: state.credentials ? 'present' : 'absent',
			dataRoot: state.dataRoot ?? null,
			endpoint: (() => { try { return market().endpoint(); } catch { return null; } })(),
			tofTicket: 'unknown',
			marketJwt: 'unknown',
			login: 'not-tried',
		};
		if (!state.credentials) { return report; }
		try {
			const m = market();
			report.tofTicket = (await m.tofTicket()) ? 'present' : 'absent';
			report.marketJwt = (await readInstalledMarketJwt()) ? 'present' : 'absent';
		} catch (e) {
			report.tofTicket = `error: ${String(e?.message ?? e)}`;
		}
		try {
			await market().login();
			report.login = 'ok';
			report.marketJwt = 'present';
		} catch (e) {
			report.login = `failed: ${String(e?.message ?? e)}`;
		}
		return report;
	}

	/** 读 dsh 侧的商城 JWT（只为自检报告"有没有"，不回传值 ✓）。 */
	async function readInstalledMarketJwt() {
		if (!state.credentials || typeof state.credentials.resolve !== 'function') { return undefined; }
		try {
			const r = await state.credentials.resolve('VSSAROS_MARKET_JWT');
			return typeof r?.value === 'string' && r.value ? r.value : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * 把一个商城动作转给 IDE。
	 *
	 * **只剩写面**（workbench 的装/卸等）：dsh 侧自己做不到「`dsh plugin add` + 重启 Host」✓。
	 *
	 * @param {string} op
	 * @param {object} params
	 */
	async function callIde(op, params) {
		const bridge = state.bridge;
		if (!bridge) {
			return { ok: false, error: '商城通道不可用（IDE 控制桥不在）—— 请确认 IDE 侧已连上 Harness。' };
		}
		if (!OPS.includes(op)) {
			return { ok: false, error: `不认识的商城动作：${op}` };
		}
		const timeoutMs = WRITE_OPS.has(op) ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS;
		let reply;
		try {
			reply = await bridge.callIDE('ide.request', {
				capability: 'marketplace',
				pluginId: PLUGIN_PACKAGE,
				params: { op, ...params },
			}, { timeoutMs });
		} catch (e) {
			return { ok: false, error: `商城通道出错：${String(e?.message ?? e)}` };
		}
		if (!reply) {
			return { ok: false, error: 'IDE 没有回执（商城动作未执行）' };
		}
		if (reply.ok === false) {
			return { ok: false, error: String(reply.error ?? 'IDE 拒绝了这次商城动作'), declined: reply.declined === true };
		}
		// 执行面把结果放在 result 里（{ ok, ... }）=> 摊平给页面 ✓
		const result = reply.result ?? {};
		return { ok: result.ok !== false, ...result };
	}

	/**
	 * 页面外壳（SSR）：真正的界面由页面自己的 JS 渲染，这里只给挂载点 ✓。
	 *
	 * ⚠ 样式走**独立的 css 文件**（`lib/page.css`）而不是 `pageShell.js` ——
	 *   `lib/pageShell.js` 是**全插件同形拷贝**（守卫 `check-host-config.mjs` 要求逐字节一致）⇒
	 *   商城自己的样式塞进去会当场红 ✗ ⇒ 单独一个文件 ✓。
	 */
	function renderPage() {
		return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>商城工作台</title>
<link rel="stylesheet" href="${ROUTE_PREFIX}/page.css" />
</head>
<body>
<div id="vs-mp-root"><div class="vs-mp-empty">正在装载商城工作台…</div></div>
<script type="module" src="${ROUTE_PREFIX}/client.js"></script>
</body>
</html>`;
	}

	ctx.inject(['webServer', 'connection'], webCtx => webCtx.effect(() => webCtx.webServer.register({
		kind: 'prefix',
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			// 鉴权栅栏（与 vssaros-market 同款 ✓）
			const rejected = webCtx.connection.requestRejection(req);
			if (rejected) {
				res.writeHead(rejected, { 'content-type': 'text/plain; charset=utf-8' });
				res.end(String(rejected));
				return;
			}
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			const json = (status, body) => {
				res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
				res.end(JSON.stringify(body));
			};
			try {
				// ── 页面外壳 ────────────────────────────────────
				if (req.method === 'GET' && (url.pathname === ROUTE_PREFIX || url.pathname === `${ROUTE_PREFIX}/`)) {
					res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
					res.end(renderPage());
					return;
				}

				// ── 客户端 chunk（页面自己加载）────────────────────
				if (req.method === 'GET' && url.pathname === `${ROUTE_PREFIX}/client.js`) {
					const { readFile } = await import('node:fs/promises');
					const here = path.dirname(fileURLToPath(import.meta.url));
					const body = await readFile(path.join(here, 'client.js'), 'utf8');
					res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
					res.end(body);
					return;
				}

				// ── 页面样式（独立文件：pageShell.js 是全插件同形拷贝，样式不能塞进去）──
				if (req.method === 'GET' && url.pathname === `${ROUTE_PREFIX}/page.css`) {
					const { readFile } = await import('node:fs/promises');
					const here = path.dirname(fileURLToPath(import.meta.url));
					const body = await readFile(path.join(here, 'page.css'), 'utf8');
					res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
					res.end(body);
					return;
				}

				// ── 商城动作：**只读面在 dsh 侧自持**，写面（装/卸）仍转 IDE ────────
				if (req.method === 'POST' && url.pathname === `${ROUTE_PREFIX}/api/action`) {
					const raw = await readBody(req);
					let parsed = {};
					try { parsed = JSON.parse(raw || '{}'); } catch { parsed = {}; }
					const op = String(parsed.op ?? '');
					const params = parsed.params ?? {};
					if (op === 'self-check') {
						// 自持性自检（真机可验）：桥在不在都能回答"我是谁、票据在哪、能不能换 JWT"
						json(200, await selfCheck());
						return;
					}
					if (LOCAL_OPS.has(op)) {
						try {
							json(200, await runLocal(op, params));
						} catch (e) {
							json(200, { ok: false, error: String(e?.message ?? e) });
						}
						return;
					}
					// S2：skill / workflow 的装、升、卸在 dsh 侧自持；其余（workbench / agent）仍转 IDE
					if ((op === 'install' || op === 'upgrade' || op === 'uninstall')
						&& LOCAL_WRITE_KINDS.has(String(params.kind ?? ''))) {
						try {
							json(200, await runLocalWrite(op, params));
						} catch (e) {
							json(200, { ok: false, error: String(e?.message ?? e) });
						}
						return;
					}
					// S2c：发布与下架在 dsh 侧（打包用 lib/tar.js，上传走 raw tar.gz）✓
					// ⚠ `publish` 的 **agent** 例外：它的包格式是 `agent.json`（IDE 侧独有的组装逻辑）
					//   ⇒ dsh 侧打不了兼容包 ⇒ 转回 IDE（`delete*` 是纯 HTTP，不分 kind）✓
					const publishIsLocal = op === 'deletePackage' || op === 'deleteVersion'
						|| (op === 'publish' && PUBLISHABLE_KINDS.includes(String(params.kind ?? '')));
					if (publishIsLocal) {
						try {
							json(200, await runLocalPublish(op, params));
						} catch (e) {
							json(200, { ok: false, error: String(e?.message ?? e) });
						}
						return;
					}
					json(200, await callIde(op, params));
					return;
				}
				// ── 自检（证明 dsh 侧自持）：桥是否在 / 票据是否可见 / 是否已能换 JWT ──
				if (req.method === 'GET' && url.pathname === `${ROUTE_PREFIX}/api/self-check`) {
					json(200, await selfCheck());
					return;
				}

				// ── 分类常量（页面用来画页签）─────────────────────
				if (req.method === 'GET' && url.pathname === `${ROUTE_PREFIX}/api/meta`) {
					json(200, { ok: true, kinds: KINDS, ops: OPS });
					return;
				}

				json(404, { ok: false, error: `unknown marketplace route: ${url.pathname}` });
			} catch (e) {
				json(500, { ok: false, error: String(e?.message ?? e) });
			}
		},
	})));
}

/** 读请求体（限长，避免无限读）。 */
function readBody(req, limit = 1_000_000) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on('data', chunk => {
			size += chunk.length;
			if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}
