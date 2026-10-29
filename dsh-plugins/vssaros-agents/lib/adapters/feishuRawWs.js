// @vssaros/dsh-agents — 飞书长连接（WebSocket）入站客户端（**纯 Node**）
//
// ── 为什么自己写这一层 ──────────────────────────────────────────────────────
// 官方 SDK（@larksuiteoapi/node-sdk 的 WSClient）几十 MB，且它的日志默认全关
//   ⇒「握手没成」与「连上了但飞书不推事件」在日志里长得一模一样（2026-10-29 排查栽过）。
// 这里手写**协议层**（编解码见 `feishuWsFrames.js`），把连接生命周期
//   （建立 / 断开 / 重连 / 心跳 / 回执）**全部留痕** —— 这是「渠道静默不可用」能被定位的前提。
//
// ── 与 IDE 侧那份实现（vscode 里的 FeishuPlatform）的差异 ─────────────────
// 协议语义逐字对齐（端点、帧结构、ping、ack、分片、challenge 应答全部一致），
//   只有两处因宿主不同而不同：
//   ① **HTTP 走 Node 的 fetch**：IDE 侧必须走主进程出口（渲染进程 fetch 会被 CORS 拦，
//      飞书 OpenAPI 不返回 CORS 头）；纯 Node 没有同源策略 ⇒ 直接 fetch 即可。
//   ② **WebSocket 优先用包内 vendor 的 `ws`**（Node 版）；没有它就退回全局 WebSocket
//      （Node 22 内置，DOM 风格 API）。两套 API 都要适配，见 `attachSocket()`。
//
// ── 与网关的契约 ───────────────────────────────────────────────────────────
// `start({ onEvent, onError, note })` → `{ close() }`：
//   · `onEvent` 收到的是**原始 JSON 对象**（`{ header:{...}, event:{...} }`）——
//     「哪些算消息 / 防环 / 幂等」这些判定在上层做（`feishuInbound.js` 的 parseFeishuEvent）。
//   · **普通断线不调 onError**：由本层按服务端下发的 ClientConfig 自己重连；
//     只有「重连次数用尽」这种**放弃**的情况才交给上层（让 UI 显示失败并允许重试）。
//     ⇒ 否则会和网关自己的重试叠成两条连接。
//   · `note(level, msg)` 是日志通道；没有时兜底 `console.info('[vssaros-agents][im-in] …')`。
//
// ★ 凭据**每次 start 现取**（`resolve()`）：用户在「设置 → 渠道」填完立刻生效，
//   不必重启 Host（与出站适配器的口径一致）。

import {
	FEISHU_WS_CONFIG_DEFAULTS,
	FEISHU_WS_ENDPOINT_PATH,
	FRAME_HEADER,
	FRAME_METHOD,
	FeishuFrameAssembler,
	MESSAGE_TYPE,
	buildAckFrame,
	buildPingFrame,
	decodeFeishuFrame,
	decodeUtf8,
	encodeUtf8,
	extractServiceId,
	frameHeader,
	parseClientConfig,
	parseWsEndpointResponse,
	resolveWsEndpointBase,
} from './feishuWsFrames.js';

/**
 * 长连接换地址的基址（**域名根**，不带 `/open-apis`）。
 *
 * ⚠ 这个端点在域名根下 —— 拼成 `https://open.feishu.cn/open-apis/callback/ws/endpoint`
 *   实测是 `404 page not found`（2026-09-22 D-07 的线上故障根因）。
 */
const FEISHU_WS_BASE = resolveWsEndpointBase('https://open.feishu.cn/open-apis');

/** 把任意异常压成一行可读文本（日志用）。 */
function errText(e) {
	if (e === null || e === undefined) { return 'unknown error'; }
	if (e instanceof Error) { return e.message || String(e); }
	return String(e);
}

/**
 * 飞书长连接入站 transport（纯 Node 实现）。
 *
 * @param {object}   opts
 * @param {string}   [opts.appId]        静态兜底凭据（App ID）
 * @param {string}   [opts.appSecret]    静态兜底凭据（App Secret）
 * @param {Function} [opts.resolve]      每次 start 现取凭据 ⇒ `{ appId, appSecret }`
 * @param {Function} [opts.note]         日志通道（start 传入的 note 优先）
 * @param {Function} [opts.fetchImpl]    HTTP 出口（默认全局 fetch；单测注入）
 * @param {Function} [opts.WebSocketImpl] WebSocket 实现（默认 vendor 的 ws → 全局 WebSocket）
 * @param {number}   [opts.openTimeoutMs] 握手等待上限（默认 15000ms）
 */
