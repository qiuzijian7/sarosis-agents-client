/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 节点交互声明的**类型定义** —— 节点无关的「机制面」。
 *
 * 拆分由来（2026-09-11）：原 `nodeInteractionSchemas.ts` 把「机制」与「逐节点声明」
 * 混装在一起（前 68 行是节点无关的类型，第 70 行起突然变成 emoji 专属数据）。
 * 现按 **机制 / 声明** 分离：
 *   · 机制（类型 + 纯函数）→ `nodeInteraction/`（本目录）
 *   · 声明（逐节点数据）    → `../nodeCatalog.ts`（唯一声明源）
 *                            + `../catalogNodes/<node>.ts`（schema 较大或有节点私有常量时）
 *
 * 注：原 `../nodeInteractionSchemas.ts` 已在同批收尾中**删除**（它只剩转发、名字却仍叫
 * schemas，会误导后来者），3 个消费方改为直连本目录。
 */

/** 交互字段类型（卡片按 kind 渲染不同控件）。 */
export type INodeInteractionField =
	| { kind: 'text'; key: string; label: string; placeholder?: string; default?: string }
	| { kind: 'textarea'; key: string; label: string; placeholder?: string; default?: string; rows?: number }
	| { kind: 'number'; key: string; label: string; min?: number; max?: number; step?: number; default?: number }
	| { kind: 'boolean'; key: string; label: string; default?: boolean }
	| { kind: 'select'; key: string; label: string; options: ReadonlyArray<{ label: string; value: string }>; default?: string }
	/**
	 * 网格尺寸（m×n）：一次渲染两个数字输入。值以 `{ rows, cols }` 合并，
	 * 也可用 `keys: { rows: 'rows', cols: 'cols' }` 映射到节点字段名。
	 */
	| { kind: 'grid-size'; key: string; label: string; rowsKey?: string; colsKey?: string; min?: number; max?: number; defaultRows?: number; defaultCols?: number }
	/**
	 * 列表（如「每个表情的提示词」）：值 = 对象数组，元素由 itemFields 声明。
	 * `countFrom` 指向 grid-size 字段的 key —— 列表长度可跟随 m×n 自动补齐。
	 * `preset`：**默认提示词预设**（2026-09-11 用户需求）——空格子用它作占位提示，
	 * 提交时仍为空则按序套用（用户不填也能生成一组有意义的表情）。
	 */
	| { kind: 'list'; key: string; label: string; itemFields: ReadonlyArray<INodeInteractionField>; countFrom?: string; preset?: ReadonlyArray<string> }
	/**
	 * 参考图像（资产引用）：值 = `AssetRef[]`，写入节点 `values.comfytv_image_refs`
	 * —— 与画布 Stage 的「资产引用（AssetReferences）」同一份存储，执行侧
	 * `applyAssetRefOverrides` 据此**覆盖**同 slot 的上游连线（img2img 参考图）。
	 *
	 * 卡片行为（2026-09-11 用户需求）：有值 → 显示缩略图；无值 → 显示「选择图像」
	 * 按钮（候选 = 上游媒体，由执行侧放进 `initialValues.__assetCandidates`）。
	 * 执行侧还会在**节点未钉住资产**时，用上游图像填充默认值（用户可直接确认）。
	 *
	 * `slot`：写入的 slot 序号（默认 0）。存储形状见 comfyHost/assetRefs.ts。
	 */
	| { kind: 'image-ref'; key: string; label: string; slot?: number; description?: string };

/**
 * 交互提交后的**行为模式**（决定执行侧如何处理提交值，无需为每个节点写代码）：
 *   - `values`（默认）：提交值合并进节点 values，随后**正常执行**该节点
 *     —— 配置型节点（StatEmoji 的 m×n/风格/提示词、DynEmoji 的时长/帧率）。
 *   - `snapshot`：提交值 = **媒体引用数组**，直接作为该节点的输出快照，
 *     **不执行节点**（也不跑 ComfyUI）—— 选择型节点（ImagePicker 选上游图输出）。
 *     候选来源由 `snapshotSource` 决定；卡片会自动渲染候选缩略图网格。
 *   - `skip`：仅收集配置，节点既不执行也不产出（纯 UI 占位）。
 */
export type NodeInteractionApplyMode = 'values' | 'snapshot' | 'skip';

/** 单个节点的交互声明。 */
export interface INodeInteractionSchema {
	/** 卡片标题（如「静态表情包设置」）。 */
	title: string;
	/** 卡片说明（可选）。 */
	description?: string;
	/** 提交按钮文案（默认「确认并执行」；snapshot 模式默认「确认选择」）。 */
	submitLabel?: string;
	fields: ReadonlyArray<INodeInteractionField>;
	/** 提交后的行为（默认 `values`）。详见 NodeInteractionApplyMode。 */
	apply?: NodeInteractionApplyMode;
	/** `apply==='snapshot'` 时候选媒体来源：上游连线（默认）或节点自身已有快照。 */
	snapshotSource?: 'upstreams' | 'self';
	/** `apply==='snapshot'` 时是否多选（默认 true）。 */
	multiSelect?: boolean;
}
