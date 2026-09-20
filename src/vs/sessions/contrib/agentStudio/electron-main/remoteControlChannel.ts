/*---------------------------------------------------------------------------------------------
 *  remoteControlChannel — 远程控制（被控端）主进程 IPC channel 宿主。
 *
 *  参照 voxLaunchChannel / comfyLaunchChannel 的「renderer → validatedIpcMain.handle」模式，
 *  提供远程被控能力：屏幕采集、WebRTC 宿主窗口管理、nut-js 驱动级键鼠注入。
 *
 *  ── 为什么必须有这个文件 ────────────────────────────────────────────────
 *  扩展宿主是 utilityProcess.fork（且 extensionHostProcess.ts 设了
 *  ELECTRON_RUN_AS_NODE=1），**没有 WebContents**，因此：
 *    - desktopCapturer 只在 Main 进程可用；
 *    - getUserMedia / RTCPeerConnection 只在 Renderer 可用；
 *    - validatedIpcMain 校验 senderFrame.host === VSCODE_AUTHORITY 且是 main frame，
 *      utility process 不满足。
 *  ⇒ 采集与键鼠必须常驻主进程，WebRTC 跑在独立的隐藏 BrowserWindow（renderer）里。
 *
 *  ── 三个关键设计点 ──────────────────────────────────────────────────────
 *  1. 采集窗口用**独立 partition session**（`saros-remote`）：
 *     - 只对它 setPermissionRequestHandler 放行 media，不污染 VS Code 全局 session；
 *     - 该 partition 上注册 `saros-remote://` scheme 提供采集页。
 *  2. 采集页与主进程之间走**原生 ipcMain** + `event.sender.id` 校验（而非
 *     validatedIpcMain）：采集页的 origin 不是 `vscode-app`，用 validated 会被拒；
 *     这里改为只信任自己创建的窗口 id，校验更精确。
 *  3. 信令（socket.io）放在**主进程**，采集页只管 getUserMedia + RTCPeerConnection，
 *     offer/answer/candidate 经 IPC 代理转发。这样 socket.io-client 无需打进 renderer。
 *
 *  注：nut-js 为 N-API 原生模块（node-addon-api），跨 ABI 稳定，Electron 39 可直接用
 *  预编译产物，无需 electron-rebuild。加载失败时降级为「仅观看」，不崩主进程。
 *--------------------------------------------------------------------------------------------*/

import { BrowserWindow, desktopCapturer, ipcMain, protocol, screen, session } from 'electron';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { validatedIpcMain } from '../../../../base/parts/ipc/electron-main/ipcMain.js';
import { RemoteControlSignaling } from './remoteControlSignaling.js';

// ⚠ `saros-remote` 的 registerSchemesAsPrivileged 在 `src/main.ts` 的既有注册块里
// （那里才是「早于 app ready」的位置）。本模块虽被 app.ts 静态 import，但 app.ts 本身
// 由 main.js 在 onReady 之后才动态加载 —— 在本文件顶层调用会抛
// "registerSchemesAsPrivileged should be called before app is ready"（2026-09-20 F5 实证）。
// `secure: true` 让 `saros-remote://` 成为 secure context —— 否则 getUserMedia 不可用。

/** 采集窗口专用 partition（与 VS Code 主 session 隔离）。 */
const CAPTURE_PARTITION = 'saros-remote-capture';

/** nut-js 类型（避免编译期强依赖；运行时 require）。 */
type NutJsModule = {
	mouse: {
		setPosition(p: { x: number; y: number }): Promise<void>;
		move(path: { x: number; y: number }[]): Promise<void>;
		pressButton(b: number): Promise<void>;
		releaseButton(b: number): Promise<void>;
		click(b: number): Promise<void>;
		doubleClick(b: number): Promise<void>;
		scrollUp(amount: number): Promise<void>;
		scrollDown(amount: number): Promise<void>;
		scrollLeft(amount: number): Promise<void>;
		scrollRight(amount: number): Promise<void>;
	};
	keyboard: {
		type(...keys: string[]): Promise<void>;
		pressKey(...keys: string[]): Promise<void>;
		releaseKey(...keys: string[]): Promise<void>;
	};
	Button: { LEFT: number; RIGHT: number; MIDDLE: number };
};

/**
 * 键鼠行为枚举 —— 与 billd-desk `BilldDeskBehaviorEnum` 数值一致，
 * 这样 billd-desk 的 Web 主控端无需改动即可控制本端。
 */
