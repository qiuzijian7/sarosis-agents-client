// @vssaros/dsh-relay — host half
//
// 五件事：
//   ① 把 `/x/relay/` 这个页面发出去（页面见 lib/page.js）；
//   ② 只读探针 `/x/relay/api/ping`（中转站可达吗 / 什么版本 / 往返多久）；
//   ③ `/x/relay/api/nodes` —— 号池（节点池）列表（页面上的表格）；
//   ④ `/x/relay/api/enroll` —— **把本机注册进号池**（页面上那个按钮点一下就走这里）；
//   ⑤ **Node Agent**（lib/agent.js）—— 反向通道常驻：中转站下发 invoke 时，
//      用**本机**的 CodeBuddy 登录态去调上游，再把流式分片回传。
//
// 认证（都在 Host 侧做 ⇒ 页面永远拿不到密钥）：
//   · 一律用**窄作用域的 enroll key**（注册 + 读号池摘要）—— 换不到管理员权限；
//   · 管理员 auth-key **只留在服务端**，绝不进这个包（守卫会盯）。
//   · CodeBuddy 登录态从 **dsh 凭据库**取（`VSSAROS_CODEBUDDY_KEY`，与 vssaros-bridge
//     **同一份**，不复制第二份 token）；本机的节点令牌存在 `VSSAROS_RELAY_NODE`。
import os from 'node:os';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { renderPage, DEFAULT_RELAY } from './page.js';

const PAGE_FILE = fileURLToPath(new URL('./page.js', import.meta.url));

/**
 * 按 **文件 mtime** 缓存 `page.js` 模块（与 vssaros-studio 同一套修法）。
 *
 * ⚠ 原 `import('./page.js?t=' + Date.now())` 每次请求都生成新模块，ESM 模块不会被 GC
 *   ⇒ 内存只增不减。mtime 当 cache-busting：没改就复用，改了才重新加载。
 */
let pageModuleCache = { mtimeMs: 0, render: null };

async function loadPageRender() {
	try {
		const { mtimeMs } = await stat(PAGE_FILE);
		if (pageModuleCache.render && pageModuleCache.mtimeMs === mtimeMs) { return pageModuleCache.render; }
		const mod = await import('./page.js?t=' + mtimeMs);
		pageModuleCache = { mtimeMs, render: mod.renderPage };
		return pageModuleCache.render;
	} catch {
		return renderPage;
	}
}
import { createNodeAgent, AGENT_STATE } from './agent.js';
import { identityOf } from './codebuddy.js';
import { toReportPayload } from './quota.js';
import { collectQuotaViaBrowser, loginInBrowser, readWoaCookies } from './quotaBrowser.js';

/**
 * 浏览器插件服务（`ctx.vssarosBrowser`）—— 额度采集靠它读**真实浏览器**里的 woa 会话。
 *
 * ★ 2026-10-28：额度采集改为**全自动**（用户要求零手工操作）⇒ 不再需要 Electron 登录窗
 *   （企业 SSO 在 Electron 窗口里收不到回执，实测），也不再需要手动粘 cookie。
 *   浏览器插件是**可选**依赖：缺席时额度采集如实报"需要浏览器插件"，其它功能照常 ✓
 */
let browserService;

/**
 * ★ CodeBuddy token 的**同步缓存**（2026-10-28 实测修掉的元凶）。
 *
 * 病根：`readAccessToken` / `readCatalogToken` 是 **async**，而 `lib/agent.js` 的 getter
 * 是**同步**用法（`String(getAccessToken() || '')`）⇒ 传出去的是字符串
 * **"[object Promise]"** ⇒ 平台 `/v3/config` 回 `data.models:null` ⇒
 * **节点模型数 0** ✗（页面上的 `tokenFingerprint` 恒为 `b4e6060006b9`
 * —— 那正是 `sha256("[object Promise]")` 的前 12 位，是自欺欺人的"指纹" ✗✗）。
 *
 * ⇒ 这里把 token 读进**同步可读**的缓存，agent 只读缓存；
 *   凭据服务可用时定时刷新（token 会轮换/过期）⇒ 刷新后让 agent 立刻重拉目录 ✓
 */
let cachedAccessToken = '';
let cachedCatalogToken = '';

/** 刷新 token 缓存（返回是否拿到）。 */
async function refreshCodebuddyTokens() {
	cachedAccessToken = await readAccessToken();
	cachedCatalogToken = await readCatalogToken();
	return !!(cachedAccessToken || cachedCatalogToken);
}

const ROUTE_PREFIX = '/x/relay';

/** 探测超时（毫秒）。 */
const PING_TIMEOUT_MS = 4000;
/** 调中转站其它接口的超时（毫秒）。 */
const CALL_TIMEOUT_MS = 15000;

/**
 * 自动注册密钥（**窄作用域**：只能注册节点 + 读号池摘要，换不到管理员权限）。
 * 与远端 `/data/chatgpt2api/data/nodes/enroll_key` 一致；也内置在 IDE 扩展的
 * `codebuddy.relay.enrollKey` 默认值里（同一份，别再分叉）。
 */
const DEFAULT_ENROLL_KEY = 'ccd6d985cdf1cfa69b124046b8784e7194ac896a17ed408b';

/** CodeBuddy access token 的凭据引用（与 vssaros-bridge **逐字一致** ⇒ 同一份登录态）。 */
const CODEBUDDY_CREDENTIAL_REF = 'VSSAROS_CODEBUDDY_KEY';
/**
 * OAuth access token 的**专用** ref（桥侧写、只有桥写 ⇒ 不会被 `providers.sync` 的 API Key 抢占）✓
 * 与 `dsh-plugins/vssaros-bridge/lib/codebuddy.js` 的 `CODEBUDDY_ACCESS_TOKEN_REF` **逐字一致**。
 */
