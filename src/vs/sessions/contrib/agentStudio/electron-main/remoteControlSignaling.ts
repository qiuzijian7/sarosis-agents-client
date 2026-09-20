/*---------------------------------------------------------------------------------------------
 *  remoteControlSignaling — 与 billd-desk-server 的信令对接（socket.io）。
 *
 *  ── 协议要点（均取自 billd-desk 客户端源码，勿凭印象改动）──────────────────
 *  1. 传输：socket.io（**不是**原生 WebSocket），`transports: ['websocket']`。
 *     每帧必须带信封：`{ request_id, socket_id, user_info, user_token, time, data }`
 *     （见 billd-desk `src/utils/network/webSocket.ts` 的 `send()`）。
 *  2. 房间：`live_room_id` = 设备码 `deskUserUuid`（`remote/index.vue:617`）。
 *  3. 入房：连接成功后 emit `billdDeskJoin`，data =
 *     `{ deskUserUuid, deskUserPassword, live_room_id }`。
 *  4. **被控端是 offer 发起方（"反向 offer"）**：被控端监听
 *     `billdDeskStartRemoteResult`，收到后**主动** `sendOffer`
 *     （`remote/index.vue:668-702` / `remoteDesk.ts:sendOffer`）。
 *     被控端**不**监听 `billdDeskStartRemote`。
 *  5. 信令消息用 `nativeWebRtcOffer` / `nativeWebRtcAnswer` /
 *     `nativeWebRtcCandidate`，并在 data 里带 `isRemoteDesk: true`。
 *     ⚠ `billdDeskOffer/Answer/Candidate` 三个枚举在 billd-desk 里是**死代码**
 *     （只有定义、无任何收发），用错将永远连不上。
 *  6. DataChannel 由**被控端**创建：`createDataChannel('MessageChannel',
 *     { maxRetransmits: 3, ordered: false })`（`webRTC.ts:558`）。
 *     主控端侧是 `ondatachannel` 接收。键鼠指令经该通道上行。
 *  7. TURN 凭据在 billd-desk 中硬编码：`hss` / `123456`。
 *--------------------------------------------------------------------------------------------*/

import type { Socket } from 'socket.io-client';

/** billd-desk `WsMsgTypeEnum` 中本模块用到的子集（值必须与服务端一致）。 */
export const SignalingMsgType = {
	connect: 'connect',
	disconnect: 'disconnect',
	billdDeskJoin: 'billdDeskJoin',
	billdDeskJoined: 'billdDeskJoined',
	billdDeskStartRemoteResult: 'billdDeskStartRemoteResult',
	nativeWebRtcOffer: 'nativeWebRtcOffer',
	nativeWebRtcAnswer: 'nativeWebRtcAnswer',
	nativeWebRtcCandidate: 'nativeWebRtcCandidate',
} as const;

export type SignalingMsgTypeValue = typeof SignalingMsgType[keyof typeof SignalingMsgType];

/** 与 billd-desk `webSocket.ts` 的 `send()` 一致的信封。 */
export interface IWsEnvelope<T = unknown> {
	request_id: string;
	socket_id: string;
	user_info: unknown;
	user_token: string;
	time: number;
	data: T;
}

export interface ISignalingConfig {
	signalingUrl: string;
	deskUserUuid: string;
	deskUserPassword?: string;
	/** 登录态 token；billd-desk 里来自 userStore.token，未登录时可为空串。 */
	userToken?: string;
}

/** 主进程侧需要处理的下行事件。 */
export interface ISignalingHandlers {
	onLog(message: string): void;
	/** 收到「主控端请求远程」——被控端应在此发起 offer。 */
	onStartRemote(data: {
		sender: string;
		receiver: string;
		roomId: string;
		maxBitrate?: number;
		maxFramerate?: number;
		resolutionRatio?: number;
	}): void;
	onAnswer(sdp: unknown): void;
	onCandidate(candidate: unknown): void;
}

/**
 * 信令客户端。放在主进程而非采集页，好处：
 *  - 采集页是 sandbox renderer，不能 require node 模块；
 *  - 凭证/配置只驻留主进程，不外泄到页面上下文。
 */
export class RemoteControlSignaling {

	private socket: Socket | undefined;
	private mySocketId = '';