export function createRawWsTransport({
	appId,
	appSecret,
	resolve,
	note,
	fetchImpl,
	WebSocketImpl,
	openTimeoutMs = 15000,
} = {}) {
	return {
		async start({ onEvent, onError, note: startNote } = {}) {
			/* 日志通道：start 传入的优先，其次构造参数，最后兜底 console。 */
			const say = (level, msg) => {
				const channel = typeof startNote === 'function' ? startNote : (typeof note === 'function' ? note : null);
				if (channel) {
					try { channel(level, msg); return; } catch { /* 忽略：日志通道挂了不能影响链路 */ }
				}
				try { console.info(`[vssaros-agents][im-in] ${msg}`); } catch { /* 忽略 */ }
			};

			/* ── 凭据：每次 start 现取 ─────────────────────────────────────── */
			let id = String(appId ?? '').trim();
			let secret = String(appSecret ?? '').trim();
			if (typeof resolve === 'function') {
				const r = (await resolve().catch(() => null)) || {};
				id = String(r.appId ?? '').trim() || id;
				secret = String(r.appSecret ?? '').trim() || secret;
			}
			if (!id || !secret) {
				/* `unavailable` 前缀是本项目的约定：上层据此判定「重试也没用」（见 isUnrecoverableError）。 */
				throw new Error('unavailable：缺少 app_id / app_secret（在「设置 → 渠道」里填飞书应用凭据）');
			}

			/* ── 状态 ───────────────────────────────────────────────────────── */
			let ws = null;
			let wsOpened = false;
			let linkDownHandled = false;
			let serviceId = 1;
			let clientConfig = FEISHU_WS_CONFIG_DEFAULTS;
			let pingTimer = null;
			let reconnectTimer = null;
			let reconnectAttempt = 0;
			let stopping = false;
			/* 首次连接失败由**上层**（网关）决定重试节奏；连上之后的断线才由本层自己重连。
			   否则两套重连会叠成两条活连接。 */
			let suppressReconnect = true;
			const assembler = new FeishuFrameAssembler();

			const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
			if (typeof fetchFn !== 'function') {
				throw new Error('unavailable：没有可用的 fetch（需要 Node 18+）');
			}

			/* ── WebSocket 实现：注入 → 包内 vendor 的 ws → 全局 WebSocket ──── */
			const loadWsImpl = async () => {
				if (typeof WebSocketImpl === 'function') { return WebSocketImpl; }
				try {
					/* 包内 vendor 的 `ws`（CJS）⇒ 用默认导入拿到的就是构造函数。
					   走动态 import 是为了「这份文件不在包内时也能降级」，而不是整模块加载失败。 */
					const mod = await import('./vendor/deps/ws/index.js');
					const impl = mod && (mod.default || mod.WebSocket);
					if (typeof impl === 'function') { return impl; }
				} catch (e) {
					say('warn', `包内 ws 不可用，退回全局 WebSocket：${errText(e)}`);
				}
				const g = globalThis.WebSocket;
				if (typeof g === 'function') { return g; }
				throw new Error('unavailable：没有可用的 WebSocket 实现（包内 ws 与全局 WebSocket 都不可用）');
			};

			/* ── HTTP：换 wss 地址 ─────────────────────────────────────────── */
			const readJsonResponse = async (res, url) => {
				const status = Number(res?.status ?? 0);
				let text = '';
				if (res && typeof res.text === 'function') {
					text = String((await res.text()) ?? '');
				} else if (res && typeof res.json === 'function') {
					return { status, json: await res.json() };
				}
				if (!text) { throw new Error(`[Feishu] 空响应：HTTP ${status} ${url}`); }
				try {
					return { status, json: JSON.parse(text) };
				} catch {
					throw new Error(`[Feishu] 非 JSON 响应：HTTP ${status} ${url} → ${text.slice(0, 120)}`);
				}
			};

			const exchangeEndpoint = async () => {
				const url = `${FEISHU_WS_BASE}${FEISHU_WS_ENDPOINT_PATH}`;
				/* 请求体字段名是官方 PascalCase（AppID / AppSecret），改成 snake_case 会被拒。 */
				const res = await fetchFn(url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ AppID: id, AppSecret: secret }),
				});
				const { status, json } = await readJsonResponse(res, url);
				if (status < 200 || status >= 300) {
					throw new Error(`[Feishu] 换取长连接地址失败：HTTP ${status} ${url}`);
				}
				return parseWsEndpointResponse(json);
			};

			/* ── 出站 ───────────────────────────────────────────────────────── */
			const sendFrame = (data) => {
				const sock = ws;
				if (!sock) { return; }
				try {
					sock.send(data);
				} catch (e) {
					say('warn', `WS 发送失败：${errText(e)}`);
				}
			};

			/* ── 心跳 ───────────────────────────────────────────────────────── */
			const stopPing = () => {
				if (pingTimer !== null && pingTimer !== undefined) {
					clearInterval(pingTimer);
					pingTimer = null;
				}
			};

			const startPing = () => {
				stopPing();
				const intervalMs = Math.max(1000, clientConfig.pingIntervalSec * 1000);
				const tick = () => sendFrame(buildPingFrame(serviceId));
				tick();                       /* ★ 连上先立刻发一次（官方 SDK 同款） */
				pingTimer = setInterval(tick, intervalMs);
				/* unref：Node 里定时器会吊住进程退出；dsh Host 是常驻进程，
				   但单测/脚本不该被它拖住（socket 本身已经吊着事件循环了）。 */
				if (typeof pingTimer?.unref === 'function') { pingTimer.unref(); }
			};

			/* ── 握手结果的收敛 ─────────────────────────────────────────────── */
			let openResolve = null;
			let openReject = null;
			let openTimer = null;
			const settleOpen = (err) => {
				if (openTimer) { clearTimeout(openTimer); openTimer = null; }
				const r = openResolve;
				const j = openReject;
				openResolve = null;
				openReject = null;
				if (err) { if (j) { j(err); } } else if (r) { r(); }
			};

			/* ── 事件处理 ───────────────────────────────────────────────────── */
			/**
			 * 事件分发：把**原始 JSON 对象**交给上层（不做消息级判定）。
			 *
			 * `url_verification` 是飞书的长连接握手挑战：必须把 challenge 原样回回去，
			 * 否则连接建立不起来。IDE 侧回的是**裸 UTF-8 JSON**（不是 pbbp2 帧），
			 * 这里照抄 —— 保持与飞书侧既有交互一致。
			 */
			const dispatchJsonEvent = (payload, asText = false) => {
				const kind = (payload && payload.header && payload.header.event_type)
					|| (payload && payload.type)
					|| '(unknown)';
				say('info', `WS 收到事件帧：${kind}`);
				const p = payload || {};
				if (p.type === 'url_verification' && p.challenge) {
					const reply = JSON.stringify({ challenge: p.challenge, token: p.token });
					sendFrame(asText ? reply : encodeUtf8(reply));
					return;
				}
				if (typeof onEvent === 'function') { onEvent(p); }
			};

			/**
			 * 处理一条入站 WS 消息：二进制 protobuf 帧（主路径）+ 纯文本 JSON（兼容兜底）。
			 */
			const handleWsMessage = async (data) => {
				if (typeof data === 'string') {
					/* 兼容兜底：理论上长连接只发二进制帧；若网关发了 JSON 文本，按 webhook 事件处理。 */
					let parsed;
					try {
						parsed = JSON.parse(data);
					} catch {
						say('warn', 'WS 收到无法解析的文本帧，已忽略');
						return;
					}
					try {
						dispatchJsonEvent(parsed, true);
					} catch (e) {
						say('warn', `WS 文本帧处理失败：${errText(e)}`);
					}
					return;
				}

				let bytes = null;
				if (data instanceof ArrayBuffer) {
					bytes = new Uint8Array(data);
				} else if (ArrayBuffer.isView(data)) {
					/* `ws` 给的是 Buffer（Node 池化 buffer）⇒ 必须带上 byteOffset/byteLength，
					   否则会把整个池子都当成这一帧。 */
					bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
				} else if (data && typeof data.arrayBuffer === 'function') {
					/* Blob（全局 WebSocket 的默认 binaryType）⇒ 必须显式取字节，否则解不出帧。 */
					bytes = new Uint8Array(await data.arrayBuffer());
				} else {
					say('warn', 'WS 收到未知类型帧（非二进制/文本），已忽略');
					return;
				}

				let frame;
				try {
					frame = decodeFeishuFrame(bytes);
				} catch (e) {
					say('warn', `帧解码失败：${errText(e)}`);
					return;
				}
				handleFrame(frame);
			};

			/**
			 * 处理一帧。
			 *
			 * - CONTROL + `type=pong` ⇒ 服务端可能带回更新后的心跳配置 ⇒ 覆盖 clientConfig。
			 * - DATA ⇒ 先按 `sum`/`seq`/`message_id` **分片重组**，齐了才取 payload；
			 *   处理完**必须回 ack 帧**（漏了飞书不再推下一条）。
			 */
			const handleFrame = (frame) => {
				const type = frameHeader(frame, FRAME_HEADER.TYPE);

				if (frame.method === FRAME_METHOD.CONTROL) {
					if (type === MESSAGE_TYPE.PONG && frame.payload.length > 0) {
						try {
							clientConfig = parseClientConfig(JSON.parse(decodeUtf8(frame.payload)));
							say('info', `WS 心跳配置已更新（心跳 ${clientConfig.pingIntervalSec}s）`);
						} catch (e) {
							say('warn', `心跳配置解析失败：${errText(e)}`);
						}
					}
					return;
				}
				if (frame.method !== FRAME_METHOD.DATA) { return; }

				const messageId = frameHeader(frame, FRAME_HEADER.MESSAGE_ID) ?? '';
				const sum = Number(frameHeader(frame, FRAME_HEADER.SUM) ?? '1');
				const seq = Number(frameHeader(frame, FRAME_HEADER.SEQ) ?? '0');
				let payload = frame.payload;
				if (Number.isFinite(sum) && sum > 1) {
					const merged = assembler.push(messageId, sum, Number.isFinite(seq) ? seq : 0, payload);
					if (!merged) { return; }   /* 未收齐 */
					payload = merged;
				}

				const started = Date.now();
				let ok = true;
				try {
					if (type === MESSAGE_TYPE.EVENT) {
						dispatchJsonEvent(JSON.parse(decodeUtf8(payload)));
					} else if (type === MESSAGE_TYPE.CARD) {
						say('info', '收到卡片交互帧（card），当前版本未实现处理');
					}
				} catch (e) {
					ok = false;
					say('warn', `事件处理失败：${errText(e)}`);
				}
				/* ★ 回执必发：飞书靠它确认这一条处理完了，否则不再推下一条。 */
				sendFrame(buildAckFrame(frame, Date.now() - started, ok));
			};

			/* ── 断线 / 重连 ────────────────────────────────────────────────── */
			const linkDown = (reason) => {
				if (linkDownHandled) { return; }
				linkDownHandled = true;
				ws = null;
				stopPing();
				assembler.clear();
				if (stopping) { return; }
				say('warn', `WS ${reason}`);
				scheduleReconnect();
			};

			/**
			 * 按服务端下发的 ClientConfig 重连：首次抖动 0~ReconnectNonce 秒，其后每次间隔
			 * ReconnectInterval 秒；ReconnectCount < 0 表示无限重连（官方默认）。
			 */
			function scheduleReconnect() {
				if (suppressReconnect) { return; }
				if (reconnectTimer) { return; }   /* 已经在等重连了，别排第二次 */
				const cfg = clientConfig;
				if (cfg.reconnectCount >= 0 && reconnectAttempt >= cfg.reconnectCount) {
					say('warn', `WS 重连次数已达上限（${cfg.reconnectCount}），停止重连`);
					try { onError?.(new Error(`unavailable：飞书长连接重连次数已达上限（${cfg.reconnectCount}）`)); } catch { /* 忽略 */ }
					return;
				}
				const attempt = reconnectAttempt++;
				const delaySec = attempt === 0
					? Math.random() * cfg.reconnectNonceSec
					: cfg.reconnectIntervalSec;
				say('info', `WS 将在 ${delaySec.toFixed(1)}s 后重连（第 ${attempt + 1} 次）`);
				reconnectTimer = setTimeout(() => {
					reconnectTimer = null;
					if (stopping) { return; }
					connectWs().catch((e) => {
						say('warn', `WS 重连失败：${errText(e)}`);
						scheduleReconnect();
					});
				}, delaySec * 1000);
				if (typeof reconnectTimer?.unref === 'function') { reconnectTimer.unref(); }
			}

			const handleOpen = () => {
				wsOpened = true;
				reconnectAttempt = 0;   /* 连接成功即清零重连计数（下一次断连从头抖动） */
				say('info', `WS 长连接已建立（service_id=${serviceId}，心跳 ${clientConfig.pingIntervalSec}s）`);
				startPing();
				settleOpen(null);
			};

			const handleError = (e) => {
				if (!wsOpened) {
					settleOpen(new Error(`[Feishu] 长连接握手失败：${errText(e)}`));
				}
				say('warn', `WS 报错：${errText(e)}`);
				linkDown(wsOpened ? '长连接异常断开' : '握手失败（error）');
			};

			/**
			 * 挂事件回调。
			 *
			 * 两套 API 都要适配：
			 *   · `ws`（Node）= `on('open'|'message'|'close'|'error')`，message 给 Buffer；
			 *   · 全局 WebSocket（Node 22 内置 / 浏览器）= `addEventListener(...)`，message 给
			 *     `ev.data`（ArrayBuffer / Blob / string）。
			 * 判据用「有没有 on()」—— Node 的内置 WebSocket 虽然也有 addEventListener，
			 * 但它没有 on()（只有 onopen 这种 setter），所以不会误判。
			 */
			const attachSocket = (sock) => {
				if (typeof sock.on === 'function') {
					sock.on('open', () => { handleOpen(); });
					sock.on('message', (data) => { void handleWsMessage(data); });
					sock.on('close', () => { linkDown('长连接已断开（close）'); });
					sock.on('error', (e) => { handleError(e); });
					return;
				}
				if (typeof sock.addEventListener === 'function') {
					sock.addEventListener('open', () => { handleOpen(); });
					sock.addEventListener('message', (ev) => { void handleWsMessage(ev ? ev.data : undefined); });
					sock.addEventListener('close', () => { linkDown('长连接已断开（close）'); });
					sock.addEventListener('error', (ev) => { handleError(ev); });
					return;
				}
				throw new Error('unavailable：这个 WebSocket 实现既没有 on() 也没有 addEventListener()');
			};

			/**
			 * 建立一条长连接：换地址 → 建 socket → 等 open。
			 *
			 * 重连时**必须重新换地址**：service_id 与心跳配置都是随地址下发的，
			 * 沿用旧值 ⇒ ping 的 service 对不上 ⇒ 连接会被服务端判死。
			 */
			async function connectWs() {
				const WSImpl = await loadWsImpl();
				const { url: wsUrl, clientConfig: cfg } = await exchangeEndpoint();
				serviceId = extractServiceId(wsUrl);
				clientConfig = cfg;
				assembler.clear();
				wsOpened = false;
				linkDownHandled = false;

				let sock;
				try {
					sock = new WSImpl(wsUrl);
				} catch (e) {
					throw new Error(`[Feishu] 创建 WebSocket 失败：${errText(e)}`);
				}
				ws = sock;
				/* DOM 风格（全局 WebSocket）默认把二进制给 Blob ⇒ 必须显式要 arraybuffer。 */
				if (typeof sock.on !== 'function') {
					try { sock.binaryType = 'arraybuffer'; } catch { /* 忽略 */ }
				}

				await new Promise((resolve, reject) => {
					openResolve = resolve;
					openReject = reject;
					openTimer = setTimeout(() => {
						openTimer = null;
						settleOpen(new Error('[Feishu] 长连接握手超时'));
					}, Math.max(1000, Number(openTimeoutMs) || 15000));
					/* ⚠ 这里**故意不 unref**：握手超时的兜底必须真能触发。
					   若 unref 了，事件循环一旦空掉（假 socket / 网络半死），
					   进程会**静默 exit 0** —— 表现为"没输出、退出码 0"，
					   比失败更难查（2026-10-29 排查时被这条误判过一轮）。
					   代价：握手卡住时进程最多多活 15s；close() 会清掉这个定时器。 */
					attachSocket(sock);
				});
			}

			/* ── 首次连接 ───────────────────────────────────────────────────── */
			await connectWs();
			suppressReconnect = false;

			return {
				close() {
					stopping = true;
					stopPing();
					if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
					if (openTimer) { clearTimeout(openTimer); openTimer = null; }
					assembler.clear();
					const sock = ws;
					ws = null;
					if (sock) {
						try { sock.close(); } catch { /* 忽略关闭异常 */ }
					}
				},
			};
		},
	};
}