const CODEBUDDY_ACCESS_TOKEN_REF = 'VSSAROS_CODEBUDDY_ACCESS_TOKEN';
/** 本机节点令牌（node_id + node_token）的凭据引用。 */
const NODE_CREDENTIAL_REF = 'VSSAROS_RELAY_NODE';

/**
 * ★ 插件状态**必须挂在进程级全局**上，不能用模块级变量。
 *
 * 病根（2026-10-28 实测）：dsh 会把同一个插件在**两个 plane**（credentials 半边 / webServer 半边）
 * 各装载一次 ⇒ 模块级 `const state` 是**两份互不相干的对象** ⇒
 *   · Node Agent 在 credentials 半边创建，它的 `getNode()` 读的是 **A 份** state；
 *   · HTTP 路由（/api/enroll、/api/agent）在 webServer 半边，用的是 **B 份** state；
 *   ⇒ 注册写进 B，agent 读 A ⇒ **agent 永远看不到节点 ⇒ 通道连不上**，
 *     页面却显示「已注册」⇒ 极难自证（本地看都"正常"）✗✗。
 * ⇒ 挂到 `globalThis` 上，两半共用同一份 ✓（同一进程内必然是同一个 Host 进程）。
 */
const state = (globalThis.__vssarosRelayState ||= {
	relayUrl: DEFAULT_RELAY,
	enrollKey: DEFAULT_ENROLL_KEY,
	/** 本机注册后拿到的节点记录（内存缓存；持久化在 dsh 凭据库 `VSSAROS_RELAY_NODE`）。 */
	localNode: undefined,
	/** dsh 凭据服务（可选依赖：没有它就退化成「每次都要手动注册」）。 */
	credentials: undefined,
	/** Node Agent 实例（反向通道）。 */
	agent: undefined,
	/**
	 * ★ **Host 侧是否自己起 Agent**（默认 **true**，2026-10-28 改）。
	 *
	 * 历史：最先只有 Host 侧一份；后来为了「关掉 app 时 Agent 一起关」把 Agent 搬到
	 * IDE 主进程（`electron-main/nodeAgentHost.ts`）⇒ 此处置 false。
	 *
	 * ★ 现状（用户要求收敛）：**主进程那份已删除**，Agent **只有 Host 侧这一份** ⇒
	 *   若这里仍是 false，则**每次重启 app 都没有任何实例去连通道** ⇒
	 *   页面永远显示「未连接 / offline」，必须手动点「重连通道」才连上 ✗✗
	 *   ⇒ 必须置 **true**，并在凭据服务就绪后自动 `ensureAgent()`
	 *     （`ensureAgent` 内部：没有节点记录就**不**连 ⇒ 未注册时不会乱连 ✓）。
	 *
	 * 副作用（已知且接受）：dsh Host 是 keepAlive 的 ⇒ **关掉 app 后通道可能还连着**
	 *   一会儿（Host 空闲 TTL 到期才退）。相比"每次启动都掉线要手点"这个代价可以接受。
	 */
	agentEnabled: true,
	/** Agent 状态快照（页面显示用；真实状态以中转站为准）。 */
	agentState: { state: AGENT_STATE.IDLE, error: '', inflight: 0, models: 0, connectedAt: 0 },
	/**
	 * CodeBuddy 账号的**额度/积分**快照（由 `quota.js` 采集，页面显示 + 上报中转站）。
	 *
	 * ★ 为什么需要用户「粘贴一次 cookie」：
	 *   本插件跑在 dsh Host（Node）里，**没有浏览器能力**（无 `BrowserWindow` /
	 *   `session.cookies`）⇒ 读不到 `token.woa.com` / `aitoken.woa.com` 的登录 cookie
	 *   （httpOnly + Chrome 127+ 的 App-Bound Encryption，实测连 SYSTEM 权限也解不开）。
	 *   ⇒ cookie 存一次进 dsh 凭据库（`VSSAROS_QUOTA_COOKIE`），之后**自动定时刷新**，
	 *     只有过期才需要重粘。
	 */
	quota: undefined,
	quotaError: '',
	quotaUpdatedAt: 0,
	quotaTimer: undefined,
});

/**
 * @param {object} [config]
 * @param {string} [config.relayUrl]   中转站地址（缺省 = AnyDev 上的部署）
 * @param {string} [config.enrollKey]  自动注册密钥（缺省 = 内置的那把）
 *
 * ⚠ 2026-10-27 实测：dsh 的 loader **不会**把补丁行的 `config` 交给插件模块的 `init()`
 *   （补丁行的 config 是 loader 自己的输入）⇒ 所以这里只当"覆盖入口"，**默认值必须写在代码里**，
 *   否则插件会静默退化成"未配置密钥"（页面报「未配置注册密钥」）。
 */
export function init(config = {}) {
	const url = typeof config.relayUrl === 'string' ? config.relayUrl.trim() : '';
	if (/^https?:\/\//i.test(url)) { state.relayUrl = url; }
	const enroll = typeof config.enrollKey === 'string' ? config.enrollKey.trim() : '';
	if (enroll) { state.enrollKey = enroll; }
	return apply;
}

/** 拼一个带超时的 fetch（超时 ⇒ 抛 AbortError，由调用方兜住）。 */
async function fetchWithTimeout(url, init, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

/** 探一下中转站：可达 / 版本 / 往返耗时。 */
async function ping() {
	const started = Date.now();
	const target = new URL('/version', state.relayUrl).toString();
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 4000);
		const res = await fetch(target, { signal: controller.signal });
		clearTimeout(timer);
		const text = await res.text();
		let version = '';
		try { version = String(JSON.parse(text).version || ''); } catch { version = ''; }
		return { ok: res.ok, status: res.status, version, latencyMs: Date.now() - started, url: state.relayUrl };
	} catch (e) {
		return {
			ok: false,
			status: 0,
			version: '',
			latencyMs: Date.now() - started,
			url: state.relayUrl,
			error: String((e && e.message) || e),
		};
	}
}

