/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 节点清单（Node Catalog，2026-09-11 用户需求：「新增每一个节点时尽可能少改动已有文件」）。
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  新增一个节点（ComfyTV/内置 stage 已由画布注册）→ **只在本文件加一条**：
 * ════════════════════════════════════════════════════════════════════════════
 *
 *    NODE_CATALOG.push({
 *      type: 'ComfyTV.MyNewStage',       // 画布持久化全名（data.stageClass）
 *      title: '我的新节点',                // 卡片/日志显示名（替代 COMFYTV_STAGE_META）
 *      aliases: ['myNewStage'],           // 归一化别名（可选，引擎枚举名等）
 *      interaction: {                     // 交互 UI（可选，阈值规则见本文件头注释）
 *        title: '我的新节点设置',
 *        fields: [{ kind: 'number', key: 'steps', label: '步数', default: 20 }],
 *        // apply: 'snapshot' 让「选择即输出、不执行节点」
 *      },
 *      localOnly: false,                  // true = 本地/no-Run（无需 ComfyUI runner）
 *    });
 *
 *  由本表驱动的既有代码（**都不需要再改**）：
 *    · 归一化    workflowExecutionService.normalizeRuntimeNodeType（别名 + 引擎类型）
 *    · 显示名    workflowExecutionService._nodeDisplayName（title）
 *    · 交互 UI   catalogInteraction（interaction → 卡片/执行侧统一处理）
 *    · 本地/远端 是否需要 ComfyUI runner（localOnly，供执行侧参考）
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  新增节点后的**聊天框工作流工具卡片展示**（2026-09-13 质量评估结论）
 * ════════════════════════════════════════════════════════════════════════════
 *  ★ 除本表外**无需额外改动** —— 各维度都有兜底链（按优先级）：
 *    · 出卡与否  `workflow/cardVisibility.ts` 自动判定（类型排除 + FLOW 链）
 *    · 标题      本表 title → `COMFYTV_STAGE_META.title` → humanize 机器名（三档兜底）
 *    · 副标题    `COMFYTV_STAGE_META` 的 kind/workflowKind（`stage: x · wf: y`）
 *                → 否则引擎中文标签（如 `comfyStage` → 「ComfyTV 阶段」）
 *    · 图标      stage kind 子串匹配（`workflow/cardDescriptor.ts`）→ 引擎图标 → ⚙️
 *    · 交互表单  本表 interaction（`catalogInteraction`）
 *    · 耗时/计数 `execution_end` 由 host 统一统计（无需节点侧改动）
 *
 *  ⚠ **两个维度必须手动**（本表管不到，忘了会「节点在卡上但无进度/无产物」）：
 *    · **进度** —— 节点须走 `_executeComfyNode`（delegate 的 `onProgress`），
 *      或自报 `node_progress` trace（参考 script 节点的 `reportScriptStageProgress`）。
 *      注：prompt/ifElse/switch/task/skill/tool/end 是毫秒级节点，**不需要**进度。
 *    · **产物** —— 执行器须写 `nodeState.snapshot`，或 host 侧调 `putWorkflowSnapshotMedia`
 *      （参考 Agent/Task 的文本产物、选择型节点的 apply:'snapshot'）。
 *
 *  ⚠ **若新增的是 ComfyTV stage**：必须让自动生成的 `comfyTVStageMeta.generated.ts`
 *    （`COMFYTV_STAGE_META`）包含它 —— 该表是**画布与聊天卡共用的数据源**
 *    （`registry.ts` 的 `comfyTVMetaFor` 也读它）。否则：标题/副标题/图标退化，
 *    且画布的 `stageKind` 为空 → **ACTIONS 区块整块不出现** ✗。生成脚本见该文件头注释。
 *  ⚠ 新增一类**全新语义**的 stage kind 时，须在 `cardDescriptor.iconForStageKind`
 *    补子串规则 —— `cardDescriptor.test.ts` 会遍历全部 kind 断言「必须命中」，
 *    漏补会直接测试失败（不会静默退化）✓。
 *
 *  仅当节点需要**全新的画布图元**（非 ComfyTV 已注册 stage）或**全新控件类型**时，
 *  才需改动 webview 的 registry / 卡片渲染分支。
 *
 * ════════════════════════════════════════════════════════════════════════════
 *  interaction 写在哪里？（2026-09-11 拆分后的阈值规则）
 * ════════════════════════════════════════════════════════════════════════════
 *   · 字段类型（卡片按 kind 渲染控件）：
 *       text / textarea / number / boolean / select / grid-size(m×n) / list(可跟随网格)
 *   · 行为模式（apply，决定执行侧怎么用提交值）：
 *       'values'（默认）→ 提交值合并进节点 values，随后正常执行（配置型节点）
 *       'snapshot'      → 提交值 = 媒体引用，直接作为节点输出，**不执行节点**
 *                         （选择型节点；卡片自动渲染候选缩略图网格）
 *       'skip'          → 只收集配置，不执行不产出
 *
 *   · schema ≤ ~25 行 **且** 无节点私有常量 → **内联在本文件条目里**（如 ImagePickerStage）
 *   · schema > ~25 行 **或** 带节点私有常量/预设（如 emoji 的 38 行风格与提示词预设）
 *     → 放到 `./catalogNodes/<node>.ts`，本文件条目只写 `interaction: xxxInteraction`
 *   · 阈值存在的意义：2~5 个节点时不必碎成 N 个文件；节点变多时本文件也不会被撑爆。
 *
 *  ⚠ 本文件是交互声明的**唯一来源** —— 不要再新增第二张按 type 索引的 schema 表
 *  （2026-09-11 已删除历史表 `NODE_INTERACTION_SCHEMAS`：它与本表并存，导致
 *   「测试验旧表、生产走新表」的静默漂移）。机制层（类型 + 纯函数）见 `./nodeInteraction/`。
 */

