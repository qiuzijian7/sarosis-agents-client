// Node Agent —— 跑在**用户机器**上的反向通道客户端
//
// 它是中转站「节点」在客户端这一侧的化身：
//   · 主动外连中转站的 WebSocket（`/api/nodes/{node_id}/channel`）—— 中转站不需要入站到内网机器；
//   · 上报本机 CodeBuddy 模型目录；
//   · 收到中转站下发的 `invoke` ⇒ 用**本机**的 CodeBuddy 登录态调上游 → 把 SSE 分片回传。
//
// 安全边界（与中转站侧 Python 版 Node Agent 一致）：
//   · **凭据永不出机器**：token 只在本机内存里用，不回传给中转站；
//   · **反跳板红线**：只打 CodeBuddy 官方上游（`copilot.tencent.com`），
//     中转站下发的只是 OpenAI 形态 body，不含 URL；
//   · 身份头一律**本地构造**，不透传中转站下发的 header。
//
// ⚠ WebSocket 的浏览器 API **不能自定义请求头** ⇒ 节点令牌走 `?token=` query
//   （中转站侧 `api/nodes.py` 的 `_extract_ws_token` 同时支持 header 与 query）。

import os from 'os';
import { CODEBUDDY_DEFAULT_ENDPOINT, decodeJwtPayload, listModels, streamChat, tokenFingerprint } from './codebuddy.js';

/**
 * token 的**声明**（不含任何秘密）⇒ 诊断用：
 * 能一眼看出「这是谁的凭据 / 过期了吗 / 是不是另一种 token（API Key 而非 OAuth）」✓
 */
function tokenClaims(token) {
	const jwt = decodeJwtPayload(String(token ?? ''));
	if (!jwt || typeof jwt !== 'object') { return undefined; }
	const out = {};
	for (const key of ['iss', 'sub', 'aud', 'exp', 'azp', 'typ', 'scope', 'preferred_username']) {
		if (jwt[key] !== undefined && jwt[key] !== null) { out[key] = String(jwt[key]); }
	}
	return Object.keys(out).length ? out : undefined;
}

const FRAME_HELLO = 'hello';
const FRAME_HEARTBEAT = 'heartbeat';
const FRAME_CATALOG = 'catalog';
const FRAME_INVOKE = 'invoke';
const FRAME_CHUNK = 'chunk';
const FRAME_INVOKE_END = 'invoke_end';
const FRAME_INVOKE_ACK = 'invoke_ack';
const FRAME_PING = 'ping';

/** 重连退避（毫秒）。 */
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 20000, 30000];
/** 心跳间隔（毫秒）—— 中转站 60s 没心跳就把节点标离线。 */
const HEARTBEAT_INTERVAL_MS = 15000;
/** 目录缓存时长（毫秒）—— 上游目录变化不频繁，别每次 invoke 都拉。 */
const CATALOG_TTL_MS = 300_000;
/** 执行日志保留条数（环形缓冲；页面「执行日志」面板读它）。 */
const EXEC_LOG_MAX = 200;

export const AGENT_STATE = {
	IDLE: 'idle',
	CONNECTING: 'connecting',
	CONNECTED: 'connected',
	STOPPED: 'stopped',
	ERROR: 'error',
};

/**
 * 反向通道的 URL。
 *
 * ⚠ 令牌只能走 **query**（`?token=`）：浏览器的 WebSocket API **不能自定义请求头**，
 * 而中转站侧 `api/nodes.py` 的 `_extract_ws_token` 同时支持 header 与 query ✓。
 */
