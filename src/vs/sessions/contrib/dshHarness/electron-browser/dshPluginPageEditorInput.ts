/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「在编辑区打开 dsh 插件页」的 EditorInput（2026-10-13，用户 D1=A）。
 *
 * 为什么需要它：插件页（`/x/<module>/`）原本**只能**由活动栏侧栏的 `DshPluginViewPane` 承载
 * （`surface=plugin-page`），**编辑区承载插件页这条路径此前不存在** —— 编辑区只承载聊天页
 * （`surface=chat`，见 `dshChatInstanceHost.ts`）。而侧栏宽度只有三百来像素，完整版页面放不下
 * ⇒ 侧栏给「摘要 + 入口」（`?surface=sideview`），入口点开就是本输入所代表的**编辑区完整页** ✓。
 *
 * ⚠ 与侧栏那份**必须共存、不能互相抢视图**：侧栏的 viewId 是 `dsh-plugin-w<win>-<containerId>`，
 *   本输入对应 `dsh-plugin-editor-w<win>-<containerId>`（多了 `-editor`）。主进程对**重复 viewId
 *   是静默忽略**（`dshViewHost.create` 里 `if (this._views.has(viewId)) { return; }`）⇒ 撞 id 的表现
 *   是"侧栏/编辑区里有一个永远空白且不报错" ✗✗（这条坑值得写在这里）。
 *
 * 单例口径：**按容器**单例（同一容器开两次不会变成两个 tab ✓），与原生 `AgentStudioDashboardEditorInput`
 * 的 `getOrCreate()` 同款；`title` 取自容器表（`DSH_MODULE_CONTAINERS[].activityBar.title`）⇒ tab 上
 * 显示的是用户看得懂的名字（如「主页」），而不是容器 id ✗。
 */

import { URI } from '../../../../base/common/uri.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import type { IUntypedEditorInput } from '../../../../workbench/common/editor.js';

export class DshPluginPageEditorInput extends EditorInput {

	static readonly ID = 'workbench.editor.dshPluginPage';

	/** 容器 id → 输入实例（`getOrCreate` 的单例表；`dispose` 时清）。 */
	private static readonly _instances = new Map<string, DshPluginPageEditorInput>();

	static getOrCreate(containerId: string, title: string): DshPluginPageEditorInput {
		const existing = DshPluginPageEditorInput._instances.get(containerId);
		if (existing && !existing.isDisposed()) {
			return existing;
		}
		const input = new DshPluginPageEditorInput(containerId, title);
		DshPluginPageEditorInput._instances.set(containerId, input);
		return input;
	}

	/**
	 * ⚠ 构造子是**公开**的：编辑器注册表用 `SyncDescriptor` 绑定"pane ← 输入"，而它需要一个可构造的
	 * 类 ✗（`private constructor` 会让 `SyncDescriptor` 直接报类型错 —— 原生那两份输入同理是公开的 ✓）。
	 * 但**取实例一律走 `getOrCreate`**：直接 new 出来的实例不进单例表，`matches` 就认不出它 ✗。
	 */
	constructor(
		/** 模块容器 id（如 `agentStudio.dashboard`）—— 路由由宿主按"已激活模块"现算 ✓ */
		readonly containerId: string,
		private readonly _title: string,
	) {
		super();
	}

	override get typeId(): string {
		return DshPluginPageEditorInput.ID;
	}

	override get editorId(): string | undefined {
		return DshPluginPageEditorInput.ID;
	}

	override get capabilities(): EditorInputCapabilities {
		// 只读（页面自己对写面负责，编辑器不提供保存语义）+ 单例（`getOrCreate` 口径 ✓）
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return this._title;
	}

	override get resource(): URI {
		return URI.from({ scheme: 'dsh-page', path: `/${this.containerId}` });
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof DshPluginPageEditorInput && other.containerId === this.containerId;
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: this.resource,
			options: { override: DshPluginPageEditorInput.ID, pinned: true },
		};
	}

	override dispose(): void {
		if (DshPluginPageEditorInput._instances.get(this.containerId) === this) {
			DshPluginPageEditorInput._instances.delete(this.containerId);
		}
		super.dispose();
	}
}
