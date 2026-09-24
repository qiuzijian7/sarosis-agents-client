/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';

/**
 * 知识库设置面板需要视图提供的能力（打开 Pane 时由 KnowledgeBaseView 装配）。
 *
 * 设计取舍：目录切换 / 重建向量索引 / 飞书同步这些动作要么依赖视图内部状态
 * （vault 列表、active vault、迁移逻辑），要么需要在视图上下文里执行，
 * 因此不改造成全局命令，而是由 Input 透传一个 host 回调集合；
 * 纯配置读写则直接走 Pane 里的 IConfigurationService（全局服务，无需 host）。
 */
export interface IKbSettingsHost {
	/** 知识库根目录绝对路径（Vault 根；供同步命令、扫描统计使用） */
	getRootPath(): string;
	/** 当前 Vault 是否激活（决定是否展示统计区块） */
	hasActiveVault(): boolean;
	/** 文档数量 */
	getDocCount(): number;
	/** 文档总大小（字节） */
	getTotalSize(): number;
	/** 是否启用 SQLite FTS5 内核索引 */
	isSqliteActive(): boolean;
	/** 已关联工作区数量（0 = 不展示） */
	getLinkedWorkspaceCount(): number;
	/** 操作日志（settings.*） */
	logOp(code: string, detail: Record<string, unknown>): void;
	/**
	 * 打开文件夹选择框（选定后由视图完成持久化与 Vault 迁移）。
	 *
	 * ★ 2026-09-23：**返回最终生效的目录路径**。此前是 `void` 单向调用 ⇒ 面板无从知道
	 * 用户选了什么、也无法回填输入框，表现为「选了目录，路径没变」。
	 * 取消 ⇒ `undefined`。
	 */
	pickDir(current: string): Promise<string | undefined>;
	/** 手动输入路径后提交；返回最终生效的目录路径（无效/无 Vault ⇒ `undefined`）。 */
	applyDir(dir: string): Promise<string | undefined>;
	/** 用当前 Embedding 配置重建所有 Vault 的向量索引 */
	rebuildVectorIndex(): void;
	/** 在系统资源管理器中打开知识库文件夹 */
	openKbFolder(): void;
	/** 触发飞书同步（dry-run 预览 / apply 实际写入） */
	feishuSync(mode: 'dry-run' | 'apply'): void;
	/**
	 * 取**累计的同步输出**（2026-09-23）。
	 *
	 * 同步跑在一个独立终端里，用户之前必须切到终端才能看到进度/报错。现在视图侧
	 * 会把终端 `onData` 的内容缓存下来，面板重建（重开设置页 / 切换后回来）时用本方法恢复显示。
	 */
	getSyncOutput(): string;
	/** 订阅同步输出（实时）；返回取消订阅。面板据此把同步过程实时显示在下方。 */
	onSyncOutput(listener: (chunk: string) => void): { dispose(): void };
	/**
	 * 读取用户自定义的「本地目录 ↔ 飞书知识库」映射（vault 内 `.feishu-space-map.json`；不存在 ⇒ 空数组）。
	 * 结构内联声明以避免 Input 反向依赖 knowledge/ 模块（同一契约由 feishuSyncCore 定义）。
	 */
	loadSpaceMap(): Promise<Array<{ dir: string; spaceId: string; spaceName?: string }>>;
	/** 保存「目录 ↔ 知识库」映射（写回 vault 内配置文件）。 */
	saveSpaceMap(list: ReadonlyArray<{ dir: string; spaceId: string; spaceName?: string }>): Promise<void>;
	/** 列出可选的飞书知识库（`wiki +space-list`；未安装 CLI / 未登录 ⇒ 空数组）。 */
	listSpaces(): Promise<Array<{ spaceId: string; name: string }>>;
	/** 弹出输入框让用户填写新知识库名称（取消 / 空 ⇒ undefined）。 */
	promptSpaceName(): Promise<string | undefined>;
	/** 在飞书**新建**知识库（`wiki +space-create`）；失败 ⇒ undefined（UI 给出提示）。 */
	createSpace(name: string): Promise<{ spaceId: string; name: string } | undefined>;
	/** 选择知识库内的目录（返回相对知识库根的路径；取消 ⇒ undefined） */
	pickDirForMapping(): Promise<string | undefined>;
	/** 打开任意文件（用于查看同步日志） */
	openFile(uri: URI): void;
	/** 配置或数据变化后，Pane 自身重渲染（由视图在必要时调用） */
	onDidChange?: (listener: () => void) => { dispose(): void };
}

/**
 * EditorInput — 在中间栏打开知识库设置面板（替代原先的 ⚙ 下拉面板）。
 *
 * 设置项较多（目录 / 构建方式 / Embedding / 飞书同步 / 统计），下拉受侧栏宽度限制
 * 显示拥挤，故改为独立的 EditorPane（对齐 VS Code 设置页的中栏形态）。
 */
/**
 * 设置页的**定位锚点**：打开后自动滚动到对应分组（2026-09-23 新增）。
 * 触发场景：知识库视图的「同步飞书」按钮发现飞书未配置 ⇒ 打开设置页并要求定位到「📤 飞书同步」。
 */
export type KbSettingsFocus = 'feishu';

export class KbSettingsEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.agentStudio.kbSettings';

	override get typeId(): string {
		return KbSettingsEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return 'workbench.editor.agentStudio.kbSettingsPane';
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Singleton | EditorInputCapabilities.Readonly;
	}

	/**
	 * @param focusSection 打开时定位到的分组（可选）。⚠ 刻意**不改 `matches()`**：
	 *   复用同一个设置 Tab 时框架会重新调用 `setInput()`（见 Pane 里 L159 的注释），
	 *   定位逻辑挂在渲染收尾处，所以复用路径同样会滚动 —— 避免开出第二个设置页。
	 */
	constructor(private readonly _host: IKbSettingsHost, readonly focusSection?: KbSettingsFocus) {
		super();
	}

	/** 视图提供的能力集合（Pane 通过它执行需要视图上下文的动作）。 */
	get host(): IKbSettingsHost {
		return this._host;
	}

	override get resource(): URI {
		// 合成 URI：用于 Tab 标识与匹配（非真实文件）
		return URI.from({ scheme: 'saros-kb-settings', path: '/settings' });
	}

	override getName(): string {
		return '知识库设置';
	}

	override matches(other: EditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		// 设置面板为单例：任意 KbSettingsEditorInput 视为同一 Tab
		return other instanceof KbSettingsEditorInput;
	}
}
