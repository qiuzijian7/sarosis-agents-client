// @vssaros/dsh-workbenches — 工作台宿主（服务端半）。
//
// doc/workbench-refactor-plan.md §4.1 路线 B：与 dsh-desktop 官方宿主 `dsh-desktop-workbenches`
// **同名同形**的兼容宿主。服务端照搬官方 `index.js` 里与市场无关的部分（MIT，见 THIRD_PARTY.md）：
//   · 只读归属服务 `desktopWorkbenchOwnership.read() → { revision, sessionBindings, added }`
//     （业务插件判断"这个会话是不是我的"用它；**不许**另开一套设置命名空间来授权会话）；
//   · `GET  /api/vssaros-workbenches/state`        读 state.json（含 revision）；
//   · `POST /api/vssaros-workbenches/state/write`  带 revision 写入（乐观锁 409 / 校验 400 / 损坏 500）。
// 不搬：市场目录 / 安装 / 投稿状态 / 文档路由（P4 再做，见方案 §6）。
//
// ⚠ 为什么路由前缀不是官方的 `/api/desktop-workbenches/`：官方宿主万一也被装进同一 profile，
//   同一路由会"谁先注册谁赢"静默打架。服务名同官方（业务插件代码零改动可移植），路由各用各的。

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createStateStore, MAX_STATE_BYTES, StateError } from './state.js';
import { pendingRestartRecords, readInstallRecords } from './localInstall.js';

export const name = 'vssaros-workbenches';
/** 没有硬依赖：connection 走可选注入（同 scheduler / sessions 口径：非 web 模板里不让整包 pending）。 */
export const inject = [];

const PREFIX = '/api/vssaros-workbenches';
const NO_STORE = { 'cache-control': 'no-store' };

async function readPayload(request, maximum = MAX_STATE_BYTES) {
	const contentLength = Number(request.headers.get('content-length'));
	if (Number.isFinite(contentLength) && contentLength > maximum) { throw new StateError('工作台状态太大。', 413); }
	const reader = request.body?.getReader();
	if (!reader) { throw new StateError('需要 JSON 请求体。'); }
	const chunks = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) { break; }
			length += value.length;
			if (length > maximum) {
				await reader.cancel();
				throw new StateError('工作台状态太大。', 413);
			}
			chunks.push(value);
		}
		try {
			return JSON.parse(Buffer.concat(chunks).toString('utf8'));
		} catch {
			throw new StateError('请求体不是合法 JSON。');
		}
	} finally {
		reader.releaseLock();
	}
}

const failure = error => Response.json(
	{ error: error instanceof StateError ? error.message : '读写工作台状态失败。' },
	{ status: error instanceof StateError ? error.status : 500, headers: NO_STORE },
);

/**
 * 规范版本（2026-11-02）：`<插件版本>/<内容 sha256 前 8 位>`，例如 `0.3.8/1a2b3c4d`。
 *
 * 为什么要机器可读的版本：规范正文只写了日期（“版本：2026-11-02”），Agent 汇报“按规范做的”时
 * **无法验证它读的是哪一版**。有了这个值：响应头带它、`check_local_workbench` 回执带它、
 * Agent 在收尾汇报里报它 ⇒ “这个工作台是按哪版规范做的”可追溯，规范改动也能对上号。
 * 内容哈希参与版本 ⇒ 只改文档不改插件版本时，这个值照样会变（挡“文档漂了但版本没动”）。
 */
export async function guideVersionOf() {
	const [text, manifestText] = await Promise.all([
		readFile(new URL('./workbench-standard.zh.md', import.meta.url), 'utf8'),
		readFile(new URL('../package.json', import.meta.url), 'utf8'),
	]);
	const version = String(JSON.parse(manifestText).version ?? '0.0.0');
	const sha = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
	return { version: `${version}/${sha}`, sha, bytes: Buffer.byteLength(text, 'utf8') };
}

/**
 * `install_local_workbench` 会返回的 `application` 取值（**唯一真源**）。
 *
 * 为什么单列出来：文档和给 Agent 的入口提示词都在讲“按 application 决定下一步”，
 * 而 2026-11-02 实测两边都写了 `overridden`——**代码从不返回它**（没有“被更高优先级包覆盖”这条路径）。
 * 一个不存在的取值会让 Agent 去处理一个永远不会发生的情况，也会让真出错时的分类失效。
 * `check-workbench-guide` 用它做双向核对：**文档/提示词点名的取值 ⇔ 这里列的取值**。
 */
