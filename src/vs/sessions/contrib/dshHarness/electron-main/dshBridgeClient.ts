/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 控制桥客户端：连接 `@vssaros/dsh-bridge` 监听的命名管道（P0-4 已验证多客户端可同时连接）。
 * 只依赖 Node 内置模块与 vs/base。
 */

import * as net from 'net';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { BridgeReverseRequestHandler, DshBridgeErrorCode, DshBridgeMethod, DshBridgeReverseMethod, encodeRpc, encodeRpcResponse, IBridgeHello, IBridgeReverseRequest, IClientRegisterParams, IRpcError, IRpcResponse, isBridgeHello, isVssarosIdeCapability, LineDecoder } from '../common/dshBridgeProtocol.js';

export class DshBridgeError extends Error {
	constructor(readonly code: number, message: string) {
		super(message);
	}
}

export class DshBridgeClient extends Disposable {

	private readonly _onDidClose = this._register(new Emitter<void>());
	readonly onDidClose: Event<void> = this._onDidClose.event;

	private readonly _onDidReceiveReverseRequest = this._register(new Emitter<IBridgeReverseRequest>());
	/** 收到反向（Host → IDE）请求时触发（审计 / 观测；**处置**由 `setReverseRequestHandler` 决定）。 */
	readonly onDidReceiveReverseRequest: Event<IBridgeReverseRequest> = this._onDidReceiveReverseRequest.event;

	/** `register()` 时记下的令牌：反向请求的 `params.token` 必须与它一致。 */
	private _token: string | undefined;
	private _instanceId: string | undefined;
	private _reverseHandler: BridgeReverseRequestHandler | undefined;

	/** 换行分帧解码器：命名管道按 chunk 到达，跨 chunk 拼接由它负责（单行解析失败只丢该行）。 */
	private readonly _decoder = new LineDecoder();
	/** 在飞的请求：id → 等待中的 resolve 与超时定时器（回包、超时或断开时都会删掉）。 */
	private readonly _pending = new Map<number, { resolve: (response: IRpcResponse) => void; timer: ReturnType<typeof setTimeout> }>();
	/** 请求序号：协议要求单调递增；反向请求用负数 id，两侧互不冲突。 */
	private _seq = 0;
	/** 连接是否已关闭（close / error / dispose 一次置真，之后的调用快速失败）。 */
	private _closed = false;

	private constructor(private readonly _socket: net.Socket, private readonly _log?: (line: string) => void) {
		super();
		_socket.setEncoding('utf8');
		_socket.on('data', (chunk: string) => {
			for (const msg of this._decoder.push(chunk)) {
				// 反向（Host → IDE）请求：**负数 id + 带 `method`**（协议 v2）。必须**先**判它——
				// v1 的老毛病就是这类消息会掉进下面"按 id 找 pending"的分支被静默丢弃。
				const asRequest = msg as unknown as { method?: unknown; params?: unknown };
				if (typeof msg.id === 'number' && msg.id < 0 && typeof asRequest.method === 'string') {
					void this._handleReverseRequest({
						id: msg.id,
						method: asRequest.method,
						params: (asRequest.params && typeof asRequest.params === 'object' ? asRequest.params : {}) as Record<string, unknown>,
					});
					continue;
				}
				if (typeof msg.id !== 'number') {
					continue;
				}
				const p = this._pending.get(msg.id);
				if (!p) {
					// 无人认领的响应：最典型的场景是"IDE 侧答得比桥侧预算晚"（`call()` 已超时 reject，
					// 回执此时才回来）。以前完全静默 ⇒ 事后无法区分"根本没回"与"回晚了"。
					this._log?.(`bridge: 丢弃无人认领的响应 id=${msg.id}（多半是已超时调用迟到的回执）`);
					continue;
				}
				clearTimeout(p.timer);
				this._pending.delete(msg.id);
				p.resolve(msg);
			}
		});
		const onEnd = () => this._handleClose();
		_socket.on('close', onEnd);
		_socket.on('error', onEnd);
	}

	/**
	 * 反复尝试连接，直到 Host 内的伴生插件开始监听或超时。
	 * `log`（可选）用于记录本类里"只能丢弃"的分支（见 `_socket.on('data')` 里那条迟到回执）。
	 */
	static async connect(path: string, timeoutMs: number, isCancelled: () => boolean = () => false, log?: (line: string) => void): Promise<DshBridgeClient> {
		const deadline = Date.now() + timeoutMs;
		let lastError: unknown;
		while (Date.now() < deadline && !isCancelled()) {
			try {
				const socket = await new Promise<net.Socket>((resolve, reject) => {
					const s = net.connect(path);
					s.once('connect', () => {
						s.removeAllListeners('error');
						resolve(s);
					});
					s.once('error', reject);
				});
				return new DshBridgeClient(socket, log);
			} catch (e) {
				lastError = e;
				await new Promise(r => setTimeout(r, 150));
			}
		}
		throw new Error(`控制桥连接超时（${timeoutMs} ms）：${String((lastError as Error | undefined)?.message ?? lastError ?? 'cancelled')}`);
	}

