/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ITofAuthService, ITofUser, TofAuthError } from '../common/tofAuth.js';

/**
 * 企业身份（TOF/OA）—— **IDE 侧的占位实现**（★ 2026-10-23 用户："TOF 所有功能都转移到 dsh 侧，
 * IDE 侧无逻辑功能"）。
 *
 * 本类**不持有任何票据、不执行任何登录流程**，只用来保证 `ITofAuthService` 在任何运行形态下
 * 都能被注入（否则 DI 会报"服务未注册"）：
 *   · **桌面版**：由 `dshHarness.contribution.ts` 后注册的 `DshTofAuthService` 覆盖 ⇒ 本类不会被用到；
 *   · 其它形态（无 dsh Host）：本类生效 —— 状态恒为"未登录"，`login()` **如实报错**并指向 dsh，
 *     **不假装成功、也不自己开浏览器** ✓
 *
 * 被删掉的东西（历史，别再加回来）：
 *   · 基于 `IAuthenticationService`（内置扩展 `tof-authentication` 的 `tof` provider）的登录/取票；
 *   · `readStoredTicket()`（给 dsh 做一次性迁移用，迁移已完成）；
 *   · `PROVIDER_ID` / `SCOPES` / 命令触发等一切认证细节。
 *
 * 为什么保留类名而不删文件：`agentStudio.contribution.ts` 里 `registerSingleton(ITofAuthService, TofAuthService)`
 * 是**非桌面入口**的唯一注册点；删掉它会让这些形态下所有 `@ITofAuthService` 注入直接失败 ✗
 */
export class TofAuthService extends Disposable implements ITofAuthService {
	declare _serviceBrand: undefined;

	private readonly _onDidChangeUser = this._register(new Emitter<ITofUser | null>());
	readonly onDidChangeUser = this._onDidChangeUser.event;

	/** 没有 dsh Host 可用时，身份**不存在**（不是"暂时没读到"）。 */
	get currentUser(): ITofUser | null { return null; }
	get currentTicket(): string | null { return null; }
	get isLoggingIn(): boolean { return false; }

	/** 固定 `ide` —— 表示"本实现不持有身份"（消费方据此不做票据同步）。 */
	readonly holder = 'ide' as const;

	constructor(@ILogService private readonly _log: ILogService) {
		super();
	}

	async login(): Promise<ITofUser> {
		this._log.warn('[TofAuth] 登录请求被拒：企业身份已统一由 dsh 侧处理（IDE 侧不再执行登录流程）');
		throw new TofAuthError(
			'企业身份登录已统一在 dsh 侧：请在 dsh 界面（或 IDE 账号菜单）触发登录，IDE 不再自己走 OA 流程',
			'moved_to_dsh',
		);
	}

	async logout(): Promise<void> {
		// 没有本地身份可清（真身在 dsh）⇒ 无事可做，也不能假装清掉了什么
		this._log.info('[TofAuth] 登出请求忽略：企业身份由 dsh 侧持有');
	}

	async restoreSession(): Promise<ITofUser | null> {
		// 没有 dsh Host ⇒ 永远未登录。**不**自动开浏览器（那正是被移除的旧行为）✗
		return null;
	}
}