/**
 * 调中转站的 `/api/nodes/pool`（**窄作用域**：enroll key 就能读，只给脱敏摘要）。
 * 返回 { ok, nodes, local, error }。
 */
async function listNodes() {
	if (!state.enrollKey) {
		return { ok: false, nodes: [], error: '未配置注册密钥' };
	}
	try {
		const res = await fetchWithTimeout(new URL('/api/nodes/pool', state.relayUrl).toString(), {
			headers: { 'x-enroll-key': state.enrollKey },
		}, CALL_TIMEOUT_MS);
		const text = await res.text();
		if (!res.ok) {
			return { ok: false, nodes: [], error: `HTTP ${res.status}` };
		}
		let data;
		try { data = JSON.parse(text); } catch { return { ok: false, nodes: [], error: '返回的不是 JSON' }; }
		const raw = Array.isArray(data && data.nodes) ? data.nodes : [];
		const localName = os.hostname();
		// 本机节点 id（Agent 拿到的那个）—— 判"是不是本机"时**双保险**：
		// ① hostname === 本机主机名；② id === 本机登记到的节点 id。
		// ⚠ 只靠 hostname 不够：中转站那边可能被别处的注册覆盖了 hostname（历史上就出现过 "nd_xxx"）✗。
		const localId = String((state.localNode && state.localNode.id) || '');
		const nodes = raw.map(n => ({
			id: String(n.id || ''),
			name: String(n.name || ''),
			status: String(n.status || ''),
			provider: String(n.provider || ''),
			lastSeenAt: String(n.last_seen_at || ''),
			models: Number(n.models_count || 0),
			hostname: String(n.hostname || ''),
			/** 反向通道连着没有（Agent node 面板用；中转站侧算的）。 */
			channelConnected: n.channel_connected === true,
			/**
			 * ★ **Tokens 用量**（CodeBuddy 账号的额度/积分）。
			 *
			 * 数据来源 = **主进程采集后上报到中转站**的（`POST /api/nodes/quota`）。
			 * 为什么不在这里采集：本插件跑在 dsh Host（Node），**没有浏览器** ⇒
			 * 登录不了 token.woa.com、也读不到 httpOnly cookie（Chrome 127+ 还用
			 * App-Bound Encryption，实测 SYSTEM 权限也解不开）。
			 * ⇒ 主进程用 Electron 自己的 session 采集 ⇒ 中转站存 ⇒ 这里只负责**展示**。
			 */
			quota: n.quota && typeof n.quota === 'object' ? n.quota : null,
			isLocal: String(n.hostname || '') === localName || (!!localId && String(n.id || '') === localId),
		}));
		const local = nodes.find(n => n.isLocal) || null;
		return { ok: true, nodes, local: local ? { registered: true, id: local.id, name: local.name, status: local.status } : { registered: false } };
	} catch (e) {
		return { ok: false, nodes: [], error: String((e && e.message) || e) };
	}
}

/**
 * 读本机 CodeBuddy access token（**只在内存里用**，绝不外传）。
 * 与 vssaros-bridge 用**同一个凭据引用** ⇒ 不复制第二份 token。
 */
async function readAccessToken() {
	const creds = state.credentials;
	if (!creds || typeof creds.resolve !== 'function') { return ''; }
	try {
		const resolved = await creds.resolve(CODEBUDDY_CREDENTIAL_REF);
		return String((resolved && resolved.value) || '').trim();
	} catch {
		return '';
	}
}

/**
 * 读本机 CodeBuddy **access token**（OAuth，JWT）—— **只用于拉模型目录**。
 *
 * ★ 为什么不用 `VSSAROS_CODEBUDDY_KEY`（2026-10-28 实测）：
 *   那个 ref 有**两个写入方** —— ① vssaros-bridge（写 OAuth token）
 *   ② IDE 的 `providers.sync`（写 **API Key**，见 `dshProviderSyncPlan.ts` 的 `credentialRefFor`）
 *   ⇒ 谁后写谁赢 ⇒ Host 侧经常拿到 **API Key**（不是 JWT）
 *   ⇒ 平台对它的 `GET /v3/config` 回 `code:12403 check ua, get coding copilot version error`
 *   ⇒ 表现为「节点模型数 0 / 拉不到目录」✗✗
 *   ⇒ 桥侧已把 OAuth token 另存到**专用 ref**（`VSSAROS_CODEBUDDY_ACCESS_TOKEN`，只有桥写）⇒ 这里读它 ✓
 *   （拿不到时回退到旧 ref：万一那一份恰好是 OAuth token 也能用 ✓）
 */
async function readCatalogToken() {
	const creds = state.credentials;
	if (!creds || typeof creds.resolve !== 'function') { return ''; }
	for (const ref of [CODEBUDDY_ACCESS_TOKEN_REF, CODEBUDDY_CREDENTIAL_REF]) {
		try {
			const resolved = await creds.resolve(ref);
			const value = String((resolved && resolved.value) || '').trim();
			if (value) { return value; }
		} catch {
			/* 试下一个 */
		}
	}
	return '';
}

/** 读回上次注册的节点记录（node_id + node_token）。 */
async function loadStoredNode() {
	const creds = state.credentials;
	if (!creds || typeof creds.resolve !== 'function') { return undefined; }
	try {
		const resolved = await creds.resolve(NODE_CREDENTIAL_REF);
		const raw = String((resolved && resolved.value) || '').trim();
		if (!raw) { return undefined; }
		const parsed = JSON.parse(raw);
		const nodeId = String(parsed.nodeId || parsed.node_id || '');
		const nodeToken = String(parsed.nodeToken || parsed.node_token || '');
		if (!nodeId || !nodeToken) { return undefined; }
		return { id: nodeId, token: nodeToken };
	} catch {
		return undefined;
	}
}

