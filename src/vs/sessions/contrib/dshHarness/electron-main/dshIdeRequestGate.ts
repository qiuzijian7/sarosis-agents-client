/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IDE 能力请求的**闸门**：反向通道 `ide.request` 的"授权 → 分发"策略。
 *
 * 为什么从通道里抽出来：授权是**放行面**（决定了 Host 里的插件能驱动 IDE 到什么程度），
 * 抽成只依赖"声明读取"与"分发"两个回调的小类之后，它就能被**单测**（用假声明表 + 假分发器），
 * 而不必拉起 electron 主进程。通道本身退化成纯接线。
 *
 * 一条不可让步的顺序：**先授权、后分发**——未授权的请求连 renderer 都不该被惊动
 * （测试里专门断言"被拒时分发器没被调用"）。
 */

import { DshBridgeReverseMethod, IBridgeReverseRequest } from '../common/dshBridgeProtocol.js';
import { authorizeIdeRequest } from '../common/dshIdeAuthorization.js';
import { ideRequestTimeoutMs } from '../common/dshIdeCapabilities.js';
import { IDshIdeRequest } from '../common/dshHarness.js';
import { IIdeCapabilityDeclaration } from '../common/dshIdeAuthorization.js';

export interface IDshIdeRequestGateOptions {
	/** 读已安装插件的清单声明（插件名 → 能力表）。每次请求读一次（调用很少，且要跟安装状态一致）。 */
	readDeclarations(): { declarations: Map<string, IIdeCapabilityDeclaration>; notes: string[] };
	/**
	 * 把**已授权**的请求交给 renderer 执行：返回结果或抛错（错误文案会原样回到 Host 侧）。
	 * `timeoutMs` 由本闸门按操作语义给出（慢操作要等用户确认与页面/画布往返，见 `ideRequestTimeoutMs`）。
	 */
	dispatch(request: Omit<IDshIdeRequest, 'id'>, timeoutMs: number): Promise<unknown>;
	log(line: string): void;
	/**
	 * 审计：每条**已授权**的请求记一行（谁声称自己是谁 + 要动哪个能力）。
	 *
	 * 为什么需要：`pluginId` 是**调用方自报**的（协议如此，见 {@link IDshIdeRequest}），所以这条链上的
	 * 授权是**声明式**的。留痕不解决冒名，但至少让"哪个插件在驱动 IDE、要的是什么能力"事后可查——
	 * 出问题时"没有任何日志"是最难处理的一种状态。
	 * 可选：不给就只记拒绝那条（走 `log`）。
	 */
	trace?(line: string): void;
}

export class DshIdeRequestGate {

	constructor(private readonly _options: IDshIdeRequestGateOptions) { }

	/**
	 * 处置一次反向请求。
	 * @throws 未授权、方法不支持、或 renderer 执行失败（错误信息都带可读原因）
	 */
	async handle(request: IBridgeReverseRequest): Promise<unknown> {
		// `ide.echo`（自检）由桥客户端内建应答，到不了这里；其它方法一律不支持。
		if (request.method !== DshBridgeReverseMethod.IdeRequest) {
			throw new Error(`反向通道不支持的方法：${request.method}`);
		}
		const { declarations, notes } = this._options.readDeclarations();
		for (const note of notes) {
			this._options.log(note);
		}
		const verdict = authorizeIdeRequest({ capability: request.params.capability, pluginId: request.params.pluginId }, declarations);
		if (!verdict.allowed) {
			this._options.log(`拒绝 IDE 能力请求：${verdict.reason}`);
			throw new Error(verdict.reason);
		}
		const params = request.params.params as Record<string, unknown> | undefined;
		// 会话 id **必须原样带给分发**：主进程靠它把这次能力定向投给"正在跑该会话的窗口"（4.48），
		// 并在同会话两窗口都开时拒绝（4.49）。少了这一行不会报错，只会静默退化成广播——
		// 这条正是 Electron 探针抓出来的（单测都测在闸门之上/之下，刚好跳过这一跳）。
		const sessionId = typeof request.params.sessionId === 'string' && request.params.sessionId ? request.params.sessionId : undefined;
		this._options.trace?.(`ide.request 已授权：capability=${String(request.params.capability)} pluginId=${verdict.declaration.pluginId}${sessionId === undefined ? '' : ` sessionId=${sessionId}`}`);
		return this._options.dispatch({
			capability: request.params.capability as string,
			pluginId: verdict.declaration.pluginId,
			...(sessionId === undefined ? {} : { sessionId }),
			...(params === undefined ? {} : { params }),
		}, ideRequestTimeoutMs(String(request.params.capability), params));
	}
}
