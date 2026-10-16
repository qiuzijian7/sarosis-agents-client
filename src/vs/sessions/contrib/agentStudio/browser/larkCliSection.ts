/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「飞书 CLI」区块（从 `agentSettingsEditorPane.ts` 外提，2026-10-12）。
 *
 * 外提原因：那个 Pane 超了 2500 行的规模预算（`test/common/fileSizeBudget.test.ts` 守着），
 * 而「飞书 CLI 安装/状态/升级 + 扫码建机器人 + 取 chat_id」是一块**自洽的协作对象**：
 * 自己建 DOM、自己探测、自己渲染、自己处理扫码轮询。
 *
 * ## 为什么正文是**逐字搬**的
 *
 * 被搬代码对服务与"活状态"的引用一字未改 —— 由下面这批 **getter** 转发到 `host`：
 *   · 服务：notificationService / configurationService / requestService
 *   · 活状态：readOnly / bindingInput（用**函数**读取，所以"切只读 / 换输入框"无需同步 push ✓）
 *   · 宿主流程：_addFeishuBinding（群列表「绑定到本 Agent」复用既有渠道绑定）
 * 于是搬迁只改 2 个入口名 + 2 处自调用 ✓。
 *
 * ## 行为网
 *
 * `test/browser/larkCliSection.test.ts`（17 条，jsdom 真 DOM）在**搬迁前就已全绿**（且有 7 条
 * 反向突变证明它不空跑），搬迁后必须仍全绿 ⇒ 那就是"行为没变"的证据。改这里的行为前先看它 ✓。
 *
 * ## 下面这段是原状搬过来的区块说明（2026-09-23）
 *
 * // ── Channel 绑定 · 飞书 CLI（2026-09-23）──────────────────────────────
 * //
 * // 三件事：
 * //   ① CLI 的安装 / 状态 / 升级 —— 探测与安装都要 child_process ⇒ 走主进程
 * //      （`electron-main/larkCliChannel.ts` ← `browser/larkCliService.ts`）；
 * //   ② 创建机器人 —— 复用产品内**已验证**的 PersonalAgent 扫码流程。飞书 CLI 自己的
 * //      `config init --new` 需要浏览器交互、输出是给人看的文本（解析不稳定），不适合内联做；
 * //   ③ 获取 chat_id —— 用渠道自身 app 凭证列「机器人所在的群」（与扫码绑定/测试连接同一条链路）。
 * //      刻意不依赖 CLI：CLI 要先 `config init` / `auth login` 才有凭证，而渠道配置里已经有了。
 *
 */

import { LARK_CLI_INSTALL_COMMAND, LARK_CLI_PACKAGE, larkCliStatusBadge, type ILarkCliStatus } from '../common/larkCli.js';
import { getLarkCliStatus, installLarkCli } from './larkCliService.js';
import { fetchFeishuChats } from './feishuChatList.js';
import { beginFeishuRegistration, pollFeishuRegistration } from './feishuRegistration.js';
import { drawQrToCanvas } from './feishuQrCode.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import * as DOM from '../../../../base/browser/dom.js';

const { $: $$ } = DOM;

/** 宿主注入面：三个服务 + 两个"活状态"读取函数 + 一个宿主流程回调。 */
export interface ILarkCliSectionHost {
	readonly notificationService: INotificationService;
	readonly configurationService: IConfigurationService;
	readonly requestService: IRequestService;
	/** 当前是否只读（读取函数，不要传快照）。 */
	readonly readOnly: () => boolean;
	/** 渠道会话 ID 输入框（「填入」按钮要往里写值；可能不存在）。 */
	readonly bindingInput: () => HTMLInputElement | undefined;
	/** 复用宿主既有的「绑定到本 Agent」流程（群列表那一行按钮）。 */
	addFeishuBinding(): void;
}

/** 飞书 CLI 区块：自管 DOM、探测、安装与扫码轮询。 */
export class LarkCliSection {

	private readonly _host: ILarkCliSectionHost;