export const enum RemoteInputBehavior {
	mouseMove = 0,
	mouseDrag = 1,
	pressButtonLeft = 2,
	pressButtonRight = 3,
	releaseButtonLeft = 4,
	releaseButtonRight = 5,
	setPosition = 6,
	doubleClick = 7,
	leftClick = 8,
	rightClick = 9,
	scrollDown = 10,
	scrollUp = 11,
	scrollLeft = 12,
	scrollRight = 13,
	keyboardType = 14,
	keyboardPressKey = 15,
	keyboardReleaseKey = 16,
}

interface IRemoteStartPayload {
	signalingUrl?: string;
	deskUserUuid?: string;
	/** 被控端连接密码（billd-desk 的 deskUserPassword）。 */
	deskUserPassword?: string;
	/** 登录态 token；未登录时留空。 */
	userToken?: string;
	sourceId?: string;
	maxFramerate?: number;
	maxBitrate?: number;
	/** Coturn 地址（默认 turn:hk.hsslive.cn，凭据 hss/123456 与 billd-desk 一致）。 */
	coturnUrl?: string;
}

export class RemoteControlChannel extends Disposable {

	private _captureWindow: BrowserWindow | undefined;
	private _captureSessionRegistered = false;
	private _nut: NutJsModule | undefined;
	private _nutError: string | undefined;
	private _signaling: RemoteControlSignaling | undefined;
	private _config: IRemoteStartPayload | undefined;
	/** 对端（主控端）socket id。 */
	private _peer: string | undefined;
	/** 本次会话房间号（= 设备码）。 */
	private _sessionRoomId: string | undefined;

	constructor(
		private readonly logService: ILogService,
	) {
		super();
		this.registerChannels();
		this.registerCaptureIpc();
	}

	override dispose(): void {
		this.disconnectSignaling();
		this.destroyCaptureWindow();
		for (const ch of [
			'vscode:sarosRemoteGetSources',
			'vscode:sarosRemoteStart',
			'vscode:sarosRemoteStop',
			'vscode:sarosRemoteCheckInput',
			'saros:remoteCaptureReady',
			'saros:remoteCaptureSignal',
			'saros:remoteCaptureInput',
		]) {
			validatedIpcMain.removeHandler(ch);
			ipcMain.removeHandler(ch);
		}
		super.dispose();
	}

	// ────────────────────── 对工作台/扩展的通道（validatedIpcMain） ──────────────────────

