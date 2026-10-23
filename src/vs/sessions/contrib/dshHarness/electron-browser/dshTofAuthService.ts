/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ITofAuthService, ITofUser, TofAuthError } from '../../agentStudio/common/tofAuth.js';
import { IBridgeTofStatus, IBridgeTofTicketResult } from '../common/dshBridgeProtocol.js';
import { DSH_HARNESS_CHANNEL, DshHarnessChannelCommand, DshHarnessChannelEvent, IDshHostStatus } from '../common/dshHarness.js';

/**
 * 企业身份（TOF/OA）—— IDE 侧的**纯转发实现**（★ 2026-10-23 用户："TOF 所有功能都转移到 dsh 侧，
 * IDE 侧无逻辑功能"）。
 *
 * 本类**没有任何登录逻辑**，只有四件事：
 *   1. `login()` / `logout()` → 转给 dsh（`TofSignIn` / `TofSignOut`，浏览器由 dsh 打开）；
 *   2. `restoreSession()` / `refresh` → 从 dsh 读状态与票据（`tof.status` / `tof.ticket`）；
 *   3. dsh 主动通知（`tof.changed`）⇒ 重读并发 `onDidChangeUser`；
 *   4. 桥断开 ⇒ 保持现状（**不能**把用户误判成登出 ✗）。
 *
 * 曾经的"旧路"（IDE 内置扩展 `tof-authentication` 持有票据 + 一次性迁移 + 老 Host 降级）
 * **已全部删除** —— 票据只有 dsh 一份。副作用（有意为之）：
 *   · 桥没连上 / Host 没起来 ⇒ 视为未登录（等 Host 起来后 `OnDidChangeStatus` 会重读）；
 *   · 老版本 Host（不认 `tof.status`）⇒ 未登录（不再降级到扩展）。
 *
 * 注册见 `dshHarness.contribution.ts`（desktop 入口后注册，覆盖 `agentStudio.contribution.ts` 里那份）。
 */
export class DshTofAuthService extends Disposable implements ITofAuthService {
	declare _serviceBrand: undefined;

	private readonly _channel: IChannel;

	private _user: ITofUser | null = null;
	private _ticket: string | null = null;
	private _isLoggingIn = false;
	private _restoring: Promise<ITofUser | null> | null = null;
	private _bridgeConnected = false;

