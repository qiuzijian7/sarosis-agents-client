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
	const err = json['error'];
	if (typeof err === 'string' && err && err !== 'authorization_pending') {
		const desc = typeof json['error_description'] === 'string' ? json['error_description'] : '';
		throw new Error(`飞书注册失败（${err}）：${desc}`);
	}
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
