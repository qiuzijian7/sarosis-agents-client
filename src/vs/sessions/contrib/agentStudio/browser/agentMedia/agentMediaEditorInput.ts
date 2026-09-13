/*---------------------------------------------------------------------------------------------
 *  Saros Agents — Agent Media Editor Input
 *
 *  在中间栏文件编辑器**独立 pane** 展示聊天里的媒体（生成结果 / 候选图 / 参考图）。
 *  2026-09-11 用户需求：聊天框显示的图片双击后可在中间编辑器单独展示。
 *
 *  为什么需要自定义 input（而非直接用 FileEditorInput）：
 *    媒体 ref 有四种形态（见 agentChatPanel.workflowCards 的 `_mediaSrc`）——
 *    `data:` / `http(s):` / `blob:` / 本地绝对路径。其中 **data URL 是画布生成结果的
 *    主流形态**（animatedEmojiExecutor / chromaCompose 均用 `blobToDataUrl` 落库），
 *    它**没有对应的文件资源** → FileEditorInput 无法承载；故自带 input + pane。
 *--------------------------------------------------------------------------------------------*/

import { EditorInput } from '../../../../../workbench/common/editor/editorInput.js';
import type { EditorInputCapabilities } from '../../../../../workbench/common/editor.js';

/** 媒体类型（与 agentChatTypes 的 snapshot.kind 同构）。 */
export type AgentMediaKind = 'image' | 'video' | 'audio' | 'unknown';

/** 打开媒体的载荷（由聊天面板经 onOpenMedia 回调传出）。 */
export interface IAgentMediaOpenPayload {
	/** **已可加载**的 URL（data: / http(s): / blob: / vscode-file:）——调用方需先经 `_mediaSrc` 转换。 */
	readonly src: string;
	readonly kind: AgentMediaKind;
	/** 标签标题；缺省按 kind 生成。 */
	readonly title?: string;
}

export class AgentMediaEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.agentStudio.agentMedia';
	static readonly EDITOR_ID = 'workbench.editor.agentStudio.agentMediaPane';

	override get typeId(): string {
		return AgentMediaEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return AgentMediaEditorInput.EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		// 2 === EditorInputCapabilities.Readonly：媒体仅展示，不参与保存 / 脏标记。
		// （用字面量：该枚举是 const enum，`import type` 下无法取值 —— 与
		//   canvasEditorInput.ts 的写法一致。）
		return 2;
	}

	/**
	 * 无文件资源：媒体 ref 多为 data URL（画布生成结果的主流形态），没有可依附的资源。
	 * 返回 undefined 是 VS Code 允许的「非资源型 EditorInput」（同 SettingsEditorInput）；
	 * tab 去重由 `matches()` 按 `kind|src` 完成。
	 */
	override get resource(): undefined {
		return undefined;
	}

	/** 去重键：同 src + 同 kind 视为同一编辑器（重复双击复用同一 tab，不刷屏）。 */
	private readonly _key: string;
	private readonly _src: string;
	private readonly _kind: AgentMediaKind;
	private readonly _title: string;

	constructor(payload: IAgentMediaOpenPayload) {
		super();
		this._src = payload.src;
		this._kind = payload.kind;
		this._title = payload.title?.trim() || AgentMediaEditorInput._defaultTitle(payload.kind);
		this._key = `${payload.kind}|${payload.src}`;
	}

	private static _defaultTitle(kind: AgentMediaKind): string {
		switch (kind) {
			case 'image': return '生成图片';
			case 'video': return '生成视频';
			case 'audio': return '生成音频';
			default: return '生成结果';
		}
	}

	/** 已可加载的 URL（pane 直接赋给 img/video/audio 的 src）。 */
	get src(): string {
		return this._src;
	}

	get kind(): AgentMediaKind {
		return this._kind;
	}

	override getName(): string {
		return this._title;
	}

	override getDescription(): string {
		// 标签页第二行：便于区分同名的多张图（data URL 的头部片段无意义，故按 kind 展示）。
		return this._kind === 'unknown' ? '' : this._kind;
	}

	override matches(other: EditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		if (other instanceof AgentMediaEditorInput) {
			return this._key === other._key;
		}
		return false;
	}
}