	private registerChannels(): void {
		validatedIpcMain.handle('vscode:sarosRemoteGetSources', async () => {
			try {
				const sources = await desktopCapturer.getSources({
					types: ['screen'],
					thumbnailSize: { width: 320, height: 180 },
				});
				return {
					ok: true,
					sources: sources.map(s => ({
						id: s.id,
						name: s.name,
						displayId: s.display_id,
						thumbnail: s.thumbnail.toDataURL(),
					})),
				};
			} catch (err) {
				this.logService.error('[RemoteControl] getSources 失败', err);
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		});

		validatedIpcMain.handle('vscode:sarosRemoteStart', async (_e, payload: IRemoteStartPayload | undefined) => {
			return this.startCapture(payload);
		});

		validatedIpcMain.handle('vscode:sarosRemoteStop', async () => {
			this.destroyCaptureWindow();
			return { ok: true };
		});

		validatedIpcMain.handle('vscode:sarosRemoteCheckInput', async () => {
			const nut = this.loadNutJs();
			if (!nut) {
				return { ok: false, error: this._nutError ?? 'nut-js 未加载' };
			}
			return { ok: true, hasMouse: !!nut.mouse, hasKeyboard: !!nut.keyboard };
		});
	}

	// ────────────── 采集页 ↔ 主进程（原生 ipcMain + webContents id 校验） ──────────────

	private registerCaptureIpc(): void {
		// 采集页就绪通知。
		ipcMain.handle('saros:remoteCaptureReady', async (event) => {
			if (!this.isCaptureSender(event.sender)) {
				return { ok: false, error: 'untrusted sender' };
			}
			this.logService.info('[RemoteControl] 采集页已就绪');
			return { ok: true };
		});

		// 采集页 → 主进程 → 信令服务器（offer/answer/candidate 代理）。
		ipcMain.handle('saros:remoteCaptureSignal', async (event, payload: {
			kind: 'offer' | 'answer' | 'candidate';
			data: unknown;
		} | undefined) => {
			if (!this.isCaptureSender(event.sender) || !payload) {
				return { ok: false, error: 'untrusted sender or empty payload' };
			}
			return this.forwardSignal(payload);
		});

		// 采集页 DataChannel 收到键鼠指令 → nut-js 注入。
		ipcMain.handle('saros:remoteCaptureInput', async (event, data: {
			type: RemoteInputBehavior;
			x?: number;
			y?: number;
			amount?: number;
			key?: string[];
		} | undefined) => {
			if (!this.isCaptureSender(event.sender)) {
				return { ok: false, error: 'untrusted sender' };
			}
			if (!data) {
				return { ok: false, error: '缺少 payload' };
			}
			return this.injectInput(data);
		});
	}

	private isCaptureSender(sender: Electron.WebContents): boolean {
		const win = this._captureWindow;
		return !!win && !win.isDestroyed() && win.webContents.id === sender.id;
	}

	/** 将采集页产生的 offer/candidate 经 socket.io 发往 billd-desk-server。 */
	private async forwardSignal(payload: { kind: 'offer' | 'answer' | 'candidate'; data: unknown }): Promise<{ ok: boolean; error?: string }> {
		const sig = this._signaling;
		if (!sig) {
			return { ok: false, error: '信令未连接' };
		}
		const peer = this._peer;
		const roomId = this._sessionRoomId || this._config?.deskUserUuid || '';
		if (payload.kind === 'offer') {
			sig.sendOffer({
				sender: sig.socketId,
				receiver: peer ?? '',
				roomId,
				sdp: payload.data,
			});
		} else if (payload.kind === 'candidate') {
			sig.sendCandidate({
				sender: sig.socketId,
				receiver: peer ?? '',
				roomId,
				candidate: payload.data,
			});
		}
		return { ok: true };
	}

	// ────────────────────────── 信令（主进程侧） ──────────────────────────

	/** 建立与被控端房间的信令连接。 */
	private async connectSignaling(config: IRemoteStartPayload): Promise<void> {
		this.disconnectSignaling();

		const deskUserUuid = config.deskUserUuid ?? '';
		if (!deskUserUuid) {
			throw new Error('缺少设备码 deskUserUuid');
		}

		this._config = config;
		const sig = new RemoteControlSignaling(
			{
				signalingUrl: config.signalingUrl ?? 'wss://srs-pull.hsslive.cn',
				deskUserUuid,
				deskUserPassword: config.deskUserPassword,
				userToken: config.userToken,
			},
			{
				onLog: msg => this.logService.info(`[RemoteControl] ${msg}`),
				onStartRemote: data => {
					this._peer = data.sender;
					this._sessionRoomId = data.roomId;
					this.logService.info(`[RemoteControl] 主控端请求远程 sender=${data.sender}`);
					// 「反向 offer」：被控端收到请求后才发起 offer。
					void this.sendToCapture('saros:remoteStartOffer', { receiver: data.sender });
				},
				onAnswer: async sdp => {
					await this.sendToCapture('saros:remoteApplyAnswer', { sdp });
				},
				onCandidate: async candidate => {
					await this.sendToCapture('saros:remoteApplyCandidate', { candidate });
				},
			}
		);

		await sig.connect();
		this._signaling = sig;
	}

	private disconnectSignaling(): void {
		this._signaling?.disconnect();
		this._signaling = undefined;
		this._peer = undefined;
		this._sessionRoomId = undefined;
	}

	/** 主进程 → 采集页（webContents.send）。 */
	private async sendToCapture(channel: string, payload: unknown): Promise<void> {
		const win = this._captureWindow;
		if (!win || win.isDestroyed()) {
			this.logService.warn(`[RemoteControl] 采集窗口不可用，丢弃 ${channel}`);
			return;
		}
		win.webContents.send(channel, payload);
	}

	// ────────────────────────── 采集窗口生命周期 ──────────────────────────

	private async startCapture(payload: IRemoteStartPayload | undefined): Promise<{ ok: boolean; error?: string }> {
		if (this._captureWindow && !this._captureWindow.isDestroyed()) {
			return { ok: false, error: '已在被控中' };
		}

		try {
			const sourceId = payload?.sourceId ?? await this.resolveDefaultSourceId();
			await this.ensureCaptureSession();

			const window = new BrowserWindow({
				show: false,
				webPreferences: {
					partition: CAPTURE_PARTITION,
					nodeIntegration: false,
					contextIsolation: true,
					sandbox: true,
					backgroundThrottling: false,
					webSecurity: true,
				},
			});
			this._captureWindow = window;

			window.on('closed', () => {
				this._captureWindow = undefined;
				this.logService.info('[RemoteControl] 采集窗口已关闭');
			});

			const opts: IRemoteStartPayload & { sourceId: string } = { ...payload, sourceId };
			await window.loadURL(`saros-remote://capture/index.html?opts=${encodeURIComponent(JSON.stringify(opts))}`);
			this.logService.info(`[RemoteControl] 采集窗口已加载 sourceId=${sourceId}`);

			// 采集页就绪后再连信令，避免 offer 早于 getUserMedia。
			await this.connectSignaling(opts);
			return { ok: true };
		} catch (err) {
			this.destroyCaptureWindow();
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	private destroyCaptureWindow(): void {
		if (this._captureWindow && !this._captureWindow.isDestroyed()) {
			this._captureWindow.destroy();
		}
		this._captureWindow = undefined;
	}

	/** 一次性初始化采集 partition：注册 scheme + 放行 media 权限。 */
	private async ensureCaptureSession(): Promise<void> {
		if (this._captureSessionRegistered) {
			return;
		}
		const ses = session.fromPartition(CAPTURE_PARTITION);

		// 只对该 partition 放行屏幕采集，不动 VS Code 全局 session。
		ses.setPermissionRequestHandler((wc, permission, callback) => {
			if (permission === 'media') {
				this.logService.info(`[RemoteControl] 放行 media 权限 (webContents=${wc.id})`);
				return callback(true);
			}
			return callback(false);
		});

		// 注：本 Electron 版本的 registerStringProtocol 不支持按 session 注册，
		// scheme 为全局注册；partition 隔离仍保证权限/存储不污染主 session。
		protocol.registerStringProtocol('saros-remote', (request, callback) => {
			callback({ mimeType: 'text/html', data: CAPTURE_PAGE_HTML });
		});

		this._captureSessionRegistered = true;
	}

	private async resolveDefaultSourceId(): Promise<string> {
		const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
		if (sources.length === 0) {
			throw new Error('未找到可采集的屏幕源');
		}
		const primary = screen.getPrimaryDisplay();
		const matched = sources.find(s => s.display_id === String(primary.id));
		return (matched ?? sources[0]).id;
	}

	// ──────────────────────────── 键鼠注入 ────────────────────────────

	private loadNutJs(): NutJsModule | undefined {
		if (this._nut) {
			return this._nut;
		}
		if (this._nutError) {
			return undefined;
		}
		try {
			const mod = require('@nut-tree/nut-js');
			this._nut = (mod?.default ?? mod) as NutJsModule;
			this.logService.info('[RemoteControl] nut-js 加载成功');
			return this._nut;
		} catch (err) {
			this._nutError = err instanceof Error ? err.message : String(err);
			this.logService.error(`[RemoteControl] nut-js 加载失败，键鼠注入不可用：${this._nutError}`);
			return undefined;
		}
	}

	/**
	 * 坐标换算：主控端传 0-1000 归一化值，按主屏物理像素还原。
	 * 与 billd-desk `use-ipcRendererSend.ts` 一致：
	 *   pixel = workAreaSize * scaleFactor * (value / 1000)
	 * amount（滚轮量）不缩放，原样透传。
	 */
	private toPixel(value: number, isWidth: boolean): number {
		const display = screen.getPrimaryDisplay();
		const size = isWidth ? display.workAreaSize.width : display.workAreaSize.height;
		return Math.round(size * display.scaleFactor * (value / 1000));
	}

	private async injectInput(data: {
		type: RemoteInputBehavior;
		x?: number;
		y?: number;
		amount?: number;
		key?: string[];
	}): Promise<{ ok: boolean; error?: string }> {
		const nut = this.loadNutJs();
		if (!nut) {
			return { ok: false, error: `nut-js 不可用：${this._nutError ?? '未加载'}` };
		}

		try {
			const LEFT = nut.Button?.LEFT ?? 0;
			const RIGHT = nut.Button?.RIGHT ?? 2;
			const x = data.x ?? 0;
			const y = data.y ?? 0;

			switch (data.type) {
				case RemoteInputBehavior.setPosition:
					await nut.mouse.setPosition({ x: this.toPixel(x, true), y: this.toPixel(y, false) });
					break;
				case RemoteInputBehavior.mouseMove:
					await nut.mouse.move([{ x: this.toPixel(x, true), y: this.toPixel(y, false) }]);
					break;
				case RemoteInputBehavior.mouseDrag:
					await nut.mouse.move([{ x: this.toPixel(x, true), y: this.toPixel(y, false) }]);
					break;
				case RemoteInputBehavior.pressButtonLeft:
					await nut.mouse.pressButton(LEFT);
					break;
				case RemoteInputBehavior.releaseButtonLeft:
					await nut.mouse.releaseButton(LEFT);
					break;
				case RemoteInputBehavior.pressButtonRight:
					await nut.mouse.pressButton(RIGHT);
					break;
				case RemoteInputBehavior.releaseButtonRight:
					await nut.mouse.releaseButton(RIGHT);
					break;
				case RemoteInputBehavior.leftClick:
					await nut.mouse.click(LEFT);
					break;
				case RemoteInputBehavior.rightClick:
					await nut.mouse.click(RIGHT);
					break;
				case RemoteInputBehavior.doubleClick:
					await nut.mouse.doubleClick(LEFT);
					break;
				case RemoteInputBehavior.scrollDown:
					await nut.mouse.scrollDown(data.amount ?? 0);
					break;
				case RemoteInputBehavior.scrollUp:
					await nut.mouse.scrollUp(data.amount ?? 0);
					break;
				case RemoteInputBehavior.scrollLeft:
					await nut.mouse.scrollLeft(data.amount ?? 0);
					break;
				case RemoteInputBehavior.scrollRight:
					await nut.mouse.scrollRight(data.amount ?? 0);
					break;
				case RemoteInputBehavior.keyboardType:
					await nut.keyboard.type(...(data.key ?? []));
					break;
				case RemoteInputBehavior.keyboardPressKey:
					await nut.keyboard.pressKey(...(data.key ?? []));
					break;
				case RemoteInputBehavior.keyboardReleaseKey:
					await nut.keyboard.releaseKey(...(data.key ?? []));
					break;
				default:
					return { ok: false, error: `未知行为类型 ${data.type}` };
			}
			return { ok: true };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logService.error(`[RemoteControl] 注入失败 type=${data.type}: ${msg}`);
			return { ok: false, error: msg };
		}
	}
}

/**
 * 采集页 HTML：负责 getUserMedia 取屏 + RTCPeerConnection + DataChannel。
 * 信令经 IPC 代理到主进程（forwardSignal），键鼠指令经 IPC 交给 nut-js。
 */
const CAPTURE_PAGE_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>saros-remote-capture</title></head>
<body>
<script>
(async function () {
  const ipc = require('electron').ipcRenderer;
  const params = new URLSearchParams(location.search);
  const opts = JSON.parse(params.get('opts') || '{}');

  let pc = null, dc = null, stream = null;

  function log(m) { console.log('[capture] ' + m); }

  async function startStream() {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: opts.sourceId }
      }
    });
    log('stream ok tracks=' + stream.getVideoTracks().length);
  }