	// ── 本区块自己的状态（原先挂在 Pane 上）──
	private _larkCliStatus: ILarkCliStatus | undefined;
	private _larkCliProbing = false;
	private _larkCliInstalling = false;
	private _larkCliStatusEl: HTMLElement | undefined;
	private _larkCliDetailEl: HTMLElement | undefined;
	private _larkCliCheckBtn: HTMLButtonElement | undefined;
	private _larkCliInstallBtn: HTMLButtonElement | undefined;
	private _larkCliOutputEl: HTMLElement | undefined;
	private _larkCliQrEl: HTMLElement | undefined;
	private _larkCliQrPolling = false;
	private _larkCliCreateBtn: HTMLButtonElement | undefined;
	private _chatIdListEl: HTMLElement | undefined;
	private _chatIdFetchBtn: HTMLButtonElement | undefined;

	constructor(host: ILarkCliSectionHost) {
		this._host = host;
	}

	// ── host 转发（正文一字未改的关键）──
	private get notificationService(): INotificationService { return this._host.notificationService; }
	private get configurationService(): IConfigurationService { return this._host.configurationService; }
	private get _requestService(): IRequestService { return this._host.requestService; }
	private get _readOnly(): boolean { return this._host.readOnly(); }
	private get _bindingInput(): HTMLInputElement | undefined { return this._host.bindingInput(); }
	private _addFeishuBinding(): void { this._host.addFeishuBinding(); }

	// ── Channel 绑定 · 飞书 CLI（2026-09-23）──────────────────────────────
	//
	// 三件事：
	//   ① CLI 的安装 / 状态 / 升级 —— 探测与安装都要 child_process ⇒ 走主进程
	//      （`electron-main/larkCliChannel.ts` ← `browser/larkCliService.ts`）；
	//   ② 创建机器人 —— 复用产品内**已验证**的 PersonalAgent 扫码流程。飞书 CLI 自己的
	//      `config init --new` 需要浏览器交互、输出是给人看的文本（解析不稳定），不适合内联做；
	//   ③ 获取 chat_id —— 用渠道自身 app 凭证列「机器人所在的群」（与扫码绑定/测试连接同一条链路）。
	//      刻意不依赖 CLI：CLI 要先 `config init` / `auth login` 才有凭证，而渠道配置里已经有了。

	/** 构建「飞书 CLI」分组（加入 Channel 绑定页签的飞书渠道分组）。 */
	build(): HTMLElement {
		const sec = $$('div.binding-section');
		const title = $$('div.binding-section-title');
		title.textContent = '飞书 CLI';
		sec.appendChild(title);

		const hint = $$('div.binding-hint');
		hint.textContent = `官方 CLI（${LARK_CLI_PACKAGE}）：装好后可在终端用 lark-cli 直接操作飞书（发消息 / 查群 / 读写文档），也供 AI 技能调用。安装与升级是同一条命令 —— 官方文档未提供独立的 upgrade 子命令。`;
		sec.appendChild(hint);

		// 状态行：徽章 + 版本/路径 + 两个动作
		const statusRow = $$('div.binding-add-row');
		this._larkCliStatusEl = $$('span.larkcli-badge');
		this._larkCliStatusEl.textContent = '检测中…';
		statusRow.appendChild(this._larkCliStatusEl);
		this._larkCliDetailEl = $$('span.larkcli-detail');
		statusRow.appendChild(this._larkCliDetailEl);
		this._larkCliCheckBtn = $$('button.agent-settings-btn') as HTMLButtonElement;
		this._larkCliCheckBtn.textContent = '🔄 重新检测';
		this._larkCliCheckBtn.onclick = () => void this.refresh(true);
		statusRow.appendChild(this._larkCliCheckBtn);
		this._larkCliInstallBtn = $$('button.agent-settings-btn primary') as HTMLButtonElement;
		this._larkCliInstallBtn.onclick = () => void this._installLarkCli();
		statusRow.appendChild(this._larkCliInstallBtn);
		sec.appendChild(statusRow);

		this._larkCliOutputEl = $$('div.larkcli-output');
		this._larkCliOutputEl.style.display = 'none';
		sec.appendChild(this._larkCliOutputEl);

		// 创建机器人（扫码）
		const botRow = $$('div.binding-add-row');
		this._larkCliCreateBtn = $$('button.agent-settings-btn') as HTMLButtonElement;
		this._larkCliCreateBtn.textContent = '🤖 创建机器人（扫码授权）';
		this._larkCliCreateBtn.onclick = () => void this._createFeishuBotByQr();
		botRow.appendChild(this._larkCliCreateBtn);
		const botHint = $$('span.larkcli-detail');
		botHint.textContent = '扫码授权后自动写入渠道凭证（app_id / app_secret），无需手工复制。';
		botRow.appendChild(botHint);
		sec.appendChild(botRow);
		this._larkCliQrEl = $$('div.larkcli-qr');
		this._larkCliQrEl.style.display = 'none';
		sec.appendChild(this._larkCliQrEl);

		// 获取 chat_id
		const chatRow = $$('div.binding-add-row');
		this._chatIdFetchBtn = $$('button.agent-settings-btn') as HTMLButtonElement;
		this._chatIdFetchBtn.textContent = '📋 获取 chat_id（机器人所在的群）';
		this._chatIdFetchBtn.onclick = () => void this._fetchChatIds();
		chatRow.appendChild(this._chatIdFetchBtn);
		sec.appendChild(chatRow);
		this._chatIdListEl = $$('div.chatid-list');
		sec.appendChild(this._chatIdListEl);

		return sec;
	}