/** 把节点记录写进 dsh 凭据库（重启后自动启动要靠它）。 */
async function saveStoredNode(record) {
	state.localNode = record;
	const creds = state.credentials;
	if (!creds || typeof creds.set !== 'function') { return; }
	try {
		await creds.set(NODE_CREDENTIAL_REF, JSON.stringify({
			nodeId: record.id,
			nodeToken: record.token,
			relayUrl: state.relayUrl,
			savedAt: new Date().toISOString(),
		}));
	} catch (e) {
		console.warn(`[vssaros-relay] 节点令牌落盘失败：${String((e && e.message) || e)}`);
	}
}

/** 建（并在有节点记录时）启动 Node Agent。 */
async function ensureAgent() {
	if (!state.agent) {
		state.agent = createNodeAgent({
			getRelayUrl: () => state.relayUrl,
			// ★ 形状必须是 **{ nodeId, nodeToken }**（agent 那边按这两个字段读）——
			//   本插件内部存的是 `{ id, token }` ⇒ 直接透传会让 agent 永远读到空值
			//   ⇒ 报「本机尚未注册到中转站」⇒ **通道永远连不上**（页面显示「未连接」）✗✗
			getNode: () => ({
				nodeId: String((state.localNode && state.localNode.id) || ''),
				nodeToken: String((state.localNode && state.localNode.token) || ''),
			}),
			getAccessToken: () => cachedAccessToken,
			// ★ 拉目录用 **OAuth token**（专用 ref）⇒ 避免拿到 API Key 导致平台拒答、模型数为 0 ✓
			getCatalogToken: () => cachedCatalogToken,
			/**
			 * ★ 自愈式注册：agent 拿不到节点凭据（跨 plane / 令牌被轮换）时**自己**注册一次。
			 *   这样"节点在线但通道连不上"的死结才能自愈 ✓
			 */
			enroll: async () => {
				const result = await enrollNodeRecord();
				return result.ok && result.record
					? { nodeId: result.record.id, nodeToken: result.record.token }
					: undefined;
			},
			onState: (snapshot) => { state.agentState = snapshot; },
			log: (message) => { console.log(`[vssaros-relay] ${message}`); },
		});
	}
	if (!state.localNode) {
		state.localNode = await loadStoredNode();
	}
	if (state.localNode) {
		state.agent.start();
	}
	return state.agent;
}

/**
 * 把**本机**注册进号池（内部动作）。
 * 返回 `{ ok, record, name, reused, status, error }`；`record` = { id, token }（**只在本进程内用**）。
 */
async function enrollNodeRecord(authorization = '') {
	if (!state.enrollKey) {
		return { ok: false, error: '未配置注册密钥（config.enrollKey）' };
	}
	const name = os.hostname() || 'unknown-host';
	// 本机 CodeBuddy 身份（user_id = JWT 的 sub）—— 只报身份，**不报 token**。
	const accessToken = await readAccessToken();
	const identity = identityOf(accessToken);
	try {
		const res = await fetchWithTimeout(new URL('/api/nodes/auto-enroll', state.relayUrl).toString(), {
			method: 'POST',
			headers: Object.assign(
				{ 'content-type': 'application/json' },
				// ★ 把**页面用户的登录会话**透传给中转站 ⇒ 它认出工号 ⇒ 写进节点 `owner`
				//   （`enroll key` 是机器级凭据，没有用户身份 ⇒ 否则节点无归属 ⇒
				//     普通用户按工号过滤时看不到自己的机器 ✗）
				authorization ? { authorization } : {},
			),
			body: JSON.stringify({
				enroll_key: state.enrollKey,
				node_name: name,
				provider: 'codebuddy',
				identity: {
					hostname: name,
					os: `${os.platform()} ${os.release()}`,
					account: os.userInfo().username,
					agent_version: '0.3.0',
					user_id: identity.userId || '',
					tenant_id: identity.tenantId || '',
				},
				// ⚠ **不要**带 catalog：中转站的 `touch()` 会用提交里的 models **覆盖**节点已有的目录
				//   ⇒ 这里若发 `models: []`，会把已经报上来的模型目录清空 ✗。
				//   模型目录由 **Node Agent 的 `catalog` 帧**上报（走通道，不走注册）。
			}),
		}, CALL_TIMEOUT_MS);
		const text = await res.text();
		if (!res.ok) {
			return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 160)}` };
		}
		let data;
		try { data = JSON.parse(text); } catch { return { ok: false, error: '返回的不是 JSON' }; }
		const record = { id: String(data.node_id || ''), token: String(data.node_token || '') };
		if (!record.id || !record.token) {
			return { ok: false, error: '注册返回缺少 node_id / node_token' };
		}
		await saveStoredNode(record);
		const node = data.node || {};
		return {
			ok: true,
			record,
			name: String(node.name || name),
			status: String(node.status || 'online'),
			reused: !!data.reused,
		};
	} catch (e) {
		return { ok: false, error: String((e && e.message) || e) };
	}
}

/**
 * 页面上那个按钮的动作：注册 + 顺手把反向通道拉起来。
 * ⚠ **不把节点令牌回给页面**（页面只需要"成功/失败 + 节点 id"）✓。
 */
async function enrollLocal(authorization = '') {
	const result = await enrollNodeRecord(authorization);
	if (!result.ok) {
		return { ok: false, error: result.error };
	}
	// 注册成功 ⇒ 立刻把反向通道拉起来（用户点「注册」的语义就是「这台机器接进号池并开始干活」）
	const agent = await ensureAgent();
	agent?.reconnect();
	return {
		ok: true,
		reused: !!result.reused,
		node: { id: result.record.id, name: result.name, status: result.status },
		agent: state.agentState,
	};
}

/**
 * 把**本机**从号池里注销（页面上「🗑 移除注册」的动作）。
 *
 * 认证用**节点自己的令牌**（服务端 `POST /api/nodes/{id}/unregister`）⇒ 不需要管理员 auth-key ✓。
 * 注销后：清掉本机节点记录 + 停掉 Agent 通道 + 清凭据库里的节点令牌
 *   （IDE 侧的 Node Agent 宿主读同一份凭据 ⇒ 也会随之停下 ✓）。
 */
async function unregisterLocal() {
	const hostname = os.hostname() || 'unknown-host';
	// ★ 用**注册密钥 + 主机名**销号（`POST /api/nodes/unregister-self`）：
	//   节点令牌可能只存在于**另一个进程**（IDE 主进程里的 Node Agent 宿主），
	//   这一半拿不到它 ⇒ 用令牌销不了号 ✗ ⇒ enroll key 是机器自带的窄作用域凭据 ⇒ 用它最稳 ✓
	try {
		const res = await fetchWithTimeout(new URL('/api/nodes/unregister-self', state.relayUrl).toString(), {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-enroll-key': state.enrollKey },
			body: JSON.stringify({ hostname }),
		}, CALL_TIMEOUT_MS);
		const text = await res.text();
		if (!res.ok) {
			return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 160)}` };
		}
	} catch (e) {
		return { ok: false, error: String((e && e.message) || e) };
	}
	// 本地收尾：停通道 + 清节点记录 + 清凭据库
	try { state.agent?.stop?.(); } catch { /* ignore */ }
	state.localNode = undefined;
	try {
		const creds = state.credentials;
		if (creds && typeof creds.set === 'function') {
			await creds.set(NODE_CREDENTIAL_REF, '');
		}
	} catch (e) {
		console.warn(`[vssaros-relay] 清节点凭据失败：${String((e && e.message) || e)}`);
	}
	return { ok: true, hostname };
}