export const INSTALL_APPLICATIONS = ['applied', 'restart-required', 'failed', 'cancelled'];

/** `application: 'failed'` 里“被 Host 主动拦下”的两类（看 `code` 区分，不是安装器故障）。 */
export const INSTALL_BLOCK_CODES = ['replace_not_authorized', 'downgrade_blocked'];

export function apply(ctx, config) {
	const root = typeof config?.root === 'string' && config.root.trim() ? config.root.trim() : '';
	if (!root) {
		// 没给数据目录 = 组合写错了 ⇒ 如实报错，不猜一个目录去写（写错位置比不写更糟）。
		try { (typeof ctx.logger === 'function' ? ctx.logger('vssaros-workbenches') : console).warn('config.root 为空：工作台状态不可用（检查 cordis.patch.yml 的 dshHomePath）'); } catch { /* 探针假 ctx */ }
		return;
	}
	const store = createStateStore(root);
	ctx.effect(() => ctx.reflect.provide('desktopWorkbenchOwnership', {
		async read() {
			const { revision, state } = await store.read();
			return { revision, sessionBindings: { ...state.sessionBindings }, added: [...state.added] };
		},
	}));
	// ⚠ 必须把 `webServer` 一起 inject：只 inject `connection` 时，子 ctx 上没有 `webServer`
	//   ⇒ `/link` 里 `ctx.webServer.port` 是 undefined ⇒ origin 拼成 `http://127.0.0.1:undefined`
	//   ⇒ `new URL()` 抛错 ⇒ 路由 500 ⇒ 前端回落成「无 token 链接」⇒ 浏览器报
	//   `dsh web authentication required`（2026-10-26 真机，绕了两轮才定位到）。
	ctx.inject(['connection', 'webServer'], webCtx => registerRoutes(webCtx, store, root));
	// 控制桥是**可选**服务（dsh 可以独立跑）。这里用**动态 inject 显式声明取用**：
	//   · 不写进 `export const inject` —— 那会把整包钉死在"必须有桥"的组合上（独立部署会 pending）；
	//   · `ctx.inject` 只在服务存在时回调 ⇒ 拿不到就是 null，不影响加载。
	// ⚠ 必须留这条声明：`dshPluginPackages` 守卫会查"调 callIDE 却没声明取法"（否则反向调用永远不发生）。
	let injectedBridge = null;
	ctx.inject(['vssarosBridge'], child => {
		try { injectedBridge = child?.vssarosBridge ?? null; } catch { injectedBridge = null; }
		return () => { injectedBridge = null; };
	});
	// 用**父 ctx** 的 effect（不是 scoped 的）：探针/守卫的假 ctx 常只给父 ctx 挂 effect，
	// scoped.effect 在那种 ctx 里不存在 ⇒ 整条 apply 直接抛（2026-11-02 link-route 探针当场抓到）。
	// tools 服务缺失时 inject 回调根本不会执行，所以这里不需要额外判空。
	ctx.inject(['tools'], scope => {
		// ★★ 2026-11-03（真机：打包版 Host 日志 `error vssaros-workbenches:
		//   Error: cannot get property "tools" without inject`，at Object.callback …index.js:124）：
		//   cordis 的规矩是**inject 回调里必须用回调参数（子 ctx）取服务**；用**父** `ctx.tools`
		//   取一个在父 ctx 上没声明注入的服务 ⇒ 直接抛 ⇒ 整条 apply 失败 ⇒
		//   `install_local_workbench` / `check_local_workbench` 两个工具**永远注册不上** ✗✗。
		//   （原来那句"判空只服务探针"的注释把方向带偏了：问题不在判空，在取法。）
		let tools = null;
		try { tools = scope?.tools ?? null; } catch { tools = null; }   // 探针的假 ctx 对未知属性可能抛
		if (!tools || typeof tools.register !== 'function') { return; }
		ctx.effect(() => tools.register(localWorkbenchInstallTool(ctx, root, () => injectedBridge)), 'vssaros-workbenches: install tool');
		ctx.effect(() => tools.register(checkLocalWorkbenchTool()), 'vssaros-workbenches: check tool');
	});
}