import type { INodeInteractionSchema } from './nodeInteraction/types.js';
import { statEmojiInteraction, dynEmojiInteraction } from './catalogNodes/index.js';

/** 单条节点清单。 */
export interface INodeCatalogEntry {
	/** 节点原始全名（画布持久化的 `data.stageClass` / node.type）。 */
	readonly type: string;
	/** 显示标题（卡片阶段名、日志）。 */
	readonly title: string;
	/** 归一化别名（小写驼峰 / 引擎枚举名等），命中即归一到 `engineType`。 */
	readonly aliases?: ReadonlyArray<string>;
	/** 归一化后的引擎类型（如 'comfyStage' / 'picker'）；缺省按前缀推断。 */
	readonly engineType?: string;
	/** true = 本地/no-Run 节点（不需要 ComfyUI runner）。 */
	readonly localOnly?: boolean;
	/** 交互声明（可选）。 */
	readonly interaction?: INodeInteractionSchema;
}

/** 节点清单（新增节点 = 在这里加一条）。 */
export const NODE_CATALOG: ReadonlyArray<INodeCatalogEntry> = Object.freeze([
	// ── 配置型：卡片里配置参数后执行 ────────────────────────────────────────
	{
		type: 'ComfyTV.StatEmojiStage',
		title: '静态表情包',
		engineType: 'comfyStage',
		interaction: statEmojiInteraction,
	},
	{
		type: 'ComfyTV.DynEmojiStage',
		title: '动态表情包',
		engineType: 'comfyStage',
		interaction: dynEmojiInteraction,
	},
	// ── 选择型：从上游结果挑选后输出（节点不执行）──────────────────────────
	{
		type: 'ComfyTV.ImagePickerStage',
		title: 'ImagePicker',
		aliases: ['imagePickerStage', 'imagePicker'],
		// ★ 走 comfyStage 分支：由 _executeComfyNode 的交互段（apply:'snapshot'）接管并
		//   直接 return —— **不会真跑 ComfyUI**（选择型节点单链路，2026-09-11）。
		engineType: 'comfyStage',
		interaction: {
			title: '选择图像',
			apply: 'snapshot',
			snapshotSource: 'upstreams',
			multiSelect: true,
			fields: [],
		},
	},
	// ── 本地/no-Run：加载素材、无需 runner ────────────────────────────────
	{
		type: 'ComfyTV.ImageLoaderStage',
		title: 'ImageLoader',
		engineType: 'comfyStage',
		localOnly: true,
	},
]);

/** 按节点全名精确查找。 */
export function findNodeCatalogEntry(type: string | undefined): INodeCatalogEntry | undefined {
	if (!type) { return undefined; }
	return NODE_CATALOG.find(e => e.type === type);
}

/** 按别名（大小写不敏感）查找 —— 归一化用。 */
export function findCatalogByAlias(alias: string | undefined): INodeCatalogEntry | undefined {
	if (!alias) { return undefined; }
	const lower = alias.toLowerCase();
	return NODE_CATALOG.find(e => (e.aliases ?? []).some(a => a.toLowerCase() === lower));
}

/** 显示标题（未登记 → undefined，调用方回退旧表）。 */
export function catalogTitle(type: string | undefined): string | undefined {
	return findNodeCatalogEntry(type)?.title;
}

/**
 * 交互声明查找（**唯一入口**）。
 *
 * 2026-09-11：旧表 `NODE_INTERACTION_SCHEMAS` 已删除，此处不再有回退分支 ——
 * 「两张表并存」会让**测试验旧表、生产走新表**，从而静默漂移。现在只认 catalog。
 */
export function catalogInteraction(type: string | undefined): INodeInteractionSchema | undefined {
	if (!type) { return undefined; }
	return findNodeCatalogEntry(type)?.interaction;
}

/** 该节点是否本地/no-Run（不需要 ComfyUI runner）。 */
export function isCatalogLocalOnly(type: string | undefined): boolean {
	return findNodeCatalogEntry(type)?.localOnly === true;
}