	get closed(): boolean {
		return this._closed;
	}

	async call<T>(method: string, params?: unknown, timeoutMs = 10_000): Promise<T> {
		if (this._closed) {
			throw new DshBridgeError(-1, 'bridge closed');
		}
		const id = ++this._seq;
		const response = await new Promise<IRpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this._pending.delete(id);
				reject(new DshBridgeError(-2, `bridge call timeout: ${method}`));
			}, timeoutMs);
			this._pending.set(id, { resolve, timer });
			this._socket.write(encodeRpc({ jsonrpc: '2.0', id, method, params }));
		});
		if (response.error) {
			throw new DshBridgeError(response.error.code, response.error.message);
		}
		return response.result as T;
	}

	async register(params: IClientRegisterParams): Promise<IBridgeHello> {
		const hello = await this.call<unknown>(DshBridgeMethod.ClientRegister, params);
		if (!isBridgeHello(hello)) {
			throw new DshBridgeError(-3, 'malformed bridge.hello');
		}
		// 记下令牌与实例 id：反向请求要校验前者、回执里会带上后者
		this._token = params.token;
		this._instanceId = params.instanceId;
		return hello;
	}

	/**
	 * 注册反向（Host → IDE）请求的处理器。**未注册时一律拒绝**（默认拒绝）：
	 * 反向通道能让 Host 驱动 IDE，放行面必须显式、可控。
	 *
	 * 注意两点：
	 * - `ide.echo`（自检）由客户端**内建**应答，不经过这里 ⇒ 能力尚未接线时也能验收通道本身；
	 * - `ide.request` 的 `capability` 会先做**名字合法性**校验（与清单 `ideCapabilities` 同一份白名单），
	 *   **逐插件授权**要由处理器补（它才知道各插件声明了什么）。
	 */
	setReverseRequestHandler(handler: BridgeReverseRequestHandler | undefined): void {
		this._reverseHandler = handler;
	}

	/** 反向请求的处置：校验令牌 → 自检内建 → 能力名合法 → 交给处理器（默认拒绝）。 */
	private async _handleReverseRequest(request: IBridgeReverseRequest): Promise<void> {
		this._onDidReceiveReverseRequest.fire(request);
		const respond = (result: unknown, error?: IRpcError): void => {
			if (this._closed) {
				return;
			}
			this._socket.write(encodeRpcResponse(error
				? { jsonrpc: '2.0', id: request.id, error }
				: { jsonrpc: '2.0', id: request.id, result }));
		};
		// 1) 令牌：反向通道也要核验（没 register 过就没有令牌 ⇒ 直接拒）
		if (!this._token || request.params.token !== this._token) {
			respond(undefined, { code: this._token ? DshBridgeErrorCode.BadToken : DshBridgeErrorCode.NotRegistered, message: this._token ? 'bad token' : 'not registered' });
			return;
		}
		// 2) 自检：不涉及任何 IDE 能力，内建应答（Host 的 `ide.roundtrip` 靠它）
		if (request.method === DshBridgeReverseMethod.IdeEcho) {
			respond({ ok: true, echo: request.params, instanceId: this._instanceId, at: Date.now() });
			return;
		}
		// 3) 能力名合法性（与清单同一份白名单）；逐插件授权由处理器负责
		if (request.method === DshBridgeReverseMethod.IdeRequest && !isVssarosIdeCapability(request.params.capability)) {
			respond(undefined, { code: DshBridgeErrorCode.MethodNotFound, message: `未知的 IDE 能力：${String(request.params.capability)}` });
			return;
		}
		// 4) 分发（默认拒绝）
		if (!this._reverseHandler) {
			respond(undefined, { code: DshBridgeErrorCode.MethodNotFound, message: `IDE 侧未注册反向处理器：${request.method}` });
			return;
		}
		try {
			respond(await this._reverseHandler(request));
		} catch (e) {
			respond(undefined, { code: DshBridgeErrorCode.Internal, message: String((e as Error)?.message ?? e) });
		}
	}

	private _handleClose(): void {
		if (this._closed) {
			return;
		}
		this._closed = true;
		for (const [, p] of this._pending) {
			clearTimeout(p.timer);
			p.resolve({ id: null, error: { code: -1, message: 'bridge closed' } });
		}
		this._pending.clear();
		this._onDidClose.fire();
	}

	override dispose(): void {
		this._socket.destroy();
		this._handleClose();
		super.dispose();
	}
}