  function createPeer() {
    pc = new RTCPeerConnection({
      iceServers: [{ urls: opts.coturnUrl || 'turn:hk.hsslive.cn', username: 'hss', credential: '123456' }]
    });
    stream.getTracks().forEach(t => pc.addTrack(t, stream));

    pc.onicecandidate = e => {
      if (e.candidate) {
        ipc.invoke('saros:remoteCaptureSignal', { kind: 'candidate', data: e.candidate });
      }
    };

    // DataChannel 由**被控端**创建（billd-desk webRTC.ts:558）：
    //   createDataChannel('MessageChannel', { maxRetransmits: 3, ordered: false })
    // 主控端侧是 ondatachannel 接收；主控端的键鼠指令从本 channel 上行。
    dc = pc.createDataChannel('MessageChannel', { maxRetransmits: 3, ordered: false });
    dc.onopen = () => log('dataChannel open');
    dc.onerror = e => log('dataChannel error ' + e);
    dc.onmessage = e => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.msgType === 'billdDeskBehavior' && msg.data) {
          ipc.invoke('saros:remoteCaptureInput', msg.data);
        }
      } catch (err) { log('parse err ' + err); }
    };
  }

  // 「反向 offer」：等主进程收到 billdDeskStartRemoteResult 后才发 offer。
  ipc.on('saros:remoteStartOffer', async () => {
    try {
      log('startOffer');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await ipc.invoke('saros:remoteCaptureSignal', { kind: 'offer', data: offer });
      log('offer sent');
    } catch (err) { log('offer failed ' + err.message); }
  });

  ipc.on('saros:remoteApplyAnswer', async (_e, p) => {
    try {
      await pc.setRemoteDescription(p.sdp);
      log('answer applied');
    } catch (err) { log('answer failed ' + err.message); }
  });

  ipc.on('saros:remoteApplyCandidate', async (_e, p) => {
    try {
      await pc.addIceCandidate(p.candidate);
    } catch (err) { log('candidate failed ' + err.message); }
  });

  try {
    await startStream();
    createPeer();
    await ipc.invoke('saros:remoteCaptureReady');
    log('ready');
  } catch (err) {
    log('FAILED ' + err.message);
  }
})();
</script>
</body>
</html>`;
