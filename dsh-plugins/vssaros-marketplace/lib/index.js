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
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createMarketClient, dataRootOf } from './marketClient.js';
import { readInstalled, removeInstalled, upsertInstalled } from './installedLedger.js';
// ⚠ 不再直接 import `sha256Of`：校验已下沉到 `installBundle`（可单测）
import { installBundle, trashBundle, uninstallBundle } from './installers.js';
import { PUBLISHABLE_KINDS, deletePackage, deleteVersion, publishDistribution, publishExternal, publishVersion } from './publisher.js';
// ★ 2026-10-22：外部源（GitHub 地址作本体）—— 归一化 / 安全边界 / 定位安装根 / 下载
import { downloadGitHubTarball, locateInstallRoot, resolveDownloadUrl } from './githubSource.js';
import { listTarGzEntries } from './tar.js';
import { listPublishables, deriveVersion } from './localResources.js';
// ★ 2026-10-23（用户「都转移到 dsh 侧实现」）：mcp 装完要注册进 `<数据根>/mcp.json`
import { readMcpPackageConfig, registerMcpServer, removeMcpCompletely, setMcpEnabled, mcpJsonPath, writeMcpJson } from './mcpInstall.js';
// ★ 2026-10-27（用户：贴 GitHub 链接自动填写并发布）
import { inspectGithubRepo } from './githubInspect.js';
// ★ 2026-10-26：发布前体检（发布源到底是不是一个可装的 dsh 插件）
import { preflightPublish } from './publishPreflight.js';
// ★ 2026-10-27 阶段 3：让工作台右侧的对话能**真的**查找/发布
import { marketToolDefinitions } from './agentTools.js';
// ★ 2026-10-26：商城专用 agent（写 .agent.md，让新建会话默认选中）
import { ensureMarketAgent, MARKET_PRESET } from './marketAgent.js';
import { ALL_OPS, LOCAL_WRITE_KINDS, WRITE_OPS, isKnownOp, resolveOp } from './dispatch.js';
// ★ 服务端 pkg → 前端形状的**唯一映射**（list/detail/reviewList/installed 共用）
import { toInstalledItem, toPackageDetail, toPackageSummary } from './shape.js';

/** 插件包名（与 package.json 一致；也是 ide.request 的 pluginId => 必须与清单里的 ideCapabilities 对上 ✓）。 */
const PLUGIN_PACKAGE = '@vssaros/dsh-marketplace';

/** 本页与商城接口所在的插件：**不许**从这里关掉/卸载（否则页面直接不可用）。 */
const SELF_PLUGIN_NAME = ['@vssaros/dsh-skills', '@vssaros/dsh-marketplace'];

/** 页面路由前缀。 */
const ROUTE_PREFIX = '/x/marketplace';

/** 转发给 IDE 的超时（读类给短档，写类给长档 —— 安装可能几分钟 ✓）。 */
const READ_TIMEOUT_MS = 60_000;
const WRITE_TIMEOUT_MS = 8 * 60_000;

/** 商城商品类型（与服务端 packages/kinds.ts 同口径）。 */
const KINDS = ['agent', 'skill', 'mcp', 'knowledge', 'workflow', 'workbench'];

// ★ 2026-10-23：op 清单与分派**只有一份真源**（`lib/dispatch.js`）——
//   此前这里是手写清单，加了 publishables / reviewList / updatePackage 等 5 个 op 后
//   `OPS` 没跟着改 ⇒ `/api/meta` 声明不全、`callIde` 白名单也不全（声明与实现漂移 ✗）

/**
 * dsh 侧**自持**的写 op（S2）：skill / workflow / agent 的安装、升级、卸载。
 *
 * ★ 为什么这三类能自持：它们落的就是数据根，dsh 侧本来就在写
 *   （`skill_manage` / `applyWorkflow`）⇒ 下载 + 解包 + 落盘 + 台账全在本地完成 ✓。
 * ★ 仍在 IDE 侧（无法消除）：`workbench`（要 `dsh plugin add` + 重启 Host）、
 *   `agent`（要生成 `.agent.md`，格式真源在 IDE 侧；等包格式统一后再搬）、
 *   以及 `publish` / `delete*`（发布要调 IDE 侧的打包与上传链，S2c 再搬）。
 */