/**
 * `install_local_workbench`（2026-11-02，对齐 dsh-desktop 的同名工具）。
 *
 * 为什么要有它：`workbench-authoring` 技能能把工作台做出来，但**最后一步装不上去**
 * （工作台包必须走主进程 `dsh plugin add`，Host 侧没有安装能力）⇒ Agent 只能让用户
 * 自己去插件中心点。有了这个工具，"做完就能装上"一个人一步就能闭环。
 *
 * 边界（不要放宽）：
 *   · 只在 Host 侧**校验与解包**，真正的安装仍走 IDE 主进程那条已验证的通道
 *     （`workbenches.install`：它自己弹用户确认、装完刷新插件列表）；
 *   · 没有控制桥（dsh 独立跑 / IDE 未开）⇒ **如实报错**，不说"已安装"；
 *   · 回执取值见 `INSTALL_APPLICATIONS`（applied / restart-required / failed / cancelled）——
 *     **没有 `overridden`**：本仓没有"被更高优先级包覆盖"这条路径，别照官方那份写；
 *     另有两类被主动拦下的 `code`（见 `INSTALL_BLOCK_CODES`）。
 *     （本通道装完一律 `restart-required`：运行中的 Host 不会热加载新包）。
 */
export function localWorkbenchInstallTool(scoped, dataRoot, bridgeProvider) {
	// 控制桥是**可选**服务（dsh 可以独立跑）。取法顺序：调用方注入的 provider（apply 里
	// `ctx.inject(['vssarosBridge'], …)` 捕获的那个）→ Cordis `get()` → 属性访问（会抛 ⇒ try）。
	const bridgeOf = () => {
		try {
			const injected = typeof bridgeProvider === 'function' ? bridgeProvider() : null;
			if (injected && typeof injected.callIDE === 'function') { return injected; }
		} catch { /* provider 也可能抛（服务已卸载）⇒ 继续往下试 */ }
		try {
			if (typeof scoped.get === 'function') {
				const viaGet = scoped.get('vssarosBridge');
				if (viaGet && typeof viaGet.callIDE === 'function') { return viaGet; }
			}
		} catch { /* 服务未注册 ⇒ 走属性访问再判一次 */ }
		try {
			const direct = scoped.vssarosBridge;
			return direct && typeof direct.callIDE === 'function' ? direct : null;
		} catch { return null; }
	};
	const text = (value) => typeof value === 'string' ? value : '';
	/**
	 * Host 的插件管理器（只读用途：查已装版本）。与 market 插件同口径：`ctx.get('pluginManager')`。
	 * 拿不到 ⇒ undefined ⇒ 覆盖检测给 `unknown`（如实，不当作「没装」）。
	 */
	const pluginManagerOf = (ctx) => {
		try {
			const viaGet = typeof ctx?.get === 'function' ? ctx.get('pluginManager') : undefined;
			if (viaGet) { return viaGet; }
		} catch { /* 服务未注册 */ }
		try { return ctx?.pluginManager ?? undefined; } catch { return undefined; }
	};
	/** 记录安装证据；**失败不影响结果**（安装已经发生，记账是附带的）。 */
	const recordQuietly = async (result) => {
		try {
			const { recordLocalInstall } = await import('./localInstall.js');
			await recordLocalInstall(dataRoot, result);
		} catch (error) {
			try { console.warn('[vssaros-workbenches] 安装记录写入失败：' + String(error && error.message || error)); } catch { /* ignore */ }
		}
	};
	return {
		name: 'install_local_workbench',
		description: [
			'把已经构建好的本地工作台包（.tgz）装进当前 VsSaros。',
			'用在你按工作台开发规范做完一个工作台、并且已经 `pnpm pack` 出 .tgz 之后；',
			'不需要让用户去插件中心填路径。安装会经 IDE 主进程的既有通道，并且**会弹一次用户确认**。',
			'⚠ 调它之前先用 check_local_workbench 干跑：包本身有问题时干跑就能发现，不必打扰用户点一次确认再失败。',
			'返回 application：applied=已生效可直接验界面；restart-required=已装但要重启 Harness（请用户重启，不要自己重启）；',
			'cancelled=用户取消；failed=失败（带原因）。任何非 applied/restart-required 都不算装好。',
			'同名已装会被拦下（replace_not_authorized），要装的版本更低也会被拦下（downgrade_blocked）——两者都要先问用户。',
			'包里必须有 package.json、dsh.bundle.patch 与它声明的入口；只收普通文件，路径必须绝对。',
		].join(''),
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: '本机 .tgz 的绝对路径（≤ 8MiB，解压后 ≤ 32MiB）' },
				replace: { type: 'boolean', description: '仅当“同名工作台已装，且用户明确同意更新它”时传 true；默认 false。已装而没传 true 会被直接拦下（不弹框、不安装），授权必须来自用户。' },
				allowDowngrade: { type: 'boolean', description: '默认 false：要装的版本比已装版本低时会被拦下（避免“装完回到旧版”）。只有用户明确要求回退旧版时才传 true。' },
			},
			required: ['path'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					application: { type: 'string' },
					packageName: { type: 'string' },
					version: { type: 'string' },
					restartRequired: { type: 'boolean' },
					via: { type: 'string' },
					error: { type: 'string' },
				},
				additionalProperties: true,
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.application === 'restart-required' || value.application === 'applied'
					? `已安装 ${value.packageName}@${value.version}（${value.application}）`
					+ (value.restartRequired ? '：请重启 Harness 后再验证界面。' : '：可以直接验证界面。')
					: `${value.application === 'cancelled' ? '用户取消了安装' : '安装失败'}：${value.error || '没有更多信息'}`,
			}],
		},
		isConcurrencySafe: () => false,
		async execute(args = {}) {
			const archive = text(args.path).trim();
			if (!archive) { throw new Error('install_local_workbench 需要 path（本机 .tgz 的绝对路径）'); }
			if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(archive)) { throw new Error(`path 必须是绝对路径：${archive}`); }
			const bridge = bridgeOf();
			if (!bridge || typeof bridge.callIDE !== 'function') {
				throw new Error('这台 VsSaros 没有可用的控制桥（dsh 独立运行 / IDE 未打开）⇒ 无法安装。'
					+ '请让用户在 IDE 的插件中心安装这个包，或先启动 VsSaros 再重试。');
			}
			let prepared;
			try {
				// 动态 import：只在真的调用时才读 zlib/fs（Host 启动路径不受影响）
				const { prepareLocalWorkbench } = await import('./localInstall.js');
				prepared = await prepareLocalWorkbench(archive);
			} catch (error) {
				throw new Error(`本地工作台包校验失败：${String(error && error.message || error)}`);
			}
			// ★ 覆盖检测（P1-4，2026-11-02）：同名包已装 ⇒ 这次是「覆盖」，必须被明说、被授权。
			//   事实来源是 Host 的 `pluginManager.listBundles()`（详见 `installedVersionOf` 的注释：
			//   为什么是版本级检测而不是官方那种指纹比对）。
			const { installedVersionOf, compareVersions } = await import('./localInstall.js');
			const existing = await installedVersionOf(pluginManagerOf(scoped), prepared.name);
			const replacing = args.replace === true;
			/**
			 * ★ 降级保护（2026-11-02，对齐 dsh-desktop「已取消安装以避免降级」）：
			 * 已装 1.2.0 又装 1.0.0 ⇒ 用户看到"安装成功"，但界面回到旧版、甚至因缺字段而崩。
			 * 放在覆盖授权**之前**判：否则用户先被要求授权覆盖、授权完才被告知是降级（两次往返）。
			 * 只在新版本**严格更低**时拦；版本不可比（不是完整 SemVer）⇒ 跳过，不误拦。
			 */
			if (existing.status === 'present' && existing.installed) {
				const order = compareVersions(prepared.version, existing.installed);
				if (order !== null && order < 0 && args.allowDowngrade !== true) {
					try { await prepared.cleanup(); } catch { /* 清理失败不掩盖结果 */ }
					const blocked = {
						application: 'failed',
						packageName: prepared.name,
						version: prepared.version,
						code: 'downgrade_blocked',
						installedVersion: existing.installed,
						error: `「${prepared.name}」已装 ${existing.installed}，这次要装的是更低的 ${prepared.version}。`
							+ '已拦下以避免降级。确实要回退旧版时，向用户确认后带 allowDowngrade: true（通常还需要 replace: true）再调。',
					};
					await recordQuietly(blocked);
					return blocked;
				}
			}
			if (existing.status === 'present' && !replacing) {
				// 没有授权就不覆盖：不打扰用户（不弹确认框）、不动磁盘，把原因和下一步说清楚。
				// 解包目录此时没有任何人在用 ⇒ 直接清掉（与「失败保留」不同：这不是安装失败，是被我们拦下的）。
				try { await prepared.cleanup(); } catch { /* 清理失败不掩盖结果 */ }
				const blocked = {
					application: 'failed',
					packageName: prepared.name,
					version: prepared.version,
					code: 'replace_not_authorized',
					installedVersion: existing.installed,
					error: `「${prepared.name}」已经装了${existing.installed ? `（当前 ${existing.installed}）` : ''}，这次会覆盖它。`
						+ '请先向用户确认“要更新这个已安装的工作台”，得到授权后再带 replace: true 调用；没有授权不要覆盖。',
				};
				await recordQuietly(blocked);
				return blocked;
			}
		// 只有**成功**才删解包目录（见 finally）：失败/超时时主进程可能还在读它，
		// 而且那份目录是最好的排查证据 ⇒ 保留，并把路径写进错误。
		let succeeded = false;
			try {
				let reply;
				try {
					reply = await bridge.callIDE('ide.request', {
						capability: 'workbenches',
						pluginId: '@vssaros/dsh-workbenches',
						params: {
							op: 'install',
							title: prepared.name,
							name: prepared.name,
							version: prepared.version,
							source: 'local',
							dir: prepared.dir,
							replace: replacing,
							// 覆盖时把「从哪个版本换到哪个版本」交给 IDE，确认框才能如实写（否则永远只写“安装”）
							...(existing.status === 'present' ? { replacing: { from: existing.installed, to: prepared.version } } : {}),
						},
					// 与 IDE 侧的 `IDE_REQUEST_INSTALL_TIMEOUT_MS`（7 分钟）同量级：用户确认框 60s
					// + `dsh plugin add`（主进程上限 5 分钟）+ 余量。默认 10s 必然"假超时"。
					}, { timeoutMs: 8 * 60 * 1000 });
				} catch (error) {
					return {
						application: 'failed',
						packageName: prepared.name,
						version: prepared.version,
						error: `IDE 安装通道出错：${String(error && error.message || error)}（解包目录保留：${prepared.dir}）`,
					};
				}
				if (!reply || reply.ok === false) {
					const cancelled = reply && reply.declined === true;
					const failed = {
						application: cancelled ? 'cancelled' : 'failed',
						packageName: prepared.name,
						version: prepared.version,
						error: (text(reply && (reply.error || reply.text)) || 'IDE 没有回执') + `（解包目录保留：${prepared.dir}）`,
					};
					// 失败也留证据（含用户取消）：否则"为什么没装上"下次只能靠回忆
					await recordQuietly(failed);
					return failed;
				}
				// IDE 通道装完必须重启 Host 才进组合（运行中的进程不热加载新包）⇒ 如实给 restart-required。
				// 只有当 IDE 明确说不需要重启时才报 applied —— 不能反过来猜"应该已经生效了"。
				const restartRequired = reply.restartRequired !== false;
				const result = {
					application: restartRequired ? 'restart-required' : 'applied',
					// 覆盖检测的结论如实随回执走：`unknown` = 没能检查（不是「没有冲突」）
					replaceCheck: existing.status,
					...(existing.status === 'present' ? { replaced: { from: existing.installed, to: prepared.version } } : {}),
					packageName: prepared.name,
					version: text(reply.version) || prepared.version,
					restartRequired,
					via: 'ide',
					changed: reply.changed !== false,
				};
				await recordQuietly(result);
				succeeded = true;
				return result;
			} finally {
				// 成功才清；失败/取消保留目录（见上面 succeeded 的注释）
				if (succeeded) {
					try { await prepared.cleanup(); } catch { /* 清理失败不掩盖安装结果 */ }
				}
			}
		},
	};
}

