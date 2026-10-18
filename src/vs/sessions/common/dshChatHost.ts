/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 聊天框 instance 的 dsh 承载钩子（方案第 5.12 节第 2 步）。
 *
 * 分层约束：`NativeChatEditorPane` 在 browser 层，dsh 通道服务在 electron-browser 层，
 * browser 不能 import electron-browser。因此本文件只定义接口与注册点：
 * pane 在创建时调用已注册的工厂，由 `dshHarness/electron-browser` 在启动时注入实现。
 * 未注册（或工厂返回 undefined，即 engine=legacy）时，聊天框保持现有 DOM 面板，行为不变。
 */

import { IDisposable } from '../../base/common/lifecycle.js';
import { Event } from '../../base/common/event.js';

/** 聊天输入上 dsh 关心的字段（方案 5.15 的 preset 持久化）。 */
export interface IDshChatInput {
	readonly chatId: string;
	/**
	 * 本聊天所属的 VsSaros 会话身份（`NativeChatEditorInput.agentId` / `.sessionId`）。
	 *
	 * 为什么 dsh 侧需要它：`chatId` 是**页签**身份（`default` 或 `chat-<ts>-<rand>`），
	 * 而会话历史侧栏的键是 `agentId::sessionId` —— 两者不是一个东西，也不可互推
	 * （dsh 会话 id `vssaros-chat-<sanitize(chatId)>` 是**不可逆**的派生）。
	 * 人格事实要落到侧栏读的那张表里，就必须由宿主把这两个 id 带到下游。
	 *
	 * 可选：新页签在绑定会话前 `sessionId` 为空（那时没人格事实可报）。
	 */
	readonly agentId?: string;
	readonly sessionId?: string;
	readonly onWillDispose: Event<void>;
	/** 方案 5.15：当前聊天的 agent preset（缺省 = 基座会话）。 */
	readonly dshPreset?: string;
	/** 基座（无后缀）会话实际运行的 preset（习得后持久化）。 */
	readonly dshBasePreset?: string;
	setDshPreset?(preset: string | undefined): void;
	setDshBasePreset?(preset: string | undefined): void;
}

/** 一个聊天 instance 的 dsh 承载；pane 把生命周期事件转发给它。 */
export interface IDshChatBinding extends IDisposable {
	/** 同一 pane 切到另一个聊天（setInput 换了 chatId）；input 为新聊天输入（preset 状态随 input 走）。 */
	setChatId(chatId: string, input?: IDshChatInput): void;
	/** pane 可见性变化（标签切换、编辑器显隐）。 */
	setVisible(visible: boolean): void;
	/** pane 布局变化。 */
	layout(): void;
	/** pane 被聚焦。 */
	focus(): void;
}

export interface IDshChatHostContext {
	/** 聊天框内容区容器（宿主在其中放占位元素并定位 WebContentsView）。 */
	readonly container: HTMLElement;
	/** 当前聊天输入（首个 setInput 的输入；后续切换经 setChatId 的 input 参数更新）。 */
	readonly input: IDshChatInput;
	/** pane 所在窗口。 */
	readonly windowId: number;
	/** 当前工作区的主目录（chatId → dsh 会话绑定的 cwd；缺省 = 不绑定会话）。 */
	readonly workspacePath?: string;
}

/** 返回 undefined = 不接管（engine=legacy 或总开关关闭），pane 走现有 DOM 聊天面板。 */
export type DshChatHostFactory = (ctx: IDshChatHostContext) => IDshChatBinding | undefined;

let factory: DshChatHostFactory | undefined;

/** 由 dshHarness 的 electron-browser 贡献在启动早期注册。 */
export function setDshChatHostFactory(f: DshChatHostFactory | undefined): void {
	factory = f;
}

export function getDshChatHostFactory(): DshChatHostFactory | undefined {
	return factory;
}
