/*---------------------------------------------------------------------------------------------
 *  TOF (Tencent OA Framework) 用户身份与配置类型
 *--------------------------------------------------------------------------------------------*/

/** 对应 OAuthSystem 网关 GET /api/v1/whoami 返回结构 */
export interface ITofUser {
	user_id: string;
	staff_id: string;
	login_name: string;
	team: string | null;
	is_admin: boolean;
	expires_at: string;
}

/** 持久化到 SecretStorage 的会话数据 */
export interface ITofStoredSession {
	id: string;
	ticket: string;
	user: ITofUser;
	createdAt: number;
}

/** 从 vscode 配置读取的 TOF 登录参数 */
export interface ITofConfig {
	paasid: string;
	siteBaseUrl: string;
	gatewayBaseUrl: string;
	timeoutSeconds: number;
}

/** TOF 登录错误 */
export class TofAuthError extends Error {
	constructor(message: string, public readonly code: string = 'tof_auth_error') {
		super(message);
		this.name = 'TofAuthError';
	}
}