/**
 * `check_local_workbench`（2026-11-02，对标 dsh-desktop 提示词里引用的 `check-workbench-package`）。
 *
 * **干跑**：对一个 `.tgz` 做和 `install_local_workbench` 同一套结构校验 + 安装前审计，
 * 但**什么都不装、不弹确认、不需要控制桥、不写盘**。Agent 在调安装之前先调它：
 *   · 通过 ⇒ 安装不会因「包本身有问题」被拒；
 *   · 不通过 ⇒ 带着具体原因回去改，不用打扰用户点一次确认再失败。
 *
 * 边界（别放宽）：它**不**证明包能在宿主里跑起来（那只有真装 + 重启才知道），
 * 回执里 `verified` 明说「结构 + 静态审计」，不许被表述成「已验证可用」。
 */
export function checkLocalWorkbenchTool() {
	const text = (value) => typeof value === 'string' ? value : '';
	return {
		name: 'check_local_workbench',
		description: [
			'安装前干跑检查一个本地工作台包（.tgz）：和 install_local_workbench 用同一套校验，但不安装、不弹确认。',
			'在 pnpm pack 出 .tgz 之后、调 install_local_workbench 之前先调它。',
			'返回 ok=true 表示结构合法且没有必然冲突（可以去安装）；ok=false 时 errors 里是必须先改的问题。',
			'warnings 是值得知道但不阻断的；capabilities 是服务端代码静态扫描到的行为（提示，不是沙箱）；',
			'identity 是它装上后的工作台身份（local:<包名>）。',
			'⚠ ok=true 只说明「结构 + 静态审计」通过，不等于「装上能跑」——真机效果仍要装完重启后核验。',
		].join(''),
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: '本机 .tgz 的绝对路径（≤ 8MiB，解压后 ≤ 32MiB）' },
			},
			required: ['path'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					verified: { type: 'string' },
					packageName: { type: 'string' },
					version: { type: 'string' },
					identity: { type: 'string' },
					errors: { type: 'array', items: { type: 'string' } },
					warnings: { type: 'array', items: { type: 'string' } },
					capabilities: { type: 'array', items: { type: 'string' } },
				},
				additionalProperties: true,
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.ok
					? `检查通过 ${value.packageName}@${value.version}（${value.identity || '身份未识别'}）`
						+ (value.warnings?.length ? `；${value.warnings.length} 条提示` : '')
						+ '。这只是结构 + 静态审计，装上并重启后仍需核验界面。'
					: `检查未通过${value.packageName ? ` ${value.packageName}@${value.version}` : ''}：${(value.errors || []).join('；') || '未知原因'}`,
			}],
		},
		isConcurrencySafe: () => true,
		async execute(args = {}) {
			const archive = text(args.path).trim();
			if (!archive) { throw new Error('check_local_workbench 需要 path（本机 .tgz 的绝对路径）'); }
			if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(archive)) { throw new Error(`path 必须是绝对路径：${archive}`); }
			const VERIFIED = '结构校验 + 静态审计（不含：加载 / 注册 / 界面）';
			const { readFile } = await import('node:fs/promises');
			const { inspectWorkbenchArchive, auditWorkbenchEntries } = await import('./localInstall.js');
			let buffer;
			try { buffer = await readFile(archive); }
			catch (error) { return { ok: false, verified: VERIFIED, errors: [`读不到文件：${String(error && error.message || error)}`], warnings: [], capabilities: [] }; }
			let inspected;
			try { inspected = await inspectWorkbenchArchive(buffer); }
			catch (error) {
				// 结构不合法是「检查结果」，不是工具故障 ⇒ 返回 ok:false 而不是抛（Agent 要读原因去改）
				return { ok: false, verified: VERIFIED, errors: [String(error && error.message || error)], warnings: [], capabilities: [] };
			}
			const audit = auditWorkbenchEntries(inspected);
			// 这次审计依据的规范版本（见 guideVersionOf）：随回执一起给，Agent 在收尾汇报里带上
			// ⇒ “这个工作台是按哪版规范做的/审的”可追溯；读不到就如实省略，不编一个值。
			const guide = await guideVersionOf().catch(() => null);
			return {
				ok: audit.errors.length === 0,
				verified: VERIFIED,
				packageName: inspected.name,
				version: inspected.version,
				identity: audit.identity,
				errors: audit.errors,
				warnings: audit.warnings,
				capabilities: audit.capabilities.map(item => item.label),
				archiveBytes: inspected.archiveBytes,
				extractedBytes: inspected.totalBytes,
				...(guide ? { guideVersion: guide.version } : {}),
			};
		},
	};
}