/** 给本机节点补一次心跳（保持「在线」，别让号池把它当掉线的节点）。 */
async function heartbeatLocal() {
	const rec = state.localNode;
	if (!rec || !rec.id || !rec.token) { return; }
	try {
		await fetchWithTimeout(new URL(`/api/nodes/${encodeURIComponent(rec.id)}/heartbeat`, state.relayUrl).toString(), {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'authorization': `Bearer ${rec.token}` },
			body: JSON.stringify({}),
		}, 8000);
	} catch {
		/* 心跳失败不影响页面展示 */
	}
}

// ─────────────────────────────────────────────────────────── 额度/积分（CodeBuddy 账号）
//
// ★ 2026-10-28 改为**全自动**（用户要求：不要手动操作）：
//   额度只认 passport 会话 cookie（`.woa.com`，httpOnly），而 dsh Host 是 Node 进程 ⇒
//   读不到 Chrome 的 cookie（App-Bound Encryption，实测 SYSTEM 也解不开）✗
//   ⇒ 改走 **浏览器插件**（`vssaros-browser` 的 `loginSession`）：
//      · `cookies()` 从**浏览器进程里**读已解密的会话 cookie（含 HttpOnly）✓
//      · 没有会话时 `open()` 在**用户可见的真实浏览器**里开登录页（企业 SSO 在这里回执正常；
//        在 Electron 窗口里实测**收不到回执** ⇒ 那条路已废弃）✓
//   ⇒ 用户零手工：平时完全静默；没有会话时自动弹一次浏览器登录（手机确认即可）。

/** 自动刷新间隔（30 分钟）。 */
const QUOTA_REFRESH_MS = 30 * 60 * 1000;

/**
 * 采集额度 ⇒ 更新 `state.quota` ⇒（有节点令牌时）上报中转站。
 *
 * ★ 2026-10-28 改成**全自动**（用户要求：不要手动操作）：
 *   数据来源 = **真实浏览器**里的 woa 会话（`vssaros-browser` 的 `loginSession`）
 *   ⇒ ① 浏览器里已有会话 ⇒ 直接采（零交互）；
 *     ② 没有 ⇒ **自动**在浏览器里打开登录页，等你在手机上确认一次 ⇒ 回来再采。
 *   ⚠ 不再需要 Electron 登录窗（那种上下文里企业 SSO 收不到回执）、也不再需要手动粘 cookie。
 *
 * @param {object} [options]
 * @param {boolean} [options.force] 强制重新采集（忽略节流）
 */
async function syncQuota({ force = false } = {}) {
	const service = browserService;
	if (!service || !service.loginSession) {
		state.quotaError = '需要浏览器插件（@vssaros/dsh-browser）才能采集额度 —— 请在「内置插件」里启用它';
		return { ok: false, error: state.quotaError };
	}
	const log = (line) => console.log(`[vssaros-relay] ${line}`);

	let outcome = await collectQuotaViaBrowser(service, { log });
	if (outcome.needsLogin) {
		// ★ 自动登录：打开**真实浏览器**的登录页（企业 SSO 在这里回执正常）
		try {
			await loginInBrowser(service, { log });
			outcome = await collectQuotaViaBrowser(service, { log });
		} catch (e) {
			state.quotaError = String((e && e.message) || e);
			state.quotaUpdatedAt = Date.now();
			return { ok: false, error: state.quotaError };
		}
	}
	const quota = outcome.quota || {};
	state.quota = quota;
	state.quotaError = outcome.ok ? '' : String(outcome.error || '采集失败');
	state.quotaUpdatedAt = Date.now();

	// 上报中转站（**只上报数字，绝不上报 cookie**）
	const nodeId = state.localNode?.id || '';
	if (nodeId && state.quotaError !== '还没到采集时间') {
		try {
			await fetchWithTimeout(new URL('/api/nodes/quota', state.relayUrl).toString(), {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-enroll-key': state.enrollKey },
				body: JSON.stringify(toReportPayload(quota, nodeId)),
			}, CALL_TIMEOUT_MS);
		} catch (e) {
			console.warn(`[vssaros-relay] 上报额度失败：${String((e && e.message) || e)}`);
		}
	}
	return quota;
}

