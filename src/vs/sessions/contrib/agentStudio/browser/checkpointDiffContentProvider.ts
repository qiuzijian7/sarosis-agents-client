/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { ITextModelContentProvider } from '../../../../editor/common/services/resolverService.js';

/**
 * 检查点 diff 的**虚拟文档**方案（2026-09-12，P2-2）。
 *
 * 背景：此前「查看变更」把快照内容写成**磁盘临时文件**（`<workspace>/.sarosworkspace/
 * checkpoint-diffs/<checkpointId>/<file>`）再交给 diff 编辑器，副作用有两个：
 *   ① 临时文件只写不删 → 需要额外的清理机制（P0-3 的「每进程首次打开前清空」）；
 *   ② 快照内容（可能是敏感源码）落盘。
 *
 * 现改为注册一个自定义 scheme 的 `ITextModelContentProvider`，快照内容**只存在于内存**：
 *   · {@link CheckpointDiffStore} —— 纯逻辑（内容存储 + URI 构造 + 批次清理），可单测；
 *   · {@link CheckpointDiffContentProvider} —— 薄适配层，把 store 的内容物化成 `ITextModel`。
 *
 * 参考 Cline 的同类做法（before/after 交给 VS Code 虚拟文档，不落盘）。
 */

/** 虚拟文档 scheme（仅本功能使用）。 */
export const CHECKPOINT_DIFF_SCHEME = 'saros-checkpoint-diff';

/**
 * 快照内容的**内存**存储 + 虚拟 URI 构造（纯逻辑，无 DI 依赖）。
 *
 * 生命周期：调用方在「开始新一批 diff」时调 {@link beginBatch} 清理上一批。
 * 已打开的 diff 编辑器不受影响 —— 其 `ITextModel` 已被 VS Code 的模型解析服务
 * 引用持有，与这里的 Map 解耦。
 */
export class CheckpointDiffStore {
	private readonly _contents = new Map<string, string>();
	private _seq = 0;

	/**
	 * 登记一份内容并返回可用于 diff 的虚拟 URI。
	 *
	 * URI 形如 `saros-checkpoint-diff:/<批次序号>-<文件名>`：**每次调用都生成新 URI**
	 * （不复用），因此同一文件在不同检查点、或同一检查点被反复打开时不会串内容。
	 */
	register(fileName: string, content: string): URI {
		const safeName = fileName.split(/[/\\]/).filter(Boolean).pop() ?? 'file';
		const uri = URI.from({
			scheme: CHECKPOINT_DIFF_SCHEME,
			path: `/${++this._seq}/${safeName}`,
		});
		this._contents.set(uri.toString(), content);
		return uri;
	}

	/** 开始新一批 diff：清空上一批内容（避免内存随打开次数无限增长）。 */
	beginBatch(): void {
		this._contents.clear();
	}

	/** 按 URI 取回内容（provider 用）。 */
	get(uri: URI): string | undefined {
		return this._contents.get(uri.toString());
	}

	/** 当前登记的内容条数（测试 / 诊断用）。 */
	get size(): number {
		return this._contents.size;
	}
}

/**
 * 把 {@link CheckpointDiffStore} 的内容物化为 `ITextModel`，供 diff 编辑器读取。
 */
export class CheckpointDiffContentProvider implements ITextModelContentProvider {

	constructor(
		private readonly _store: CheckpointDiffStore,
		private readonly _modelService: IModelService,
		private readonly _languageService: ILanguageService,
	) { }

	provideTextContent(resource: URI): Promise<ITextModel | null> {
		const content = this._store.get(resource);
		if (content === undefined) {
			// 内容不在内存（进程重启后的历史 diff / 未知 URI）→ 返回 null，
			// VS Code 会显示「无法打开」而不是静默空白。
			return Promise.resolve(null);
		}
		// languageId 交给 VS Code 按文件名推断（virtual URI 的 path 保留了扩展名）。
		return Promise.resolve(this._modelService.createModel(
			content,
			this._languageService.createByFilepathOrFirstLine(resource),
			resource,
		));
	}
}