	/** 刷新 CLI 状态（页签切入时静默探测；手动点击给通知）。 */
	async refresh(manual: boolean): Promise<void> {
		if (this._larkCliProbing) { return; }
		this._larkCliProbing = true;
		this._applyLarkCliBusy();
		try {
			const status = await getLarkCliStatus();
			this._larkCliStatus = status;
			this._renderLarkCliStatus();
			if (manual) {
				if (!status.available) {
					this.notificationService.warn(`飞书 CLI 探测不可用：${status.error ?? '未知原因'}`);
				} else if (!status.installed) {
					this.notificationService.info(`未检测到飞书 CLI${status.latestVersion ? `（npm 最新 ${status.latestVersion}）` : ''}，可点「安装」`);
				} else {
					const badge = larkCliStatusBadge(status);
					this.notificationService.info(badge.tone === 'warn'
						? `飞书 CLI ${status.version} 可升级到 ${status.latestVersion}`
						: `飞书 CLI 就绪：${badge.label}`);
				}
			}
		} finally {
			this._larkCliProbing = false;
			this._applyLarkCliBusy();
		}
	}

	/** 按状态刷新徽章 / 详情 / 按钮文案。 */
	private _renderLarkCliStatus(): void {
		const status = this._larkCliStatus;
		const badge = larkCliStatusBadge(status);
		if (this._larkCliStatusEl) {
			this._larkCliStatusEl.textContent = badge.label;
			this._larkCliStatusEl.className = `larkcli-badge tone-${badge.tone}`;
			this._larkCliStatusEl.title = status?.error ?? '';
		}
		if (this._larkCliDetailEl) {
			const parts: string[] = [];
			if (status?.path) { parts.push(status.path); }
			if (status?.latestVersion) { parts.push(`npm 最新 ${status.latestVersion}`); }
			if (status?.available && !status.installed) { parts.push(`将执行：${LARK_CLI_INSTALL_COMMAND}`); }
			if (!status?.available && status?.error) { parts.push(status.error); }
			this._larkCliDetailEl.textContent = parts.join(' · ');
		}
		if (this._larkCliInstallBtn) {
			this._larkCliInstallBtn.textContent = this._larkCliInstalling ? '⏳ 安装中…' : (status?.installed ? '⬆ 升级' : '⬇ 安装');
			this._larkCliInstallBtn.disabled = this._readOnly || this._larkCliInstalling || !status?.available;
		}
	}