/**
 * 启动定时刷新（每 30 分钟一次；首次宿主就绪后很快试一次）。
 *
 * ⚠ 全自动 ⇒ 首次若浏览器里没有会话，会**自动**弹出浏览器登录页（这是唯一一次交互，
 *   之后 cookie 长期有效）；过期时同样自动重来一次 ✓
 */
function startQuotaTimer() {
	if (state.quotaTimer) { return; }
	state.quotaTimer = setInterval(() => {
		void syncQuota().catch(() => { /* 定时任务不抛 */ });
	}, QUOTA_REFRESH_MS);
	state.quotaTimer.unref?.();
	// 首次：宿主就绪后**稍晚**试一次。
	//
	// ★★ 2026-10-29（真机：打包版 Host 首启慢 18 秒）：原来这个首次采集排在 **+5s**，
	//   而它要经 CDP 驱动**专属 Chrome**（冷启动 ⇒ 实测 18 秒）⇒ 采集结束的刻度正好
	//   撞上 Host ready（`host-52014a34.log`：quota 那行在 host uptime 24.8s，
	//   `[vssaros-bridge] apply` 也在 24.8s）⇒ **Host 就绪被额度采集挡住了 18 秒** ✗✗。
	//   ⇒ ① 推迟到 +20s（Host 早已就绪）；② `readWoaCookies` 本身加了 5s 硬超时
	//   （`quotaBrowser.js`）⇒ 两者叠加 ⇒ 额度采集**再也不可能**拖住启动 ✓。
	setTimeout(() => { void syncQuota().catch(() => { /* ignore */ }); }, 20_000).unref?.();
}

