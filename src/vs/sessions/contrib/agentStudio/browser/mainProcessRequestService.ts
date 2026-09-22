/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * 主进程 HTTP 出口的 `IRequestService` 适配器（renderer 侧）。
 *
 * ## 为什么需要它（2026-09-22 实测事故）
 *
 * 桌面端渲染进程的 origin 是 `vscode-file://vscode-app`，飞书 OpenAPI 不返回
 * `Access-Control-Allow-Origin` ⇒ renderer 直连被 CORS 预检拦截：
 * ```
 * Access to fetch at 'https://open.feishu.cn/open-apis/event/v1/outbound_event/subscribe'
 * from origin 'vscode-file://vscode-app' has been blocked by CORS policy ...
 * net::ERR_FAILED
 * ```
 *
 * ★ 关键澄清（此前判断错过一次）：**DI 注入的 `IRequestService` 并不能绕开 CORS** ——
 * 桌面端注册的是 `workbench/services/request/electron-browser/requestService.ts`
 * （`NativeRequestService`），其 `request()` 最终走到
 * `base/parts/request/common/requestImpl.ts` 的 **`fetch`**，仍在 renderer 网络栈里。
 * 栈里会看到 `requestImpl.ts:33 → net::ERR_FAILED`，即为此证。
 *
 * 本 fork 既定的「真正的网络出口」是主进程 LLM channel 的 `httpRequest`
 * （`app.ts` 注册 `VSSAROS_LLM_CHANNEL` → `electron-main/llmMainChannel.ts` →
 * `node/llmBridgeNode.ts#httpRequest`，主进程 Node fetch，无 CORS）。
 * 它已经有成熟消费者：`agentStudioWebviewController.ts` 用它内联外链图片
 * （注释明确写着「服务器不带 Access-Control-Allow-Origin ⇒ webview 侧无法自救」）。
 *
 * ## 这层适配的价值
 *
 * 把 channel 适配成 `IRequestService` 形状后，**渠道相关代码零改动**即可获得主进程出口：
 * 飞书 REST（`bridge/platforms/feishu.ts`）、测试连接（`feishuRegistration.ts#probeFeishuCredentials`）、
 * 扫码注册（`begin/pollFeishuRegistration`）原本都收 `IRequestService` 参数。
 *
 * ## 不复刻的部分
 *
 * 仅实现 `request()`：代理解析 / 客户端证书 / 鉴权查询在本 channel 无对应能力，
 * 一律返回空值（这些能力渠道代码从未使用）。
 */

import { bufferToStream, VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { IHeaders, IRequestContext, IRequestOptions } from '../../../../base/parts/request/common/request.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { VSSAROS_LLM_CHANNEL, type IHttpRequestResult } from '../common/llmBridge.js';

/** 默认超时（与 `node/llmBridgeNode.ts#httpRequest` 的 15s 默认值保持一致）。 */
const DEFAULT_TIMEOUT_MS = 15_000;

/** 这些请求头由网络栈自行管理，透传会被 undici 拒绝或引发歧义。 */
const UNSAFE_HEADERS = new Set(['content-length', 'host', 'connection', 'transfer-encoding']);

/**
 * 创建经主进程执行 HTTP 的 `IRequestService`。
 *
 * @returns 无法建立主进程 channel 时返回 `undefined`（如 web/remote 宿主），调用方应回退。
 */
export function createMainProcessRequestService(
	mainProcessService: IMainProcessService | undefined,
): IRequestService | undefined {
	if (!mainProcessService) {
		return undefined;
	}
	let channel;
	try {
		channel = mainProcessService.getChannel(VSSAROS_LLM_CHANNEL);
	} catch {
		// 通道未注册 / 连接未建立：交由调用方回退，而不是把装配期炸掉
		return undefined;
	}
	if (!channel) {
		return undefined;
	}

	return {
		_serviceBrand: undefined,
		onDidCompleteRequest: Event.None,
		request: async (options: IRequestOptions, token: CancellationToken): Promise<IRequestContext> => {
			const method = (options.type ?? 'GET').toUpperCase();
			const result = await channel.call<IHttpRequestResult>('httpRequest', {
				url: options.url ?? '',
				method,
				headers: toPlainHeaders(options.headers),
				body: options.data,
				timeoutMs: options.timeout ?? DEFAULT_TIMEOUT_MS,
			}, token);
			// 主进程已按 UTF-8 解出文本（二进制路径本适配器不使用）；
			// 包回 VSBuffer 流，形状与 core 的 `requestImpl.ts` / `RequestChannelClient` 一致。
			return {
				res: { statusCode: result.status, headers: {} },
				stream: bufferToStream(VSBuffer.fromString(result.body ?? '')),
			};
		},
		resolveProxy: async () => undefined,
		lookupAuthorization: async () => undefined,
		lookupKerberosAuthorization: async () => undefined,
		loadCertificates: async () => [],
	} as unknown as IRequestService;
}

/** `IHeaders` 值可能是 `string[]`，channel 侧只接受 `Record<string, string>`。 */
function toPlainHeaders(headers: IHeaders | undefined): Record<string, string> | undefined {
	if (!headers) {
		return undefined;
	}
	const out: Record<string, string> = {};
	for (const key of Object.keys(headers)) {
		if (UNSAFE_HEADERS.has(key.toLowerCase())) {
			continue;
		}
		const value = headers[key];
		if (typeof value === 'string') {
			out[key] = value;
		} else if (Array.isArray(value)) {
			out[key] = value.join(', ');
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}