export function buildChannelUrl(relayUrl, nodeId, nodeToken) {
	const base = String(relayUrl || '').trim().replace(/\/+$/, '');
	const scheme = base.startsWith('https://') ? 'wss://' : 'ws://';
	const trimmed = base.replace(/^https?:\/\//i, '');
	return `${scheme}${trimmed}/api/nodes/${encodeURIComponent(nodeId || '')}/channel?token=${encodeURIComponent(nodeToken || '')}`;
}

/**
 * 建一个 Node Agent。
 *
 * @param {object} deps
 * @param {() => string} deps.getRelayUrl     中转站地址
 * @param {() => {nodeId:string, nodeToken:string}} deps.getNode  本机节点凭据
 * @param {() => string} deps.getAccessToken  本机 CodeBuddy access token（**只在内存里用**）
 * @param {object} [deps.log]
 * @param {(state:object) => void} [deps.onState] 状态变化回调（页面用）
 * @param {string} [deps.codebuddyEndpoint]
 * @param {Function} [deps.listModelsImpl]  目录拉取（默认真实现；测试注入假实现）
 * @param {Function} [deps.streamChatImpl]  聊天流（默认真实现；测试注入假实现）
 */
export function createNodeAgent(deps) {
	const {
		getRelayUrl,
		getNode,
		getAccessToken,
		/**
		 * 拉**模型目录**用的 token（默认 = `getAccessToken`）。
		 * ★ 目录接口 `/v3/config` 只认 **OAuth access token**（JWT）⇒ 若拿到的是 API Key，
		 *   平台会回 `code:12403 check ua…` ⇒ 表现为"模型数 0"⇒ 故允许单独给一份 OAuth token ✓
		 */
		getCatalogToken,
		log = () => { },
		onState = () => { },
		codebuddyEndpoint = CODEBUDDY_DEFAULT_ENDPOINT,
		listModelsImpl = listModels,
		streamChatImpl = streamChat,
		/**
		 * **自愈式注册**：返回 `{ nodeId, nodeToken }`（本机在号池里的长期凭据）。
		 * 没有它时，agent 只能靠外部把节点记录喂进来 ⇒ 跨 plane 取不到就永远连不上 ✗。
		 */
		enroll = undefined,
	} = deps;

	let socket = null;
	let state = AGENT_STATE.IDLE;
	let lastError = '';
	let reconnectAttempt = 0;
	let reconnectTimer = null;
	let heartbeatTimer = null;
	let stopped = true;
	let catalogCache = null;
	let catalogFetchedAt = 0;
	/**
	 * 「拉模型目录失败的原因」（闭包级状态；页面诊断用）。
	 *
	 * ⚠ **必须声明**：它在 `reportCatalog()` 里被**赋值**、在 `publish()` 里被**读取**，
	 *   而 `publish()` 会在**任何**状态变化时触发（含 Agent 刚启动那一次）
	 *   ⇒ 一旦没声明 ⇒ 启动即抛 `ReferenceError: catalogError is not defined`
	 *   ⇒ **通道永远连不上**（线上表现：节点「在线」但「通道未连接」⇒ 调用 502）✗✗
	 */
	let catalogError = '';
	/** 下一次 connect() 必须**重新注册**（令牌被中转站轮换/作废后的自愈开关）。 */
	let forceEnroll = false;

	/**
	 * 自愈式注册：向中转站要一份本机节点凭据（`nodeId` + `nodeToken`）。
	 * 失败返回 undefined（调用方据此继续"等下一次重试"）。
	 */
	const enrollNode = async () => {
		if (typeof enroll !== 'function') { return undefined; }
		try {
			const rec = await enroll();
			const nodeId = String((rec && (rec.nodeId || rec.id)) || '');
			const nodeToken = String((rec && (rec.nodeToken || rec.token)) || '');
			if (!nodeId || !nodeToken) { return undefined; }
			pushExec({ kind: 'enroll', nodeId });
			return { nodeId, nodeToken };
		} catch (e) {
			pushExec({ kind: 'enroll_error', error: String((e && e.message) || e) });
			return undefined;
		}
	};
	/** 正在处理的 invoke 计数（页面显示用）。 */
	let inflight = 0;
	/**
	 * **执行日志**（环形缓冲）：每次 invoke 的开始/结束，以及通道生命周期。
	 * 页面「执行日志」面板读它 ⇒ 用户能看见"这台 agent node 刚干了什么"。
	 */
	const execLog = [];
	const pushExec = (entry) => {
		const row = Object.assign({ ts: new Date().toISOString() }, entry);
		execLog.push(row);
		while (execLog.length > EXEC_LOG_MAX) { execLog.shift(); }
		return row;
	};

	const publish = () => {
		onState({
			state,
			error: lastError,
			inflight,
			connectedAt: connectedAt || 0,
			// ★ 诊断字段：页面「Agent 节点」面板据此说明"为什么这台机器还没上报模型目录"
			//   （hasToken=false ⇒ 本机取不到 CodeBuddy 登录态；catalogError ⇒ 拉目录失败的原因）✓
			models: (catalogCache && catalogCache.models) ? catalogCache.models.length : 0,
			hasToken: !!String(getAccessToken() || '').trim(),
			// ★ token 指纹（只用于对账，不是凭据）⇒ 与磁盘 `.credentials.yaml` 那份对比，
			//   能一眼看出"Host 用的 token 是不是同一份"（目录拉不到时的第一嫌疑）✓
			tokenFingerprint: tokenFingerprint(String(getAccessToken() || '')),
			// ★ token 的**声明**（iss/sub/exp/aud —— 不含任何秘密）⇒ 能直接看出
			//   「这是谁的凭据 / 是不是已过期 / 是不是另一种 token（API Key 而非 OAuth）」✓
			tokenClaims: tokenClaims(String(getAccessToken() || '')),
			catalogError: catalogError || '',
		});
	};

	let connectedAt = 0;

	const setState = (next, error = '') => {
		state = next;
		lastError = error;
		publish();
	};

	const wsUrl = () => {
		const node = getNode() || {};
		// 两种形状都认（见 connect() 里的说明）⇒ 形状不一致时 URL 里也不会带上空 id/token ✗
		const nodeId = String(node.nodeId || node.id || '');
		const nodeToken = String(node.nodeToken || node.token || '');
		return buildChannelUrl(getRelayUrl(), nodeId, nodeToken);
	};

	const send = (type, payload) => {
		if (!socket || socket.readyState !== 1) { return false; }
		try {
			socket.send(JSON.stringify({ t: type, v: payload ?? {} }));
			return true;
		} catch (e) {
			log(`发送 ${type} 失败：${String((e && e.message) || e)}`);
			return false;
		}
	};

	/** 取本机模型目录（带缓存）。 */
	const fetchCatalog = async () => {
		const now = Date.now();
		if (catalogCache && now - catalogFetchedAt < CATALOG_TTL_MS) { return catalogCache; }
		// ★ 目录用 **OAuth token**（`getCatalogToken`，默认回落到 `getAccessToken`）
		//   ⇒ `/v3/config` 只认 OAuth token；给它 API Key 会被平台拒答（code:12403）⇒ 模型数 0 ✗
		const token = String((getCatalogToken ? getCatalogToken() : getAccessToken()) || '').trim();
		if (!token) {
			catalogCache = { ok: false, models: [], model_meta: {}, error: 'no_credential', message: '本机还没有 CodeBuddy 登录态' };
			catalogFetchedAt = now;
			return catalogCache;
		}
		catalogCache = await listModelsImpl(token, { endpoint: codebuddyEndpoint });
		catalogFetchedAt = now;
		return catalogCache;
	};

	const reportCatalog = async () => {
		let catalog;
		try {
			catalog = await fetchCatalog();
		} catch (e) {
			// 拉目录直接抛了（例如下游 client 抛错）⇒ 记进执行日志，别让"模型数 0"变成无解释的黑洞 ✗
			catalogError = String((e && e.message) || e);
			pushExec({ kind: 'catalog_error', error: catalogError });
			publish();
			return { models: [], model_meta: {}, error: catalogError };
		}
		catalogError = String((catalog && catalog.error) || '');
		if (catalogError) {
			pushExec({ kind: 'catalog_error', error: catalogError });
		}
		send(FRAME_CATALOG, {
			models: catalog.models || [],
			model_meta: catalog.model_meta || {},
			error: catalog.error || '',
		});
		publish();
		return catalog;
	};

	/** 处理一次 `invoke`：调上游 → 回传分片。 */
	const handleInvoke = async (payload) => {
		const requestId = String((payload && payload.request_id) || '');
		const method = String((payload && payload.method) || 'chat.completions');
		const body = (payload && payload.body && typeof payload.body === 'object') ? payload.body : {};
		send(FRAME_INVOKE_ACK, { request_id: requestId, ok: true });
		if (method !== 'chat.completions') {
			send(FRAME_INVOKE_END, { request_id: requestId, status: 'error', error: `不支持的方法：${method}` });
			pushExec({ kind: 'invoke_error', requestId, method, status: 'error', error: `不支持的方法：${method}` });
			return;
		}
		const token = String(getAccessToken() || '').trim();
		if (!token) {
			send(FRAME_INVOKE_END, { request_id: requestId, status: 'error', error: '本机没有 CodeBuddy 登录态' });
			pushExec({ kind: 'invoke_error', requestId, method, status: 'error', error: '本机没有 CodeBuddy 登录态' });
			return;
		}
		inflight += 1;
		publish();
		let seq = 0;
		const startedAt = Date.now();
		const modelId = String(body.model || '');
		pushExec({ kind: 'invoke_start', requestId, method, model: modelId });
		try {
			const catalog = await fetchCatalog();
			const vendor = String(body.vendor || (catalog.model_meta?.[modelId]?.vendor) || '');
			for await (const data of streamChatImpl(token, body, { modelId, vendor, endpoint: codebuddyEndpoint })) {
				if (!send(FRAME_CHUNK, { request_id: requestId, seq: seq++, data })) { break; }
			}
			send(FRAME_INVOKE_END, { request_id: requestId, status: 'ok' });
			pushExec({ kind: 'invoke_done', requestId, model: modelId, chunks: seq, ms: Date.now() - startedAt, status: 'ok' });
		} catch (e) {
			const message = String((e && e.message) || e);
			send(FRAME_INVOKE_END, {
				request_id: requestId,
				status: 'error',
				error: message,
			});
			pushExec({ kind: 'invoke_error', requestId, model: modelId, chunks: seq, ms: Date.now() - startedAt, status: 'error', error: message });
		} finally {
			inflight -= 1;
			publish();
		}
	};

	const clearTimers = () => {
		if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
		if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
	};

	const scheduleReconnect = () => {
		if (stopped) { return; }
		// 幂等：onerror 与 onclose 可能**都**触发 ⇒ 别排两个定时器
		//（否则重连频率翻倍，且两个定时器都会去 connect）。
		if (reconnectTimer) { return; }
		const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
		reconnectAttempt += 1;
		log(`${delay / 1000}s 后重连中转站…`);
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			// 定时器回调里抛异常 ⇒ **整个进程退出** ⇒ 通道永久失联。
			// ⇒ 兜住并继续重连。
			try {
				connect();
			} catch (e) {
				log(`重连异常：${String((e && e.message) || e)}`);
				scheduleReconnect();
			}
		}, delay);
	};

	const connect = async () => {
		if (stopped) { return; }
		const node = getNode() || {};
		// ⚠ 两种形状都认：`{nodeId,nodeToken}`（标准形状）与 `{id,token}`（旧形状）。
		//   形状对不上时 `node.nodeId` 恒为空 ⇒ 一路判「本机尚未注册」⇒ **通道永远连不上**（踩过）✗
		let nodeId = String(node.nodeId || node.id || '');
		let nodeToken = String(node.nodeToken || node.token || '');
		// ★ **自愈式注册**：没有节点记录（或令牌已被中转站轮换作废）⇒ **自己**注册一次拿长期令牌。
		//   为何要自己注册：节点令牌只存在「另一个 plane 的凭据库」里 ⇒ 跨 plane 取不到 / 被轮换后就是废的
		//   ⇒ 表现为「节点在线、但通道永远连不上」✗（2026-10-28 实测踩过）。
		//   auto-enroll 是**同机幂等**的（复用同一个节点、只轮换令牌）⇒ 自己注册不会堆出重复节点 ✓
		if (!nodeId || !nodeToken || forceEnroll) {
			forceEnroll = false;
			const fresh = await enrollNode();
			if (!fresh) {
				setState(AGENT_STATE.IDLE, '本机尚未注册到中转站');
				// 别就此躺平：每 5 秒安静地再试一次 ⇒ 用户点完「注册本机到号池」后通道会自己连上 ✓
				if (!reconnectTimer) {
					reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(); }, 5000);
				}
				return;
			}
			nodeId = fresh.nodeId;
			nodeToken = fresh.nodeToken;
		}
		if (socket && (socket.readyState === 0 || socket.readyState === 1)) { return; }
		setState(AGENT_STATE.CONNECTING);
		let ws;
		try {
			ws = new WebSocket(buildChannelUrl(getRelayUrl(), nodeId, nodeToken));
		} catch (e) {
			setState(AGENT_STATE.ERROR, String((e && e.message) || e));
			scheduleReconnect();
			return;
		}
		socket = ws;
		ws.onopen = () => {
			reconnectAttempt = 0;
			connectedAt = Date.now();
			setState(AGENT_STATE.CONNECTED);
			pushExec({ kind: 'channel_open', nodeId: nodeId });
			const { nodeId: helloNodeId } = getNode() || {};
			send(FRAME_HELLO, {
				agent_version: 'vssaros-relay/0.3.0',
				// ⚠ 报**真实主机名**，不是 node_id：中转站那边会用它覆盖节点身份的 hostname ⇒
				//   报 node_id 会把 hostname 变成 "nd_xxx" ⇒ ① 号池看不出是哪台机器
				//   ② `same_machine` 判不出同机 ⇒ 重复注册会**多出一个节点** ✗✗
				hostname: os.hostname() || helloNodeId || '',
				os: `${process.platform} ${process.release?.name || ''}`,
			});
			void reportCatalog();
			heartbeatTimer = setInterval(() => { send(FRAME_HEARTBEAT, { ts: Date.now() }); }, HEARTBEAT_INTERVAL_MS);
		};
		ws.onmessage = (event) => {
			let frame;
			try { frame = JSON.parse(String(event.data ?? '')); } catch { return; }
			if (!frame || typeof frame !== 'object') { return; }
			const type = String(frame.t || '');
			const payload = (frame.v && typeof frame.v === 'object') ? frame.v : {};
			if (type === FRAME_PING) { return; }
			if (type === FRAME_INVOKE) { void handleInvoke(payload); return; }
			if (type === 'refresh_catalog') { void reportCatalog(); }
		};
		ws.onerror = () => {
			lastError = 'WebSocket 连接出错';
			publish();
			// ★ 握手失败最常见的原因是**令牌被中转站轮换作废**（每次 auto-enroll 都会轮换）
			//   ⇒ 下一次重连前**强制重新注册**一次，拿新的长期令牌 ⇒ 通道能自愈 ✓
			//   （否则：节点在线、通道永远连不上、调用 502 ✗）
			forceEnroll = true;
			// ★ `onerror` 之后**不保证**会跟一个 `onclose`（Node 的 WebSocket 实现
			//   在握手失败时可能只报 error）⇒ 这里也安排一次重连，
			//   否则「重连一次失败就再也没人重试」⇒ 通道永久断开。
			scheduleReconnect();
		};
		ws.onclose = (event) => {
			clearTimers();
			socket = null;
			if (stopped) { setState(AGENT_STATE.STOPPED); return; }
			// 4401 = 节点令牌无效（中转站重启/令牌轮换）⇒ 交给上层重新注册
			const reason = String((event && (event.reason || event.code)) || '');
			setState(AGENT_STATE.ERROR, reason ? `通道断开：${reason}` : '通道断开');
			pushExec({ kind: 'channel_close', reason: reason || '通道断开' });
			scheduleReconnect();
		};
	};

	return {
		/** 启动（幂等）。 */
		start() {
			if (!stopped) { return; }
			stopped = false;
			connect();
		},
		/** 停止并断开。 */
		stop() {
			stopped = true;
			clearTimers();
			if (socket) {
				try { socket.close(); } catch { /* ignore */ }
				socket = null;
			}
			setState(AGENT_STATE.STOPPED);
		},
		/** 状态快照（页面显示用）。 */
		status() {
			return {
				state,
				error: lastError,
				inflight,
				connectedAt,
				models: catalogCache?.models?.length || 0,
			};
		},
		/**
		 * 强制重连（注册成功后用）。
		 *
		 * ⚠ 2026-10-28 修：这里**必须**把 `stopped` 置回 false ——
		 *   首次启动时若还没有节点记录，`start()` 不会被调用（见 `ensureAgent`）⇒ `stopped` 一直是 true
		 *   ⇒ 之后注册成功调 `reconnect()` → `connect()` 里的 `if (stopped) return;` 直接把它挡掉
		 *   ⇒ **通道永远连不上**（表现：页面一直显示「通道未启动」，执行日志永远是空的）✗✗
		 */
		reconnect() {
			stopped = false;
			clearTimers();
			if (socket) {
				try { socket.close(); } catch { /* ignore */ }
				socket = null;
			}
			reconnectAttempt = 0;
			connect();
		},
		/** 重新拉目录并上报。 */
		refreshCatalog() { return reportCatalog(); },
		/**
		 * **执行日志**（最近的在前；页面「执行日志」面板读它）。
		 * 每条 = { ts, kind, requestId?, model?, method?, chunks?, ms?, status?, error? }
		 */
		execLog() { return execLog.slice().reverse(); },
		/** 清空执行日志（页面上的「清空」按钮）。 */
		clearExecLog() { execLog.length = 0; },
		/**
		 * 当前状态快照（**直接读内部状态**，不经 onState 回调 ⇒ 不会被"另一个 half 的 state"污染）✓
		 * 含 pid：用来确认"页面读到的是不是同一个进程里的那个 agent"（dsh 插件可能被拆到两个进程/plane）。
		 */
		status() {
			return {
				pid: process.pid,
				state,
				error: lastError,
				inflight,
				connectedAt: connectedAt || 0,
				models: (catalogCache && catalogCache.models) ? catalogCache.models.length : 0,
				hasToken: !!String(getAccessToken() || '').trim(),
				tokenFingerprint: tokenFingerprint(String(getAccessToken() || '')),
				catalogError: catalogError || '',
				logCount: execLog.length,
			};
		},
	};
}