	private readonly _onDidChangeUser = this._register(new Emitter<ITofUser | null>());
	readonly onDidChangeUser = this._onDidChangeUser.event;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		this._channel = mainProcessService.getChannel(DSH_HARNESS_CHANNEL);
		// dsh 侧登录 / 登出（设置页、dsh 页面、工具、别的 IDE 窗口）⇒ 立刻重读
		// ⚠ `IChannel.listen<T>(event)` 返回的是 `Event<T>`（不是 Disposable）⇒ 要再调用一次传回调 ✓
		this._register(this._channel.listen<void>(DshHarnessChannelEvent.OnDidChangeTof)(
			() => void this.refresh('dsh 侧登录态变化'),
		));
		// 桥连上 ⇒ 重读（Host 刚起来 / 重启 / 换了版本）；断开 ⇒ 只标记，**不动用户状态**
		this._register(this._channel.listen<IDshHostStatus>(DshHarnessChannelEvent.OnDidChangeStatus)(
			(status: IDshHostStatus) => {
				const connected = status?.bridge === 'connected';
				if (connected && !this._bridgeConnected) {
					this._bridgeConnected = true;
					void this.restoreSession();
				} else if (!connected && this._bridgeConnected) {
					this._bridgeConnected = false;
				}
			},
		));
	}

	/** 企业身份**只由 dsh 持有**（接口保留该字段，但值恒定）。 */
	get holder(): 'dsh' | 'ide' { return 'dsh'; }

	get currentUser(): ITofUser | null { return this._user; }
	get currentTicket(): string | null { return this._ticket; }
	get isLoggingIn(): boolean { return this._isLoggingIn; }

	// --- 登录 / 登出（都只是转发，IDE 不做任何认证动作）-------------------------

	async login(): Promise<ITofUser> {
		if (this._isLoggingIn) {
			throw new TofAuthError('登录正在进行中，请稍候', 'already_in_progress');
		}
		this._isLoggingIn = true;
		this._log.info('[TofAuth] 企业身份登录交给 dsh 侧（由 dsh 打开系统浏览器）…');
		try {
			await this._channel.call<IBridgeTofStatus>(DshHarnessChannelCommand.TofSignIn);
			const user = await this.refresh('dsh 侧登录完成');
			if (!user) {
				throw new TofAuthError('dsh 侧登录完成但未能读到身份信息', 'no_user');
			}
			this._log.info(`[TofAuth] dsh 侧登录成功：staff_id=${user.staff_id} login_name=${user.login_name}`);
			return user;
		} catch (e) {
			this._log.error('[TofAuth] dsh 侧登录失败:', e);
			throw e instanceof TofAuthError ? e : new TofAuthError(`登录失败：${(e as Error)?.message ?? e}`, 'login_failed');
		} finally {
			this._isLoggingIn = false;
		}
	}

	async logout(): Promise<void> {
		this._log.info('[TofAuth] 企业身份登出交给 dsh 侧…');
		try {
			await this._channel.call(DshHarnessChannelCommand.TofSignOut);
		} finally {
			// 无论 dsh 侧是否成功，本地镜像都不该继续显示"已登录"（下次 refresh 以 dsh 为准）
			this._setUser(null, null);
		}
	}

	restoreSession(): Promise<ITofUser | null> {
		if (this._restoring) {
			return this._restoring;
		}
		this._restoring = (async () => {
			try {
				return await this.refresh('启动恢复');
			} finally {
				this._restoring = null;
			}
		})();
		return this._restoring;
	}

	/**
	 * 从 dsh 重读状态与票据（有变化才发事件）。
	 *
	 * ⚠ 读失败（桥刚断 / Host 没起来）⇒ **保持现状**，不能把用户误判成登出 ✗
	 */
	async refresh(reason: string): Promise<ITofUser | null> {
		let status: IBridgeTofStatus;
		try {
			status = await this._channel.call<IBridgeTofStatus>(DshHarnessChannelCommand.TofStatus, {});
		} catch (e) {
			this._log.info(`[TofAuth] 读 dsh 侧企业身份失败（${reason}），保持现状：${String((e as Error)?.message ?? e)}`);
			return this._user;
		}
		if (!status.signedIn) {
			if (status.expired) {
				// 票据被网关拒绝：dsh 侧自己会负责"要不要重新登录"，IDE 只是如实转述（不自动开浏览器）
				this._log.info('[TofAuth] dsh 侧企业身份已失效（票据被网关拒绝）⇒ 视为未登录（不自动重登）');
			}
			this._setUser(null, null);
			return null;
		}
		let ticket: string | null = null;
		try {
			ticket = (await this._channel.call<IBridgeTofTicketResult>(DshHarnessChannelCommand.TofTicket)).ticket ?? null;
		} catch {
			ticket = this._ticket;   // 取票失败 ⇒ 沿用手上那张（身份以状态为准）
		}
		const user: ITofUser = {
			user_id: status.userId || `taihu:staffid:${status.staffId ?? ''}`,
			staff_id: String(status.staffId ?? ''),
			login_name: String(status.loginName ?? ''),
			team: status.team ?? null,
			is_admin: !!status.isAdmin,
			expires_at: String(status.expiresAt ?? ''),
		};
		this._setUser(user, ticket);
		return user;
	}

	private _setUser(user: ITofUser | null, ticket: string | null): void {
		const before = this._user;
		const changed = (before?.staff_id ?? null) !== (user?.staff_id ?? null)
			|| (before?.login_name ?? null) !== (user?.login_name ?? null)
			|| (before?.team ?? null) !== (user?.team ?? null)
			|| this._ticket !== ticket;
		this._user = user;
		this._ticket = user ? ticket : null;
		if (changed) {
			this._onDidChangeUser.fire(user);
		}
	}
}
