/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * TOF (Tencent OA Framework) 登录用户身份信息。
 * 对应 OAuthSystem 网关 GET /api/v1/whoami 返回结构。
 */
export interface ITofUser {
	/** 内部标准用户 ID，格式 taihu:staffid:<StaffId> */
	readonly user_id: string;
	/** 原始太湖 StaffId */
	readonly staff_id: string;
	/** OA 登录名（英文名） */
	readonly login_name: string;
	/** 团队 / 部门 */
	readonly team: string | null;
	/** 是否管理员 */
	readonly is_admin: boolean;
	/** 票据过期时间（ISO 8601） */
	readonly expires_at: string;
}

/**
 * TOF 登录服务 — 对接 OAuthSystem 网关 (太湖 MCP 鉴权网关)。
 *
 * 登录流程 (system browser + local callback):
 *  1. 启动本地 HTTP server 监听 127.0.0.1:<random_port>
 *  2. 打开系统浏览器到 passport.woa.com signin.ashx
 *  3. 用户在浏览器完成 iOA 登录
 *  4. TOF 302 → 网关 /api/v1/auth/tof/callback → 网关用 code 换身份 →
 *     网关 302 → http://127.0.0.1:<port>/got?identity=<ticket>&state=<state>
 *  5. 本地 server 捕获 ticket，校验 state，返回 x-tai-identity
 *  6. 用 ticket 调 /api/v1/whoami 获取用户身份
 *
 * 谁执行这套流程（★ 2026-10-23 用户："TOF 所有功能都转移到 dsh 侧，IDE 侧无逻辑功能"）：
 *  - **只有 dsh 侧**：`dsh-plugins/vssaros-bridge/lib/tof.js` 自己起 loopback server、校验 state、
 *    开浏览器、持有票据、判过期（入口 `tof_signin` / `tof_signout` / `tof_status` + `vssarosTof.ticket()`）。
 *  - IDE 侧**只剩转发**：`DshTofAuthService`（desktop）把 login/logout 转给 dsh，状态与票据从 dsh 读；
 *    `TofAuthService`（非桌面兜底）是**占位**：恒为未登录，`login()` 直接报"去 dsh 登录"。
 *  - **IDE 不再有任何登录流程**：扩展 `extensions/tof-authentication` 已停止注册 `tof` provider，
 *    `tofAuthProvider` / `tofAuthServer` / `tofGatewayClient` 三个实现文件已删除
 *    （该扩展现在只剩商城的 HTTP/tar 命令，与 TOF 无关）。
 *  - 两条铁律：票据过期**不自动开浏览器**（只报"已失效"，由用户自己点登录）；
 *    桥断开 / Host 没起来时**保持现状**，不能把用户误判成登出。
 */
export const ITofAuthService = createDecorator<ITofAuthService>('tofAuthService');

export interface ITofAuthService {
	readonly _serviceBrand: undefined;

	/** 当前登录用户（null 表示未登录） */
	readonly currentUser: ITofUser | null;
	/** 当前 x-tai-identity 票据（null 表示未登录） */
	readonly currentTicket: string | null;
	/** 用户变更事件 */
	readonly onDidChangeUser: Event<ITofUser | null>;

	/**
	 * 企业身份由谁持有：`dsh` = dsh 侧持有（IDE 只读镜像）；`ide` = IDE 内置扩展持有。
	 * IDE → dsh 的票据同步（`tof.sync`）只在 `ide` 时需要。
	 */
	readonly holder: 'dsh' | 'ide';

	/**
	 * 发起 TOF 浏览器登录。
	 * 启动本地回调 server，打开系统浏览器，等待用户完成 iOA 登录。
	 * 成功后持久化票据并刷新 currentUser。
	 * @throws TofAuthError 登录失败（超时 / state 不匹配 / 网关不可达）
	 */
	login(): Promise<ITofUser>;

	/** 登出：清除本地票据和用户信息 */
	logout(): Promise<void>;

	/**
	 * 读回已保存的登录态（启动时自动调用）。
	 * 票据过期或校验失败时视为未登录 —— **不**自动打开浏览器重登。
	 */
	restoreSession(): Promise<ITofUser | null>;

	/** 是否正在登录流程中 */
	readonly isLoggingIn: boolean;
}

/** TOF 登录错误 */
export class TofAuthError extends Error {
	constructor(message: string, public readonly code: string = 'tof_auth_error') {
		super(message);
		this.name = 'TofAuthError';
	}
}