/**
 * 外开链接的 origin。
 *
 * ⚠ 2026-10-26 真机 bug：曾用 `new URL(request.url, 'http://dsh.internal')` 的 host 当 origin，
 *   而 `request.url` 是相对路径 ⇒ 兜底串 `dsh.internal` 变成真实域名 ⇒
 *   外开打开 `http://dsh.internal/?token=…`，浏览器报「站点无法访问 / DNS_PROBE_FINISHED_NXDOMAIN」。
 *
 * 正确来源：① 请求的 Host 头（用户可能是 localhost / 自定义域名）
 *          ② 该头缺失或仍是内部占位名 ⇒ 回落到 `127.0.0.1:<webServer.port>`
 * dsh 与本机浏览器同机，回环地址永远可达。
 */
export function resolveOrigin(hostHeader, port) {
	const host = String(hostHeader || '').trim();
	if (host && !/^dsh\.internal(:|$)/i.test(host)) { return `http://${host}`; }
	return `http://127.0.0.1:${port}`;
}

/**
 * 综合决定外开链接的 origin（**客户端上报优先**）。
 *
 * ⚠ 2026-10-26 真机 500：`/link` 曾用 `ctx.webServer.port` 兜底，但
 *   `ctx.inject(['connection'])` 拿到的子 ctx **没有 webServer** ⇒ port 是 undefined
 *   ⇒ origin 变成 `http://127.0.0.1:undefined` ⇒ `new URL()` 抛错 ⇒ 500（前端回落成无 token 链接 ⇒ 401）。
 *
 * 现在的优先级：
 *   ① 浏览器上报的 `origin`（同源请求，最可信；dsh 里一定有）
 *   ② 请求的 Host 头（真实地址时）
 *   ③ 回环 + 端口（只有拿到有效端口才用，否则抛明确错误）
 */
