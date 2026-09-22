/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── 飞书 PersonalAgent 注册流程（Device Flow）──
// 协议与 cc-connect 对齐：POST application/x-www-form-urlencoded 到
// https://accounts.feishu.cn/oauth/v1/app/registration
//   action=init → 探测支持的鉴权方式
//   action=begin&archetype=PersonalAgent&auth_method=client_secret&request_user_info=open_id
//          → 返回 device_code + verification_uri_complete（即二维码要编码的 URL）
//   action=poll&device_code=... → 用户扫码授权后返回 client_id/client_secret（即 app_id/app_secret）
//
// 通过 IRequestService 走主进程（node）发请求，绕过浏览器 CORS 限制。

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { asText, IRequestService } from '../../../../platform/request/common/request.js';

const FEISHU_ACCOUNTS_BASE = 'https://accounts.feishu.cn';
const LARK_ACCOUNTS_BASE = 'https://accounts.larksuite.com';
const REGISTRATION_ENDPOINT = '/oauth/v1/app/registration';

/** 飞书 / Lark 开放平台 OpenAPI 基址（自检探针用）。 */
export const FEISHU_OPEN_BASE = 'https://open.feishu.cn/open-apis';
export const LARK_OPEN_BASE = 'https://open.larksuite.com/open-apis';

export interface FeishuBeginResult {
	readonly deviceCode: string;
	readonly qrUrl: string;
	readonly interval: number;
	readonly expiresIn: number;
}

export type FeishuPollStatus = 'pending' | 'completed' | 'denied' | 'expired' | 'error' | 'slow_down';

export interface FeishuPollResult {
	readonly status: FeishuPollStatus;
	readonly appId?: string;
	readonly appSecret?: string;
	readonly ownerOpenId?: string;
	readonly platform?: 'feishu' | 'lark';
	readonly error?: string;
	readonly baseUrl?: string;
}

function buildForm(params: Record<string, string>): string {
	const form = new URLSearchParams();
	for (const key in params) {
		form.set(key, params[key]);
	}
	return form.toString();
}

async function postForm(
	requestService: IRequestService,
	baseUrl: string,
	params: Record<string, string>,
): Promise<Record<string, any>> {
	const ctx = await requestService.request(
		{
			url: baseUrl + REGISTRATION_ENDPOINT,
			type: 'POST',
			data: buildForm(params),
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			callSite: 'feishuRegistration',
		},
		CancellationToken.None,
	);
	const text = await asText(ctx);
	if (!text) {
		throw new Error('飞书注册接口返回空响应');
	}
	let json: Record<string, any>;
	try {
		json = JSON.parse(text) as Record<string, any>;
	} catch (e) {
		throw new Error('飞书注册接口返回非 JSON：' + text.slice(0, 200));
	}
	// ★ 2026-09-22 修复（D-06）：**不再在这里因 `error` 字段抛错**。
	//   Device Flow 的协议状态（authorization_pending / slow_down / access_denied /
	//   expired_token / 未知错误）是「轮询状态」而不是「传输失败」——必须原样交给
	//   `pollFeishuRegistration` 做状态映射，否则 UI 只能看到笼统的「失败」，
	//   用户被提示「被拒绝」「已过期」的精确信息全部丢失。
	//   只有真实的传输/解析失败（空响应 / 非 JSON）才在上面抛错。
	return json;
}

/** 发起注册：返回 device_code 与二维码 URL。 */
export async function beginFeishuRegistration(requestService: IRequestService): Promise<FeishuBeginResult> {
	// init：探测支持的鉴权方式（忽略其错误，部分环境无返回）
	try {
		await postForm(requestService, FEISHU_ACCOUNTS_BASE, { action: 'init' });
	} catch {
		// init 失败时仍可尝试 begin
	}

	const begin = await postForm(requestService, FEISHU_ACCOUNTS_BASE, {
		action: 'begin',
		'archetype': 'PersonalAgent',
		'auth_method': 'client_secret',
		'request_user_info': 'open_id',
	});

	const deviceCode = typeof begin['device_code'] === 'string' ? begin['device_code'] : '';
	const qrUrl = typeof begin['verification_uri_complete'] === 'string' ? begin['verification_uri_complete'] : '';
	if (!deviceCode || !qrUrl) {
		throw new Error('飞书 begin 接口返回不完整（缺少 device_code / verification_uri_complete）');
	}
	const interval = typeof begin['interval'] === 'number' ? begin['interval'] : (typeof begin['interval'] === 'string' ? Number(begin['interval']) : 5);
	const expiresIn = typeof begin['expire_in'] === 'number' ? begin['expire_in'] : (typeof begin['expire_in'] === 'string' ? Number(begin['expire_in']) : 300);
	return {
		deviceCode,
		qrUrl,
		interval: Number.isFinite(interval) && interval > 0 ? interval : 5,
		expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 300,
	};
}