export function apply(ctx) {
	// ★ 通道"半开"自愈（2026-10-28）。
	//
	// 现象：服务端把这条通道摘掉（踢下线 / 超时清理 / 服务重启）后，
	//   **客户端收不到 close**（只收到 error，甚至什么都没收到）
	//   ⇒ 本地 `state=connected`（socket 半开，写入不报错）
	//   ⇒ 但中转站 registry 里已经没有它 ⇒ 页面显示「未连接」（这是**服务端事实** ✓）
	//   ⇒ 中转站派活发不到 ⇒ 调用 502；执行日志里也没有 `channel_close` ⇒ 查不到原因 ✗✗
	//
	// ⇒ **纯客户端**自愈：每 60 秒问一次中转站「我这条通道还在吗」
	//   （号池摘要里的 `channel_connected` 是唯一真实来源）⇒ 不在 ⇒ 强制 `agent.reconnect()` ✓
	//   （不依赖服务端改动 —— 远端 `/data/chatgpt2api` 的改动会被回滚 ⇒ 客户端自愈更可靠）
	const verifyChannel = async () => {
		const agent = state.agent;
		if (!agent) { return; }
		let localState = '';
		try { localState = String((agent.status && agent.status().state) || ''); } catch { /* ignore */ }
		if (localState !== 'connected') { return; }
		try {
			const pool = await listNodes();
			const local = (pool.nodes || []).find((node) => node.isLocal);
			if (local && local.channelConnected === false) {
				console.warn('[vssaros-relay] 中转站已无本机通道（本地 socket 半开）⇒ 强制重连');
				agent.reconnect();
			}
		} catch {
			/* 中转站暂时不可达：等下一轮，别乱重连 */
		}
	};
	// ⚠ `apply()` 可能被重复调用（热重载）⇒ 先清掉上一个定时器，别越堆越多 ✓
	if (state.channelWatch) { clearInterval(state.channelWatch); }
	state.channelWatch = setInterval(() => { void verifyChannel(); }, 60_000);
	state.channelWatch.unref?.();
	// ★ 浏览器插件（**可选**依赖）：额度采集靠它读**真实浏览器**里的 woa 会话 ⇒ 全自动、零手工。
	//   （与 vssaros-bridge 的 LightAI 同一套接法：动态 inject，缺席时如实说明，不影响其它功能。）
	try {
		ctx.inject?.(['vssarosBrowser'], scope => {
			browserService = scope.vssarosBrowser;
			startQuotaTimer();
			return () => { browserService = undefined; };
		});
	} catch { /* 老运行时没有动态 inject ⇒ 额度采集时报"需要浏览器插件" */ }
	// ★ 凭据服务（**可选**）：拿到它才能
	//   ① 读本机 CodeBuddy 登录态（`VSSAROS_CODEBUDDY_KEY`，与 vssaros-bridge 同一份）；
	//   ② 持久化本机节点令牌（`VSSAROS_RELAY_NODE`）⇒ 重启后能自动启动。
	//   服务不在时插件照常起，只是「自动启动」退化成「每次手动注册」。
	ctx.inject?.(['credentials'], child => child.effect(() => {
		state.credentials = child.credentials;
		// ★ 有了凭据服务就能定时刷新「额度/积分」（浏览器侧的 woa 会话）。
		startQuotaTimer();
		// ★ CodeBuddy token 进**同步缓存**（agent 的 getter 是同步的 ⇒ 必须有缓存，见上方注释）。
		const refreshTokens = async () => {
			try {
				const ok = await refreshCodebuddyTokens();
				if (ok) {
					// token 刚拿到/刚换过 ⇒ 让 agent 立刻重拉目录（否则要等 5 分钟 TTL）✓
					void state.agent?.refreshCatalog?.();
				}
				return ok;
			} catch {
				return false;
			}
		};
		void refreshTokens();
		// 定时刷新（token 会轮换/过期 ⇒ 2 分钟一次足够）
		const tokenTimer = setInterval(() => { void refreshTokens(); }, 2 * 60 * 1000);
		tokenTimer.unref?.();
		// ★ 2026-10-28：**启动即自动连通道**（这是"每次重启都 offline"的根治点）。
		//   之前这里受 `agentEnabled=false` 挡住（当时 Agent 在主进程那份）⇒ 主进程已删
		//   ⇒ 若仍不自动起，就**没有任何实例**去连 ⇒ 页面永远「未连接 / offline」✗
		//   `ensureAgent()` 内部只在**有节点记录**时才 start ⇒ 未注册的机器不会乱连 ✓
		if (state.agentEnabled) {
			void (async () => {
				await ensureAgent();
				// ★ Agent 建好后**再刷一次** token 缓存并立刻重拉目录
				//   （否则首次拉目录时缓存可能还是空的 ⇒ 目录要等下一轮定时刷新才有 ⇒ 慢 2 分钟）✓
				await refreshTokens();
				void state.agent?.refreshCatalog?.();
			})().catch((e) => {
				console.warn(`[vssaros-relay] 自动启动 Agent 失败：${String((e && e.message) || e)}`);
			});
		}
		return () => {
			clearInterval(tokenTimer);
			state.agent?.stop();
			state.agent = undefined;
		};
	}));

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
			if (url.pathname === ROUTE_PREFIX + '/api/ping') {
				const payload = await ping();
				res.writeHead(200, {
					'content-type': 'application/json; charset=utf-8',
					'cache-control': 'no-store',
				});
				res.end(JSON.stringify(payload));
				return;
			}
			// 号池（节点池）列表：页面上的表格。
			if (url.pathname === ROUTE_PREFIX + '/api/nodes') {
				await heartbeatLocal();
				const payload = await listNodes();
				res.writeHead(200, {
					'content-type': 'application/json; charset=utf-8',
					'cache-control': 'no-store',
				});
				res.end(JSON.stringify(payload));
				return;
			}
			// 「注册本机到号池」按钮：点一下 ⇒ 本机成为中转站的一个节点，
			// 并且**顺手把反向通道（Node Agent）拉起来**。
			if (url.pathname === ROUTE_PREFIX + '/api/enroll') {
				// ★ 页面把**当前用户会话**放在 `Authorization` 里传进来 ⇒ 透传给中转站 ⇒
				//   注册出来的节点 `owner = 该工号`（否则节点无归属，普通用户看不到自己的机器）
				const payload = await enrollLocal(String(req.headers.authorization || ''));
				res.writeHead(200, {
					'content-type': 'application/json; charset=utf-8',
					'cache-control': 'no-store',
				});
				res.end(JSON.stringify(payload));
				return;
			}
			// Node Agent **执行日志**（页面「执行日志」面板）：本机 agent 每次 invoke 的开始/结束。
			if (url.pathname === ROUTE_PREFIX + '/api/agent/logs') {
				const agent = state.agent;
				const payload = {
					ok: true,
					entries: agent ? agent.execLog() : [],
					agent: state.agentState,
					node: state.localNode ? { id: state.localNode.id, registered: true } : { registered: false },
				};
				res.writeHead(200, {
					'content-type': 'application/json; charset=utf-8',
					'cache-control': 'no-store',
				});
				res.end(JSON.stringify(payload));
				return;
			}
			// 「🗑 移除注册」：把**本机**从号池里注销（节点自己带着令牌去销号 ⇒ 不需要管理员密钥）✓
			if (url.pathname === ROUTE_PREFIX + '/api/unregister') {
				const payload = await unregisterLocal();
				res.writeHead(200, {
					'content-type': 'application/json; charset=utf-8',
					'cache-control': 'no-store',
				});
				res.end(JSON.stringify(payload));
				return;
			}
			// 「↻ 重连通道」：**只**重连反向通道，**不重新注册** ⇒ 不轮换节点令牌 ⇒ 不会踢断正在跑的通道 ✓
			if (url.pathname === ROUTE_PREFIX + '/api/agent/reconnect') {
				try {
					state.agent?.reconnect?.();
				} catch (e) {
					console.warn(`[vssaros-relay] 重连通道失败：${String((e && e.message) || e)}`);
				}
				res.writeHead(200, {
					'content-type': 'application/json; charset=utf-8',
					'cache-control': 'no-store',
				});
				res.end(JSON.stringify({ ok: true, agent: state.agentState }));
				return;
			}
			// 清空执行日志（页面上的「清空」按钮）。
			if (url.pathname === ROUTE_PREFIX + '/api/agent/logs/clear') {
				state.agent?.clearExecLog?.();
				res.writeHead(200, {
					'content-type': 'application/json; charset=utf-8',
					'cache-control': 'no-store',
				});
				res.end(JSON.stringify({ ok: true }));
				return;
			}
			// Node Agent 状态（页面上的那一行：通道是否连着、在途几个请求、上报了几个模型）。
			// ★ 2026-10-28：**主进程侧那份 Agent 宿主已删除**（用户要求「仅保留插件里的 dsh Host 侧」）
			//   ⇒ Agent 就跑在**这个 dsh Host 进程**里 ⇒ 它的内部状态**直接可读** ✓
			// ★ **Tokens 用量（中转站侧快照）** —— 已不是页面的数据源。
			//   页面改用 `/api/quota`（Host 本地采集，见 lib/quota.js）；这里保留给"从号池看某台机器的额度"用。
			if (url.pathname === ROUTE_PREFIX + '/api/quota/account') {
				let payload;
				try {
					const pool = await listNodes();
					const local = (pool.nodes || []).find((n) => n.isLocal) || null;
					const quota = (local && local.quota) || null;
					payload = {
						ok: !!(quota && !quota.error),
						quota,
						node: local ? { id: local.id, name: local.name, registered: true } : { registered: false },
						hint: quota
							? ''
							: '中转站还没有这台机器的额度快照（Host 侧采集成功后会自动上报）',
					};
				} catch (e) {
					payload = { ok: false, quota: null, error: String((e && e.message) || e), hint: '' };
				}
				res.writeHead(200, {
					'content-type': 'application/json; charset=utf-8',
					'cache-control': 'no-store',
				});
				res.end(JSON.stringify(payload));
				return;
			}

			// ★ **额度/积分**（CodeBuddy 账号）：采集结果（页面显示用）
			if (url.pathname === ROUTE_PREFIX + '/api/quota') {
				// 会话状态：**浏览器**里有没有 woa 会话（只回 cookie **名字**，不回值 ✓）
				let names = [];
				let hasCookie = false;
				if (browserService?.loginSession) {
					try {
						const cookies = await readWoaCookies(browserService);
						names = cookies.names;
						hasCookie = !!cookies.cookie;
					} catch { /* ignore */ }
				}
				const payload = {
					ok: true,
					quota: state.quota || null,
					error: state.quotaError || '',
					updated_at: state.quotaUpdatedAt ? new Date(state.quotaUpdatedAt).toISOString() : null,
					has_cookie: hasCookie,
					browser_available: !!browserService?.loginSession,
					cookie_names: names,
					node: state.localNode ? { id: state.localNode.id, registered: true } : { registered: false },
				};
				res.writeHead(200, {
					'content-type': 'application/json; charset=utf-8',
					'cache-control': 'no-store',
				});
				res.end(JSON.stringify(payload));
				return;
			}

			// ★ **在浏览器里登录**：`POST /api/quota/login`
			//   ⇒ 用浏览器插件（`vssaros-browser` 的 loginSession）在**用户可见的真实浏览器**里
			//     打开 token.woa.com 登录页（企业 SSO 在真实浏览器里回执正常；在 Electron 窗口里
			//     实测收不到回执 ⇒ 那条路已废弃）⇒ 登录成功即采集。
			//   ⇒ **零手工**：不需要复制 cookie、不需要粘贴。
			if (url.pathname === ROUTE_PREFIX + '/api/quota/login') {
				let outcome;
				try {
					// ★ 2026-10-30（用户要求）：手动点「浏览器登录」⇒ **必须弹出有头浏览器**
					//   （显式先切有头，再由 loginInBrowser 打开登录页；登录完自动切回无头 ⇒ 只打扰这一次）✓
					await browserService?.loginSession?.ensureHeaded?.();
					await loginInBrowser(browserService, {
						log: line => console.log(`[vssaros-relay] ${line}`),
					});
					outcome = await syncQuota();
				} catch (e) {
					outcome = { ok: false, error: String((e && e.message) || e) };
				}
				res.writeHead(outcome?.ok ? 200 : 400, {
					'content-type': 'application/json; charset=utf-8',
					'cache-control': 'no-store',
				});
				res.end(JSON.stringify({ ok: !!outcome?.ok, quota: outcome, error: outcome?.error || state.quotaError || '' }));
				return;
			}

			// ★ **同步额度**：`POST /api/quota/sync`（**已不需要 body 里的 cookie**）
			//   ⇒ 现在一律走浏览器会话（自动）；保留这个路由只为兼容旧页面。
			if (url.pathname === ROUTE_PREFIX + '/api/quota/sync') {
				let raw = '';
				try {
					for await (const chunk of req) { raw += chunk; }
				} catch {
					raw = '';
				}
				let outcome;
				try {
					outcome = await syncQuota();
				} catch (e) {
					outcome = { ok: false, error: String((e && e.message) || e) };
				}
				res.writeHead(outcome?.ok ? 200 : 400, {
					'content-type': 'application/json; charset=utf-8',
					'cache-control': 'no-store',
				});
				res.end(JSON.stringify({ ok: !!outcome?.ok, quota: outcome, error: outcome?.error || '' }));
				return;
			}

			//   （通道是否真连着仍以中转站 `channel_connected` 为准 —— 那是唯一真实来源 ✓）。
			if (url.pathname === ROUTE_PREFIX + '/api/agent') {
				const pool = await listNodes();
				const local = (pool.nodes || []).find((n) => n.isLocal) || null;
				// ① Agent 自己的状态（直读内部，不经 onState 回调）
				const live = state.agent && typeof state.agent.status === 'function' ? state.agent.status() : undefined;
				// ② 通道以中转站为准（Agent 视角可能滞后一拍）
				const channelConnected = !!(local && local.channelConnected);
				const payload = {
					ok: true,
					agent: live
						? Object.assign({}, live, {
							state: channelConnected ? 'connected' : live.state,
							models: channelConnected || live.models ? (local ? Number(local.models || live.models || 0) : live.models) : live.models,
						})
						: {
							state: channelConnected ? 'connected' : 'idle',
							error: '',
							inflight: 0,
							models: local ? Number(local.models || 0) : 0,
						},
					// ★ 诊断：token 指纹（可与 `.credentials.yaml` 那份对账）⇒ 模型数为 0 时能立刻定位
					agentLive: live,
					pid: process.pid,
					node: state.localNode
						? { id: state.localNode.id, registered: true }
						: { registered: false },
				};
				res.writeHead(200, {
					'content-type': 'application/json; charset=utf-8',
					'cache-control': 'no-store',
				});
				res.end(JSON.stringify(payload));
				return;
			}
			if (url.pathname !== ROUTE_PREFIX && url.pathname !== ROUTE_PREFIX + '/') {
				res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
				res.end('not found');
				return;
			}
			let html;
			try {
				const render = await loadPageRender();
				html = render({ relayUrl: state.relayUrl });
			} catch (e) {
				html = renderPage({ relayUrl: state.relayUrl });
			}
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
			});
			res.end(html);
		},
	}), 'vssaros-relay: page route'));
}