export async function apply(ctx, config) {
	/** IDE 控制桥（可选注入）：**只有 workbench 的装/卸**还需要它 ✓。 */
	const state = {
		bridge: null,
		credentials: null,
		market: null,
		dataRoot: null,
		/** agent 重扫（可选）：`vssaros-agents` 提供了才能即时生效，否则重启兜底 */
		agentsRescan: null,
		/** ★ TOF 服务（`vssarosTof.ticket()`）：dsh 侧**唯一**的票据真源，本插件只消费不实现优先级 */
		tof: null,
		/** 取数据根失败的原因（self-check 会报出来，**不静默**）*/
		dataRootError: null,
		/** ★ 2026-10-24：dsh 的进程内插件管理服务（装/卸/升插件与工作台，与 dsh plugin add 同一套） */
		pluginManager: null,
	};
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
	// ★ 2026-10-23（用户要求「TOF 应该在 dsh 侧，不应该有多个」）：
	//   票据**只问 TOF 服务**（`vssarosTof.ticket()`，由 @vssaros/dsh-bridge 提供）——
	//   优先级/兜底/刷新都在 bridge 一处。本插件**不再自己拼两份票据的优先级** ✓
	//   （此前本插件硬编码「本地优先」，而本地票据过期时永远试不到 IDE 同步的那张 ✗）
	ctx.inject(['vssarosTof'], scope => {
		state.tof = scope.vssarosTof ?? null;
		return () => { state.tof = null; };
	});

	// ★ 2026-10-22 晚：**可选**注入 agent 重扫服务（等 `vssaros-agents` 提供后即自动生效）。
	//   现状：它的 `syncPresets` 只在插件激活时跑一次（没有文件监听）⇒ dsh 侧装完 agent
	//   要重启 IDE 才会成为 preset。这里预留调用点，**不强求**：
	//   服务不在 ⇒ 装完返回 `restartRequired`（如实告知），不假装即时生效 ✗
	//   ⚠ 用回调式 `ctx.inject`（不是静态 inject）：缺服务时不会让插件永久 pending ✓
	// ★ 2026-10-24（用户：「插件管理能否在 dsh 侧实现，不走 ide」）：能。
	//   dsh 把 `dsh plugin add` 做成了进程内服务 pluginManager（@deepseek-ai/dsh-plugin-manager，
	//   与 CLI 共用 operations.js：文件锁 → pnpm → reconcile bundles）；装了 dsh-hmr 时还能热生效。
	//   ⚠ 仍然用**回调式**可选注入：老 Host / 无 profileContext 时没有这个服务，
	//     此时 state.pluginManager 保持 null ⇒ 装/卸自动退回 IDE（不能静态 inject，会让插件 pending ✗）。
	ctx.inject(['pluginManager'], scope => {
		state.pluginManager = scope.pluginManager ?? null;
		return () => { state.pluginManager = null; };
	});

	ctx.inject(['vssarosAgents'], scope => {
		state.agentsRescan = typeof scope.vssarosAgents?.rescan === 'function'
			? () => scope.vssarosAgents.rescan()
			: null;
		return () => { state.agentsRescan = null; };
	});

	// 数据根（台账 + 未来的安装落点）：经 foundation 收口（与其它模块同一份口径 ✓）。
	// ★ 2026-10-23（真机：点「安装」没反应）：**先在 apply 里算一次**。
	//   原先只在 `ctx.inject(['vssarosFoundation'])` 的**回调里**算 —— foundation 没绑上时
	//   回调压根不跑 ⇒ `dataRoot` 永远是 null ⇒ 一切落盘动作全废，且页面表现成"点了没反应" ✗
	//   `dataRootOf(config)` 现在**配置优先**（`config.dataRoot` 由 IDE 覆盖层注入）
	//   ⇒ 不依赖激活顺序 ✓
	{
		try {
			state.dataRoot = dataRootOf(config);
			state.dataRootError = null;
		} catch (e) {
			state.dataRoot = null;
			state.dataRootError = String(e?.message ?? e);
		}
	}

	// ── 商城专用 agent（★ 2026-10-26 用户：「新建会话时使用专门的商城 agent」）──
	//   落成 `<数据根>/agents/marketplace-bot/.agent.md`（与"用户自己建 bot"同构），
	//   然后让 `vssaros-agents` 重扫 ⇒ **不用重启**就能在新建会话里选到 ✓
	//   `vssarosAgents.rescan()` 不在（老版本）⇒ 文件已落好，重启后自然扫到（如实记录）。
	ctx.effect(() => {
		let cancelled = false;
		(async () => {
			if (!state.dataRoot) { return; }
			const r = await ensureMarketAgent({ dataRoot: state.dataRoot });
			state.marketAgent = { ok: r.ok, created: r.created, preset: MARKET_PRESET, error: r.error ?? '' };
			// ⚠ 必须**无论 created 都 rescan**：
			//   文件已存在时（`created:false`）看起来"没什么要做"，但**本次 Host 启动可能还没扫过它**
			//   （比如插件是后装的、或用户手动放了文件）⇒ 不 rescan 就永远没有 preset ✗
			if (cancelled || !r.ok || !state.agentsRescan) { return; }
			try {
				await state.agentsRescan();
				state.marketAgent.rescanned = true;
			} catch (e) {
				state.marketAgent.rescanned = false;
				state.marketAgent.rescanError = String(e?.message ?? e).slice(0, 160);
			}
		})().catch(e => {
			state.marketAgent = { ok: false, created: false, preset: MARKET_PRESET, error: String(e?.message ?? e).slice(0, 160) };
		});
		return () => { cancelled = true; };
	}, 'vssaros-marketplace: market agent');

	ctx.inject(['vssarosFoundation'], scope => {
		try {
			state.dataRoot = dataRootOf(config);
			state.dataRootError = null;
		} catch (e) {
			// ⚠ **不静默**：真机踩到 `dataRoot: null` 时，self-check 只报 null，
			//   根本看不出是"foundation 没注入"还是"取根时抛错"✗ ⇒ 记下原因
			state.dataRoot = null;
			state.dataRootError = String(e?.message ?? e);
		}
		return () => { state.dataRoot = null; state.dataRootError = 'foundation 已卸载'; };
	});

	/** 懒建商城客户端（凭据服务晚于 apply 才注入 ⇒ 不能在这里同步建）。 */
	function market() {
		if (!state.credentials) {
			throw new Error('dsh 侧拿不到凭据服务（ctx.credentials）⇒ 无法读取登录态');
		}
		if (!state.market) {
			state.market = createMarketClient({
				credentials: state.credentials,
				config,
				log: (line) => console.log(line),
				// 票据**只向 TOF 服务要**（单一真源）；服务不在时 marketClient 才降级读凭据
				tofProvider: typeof state.tof?.ticket === 'function' ? () => state.tof.ticket() : null,
			});
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
		// 管理员审核队列（服务端 requireAdmin 判权 ⇒ 非管理员会 403，如实抛 ✓）
		if (op === 'reviewList') {
			const res = await market().reviewList();
			return {
				ok: true,
				total: res.total,
				// ★ 与列表共用同一份映射（`shape.js`）—— 以前这里手抄一遍，漏字段就是
				//   "审核队列少显示一列"这类静默不一致 ✗
				items: res.items.map(pkg => toPackageSummary(pkg, { review: true })),
			};
		}
		// ★ 2026-10-27：从 GitHub 链接**自动识别**可发布信息（名称/描述/版本/logo/kind）
		//   全程走不占 GitHub API 额度的通道（og 标签 / raw 文件 / releases 302）
		//   ⇒ 未认证 60 请求/小时的限制不会挡住发布流程 ✓
		if (op === 'inspectGithub') {
			const r = await inspectGithubRepo(String(params.repo ?? params.url ?? params.source ?? ''));
			return r;
		}
		// ★ 2026-10-26（用户：「有没有校验机制，避免发布错误」）：
		//   发布前先判断「这个发布源能不能装」—— 字段校验拦不住 BrowserSkill 那类
		//   「根目录是 private monorepo、真插件在子包」的错误。
		if (op === 'preflightPublish') {
			return preflightPublish({
				kind: String(params.kind ?? ''),
				source: params.source == null ? undefined : String(params.source),
				npmName: params.npmName == null ? undefined : String(params.npmName),
				version: params.version == null ? undefined : String(params.version),
				sha256: params.sha256 == null ? undefined : String(params.sha256),
			});
		}

		if (op === 'list') {
			const res = await market().list({
					...(params.kind ? { kind: String(params.kind) } : {}),
					...(params.q ? { q: String(params.q) } : {}),
					...(params.category ? { category: String(params.category) } : {}),
					...(params.scope ? { scope: String(params.scope) } : {}),
					...(typeof params.limit === 'number' ? { pageSize: params.limit } : {}),
					// ★ 分页（商城里单类 500+ 条 ⇒ 不分页等于看不到大部分 ✗）
					...(typeof params.page === 'number' && params.page > 0 ? { page: params.page } : {}),
					// 排序（recent|popular|name；非法值不传 ⇒ 用服务端默认，不报错 ✓）
					...(params.sort === 'recent' || params.sort === 'popular' || params.sort === 'name' ? { sort: params.sort } : {}),
				});
			// 台账（同一份 installed-packages.json）⇒ 让页面标出"已安装 / 可升级"
			const installed = state.dataRoot ? await readInstalled(state.dataRoot) : [];
			const installedByKey = new Map(installed.map(e => [`${e.kind}:${e.storeId}`, e.version]));
			return {
				ok: true,
				total: res.total,
				items: res.items.map(pkg => toPackageSummary(pkg, {
					installedVersion: installedByKey.get(`${pkg.kind}:${pkg.slug}`) ?? '',
				})),
			};
		}
		if (op === 'detail') {
			const slug = String(params.slug ?? '');
			const pkg = await market().detail(slug);
			// ★ 详情 = 列表的公共字段 + visibility/featured/versions（同一份 `baseOf`）
			return { ok: true, ...toPackageDetail(pkg) };
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
			items: entries.map(e => toInstalledItem(e, updatable.get(`${e.kind}:${e.storeId}`) ?? '')),
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
			throw new Error('dsh 侧拿不到数据根（config.dataRoot 未注入，且 vssarosFoundation 服务不可用）⇒ 无法落盘');
		}
		// ★ 2026-10-26（用户：「需要一个统一的 mcp 配置按钮入口」「点击弹出二级页面可编辑」）：
		//   整份 mcp.json 的保存。**故意不带 kind** ⇒ 必须放在下面那段 kind 校验**之前**。
		//   校验比"能存进去"更重要：非法 JSON 一旦落盘，下次 Host 启动会整份读不到（所有连接器消失）。
		if (op === 'saveMcpConfig') {
			const text = String(params.text ?? '');
			if (!text.trim()) { throw new Error('内容为空（要清空 mcp.json 请直接删文件）'); }
			let parsed;
			try {
				parsed = JSON.parse(text);
			} catch (e) {
				throw new Error('不是合法 JSON：' + String((e && e.message) || e).slice(0, 160));
			}
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				throw new Error('顶层必须是对象（形如 { servers: { … } }）');
			}
			if (parsed.servers !== undefined
				&& (typeof parsed.servers !== 'object' || Array.isArray(parsed.servers))) {
				throw new Error('servers 必须是对象：键=服务器名，值=该服务器的配置');
			}
			const file = mcpJsonPath(dataRoot);
			let backup = '';
			try {
				const { copyFile, stat } = await import('node:fs/promises');
				await stat(file);
				backup = file + '.bak-' + Date.now();
				await copyFile(file, backup);
			} catch { /* 文件本来不存在 ⇒ 不用备份 */ }
			await writeMcpJson(dataRoot, parsed);
			return { ok: true, bytes: Buffer.byteLength(text, 'utf8'), backup, file };
		}
		const kind = String(params.kind ?? '');
		const slug = String(params.slug ?? '');
		if (!LOCAL_WRITE_KINDS.has(kind)) {
			throw new Error(`这一类（${kind}）不能由 dsh 侧安装：只有 ${[...LOCAL_WRITE_KINDS].join(' / ')} 能自持`);
		}
		// agent 的"生效"与 skill 不同：`vssaros-agents` 只在**启动时**扫描 agent 目录
		// （`syncPresets` 没有文件监听）⇒ 装完必须重启才注册成 preset。
		// 如实返回，不让用户以为"装完就能用"✗（重启后自然生效，代码里不需要额外动作）
		if (!slug) { throw new Error(`marketplace.${op} 需要 slug`); }

		// ★ 2026-10-26（用户：「连接器每个 item 增加开关」）：开关 = mcp.json 里那条的 `disabled`。
		//   ⚠ 不是热生效：MCP 行是 Host 启动时按 mcp.json 生成覆盖层 ⇒ 重启 Host 才真正挂/摘。
		if (op === 'setMcpEnabled') {
			if (kind !== 'mcp') { throw new Error('setMcpEnabled 只适用于连接器（kind=mcp）'); }
			const want = params.enabled !== false;
			const r = await setMcpEnabled(dataRoot, slug, want);
			return { ok: true, changed: r.changed, enabled: !r.disabled, restartRequired: true };
		}

		// ★ 2026-10-23：删除到回收站（可恢复）。工作流/Agent 这类本地条目没有商城包可重装，
		//   直接 rm 太狠 ⇒ 移到 <数据根>/.trash-<时间戳>/ 下，用户能捞回来。
		if (op === 'trash') {
			// ⚠ 连接器不能只挪目录：它还登记在 `<数据根>/mcp.json` 里，
			//   挪走会留下一条指向空目录的 entry（下次启动 Host 会去连一个不存在的路径）。
			//   要删连接器请用 uninstall（它会同时注销 entry）。这里直接拒绝，不做半截事。
			if (kind === 'mcp') {
				throw new Error('连接器不支持删除到回收站（它同时登记在 mcp.json 里）⇒ 请用「卸载」');
			}
			const { movedTo } = await trashBundle({ dataRoot, kind, storeId: slug });
			await removeInstalled(dataRoot, kind, slug);
			return { ok: true, changed: true, movedTo };
		}

		if (op === 'uninstall') {
			// ★ mcp 的卸载必须**同时**从 `mcp.json` 注销（只删目录会留下指向空目录的 entry ✗）
			if (kind === 'mcp') {
				const { removedEntry, removedDir } = await removeMcpCompletely(dataRoot, slug);
				await removeInstalled(dataRoot, kind, slug);
				return { ok: true, changed: removedEntry || removedDir, mcpUnregistered: removedEntry };
			}
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
		// ★ 2026-10-22（用户需求）：商品本体可能是**外部源（GitHub 地址）**而不是自带包 ⇒
		//   按 `manifest.distribution` 分流：外部源走 GitHub 下载 + 定位安装根，否则走商城下载 ✓
		const dist = versionRow.manifest?.distribution;
		let installed;
		if (dist && typeof dist === 'object' && dist.type) {
			installed = await installFromExternal({
				dataRoot, kind, storeId: slug, version: versionRow.version, distribution: dist,
				upgrade: op === 'upgrade',
			});
		} else {
			const gzBuffer = await downloadVersion(slug, versionRow.version);
			// ★ sha256 校验**下沉到 installBundle**（不在磁盘上留任何东西之前就验完）⇒
			//   这样它可被单测直接覆盖（此前算在这里，测试只能绕一大圈 ✗）
			installed = await installBundle({
				dataRoot,
				kind,
				storeId: slug,
				version: versionRow.version,
				// 商城商品名 = 可读名 ⇒ 装完本地条目的标题就是它（不是 kebab）
				displayName: String(detailPkg?.name ?? '').trim(),
				gzBuffer,
				expectedSha256: String(versionRow.sha256 ?? '').trim() || undefined,
				upgrade: op === 'upgrade',
			});
			await upsertInstalled(dataRoot, { kind, storeId: slug, version: versionRow.version });
		}
		await upsertInstalled(dataRoot, { kind, storeId: slug, version: versionRow.version });
		// ★ mcp：装完把服务器**注册进** `<数据根>/mcp.json`（与 IDE 侧 `mcpInstaller` 同一份文件、同一套形状）
		let mcpRegistered = null;
		if (kind === 'mcp') {
			try {
				const { config } = await readMcpPackageConfig(dataRoot, slug);
				const entry = await registerMcpServer(dataRoot, slug, config);
				mcpRegistered = { type: String(entry.type ?? 'stdio'), transport: config.transport ?? 'stdio' };
			} catch (e) {
				// 文件已经落好了，但注册失败 ⇒ **必须报出来**（否则用户以为装好了却用不了 ✗）
				throw new Error(`mcp 已下载并落盘，但注册进 mcp.json 失败：${String(e?.message ?? e)}`);
			}
		}
		// skill 装完**必须**让 IDE 侧技能库重读（它没有文件监听 ✗）——
		// best-effort：刷不过**不让安装失败**（文件已经落好了），但要把原因报出来 ✓
		const reloadNote = kind === 'skill' ? await reloadIdeSkills() : undefined;
		// agent：优先让 `vssaros-agents` 重扫（服务在就即时生效）；不在 ⇒ 重启兜底（如实报）
		let agentsRescan = 'restart';
		if (kind === 'agent') {
			if (state.agentsRescan) {
				try {
					await state.agentsRescan();
					agentsRescan = 'ok';
				} catch (e) {
					agentsRescan = `failed: ${String(e?.message ?? e)}`;
				}
			}
		}
		return {
			ok: true,
			changed: true,
			version: versionRow.version,
			fileCount: installed.fileCount,
			...(installed.backup ? { backup: installed.backup } : {}),
			...(reloadNote ? { skillsReload: reloadNote } : {}),
			// agent：重扫成功 ⇒ 即时可用；否则文件已落好但 preset 要重启才扫描到（如实报）
			...(kind === 'agent' ? { restartRequired: agentsRescan !== 'ok', agentsRescan } : {}),
			// mcp：文件 + mcp.json 都写好了；dsh 的 MCP 连接需要重启才重建（没有热重载入口）
			...(kind === 'mcp' ? { mcpRegistered, restartRequired: true, mcpNote: '已写入 mcp.json；连接要重启 IDE 才建立' } : {}),
		};
	}

	/**
	 * 从**外部源**（GitHub 地址）装一个商品（★ 2026-10-22 用户需求）。
	 *
	 * 流程：描述 → 可下载的 tar.gz 地址 → 下载 → 解包 → **定位安装根**（剥掉
	 * `<repo>-<ref>/` 与 `skills/<name>/` 这类前缀）→ 复用 `installBundle` 落盘 ✓
	 *
	 * ⚠ 与本地包的区别：外部源**没有 sha256**（服务端没登记）⇒ 不做完整性校验；
	 *   但**安全性靠"只允许 GitHub 域 + 体积上限"**兜住（见 githubSource.js）✓
	 *
	 * @param {{ dataRoot: string, kind: string, storeId: string, version: string, distribution: object, upgrade: boolean }} args
	 */
	async function installFromExternal({ dataRoot, kind, storeId, version, distribution, upgrade }) {
		const url = resolveDownloadUrl(distribution);
		const gzBuffer = await downloadGitHubTarball(url);
		const unpacked = await listTarGzEntries(gzBuffer);
		const located = locateInstallRoot(unpacked.files, kind);
		return installBundle({
			dataRoot,
			kind,
			storeId,
			version,
			files: located.files,
			upgrade,
		});
	}

	/** 把 ChangeResult.error 变成一句人话。 */
	function mgmtErrorText(e) {
		if (e === null || e === undefined) { return '商城没返回原因'; }
		if (typeof e === 'string') { return e; }
		return String(e.message ?? e.code ?? e.name ?? JSON.stringify(e));
	}

	/** 版本级 / 包级 distribution（与 IDE 的 distributionOfVersion 同口径）。 */
	function distributionOf(detail, version) {
		const versions = Array.isArray(detail?.versions) ? detail.versions : [];
		const hit = versions.find(v => String(v?.version) === version);
		return (hit && (hit.distribution || hit.manifest?.distribution)) || detail?.distribution || null;
	}

	/**
	 * 发布源 → pnpm spec（与 IDE 的 resolveDistributionSpec 同口径）。
	 *   npm            ⇒ name@version
	 *   github-source  ⇒ github:owner/repo(#commit)
	 *   github-release ⇒ dsh 侧先下载 + 校验 sha256，再 file:<tmp.tgz>
	 * ⚠ 校验不通过就**不装**（不为了"能装上"而跳过完整性检查）。
	 */
	async function specForDistribution(dist, slug, version) {
		if (!dist || typeof dist !== 'object') {
			return { error: '这个商品没有登记发布源（distribution）⇒ 不知道从哪儿装' };
		}
		if (dist.type === 'npm') {
			if (!dist.name) { return { error: 'npm 发布源缺少包名' }; }
			return { spec: dist.name + '@' + version, name: String(dist.name) };
		}
		if (dist.type === 'github-source') {
			if (!dist.name) { return { error: 'github-source 发布源缺少 owner/repo' }; }
			const commit = dist.commit ? '#' + dist.commit : '';
			return { spec: 'github:' + dist.name + commit, name: String(dist.name).split('/').pop() };
		}
		if (dist.type === 'github-release') {
			if (!dist.url) { return { error: 'github-release 发布源缺少 url' }; }
			if (!dist.sha256) { return { error: 'github-release 发布源缺少 sha256（不校验就不装）' }; }
			const buf = await downloadGitHubTarball(dist.url);
			const sha = createHash('sha256').update(buf).digest('hex');
			if (sha !== String(dist.sha256).toLowerCase()) {
				return { error: '下载包的 sha256 与商城登记不一致（期望 ' + dist.sha256 + '，实际 ' + sha + '）' };
			}
			const file = path.join(tmpdir(), 'vssaros-marketplace', slug + '-' + version + '.tgz');
			await mkdir(path.dirname(file), { recursive: true });
			await writeFile(file, buf);
			return { spec: 'file:' + file, name: String(dist.name || slug) };
		}
		return { error: 'dsh 侧不认识的发布源类型：' + String(dist.type) };
	}

	/**
	 * 插件 / 工作台的装、升、卸 —— **在 dsh 侧执行**。
	 *
	 * 依据（2026-10-24 取证）：dsh 有 `ctx.pluginManager`（@deepseek-ai/dsh-plugin-manager），
	 * 与 `dsh plugin` CLI 共用 operations.js（文件锁 → pnpm → reconcile dsh.profile.bundles），
	 * 装了 `dsh-hmr` 时返回 application='applied'（**热生效，不用重启 Host**）。
	 *
	 * 返回 null = "dsh 侧做不了 ⇒ 调用方退回 IDE"，只有三种：
	 *   ① 没有 pluginManager；② 卸载时台账里没有包名（历史数据只有 slug）；③ removeBundle 不在。
	 */
	async function runLocalPlugin(op, params) {
		const pm = state.pluginManager;
		if (!pm || typeof pm.installBundle !== 'function') { return null; }

		// ── 插件状态（开关）──
		// ★ 2026-10-24（用户：「插件 item 是允许有开关的」）：dsh 的 pluginManager 本来就提供
		//   setBundleEnabled(name, enabled) —— 改的是 profile 的 `dsh.profile.bundles` 选择，
		//   有 hmr 时热生效（application=applied），没有就返回 restart-required（如实告知）。
		if (op === 'pluginState') {
			if (typeof pm.listBundles !== 'function') { return null; }
			const bundles = await pm.listBundles();
			return {
				ok: true,
				plugins: (Array.isArray(bundles) ? bundles : []).map(b => ({
					name: String(b.name || ''),
					enabled: b.enabled === true,
					installed: b.installed === true,
					official: b.official === true,
					optional: b.optional === true,
					removable: b.removable === true,
					version: String(b.version || ''),
					description: String(b.description || ''),
				})).filter(x => x.name),
			};
		}

		if (op === 'setPluginEnabled') {
			const name = String(params.name || '');
			if (!name) { throw new Error('setPluginEnabled 需要 name（npm 包名）'); }
			if (typeof pm.setBundleEnabled !== 'function') { return null; }
			// ⚠ 不许关掉本页所在的插件：关掉之后页面直接不可用，用户只能在 IDE 里找回
			if (SELF_PLUGIN_NAME.includes(name) && params.enabled === false) {
				return { ok: false, error: '「' + name + '」是当前页面/商城接口所在的插件，不能从这里关闭' };
			}
			const want = params.enabled !== false;
			const r = await pm.setBundleEnabled(name, want);
			if (r && r.error) { return { ok: false, error: mgmtErrorText(r.error) }; }
			return {
				ok: true,
				changed: r ? r.changed !== false : true,
				enabled: want,
				application: r?.application ?? null,
				restartRequired: r?.application === 'restart-required',
			};
		}
		const kind = String(params.kind || '');
		const slug = String(params.slug || '');
		if (!kind || !slug) { throw new Error('marketplace.' + op + ' 需要 kind 与 slug'); }
		const root = state.dataRoot;
		if (!root) { throw new Error(state.dataRootError || '数据根未知（foundation 还没就绪）'); }

		if (op === 'uninstall') {
			const entries = await readInstalled(root);
			const entry = entries.find(e => e.kind === kind && e.storeId === slug);
			// ★ 2026-10-24（用户：「插件 item 缺少卸载按钮」）：页面直接给的是**包名**
			//   （插件页签的条目本来就来自 profile 的 dependencies，slug 就是包名）；
			//   从商城装的仍走台账里的 packageName。两者都没有才交给 IDE。
			const pkgName = String(params.packageName || '')
				|| (entry && entry.packageName ? String(entry.packageName) : '');
			if (!pkgName) { return null; }   // 包名不知道 ⇒ 交 IDE（它按 storeId 反查）
			// ⚠ 内置插件（@vssaros/* / @deepseek-ai/*）**不许卸**：那是随产品/官方发布的，
			//   删掉会把产品自己的插件（含本页所在的插件）一起带走，而且用户没法从商城装回来。
			if (/^@(vssaros|deepseek-ai)\//.test(pkgName)) {
				return { ok: false, error: '「' + pkgName + '」是随产品发布的内置插件，不能卸载' };
			}
			if (typeof pm.removeBundle !== 'function') { return null; }
			const r = await pm.removeBundle(pkgName);
			if (r && r.error) { return { ok: false, error: mgmtErrorText(r.error) }; }
			await removeInstalled(root, kind, slug);
			return {
				ok: true,
				changed: r ? r.changed !== false : true,
				application: r?.application ?? null,
				restartRequired: r?.application === 'restart-required',
				via: 'dsh',
			};
		}

		// install / upgrade
		const detail = await market().detail(slug);
		const version = String(params.version || detail.latest_version || detail.latestVersion || '');
		if (!version) { throw new Error('这个商品没有可用版本'); }
		const dist = distributionOf(detail, version);
		const built = await specForDistribution(dist, slug, version);
		if (built.error) { return { ok: false, error: built.error }; }
		const r = await pm.installBundle(built.spec, { enabled: true });
		if (r && r.error) { return { ok: false, error: mgmtErrorText(r.error) }; }
		await upsertInstalled(root, { kind, storeId: slug, version, packageName: built.name || '' });
		return {
			ok: true,
			changed: r ? r.changed !== false : true,
			version,
			application: r?.application ?? null,
			restartRequired: r?.application === 'restart-required',
			via: 'dsh',
		};
	}

	/**
	 * 按分派目标执行（★ 2026-10-23：替代原来路由里的 6 层 if）。
	 *
	 * 五个目标各自对应一条**已有**的本地路径；这里只做路由，不含业务逻辑 ✓
	 *
	 * @param {'local-read'|'local-write'|'local-http'|'local-publish'} target
	 * @param {string} op
	 * @param {object} params
	 */
	async function runLocalByTarget(target, op, params) {
		if (target === 'local-read') { return runLocal(op, params); }
		if (target === 'local-write') { return runLocalWrite(op, params); }
		// 插件 / 工作台：先试 dsh 侧（pluginManager）；它说做不了（null）再退回 IDE
		if (target === 'local-plugin') {
			const local = await runLocalPlugin(op, params);
			if (local) { return local; }
			return callIde(op, params);
		}
		if (target === 'local-publish') { return runLocalPublish(op, params); }
		// local-http：编辑元数据 / 管理员审核（纯 HTTP，服务端判权）
		const m = market();
		if (op === 'updatePackage') {
			const pkg = await m.updatePackage(
				String(params.slug || params.id || ''),
				{
					...(typeof params.name === 'string' ? { name: params.name } : {}),
					...(typeof params.description === 'string' ? { description: params.description } : {}),
					...(typeof params.category === 'string' ? { category: params.category } : {}),
					...(typeof params.icon === 'string' ? { icon: params.icon } : {}),
					...(typeof params.visibility === 'string' ? { visibility: params.visibility } : {}),
					...(Array.isArray(params.tags) ? { tags: params.tags } : {}),
				},
			);
			return { ok: true, package: pkg };
		}
		const idOrSlug = String(params.slug || params.id || '');
		if (op === 'reviewStatus') {
			await m.reviewSetStatus(idOrSlug, String(params.status ?? ''));
			return { ok: true };
		}
		if (op === 'reviewFeature') {
			await m.reviewSetFeatured(idOrSlug, params.featured === true);
			return { ok: true };
		}
		throw new Error(`本地说不了这个动作：${op}`);
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
			throw new Error('dsh 侧拿不到数据根（config.dataRoot 未注入，且 vssarosFoundation 服务不可用）⇒ 无法打包发布');
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
		const localId = String(params.localId ?? slug);
		const version = String(params.version ?? '').trim();
		if (!version) { throw new Error('publish 需要 version'); }

		// ★ 2026-10-22（用户需求）：本体是一个 **GitHub 地址** ⇒ 只登记来源，不打包上传。
		//   这条对**所有 kind** 都成立（服务端 external 接口不限类型）；
		//   而"能不能装"另说：skill / workflow 可装，其余见 installFromExternal 的说明 ✓
		// ★ 2026-10-26（用户：「有没有校验机制，避免发布错误」）：
		//   登记 **npm 源**（`{type:'npm', name}`）—— 工作台/插件最常见的形态。
		//   像 Tencent/BrowserSkill 这种 monorepo 仓库，只有子包的 npm 名才是能装的；
		//   以前这里只认 GitHub 地址 ⇒ 那类仓库只能按"根目录"发，必然装不上。
		const npmName = String(params.npmName ?? '').trim();
		if (npmName) {
			if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(npmName)) {
				throw new Error(`npm 包名不合法：${npmName}`);
			}
			return publishDistribution({
				market: m,
				kind,
				localId,
				version,
				distribution: { type: 'npm', name: npmName },
				changelog: String(params.changelog ?? ''),
				meta: {
					...(typeof params.name === 'string' ? { name: params.name } : {}),
					...(typeof params.description === 'string' ? { description: params.description } : {}),
					...(typeof params.category === 'string' ? { category: params.category } : {}),
				},
			});
		}

		const source = String(params.source ?? '').trim();
		if (source) {
			return publishExternal({
				market: m,
				kind,
				localId,
				version,
				source,
				changelog: String(params.changelog ?? ''),
				meta: {
					...(typeof params.name === 'string' ? { name: params.name } : {}),
					...(typeof params.description === 'string' ? { description: params.description } : {}),
					...(typeof params.category === 'string' ? { category: params.category } : {}),
				},
			});
		}

		if (!PUBLISHABLE_KINDS.includes(kind)) {
			throw new Error(
				`这一类（${kind}）不走 bundle 发布：只有 ${PUBLISHABLE_KINDS.join(' / ')} 能由 dsh 侧打包发布`
				+ '；如果本体在 GitHub 上，请在「来源」里填 GitHub 地址（这样任何类型都能登记）',
			);
		}
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
			...(state.dataRoot ? {} : { dataRootError: state.dataRootError ?? 'foundation 尚未注入（插件可能还没激活完）' }),
			endpoint: (() => { try { return market().endpoint(); } catch { return null; } })(),
			tofTicket: 'unknown',
			marketJwt: 'unknown',
			login: 'not-tried',
		};
		if (!state.credentials) { return report; }
		try {
			const m = market();
			report.tofTicket = (await m.tofTicket()) ? 'present' : 'absent';
			// ★ 2026-10-23：**分别**报两个来源 —— 真机踩到"本地票据过期、IDE 票据有效"
			//   时，只报合并结果根本看不出该往哪查 ✗
			report.tofTicketSources = await m.tofTicketSources();
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
		// ★ 白名单来自 dispatch.js 的 ALL_OPS（与分派同源）⇒ 不会再"声明有、实际不认" ✓
		if (!isKnownOp(op)) {
			return { ok: false, error: `不认识的商城动作：${op}` };
		}
		const timeoutMs = WRITE_OPS.has(op) ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS;
		// ★ 2026-10-24（用户：「安装插件失败 … HTTP 404」）：
		//   商城里有 6704 个 `kind: 'plugin'` 的 dsh 插件（本体在 npm / GitHub，商城只有元数据）。
		//   旧版 IDE 的安装分支只认 `workbench` ⇒ plugin 掉进"下载包体"那条链 ⇒ 404。
		//   在**装/卸**这两个写动作上把 plugin 说成 workbench：IDE 侧走的就是「按 distribution
		//   生成 spec → `dsh plugin add`」这条正确通道（plugin 与 workbench 本质是同一件事）。
		//   ⚠ 等 IDE 侧也认识 plugin 之后，这段可以删（那边已在同一版本里加了分支）。
		const ideParams = { op, ...params };
		if (String(ideParams.kind) === 'plugin' && (op === 'install' || op === 'upgrade' || op === 'uninstall')) {
			ideParams.kind = 'workbench';
		}
		let reply;
		try {
			reply = await bridge.callIDE('ide.request', {
				capability: 'marketplace',
				pluginId: PLUGIN_PACKAGE,
				params: ideParams,
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
		// ★ 2026-10-22：界面改用 **React**（用户要求；也修掉"文字看不清"）。
		//
		// ★ React 从哪来：本页是**自托管 SSR 页**（`vssaros.view.kind='page'`），
		//   不在 dsh 的 chunk 装载器里 ⇒ **不能** `require("react")`（那是 chunk 形态的拿法）。
		//   ⇒ 自带 **UMD 版 React 18.3.1**（`lib/vendor/*.production.min.js`，共 139KB，
		//     复制自本仓 `vssaros-imagegen/vendor/excalidraw/node_modules`，不联网 ✓）。
		//   ⚠ 顺序不能错：react → react-dom → client.js（后两个都依赖前一个的全局）✓
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
<script src="${ROUTE_PREFIX}/vendor/react.js"></script>
<script src="${ROUTE_PREFIX}/vendor/react-dom.js"></script>
<script src="${ROUTE_PREFIX}/client.js"></script>
</body>
</html>`;
	}

	/**
	 * 发一份 vendor 静态文件（React UMD）。
	 *
	 * ⚠ 用 `immutable` 长缓存：这些文件**内容不变**（版本号在文件名/来源说明里）⇒
	 *   每次都重传 139KB 是浪费 ✓。真升级 React 时改文件名（`?v=`）即可。
	 */
	async function sendVendor(res, fileName) {
		const { readFile } = await import('node:fs/promises');
		const here = path.dirname(fileURLToPath(import.meta.url));
		const body = await readFile(path.join(here, 'vendor', fileName), 'utf8');
		res.writeHead(200, {
			'content-type': 'text/javascript; charset=utf-8',
			'cache-control': 'public, max-age=604800, immutable',
		});
		res.end(body);
	}

	// ── Agent 工具（★ 2026-10-27）：让右侧对话能识别与发布 ──────────────────
	//   为什么放这里：`market()` 是懒建的（凭据服务晚于 apply 注入），
	//   所以工具里**不能**预先持有 client，必须每次调 `market()` ✓
	// ⚠ **必须 `ctx.inject(['tools'])`**（★ 2026-10-26 真机日志抓到）：
	//   直接读 `ctx.tools` 会抛 `cannot get property "tools" without inject`，
	//   而它被 catch 吞掉 ⇒ 表现成"商城工具**静默不存在**"（右侧对话里模型说没有这个工具）✗
	//   证据：`vssaros-agents/lib/index.js` 就是 `export const inject = ['tools']` ✓
	// ── 写类工具的**审批闸**（2026-10-28）──────────────────────────────────────
	//   与 kb / kanban / workflow 同一把：官方派发前决策钩子 `tools/pre-execute`（waterfall ✓），
	//   返回 `{ kind: 'ask' }` ＝ 先问用户；没有审批支持的部署 degrade 成 deny（fail-closed ✓，正是想要的）。
	//   闸这两个：`market_install` 会**真落盘**（skills / workflows + installed-packages.json 台账）、
	//   `market_publish` 会**上传发布**（不可撤销）。`market_search` / `market_inspect_github` 纯只读 ⇒ 放行。
	//   ⚠ 判据带上参数：`dryRun` 只出计划不落盘（预检/预览）⇒ 不该弹窗（与 kb 的 apply=true 同一取舍）。
	ctx.effect(() => ctx.on('tools/pre-execute', (exec, next) => {
		const toolName = exec && typeof exec.name === 'string' ? exec.name : '';
		if (toolName !== 'market_install' && toolName !== 'market_publish') {
			return next();
		}
		const args = exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {};
		if (args.dryRun === true) {
			return next();
		}
		const target = String(args.slug ?? args.name ?? '').trim() || '(未命名)';
		return {
			kind: 'ask',
			reason: toolName === 'market_install'
				? `market_install 会把「${target}」落盘到本机商城安装目录（skills / workflows / installed-packages.json 台账）`
				: `market_publish 会把「${target}」上传发布到商城（不可撤销）`,
			displayReason: toolName === 'market_install'
				? { zh: `允许把「${target}」安装到本机？`, en: `Allow installing "${target}" locally?` }
				: { zh: `允许把「${target}」发布到商城？`, en: `Allow publishing "${target}" to the marketplace?` },
		};
	}), 'vssaros-marketplace: write-tool approval gate');

	ctx.inject(['tools'], (scope) => {
		const tools = scope.tools || (scope.get && scope.get('tools'));
		if (!tools || typeof tools.register !== 'function') { return; }
		scope.effect(() => marketToolDefinitions({
			inspectGithubRepo,
			// ★ 2026-10-26（用户：「商城助手中，增加安装功能」）：
			//   把两条已有的安装路径**统一成一个入口**给 Agent 用 ——
			//   · `LOCAL_WRITE_KINDS`（skill / workflow / agent / mcp）⇒ `runLocalWrite`
			//   · `LOCAL_PLUGIN_KINDS`（plugin / workbench）⇒ `runLocalPlugin`（走 ctx.pluginManager）
			//   ⚠ **kind 由服务端登记说了算**，不信调用方传的值（传错会装错目录 ✗）
			installPackage: async ({ slug, version }) => {
				const s = String(slug ?? '').trim();
				if (!s) { throw new Error('market_install 需要 slug'); }
				const detail = await market().detail(s);
				const kind = String(detail?.kind ?? '').trim();
				if (!kind) { throw new Error(`商城里查不到「${s}」的类型（可能 slug 写错）`); }
				const v = String(version ?? '').trim() || undefined;
				if (LOCAL_PLUGIN_KINDS.has(kind)) {
					return { kind, ...(await runLocalPlugin('install', { kind, slug: s, version: v })) };
				}
				if (LOCAL_WRITE_KINDS.has(kind)) {
					return { kind, ...(await runLocalWrite('install', { kind, slug: s, version: v })) };
				}
				// knowledge 之类：dsh 侧没有可落盘的本体 ⇒ 如实拒绝，别让 Agent 以为装上了
				throw new Error(`「${kind}」这一类暂不支持由 dsh 侧安装（请在商城页面上操作）`);
			},
			// ★ 2026-10-27：用 `publishDistribution` 而不是 `publishExternal` ——
			//   后者把 distribution 硬编码成 `github-source`，而 monorepo（如 BrowserSkill）
			//   必须发 `npm` 子包，否则「发布成功但装不上」（文档 §7）✗
			publishDistribution,
			market,
		}).map(def => tools.register(def)), 'vssaros-marketplace: agent tools');
	});

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

				// ── React UMD（自托管页面自带，见 renderPage 的说明）──────────
				if (req.method === 'GET' && url.pathname === `${ROUTE_PREFIX}/vendor/react.js`) {
					await sendVendor(res, 'react.production.min.js');
					return;
				}
				if (req.method === 'GET' && url.pathname === `${ROUTE_PREFIX}/vendor/react-dom.js`) {
					await sendVendor(res, 'react-dom.production.min.js');
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
					// ★ 2026-10-23：分派改走 `lib/dispatch.js`（原先是 6 层 if 嵌套，
					//   "哪个 op 去哪"这条最容易错的契约一个测试都没有 ✗）。
					//   ⚠ 五条本地路径的**错误契约必须一致**（200 + `{ok:false,error}`），
					//     绝不能让某一条抛到外层变成 500 —— 前端只认 `ok === false` ✓
					const target = resolveOp(op, params);
					if (target !== 'ide') {
						try {
							json(200, await runLocalByTarget(target, op, params));
						} catch (e) {
							json(200, { ok: false, error: String(e?.message ?? e) });
						}
						return;
					}
					// 兜底：转 IDE（workbench 装卸 / agent 发布 / 未知 op）。
					// ⚠ 这里也**包了 try/catch**：原先是裸调用 ⇒ 唯一会返回 500 的分支
					//   （错误契约不一致 ✗）。现在统一成 200 + ok:false ✓
					try {
						json(200, await callIde(op, params));
					} catch (e) {
						json(200, { ok: false, error: `商城通道出错：${String(e?.message ?? e)}` });
					}
					return;
				}
				// ── 自检（证明 dsh 侧自持）：桥是否在 / 票据是否可见 / 是否已能换 JWT ──
				if (req.method === 'GET' && url.pathname === `${ROUTE_PREFIX}/api/self-check`) {
					json(200, await selfCheck());
					return;
				}

				// ── 分类常量（页面用来画页签）─────────────────────
				if (req.method === 'GET' && url.pathname === `${ROUTE_PREFIX}/api/meta`) {
					json(200, { ok: true, kinds: KINDS, ops: ALL_OPS });
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