/** 轮询注册状态，直到用户扫码授权或超时/拒绝。 */
export async function pollFeishuRegistration(
	requestService: IRequestService,
	deviceCode: string,
	baseUrl: string = FEISHU_ACCOUNTS_BASE,
): Promise<FeishuPollResult> {
	const resp = await postForm(requestService, baseUrl, {
		action: 'poll',
		'device_code': deviceCode,
	});

	const clientId = typeof resp['client_id'] === 'string' ? resp['client_id'] : '';
	const clientSecret = typeof resp['client_secret'] === 'string' ? resp['client_secret'] : '';
	if (clientId && clientSecret) {
		const ui = (resp['user_info'] ?? {}) as Record<string, any>;
		const brand = typeof ui['tenant_brand'] === 'string' ? String(ui['tenant_brand']).toLowerCase() : '';
		const openId = typeof ui['open_id'] === 'string' ? ui['open_id'] : '';
		return {
			status: 'completed',
			appId: clientId,
			appSecret: clientSecret,
			ownerOpenId: openId,
			platform: brand === 'lark' ? 'lark' : 'feishu',
			baseUrl,
		};
	}

	const err = typeof resp['error'] === 'string' ? resp['error'] : '';
	switch (err) {
		case 'authorization_pending':
			return { status: 'pending', baseUrl };
		case 'slow_down':
			return { status: 'slow_down', baseUrl };
		case 'access_denied':
			return { status: 'denied', baseUrl };
		case 'expired_token':
			return { status: 'expired', baseUrl };
		default:
			if (err) {
				return { status: 'error', error: err, baseUrl };
			}
			return { status: 'pending', baseUrl };
	}
}

/** Lark 域名自动切换（仅当用户账号属于 Lark 时由调用方处理，这里仅暴露常量）。 */
export const FEISHU_BASE = FEISHU_ACCOUNTS_BASE;
export const LARK_BASE = LARK_ACCOUNTS_BASE;

// ─── 凭证自检探针（★ 2026-09-22 新增，修复 D-03）─────────────────────────
//
// 此前「测试连接」只做「字段非空」的假检查，用户填错凭证也会显示成功，
// 导致「配置成功但渠道不工作」的最后一环假象。现在做真实探测：
// 调 `/auth/v3/tenant_access_token/internal`，用飞书返回码说话。
// 网络出口走注入的 IRequestService（装配侧应传主进程出口，见 D-12）。

export interface FeishuProbeResult {
	readonly ok: boolean;
	readonly message: string;
	/** 成功时回显的 token 前缀（仅前 6 字符 + 省略号，用于交叉核对）。 */
	readonly tokenPrefix?: string;
}

/**
 * 真实探测 appId/appSecret 是否可换取 tenant_access_token。
 *
 * @param openBase OpenAPI 基址（Lark 用 LARK_OPEN_BASE）。
 * 约定：任何失败都以 `{ok:false, message}` 返回（不抛错），网络异常消息中的 appSecret 会被脱敏。
 */
export async function probeFeishuCredentials(
	requestService: IRequestService,
	appId: string,
	appSecret: string,
	openBase: string = FEISHU_OPEN_BASE,
): Promise<FeishuProbeResult> {
	if (!appId || !appSecret) {
		return { ok: false, message: '请先填写 App ID 与 App Secret（或使用扫码绑定）' };
	}
	const url = `${openBase}/auth/v3/tenant_access_token/internal`;
	try {
		const ctx = await requestService.request(
			{
				url,
				type: 'POST',
				data: JSON.stringify({ app_id: appId, app_secret: appSecret }),
				headers: { 'Content-Type': 'application/json' },
				callSite: 'feishuProbe',
			},
			CancellationToken.None,
		);
		const status = ctx.res.statusCode ?? 0;
		const text = (await asText(ctx)) ?? '';
		if (!text) {
			return { ok: false, message: `凭证自检失败：空响应（HTTP ${status}）` };
		}
		let data: { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
		try {
			data = JSON.parse(text) as typeof data;
		} catch {
			return { ok: false, message: `凭证自检失败：非 JSON 响应（HTTP ${status}）→ ${text.slice(0, 120)}` };
		}
		if (data.code !== 0 || !data.tenant_access_token) {
			return { ok: false, message: `凭证自检失败（HTTP ${status} code=${data.code ?? '?'}）：${data.msg ?? '(无 msg)'}` };
		}
		const expire = typeof data.expire === 'number' ? data.expire : 7200;
		return {
			ok: true,
			message: `连接成功：token 有效期 ${expire}s`,
			tokenPrefix: `${data.tenant_access_token.slice(0, 6)}…`,
		};
	} catch (err) {
		// 网络异常：不抛错；回显里绝不能出现 appSecret（错误栈可能带请求参数）
		const raw = err instanceof Error ? err.message : String(err);
		return { ok: false, message: `凭证自检请求失败：${raw.split(appSecret).join('[REDACTED]')}` };
	}
}