	/** 忙碌态统一处理（探测 / 安装期间禁用按钮并改文案）。 */
	private _applyLarkCliBusy(): void {
		const busy = this._larkCliProbing || this._larkCliInstalling;
		if (this._larkCliCheckBtn) {
			this._larkCliCheckBtn.disabled = this._readOnly || busy;
			this._larkCliCheckBtn.textContent = this._larkCliProbing ? '⏳ 检测中…' : '🔄 重新检测';
		}
		if (this._larkCliInstallBtn) {
			this._larkCliInstallBtn.disabled = this._readOnly || busy || this._larkCliStatus?.available === false;
		}
	}

	/** 安装 / 升级（同一命令）；完成后自动重新探测并回显输出尾部。 */
	private async _installLarkCli(): Promise<void> {
		if (this._larkCliInstalling) { return; }
		this._larkCliInstalling = true;
		this._applyLarkCliBusy();
		this._showLarkCliOutput(`⏳ 正在执行：${LARK_CLI_INSTALL_COMMAND}\n（首次安装会下载依赖，可能 1-2 分钟）`);
		this.notificationService.info('正在主进程执行飞书 CLI 安装 / 升级');
		try {
			const r = await installLarkCli();
			this._showLarkCliOutput(`${r.ok ? '✅' : '❌'} ${r.message}${r.output ? `\n\n${r.output}` : ''}`);
			if (r.ok) {
				this.notificationService.info(r.message);
			} else {
				this.notificationService.error(`飞书 CLI 安装失败：${r.message}`);
			}
		} finally {
			this._larkCliInstalling = false;
			this._applyLarkCliBusy();
			await this.refresh(false);
		}
	}

	private _showLarkCliOutput(text: string): void {
		if (!this._larkCliOutputEl) { return; }
		this._larkCliOutputEl.textContent = text;
		this._larkCliOutputEl.style.display = '';
	}

