/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * 飞书「机器人所在的群」列表 —— 用于 Channel 绑定页签的「获取 chat_id」。
 *
 * 与扫码注册（`feishuRegistration.ts`）、测试连接（`probeFeishuCredentials`）走**同一条**链路：
 * 渠道自身的 `app_id / app_secret` → `tenant_access_token` → OpenAPI，
 * 并经主进程 HTTP 出口（渲染进程直连会被 CORS 拦，见 `mainProcessRequestService.ts` 的事故记录）。
 *
 * 这里刻意不依赖飞书 CLI：CLI 需要额外 `config init` / `auth login` 才有凭证，
 * 而渠道配置里已经有可用的应用凭证 ⇒ 取号这一步用渠道凭证最稳。
 * 解析部分（`parseFeishuChatList`）抽成纯函数，便于单测。
 */

import { CancellationToken } from '../../../../base/common/cancellation.js';
// asText 在 platform/request/common（**不在** base/parts/request，与 feishu.ts 同一处）
import { asText, IRequestService } from '../../../../platform/request/common/request.js';

const FEISHU_BASE = 'https://open.feishu.cn';
const TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal';
const CHATS_PATH = '/open-apis/im/v1/chats';

/** 一个群的展示信息。 */
export interface IFeishuChat {
	readonly chatId: string;
	readonly name: string;
	readonly memberCount?: number;
}

/**
 * 解析 `GET /open-apis/im/v1/chats` 的响应体（纯函数）。
 *
 * 容错：缺 `data.items` / 条目缺 `chat_id` 一律跳过；群名缺省给占位，
 * 保证「拿得到号」不被非关键字段缺失挡住。
 */
export function parseFeishuChatList(body: unknown): IFeishuChat[] {
	const items = (body as { data?: { items?: unknown[] } } | undefined)?.data?.items;
	if (!Array.isArray(items)) { return []; }
	const out: IFeishuChat[] = [];
	for (const raw of items) {
		const item = raw as { chat_id?: unknown; name?: unknown; user_count?: unknown };
		const chatId = typeof item.chat_id === 'string' ? item.chat_id.trim() : '';
		if (!chatId) { continue; }
		const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '（未命名群）';
		const memberCount = typeof item.user_count === 'number' ? item.user_count : undefined;
		out.push({ chatId, name, memberCount });
	}
	return out;
}

/** 读取响应文本（主进程出口把 body 包成流，与渠道平台同一口径）。 */
async function readText(requestService: IRequestService, url: string, init: { type: 'GET' | 'POST'; data?: string; headers?: Record<string, string> }): Promise<string> {
	const ctx = await requestService.request(
		{
			url, type: init.type, data: init.data,
			headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
			callSite: 'feishuChatList',   // IRequestOptions 必填：日志/诊断里能指认调用点
		},
		CancellationToken.None,
	);
	return (await asText(ctx)) ?? '';
}

/** 取 `tenant_access_token`（应用凭证换取；失败抛带飞书错误码的异常）。 */
async function fetchTenantToken(requestService: IRequestService, appId: string, appSecret: string): Promise<string> {
	const text = await readText(requestService, `${FEISHU_BASE}${TOKEN_PATH}`, {
		type: 'POST',
		data: JSON.stringify({ app_id: appId, app_secret: appSecret }),
	});
	let json: { code?: number; msg?: string; tenant_access_token?: string };
	try {
		json = JSON.parse(text);
	} catch {
		throw new Error(`[Feishu] 换取 tenant_access_token 返回非 JSON：${text.slice(0, 120)}`);
	}
	if (!json.tenant_access_token) {
		throw new Error(`[Feishu] 换取 tenant_access_token 失败：code=${json.code ?? '-'} msg=${json.msg ?? '-'}`);
	}
	return json.tenant_access_token;
}

/**
 * 列出机器人所在的群（默认前 50 个）。
 *
 * @param appId/appSecret 渠道配置里的应用凭证（`sessions.channel.feishu.appId/appSecret`）。
 */
export async function fetchFeishuChats(
	requestService: IRequestService,
	appId: string,
	appSecret: string,
	pageSize = 50,
): Promise<IFeishuChat[]> {
	const token = await fetchTenantToken(requestService, appId, appSecret);
	const text = await readText(requestService, `${FEISHU_BASE}${CHATS_PATH}?page_size=${pageSize}`, {
		type: 'GET',
		headers: { Authorization: `Bearer ${token}` },
	});
	let json: { code?: number; msg?: string };
	try {
		json = JSON.parse(text);
	} catch {
		throw new Error(`[Feishu] 群列表返回非 JSON：${text.slice(0, 120)}`);
	}
	// code 非 0 时仍尝试解析（部分版本 code 缺省），但无可用群则把错误抛出，避免 UI 静默空列表
	const chats = parseFeishuChatList(json);
	if (chats.length === 0 && json.code !== undefined && json.code !== 0) {
		throw new Error(`[Feishu] 获取群列表失败：code=${json.code} msg=${json.msg ?? '-'}`);
	}
	return chats;
}