	constructor(
		private readonly config: ISignalingConfig,
		private readonly handlers: ISignalingHandlers,
	) { }

	async connect(): Promise<void> {
		// 动态 require：避免在主进程冷启动路径上引入 socket.io 成本。
		const { io } = require('socket.io-client') as typeof import('socket.io-client');

		this.socket = io(this.config.signalingUrl, { transports: ['websocket'] }) as Socket;

		this.socket.on(SignalingMsgType.connect, () => {
			this.handlers.onLog('信令已连接');
			this.sendJoin();
		});

		this.socket.on(SignalingMsgType.disconnect, (reason: string) => {
			this.handlers.onLog(`信令断开：${reason}`);
		});

		this.socket.on(SignalingMsgType.billdDeskJoined, (_data: unknown) => {
			this.mySocketId = this.socket?.id ?? '';
			this.handlers.onLog(`已加入房间 ${this.config.deskUserUuid}（socketId=${this.mySocketId}）`);
		});

		// 主控端发起远程 → 被控端收到后主动发 offer
		this.socket.on(SignalingMsgType.billdDeskStartRemoteResult, (res: {
			code: number;
			msg?: string;
			data?: { sender: string; receiver: string; live_room_id?: string; maxBitrate?: number; maxFramerate?: number; resolutionRatio?: number };
		}) => {
			this.handlers.onLog(`收到 billdDeskStartRemoteResult code=${res?.code}`);
			if (!res || res.code !== 0 || !res.data) {
				this.handlers.onLog(`忽略：code=${res?.code} msg=${res?.msg ?? ''}`);
				return;
			}
			this.handlers.onStartRemote({
				sender: res.data.sender,
				receiver: res.data.receiver,
				roomId: res.data.live_room_id ?? this.config.deskUserUuid,
				maxBitrate: res.data.maxBitrate,
				maxFramerate: res.data.maxFramerate,
				resolutionRatio: res.data.resolutionRatio,
			});
		});

		this.socket.on(SignalingMsgType.nativeWebRtcAnswer, (res: { data?: { sdp?: unknown } }) => {
			const sdp = res?.data?.sdp;
			if (sdp) {
				this.handlers.onAnswer(sdp);
			}
		});

		this.socket.on(SignalingMsgType.nativeWebRtcCandidate, (res: { data?: { candidate?: unknown } }) => {
			const candidate = res?.data?.candidate;
			if (candidate) {
				this.handlers.onCandidate(candidate);
			}
		});
	}

	disconnect(): void {
		this.socket?.disconnect();
		this.socket = undefined;
	}

	get socketId(): string {
		return this.mySocketId || this.socket?.id || '';
	}

	// ────────────────────────────── 上行 ──────────────────────────────

	private send<T>(msgType: SignalingMsgTypeValue, data: T): void {
		if (!this.socket?.connected) {
			this.handlers.onLog(`未连接，丢弃消息 ${msgType}`);
			return;
		}
		const envelope: IWsEnvelope<T> = {
			request_id: randomId(8),
			socket_id: this.socket.id ?? '',
			user_info: {},
			user_token: this.config.userToken ?? '',
			time: Date.now(),
			data,
		};
		this.socket.emit(msgType, envelope);
	}

	private sendJoin(): void {
		this.send(SignalingMsgType.billdDeskJoin, {
			deskUserUuid: this.config.deskUserUuid,
			deskUserPassword: this.config.deskUserPassword ?? '',
			live_room_id: this.config.deskUserUuid,
		});
	}

	/** 被控端发出 offer（反向 offer 模式）。 */
	sendOffer(params: { sender: string; receiver: string; roomId: string; sdp: unknown }): void {
		this.send(SignalingMsgType.nativeWebRtcOffer, {
			isRemoteDesk: true,
			live_room_id: params.roomId,
			sender: params.sender,
			receiver: params.receiver,
			sdp: params.sdp,
		});
	}

	sendCandidate(params: { sender: string; receiver: string; roomId: string; candidate: unknown }): void {
		this.send(SignalingMsgType.nativeWebRtcCandidate, {
			candidate: params.candidate,
			sender: params.sender,
			receiver: params.receiver,
			live_room_id: params.roomId,
		});
	}
}

function randomId(len: number): string {
	const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < len; i++) {
		out += chars[Math.floor(Math.random() * chars.length)];
	}
	return out;
}