	/**
	 * 创建机器人：复用 PersonalAgent 扫码流程（与渠道编辑器的「📷 扫码绑定」同一协议）。
	 * 授权完成后把 app_id / app_secret 写入渠道配置并启用（与手工绑定同一落点）。
	 */
	private async _createFeishuBotByQr(): Promise<void> {
		if (this._larkCliQrPolling) { return; }
		const host = this._larkCliQrEl;
		const createBtn = this._larkCliCreateBtn;
		if (!host) { return; }

		host.replaceChildren();
		host.style.display = '';
		const canvas = document.createElement('canvas');
		canvas.className = 'larkcli-qr-canvas';
		const statusEl = $$('div.larkcli-qr-status');
		statusEl.textContent = '正在向飞书申请授权…';
		host.appendChild(canvas);
		host.appendChild(statusEl);

		this._larkCliQrPolling = true;
		if (createBtn) { createBtn.disabled = true; }
		const setStatus = (msg: string): void => { statusEl.textContent = msg; };

		try {
			const begin = await beginFeishuRegistration(this._requestService);
			drawQrToCanvas(canvas, begin.qrUrl);
			setStatus('请用飞书扫码授权（授权后自动创建机器人并回填凭证）');

			// 间隔与超时都取自服务端返回，避免写死
			const deadline = Date.now() + begin.expiresIn * 1000;
			let interval = begin.interval;
			while (Date.now() < deadline) {
				await this._larkCliSleep(interval * 1000);
				const r = await pollFeishuRegistration(this._requestService, begin.deviceCode);
				if (r.status === 'completed') {
					const appId = r.appId ?? '';
					const appSecret = r.appSecret ?? '';
					if (!appId || !appSecret) { setStatus('❌ 飞书未返回有效凭证'); return; }
					await this.configurationService.updateValue('sessions.channel.feishu.appId', appId);
					await this.configurationService.updateValue('sessions.channel.feishu.appSecret', appSecret);
					await this.configurationService.updateValue('sessions.channel.feishu.enabled', true);
					setStatus(`✅ 机器人已创建：${appId}（凭证已写入渠道配置并启用）`);
					this.notificationService.info(`飞书机器人已创建：${appId}`);
					return;
				}
				if (r.status === 'denied') { setStatus('❌ 授权被拒绝'); return; }
				if (r.status === 'expired') { setStatus('⌛ 授权已过期，请重新发起'); return; }
				if (r.status === 'error') { setStatus(`❌ ${r.error ?? '授权失败'}`); return; }
				if (r.status === 'slow_down') { interval += 5; }
			}
			setStatus('⌛ 等待超时，请重新发起');
		} catch (e) {
			setStatus(`❌ 发起失败：${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this._larkCliQrPolling = false;
			if (createBtn) { createBtn.disabled = false; }
		}
	}

	/** 获取 chat_id：列「机器人所在的群」，可一键填入输入框或直接绑定到本 Agent。 */
	private async _fetchChatIds(): Promise<void> {
		const listEl = this._chatIdListEl;
		if (!listEl) { return; }
		const appId = String(this.configurationService.getValue('sessions.channel.feishu.appId') ?? '').trim();
		const appSecret = String(this.configurationService.getValue('sessions.channel.feishu.appSecret') ?? '').trim();
		listEl.replaceChildren();
		if (!appId || !appSecret) {
			const tip = $$('div.skills-empty');
			tip.textContent = '尚未配置飞书应用凭证：先点上方「创建机器人（扫码授权）」，或手工填写 app_id / app_secret。';
			listEl.appendChild(tip);
			return;
		}
		if (this._chatIdFetchBtn) { this._chatIdFetchBtn.disabled = true; this._chatIdFetchBtn.textContent = '⏳ 拉取中…'; }
		try {
			const chats = await fetchFeishuChats(this._requestService, appId, appSecret);
			if (chats.length === 0) {
				const tip = $$('div.skills-empty');
				tip.textContent = '机器人还没有加入任何群：把机器人拉进一个群后重新拉取。';
				listEl.appendChild(tip);
				return;
			}
			for (const chat of chats) {
				const item = $$('div.chatid-item');
				const info = $$('div.chatid-item-info');
				const nameEl = $$('span.chatid-item-name');
				nameEl.textContent = chat.name;
				const idEl = $$('span.chatid-item-id');
				idEl.textContent = chat.memberCount ? `${chat.chatId} · ${chat.memberCount} 人` : chat.chatId;
				info.appendChild(nameEl);
				info.appendChild(idEl);
				item.appendChild(info);

				const fillBtn = $$('button.agent-settings-btn') as HTMLButtonElement;
				fillBtn.textContent = '填入';
				fillBtn.title = '填入上方「输入飞书群聊会话 ID」输入框';
				fillBtn.onclick = () => {
					if (this._bindingInput) { this._bindingInput.value = chat.chatId; this._bindingInput.focus(); }
				};
				item.appendChild(fillBtn);

				const bindBtn = $$('button.agent-settings-btn primary') as HTMLButtonElement;
				bindBtn.textContent = '绑定到本 Agent';
				bindBtn.disabled = this._readOnly;
				bindBtn.onclick = () => {
					if (this._bindingInput) { this._bindingInput.value = chat.chatId; }
					void this._addFeishuBinding();
				};
				item.appendChild(bindBtn);
				listEl.appendChild(item);
			}
		} catch (e) {
			const tip = $$('div.skills-empty');
			tip.textContent = `拉取群列表失败：${e instanceof Error ? e.message : String(e)}`;
			listEl.appendChild(tip);
		} finally {
			if (this._chatIdFetchBtn) {
				this._chatIdFetchBtn.disabled = false;
				this._chatIdFetchBtn.textContent = '📋 获取 chat_id（机器人所在的群）';
			}
		}
	}

	/** 轮询间隔用的简单延时（独立命名，避免与其它页签的同名 helper 冲突）。 */
	private _larkCliSleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}