export function pickOrigin(claimed, hostHeader, port) {
	for (const raw of [claimed, hostHeader]) {
		const v = String(raw || '').trim();
		if (!v) { continue; }
		const withScheme = /^https?:\/\//i.test(v) ? v : `http://${v}`;
		try {
			const u = new URL(withScheme);
			if (!/^dsh\.internal$/i.test(u.hostname)) { return `${u.protocol}//${u.host}`; }
		} catch { /* 试下一个 */ }
	}
	if (Number.isFinite(port)) { return `http://127.0.0.1:${port}`; }
	throw new Error('拿不到可用 origin：客户端未上报 origin，且本 ctx 无 webServer.port');
}

function registerRoutes(ctx, store, dataRoot) {
	/**
	 * 生效态（2026-11-02，对标官方 `restart-status`）：哪些包「已安装、但当前 Host 还没加载」。
	 *
	 * 为什么要它：`install_local_workbench` 回 `restart-required` 之后，用户重启之前，
	 * 界面上看不到任何东西 ⇒ 表现成「装了没出现」。以前只有开发期守卫知道（仓库 ≠ 已装），用户不知道。
	 * 判据与理由见 `pendingRestartRecords`（只用 Host 启动时间 vs 记录时间，不需要"已读"状态）。
	 */
	ctx.connection.fetch.register({
		path: `${PREFIX}/install-status`,
		methods: ['GET'],
		requestBody: 'buffered',
		async fetch() {
			try {
				const hostStartedAt = Date.now() - Math.round(process.uptime() * 1000);
				const records = await readInstallRecords(dataRoot);
				return Response.json({
					hostStartedAt: new Date(hostStartedAt).toISOString(),
					pending: pendingRestartRecords(records, hostStartedAt),
					recent: records.slice(0, 10),
				}, { headers: NO_STORE });
			} catch (error) {
				return failure(error);
			}
		},
	});
	/**
	 * 随包工作台开发规范（2026-11-02，对齐 dsh-desktop 的 `/api/desktop-workbenches/development-guide`）。
	 *
	 * 为什么要它：规范源在 `doc/` 与内置技能里，**dsh 侧 Agent 未必能读到工作区文件**；
	 * 给一个稳定 URL，Agent（含在线 Skill）就能拿到与产品版本一致的规范，
	 * 不会用记忆里的旧口径去写工作台。文件由 `scripts/build-workbench-guide.mjs` 生成，
	 * `dsh-plugins/check-workbench-guide.mjs` 保证它与源逐字一致。
	 */
	ctx.connection.fetch.register({
		path: `${PREFIX}/development-guide`,
		methods: ['GET'],
		requestBody: 'buffered',
		async fetch() {
			try {
				const text = await readFile(new URL('./workbench-standard.zh.md', import.meta.url), 'utf8');
				const guide = await guideVersionOf().catch(() => null);
				return new Response(text, {
					headers: {
						'content-type': 'text/markdown; charset=utf-8',
						'cache-control': 'no-store',
						// 规范版本（见 guideVersionOf 的注释）：Agent 在收尾汇报里报这个值，
						// “按哪版规范做的”才可验证；文档漂了而插件版本没动时它也会变。
						...(guide ? { 'x-workbench-guide-version': guide.version } : {}),
					},
				});
			} catch {
				return Response.json(
					{ error: '随包工作台开发规范缺失：重新安装 @vssaros/dsh-workbenches（或跑 scripts/build-workbench-guide.mjs）。' },
					{ status: 500, headers: NO_STORE },
				);
			}
		},
	});
	ctx.connection.fetch.register({
		path: `${PREFIX}/state`,
		methods: ['GET'],
		requestBody: 'buffered',
		async fetch() {
			try {
				return Response.json(await store.read(), { headers: NO_STORE });
			} catch (error) {
				return failure(error);
			}
		},
	});
	/**
	 * ★ 2026-10-26「外开」用：返回**带 token** 的工作台深链。
	 *
	 * 为什么必须服务端给：`?token=` 只在"还没有有效 Cookie"时用，认证完会换成 Cookie。
	 * 外开是**另一个浏览器**（没有那份 Cookie），若只拿 `location.search` 里的 token
	 * （认证后早被消费掉）⇒ 打开就是 401/空白（真机 bug：编辑器里显示内容为空）。
	 * `connection.authenticatedUrl()` 会附上**当前进程的新 token**，直接可用。
	 */
	ctx.connection.fetch.register({
		path: `${PREFIX}/link`,
		methods: ['GET'],
		requestBody: 'buffered',
		async fetch(request) {
			try {
				const reqUrl = new URL(request.url, 'http://dsh.internal');
				const wb = String(reqUrl.searchParams.get('wb') || '').trim();
				if (!wb) {
					return Response.json({ error: 'missing-wb' }, { status: 400, headers: NO_STORE });
				}
				/* ⚠ 2026-10-26 真机 bug：**不能用 `new URL(request.url, 'http://dsh.internal')` 的 host**。
				   `request.url` 是相对路径 ⇒ 兜底串 `dsh.internal` 会变成真实 origin，
				   外开就打开 `http://dsh.internal/?token=…`（ERR_NAME_NOT_RESOLVED / 站点无法访问）。
				   正确来源（与 `vssaros-bridge` 同口径）：
				     ① 优先用请求的 Host 头（用户可能用 localhost / 自定义域名访问）
				     ② 该头缺失或仍是内部占位名 ⇒ 回落到 `127.0.0.1:<webServer.port>`
				   dsh 与本机浏览器同机，回环地址永远可达。 */
				let hostHeader = '';
				try { hostHeader = String(request.headers.get('host') || '').trim(); } catch (e) { hostHeader = ''; }
				const claimed = String(reqUrl.searchParams.get('origin') || '').trim();
				const port = ctx.webServer && ctx.webServer.port;
				const origin = pickOrigin(claimed, hostHeader, port);
				const base = ctx.connection.authenticatedUrl(origin + '/');
				// `alone=1`：告诉前端「这是外开，只显示工作台」⇒ 进入后收起左侧会话栏
				return Response.json({ url: base + '#wb=' + encodeURIComponent(wb) + '&alone=1', origin }, { headers: NO_STORE });
			} catch (error) {
				// ⚠ 这里不能复用通用的 failure()（文案是"读写工作台状态失败"，会掩盖真实原因）
				return Response.json({
					error: String((error && error.message) || error || 'unknown'),
					hasWebServer: !!(ctx && ctx.webServer),
					port: ctx && ctx.webServer && ctx.webServer.port,
				}, { status: 500, headers: NO_STORE });
			}
		},
	});
	ctx.connection.fetch.register({
		path: `${PREFIX}/state/write`,
		methods: ['POST'],
		requestBody: 'buffered',
		async fetch(request) {
			try {
				return Response.json(await store.write(await readPayload(request)), { headers: NO_STORE });
			} catch (error) {
				return failure(error);
			}
		},
	});
}
