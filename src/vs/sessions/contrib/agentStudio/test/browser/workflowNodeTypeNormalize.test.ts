/*---------------------------------------------------------------------------------------------
 *  Unit tests for node type normalization —— 全名化画布（Saros.*）⇄ 引擎枚举。
 *
 *  背景（2026-09-10 卡死实测）：画布持久化 `Saros.AskUser` 全名，而
 *  _executeNodeRecursive 的 switch 匹配引擎枚举 `askUser` —— 不归一化时
 *  编排节点全部落 default「Unknown node type, skipping」被静默跳过，
 *  下游 join 入度永不归零 → 执行卡死（wf-emoji-workflow 实测）。
 *  本测试锁定「归一化后的值必须命中引擎枚举」这一契约。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { normalizeRuntimeNodeType } from '../../browser/workflowExecutionService.js';
import { WorkflowNodeType } from '../../common/workflowStorage.js';
import { isNodeOnFlowChain, isFlowConnection } from '../../browser/workflow/flowChain.js';
import { resolveNodeDisplayName, isMachineNodeName, humanizeMachineName } from '../../browser/workflow/nodeDisplayName.js';
import {
	buildInteractionInitialValues, applyInteractionValues, resizeListToGrid,
	defaultFieldValue, currentFieldValue, buildImageRefDefaults, collectImageRefCandidates,
} from '../../browser/workflow/nodeInteraction/index.js';
import {
	newWorkflowSessionId, defaultSessionName, pickSessionForChat, buildWorkflowSession,
	touchWorkflowSession, sessionDisplayName, sortSessionsByRecent,
	type IWorkflowSessionMeta,
} from '../../common/workflowSessions.js';
import { MediaSnapshotStore } from '../../webview/src/features/workflowEditor/comfyHost/mediaSnapshotStore.js';
import {
	NODE_CATALOG, findNodeCatalogEntry, catalogTitle, catalogInteraction, isCatalogLocalOnly,
} from '../../browser/workflow/nodeCatalog.js';

/** 全部 14 种节点类型的画布全名（Saros.*）或裸形态。 */
const CANVAS_FORMS: Array<[string, WorkflowNodeType]> = [
	['Saros.Start', WorkflowNodeType.Start],
	['Saros.End', WorkflowNodeType.End],
	['Saros.Task', WorkflowNodeType.Task],
	['Saros.Prompt', WorkflowNodeType.Prompt],
	['Saros.Agent', WorkflowNodeType.Agent],
	['Saros.Skill', WorkflowNodeType.Skill],
	['Saros.Tool', WorkflowNodeType.Tool],
	['Saros.IfElse', WorkflowNodeType.IfElse],
	['Saros.Switch', WorkflowNodeType.Switch],
	['Saros.AskUser', WorkflowNodeType.AskUser],
	['Saros.Group', WorkflowNodeType.Group],
	['Saros.Script', WorkflowNodeType.Script],
];

suite('nodeType normalization (join 卡死修复契约)', () => {

	test('★ 每个画布全名归一化后必须命中引擎枚举（switch case 可达）', () => {
		for (const [canvas, expected] of CANVAS_FORMS) {
			const normalized = normalizeRuntimeNodeType(canvas);
			assert.strictEqual(normalized, expected, `canvas type ${canvas} should normalize to ${expected}`);
			// 归一化值必须能在引擎枚举中找到（switch case 可达性）
			assert.ok(Object.values(WorkflowNodeType).includes(normalized as WorkflowNodeType));
		}
	});

	test('幂等：已是枚举值的输入原样返回', () => {
		for (const v of Object.values(WorkflowNodeType)) {
			assert.strictEqual(normalizeRuntimeNodeType(v), v);
		}
	});

	test('AskUser 被正确识别（实测卡死节点）', () => {
		assert.strictEqual(normalizeRuntimeNodeType('Saros.AskUser'), 'askUser');
		assert.strictEqual(normalizeRuntimeNodeType('askUser'), 'askUser');
	});

	test('★ 媒体 stage 归一 comfyStage（表情包工作流 AnimatedEmoji 静默跳过实测）', () => {
		// Saros.* 前缀但不在编排枚举的媒体节点 → comfyStage（批次 71 修复）
		assert.strictEqual(normalizeRuntimeNodeType('Saros.AnimatedEmoji'), 'comfyStage');
		assert.strictEqual(normalizeRuntimeNodeType('Saros.EmojiStage'), 'comfyStage');
		// Comfy 家族全名（actionSpawn/state.addNode 证实画布持久化形态）
		assert.strictEqual(normalizeRuntimeNodeType('ComfyTV.EmojiStage'), 'comfyStage');
		assert.strictEqual(normalizeRuntimeNodeType('Comfy.ImageLoader'), 'comfy');
	});

	test('★ Picker 家族归一 comfyStage（单链路：由交互段 apply:snapshot 接管，不跑 ComfyUI）', () => {
		// 2026-09-11 单链路改造：不再有独立 'picker' 执行分支 —— Picker 归一为
		// comfyStage，但 _executeComfyNode 的交互段（catalog 声明 apply:'snapshot'）
		// 会先接管并 return，因此**不会真跑 ComfyUI**，也不需要 ComfyUI delegate。
		assert.strictEqual(normalizeRuntimeNodeType('ComfyTV.ImagePickerStage'), 'comfyStage');
		assert.strictEqual(normalizeRuntimeNodeType('ComfyTV.VideoPickerStage'), 'comfyStage');
		assert.strictEqual(normalizeRuntimeNodeType('ComfyTV.AudioPickerStage'), 'comfyStage');
		assert.strictEqual(normalizeRuntimeNodeType('Saros.ImagePickerStage'), 'comfyStage');
		// 非 Picker 的 Image* 节点不受影响（仍走媒体分支）
		assert.strictEqual(normalizeRuntimeNodeType('ComfyTV.ImageStage'), 'comfyStage');
	});

	test('★ Loader 家族走 comfyStage（不是 picker）——参考图物化前提', () => {
		// ★ 2026-09-10 契约（参考图丢失实锤后修正）：Loader 必须走 comfyStage →
		//   delegate → webview runLoaderNode 才能把「弹窗选定的图 / mediaAssetId」
		//   物化成快照返回（webview 侧 isLocalStage 已识别 → 无需 ComfyUI runner，
		//   纯本地产出，不真跑也不报错）。若归 picker 则只汇总上游（loader 无上游）
		//   → 快照恒空 → 下游 StatEmojiStage 参考图丢失。
		assert.strictEqual(normalizeRuntimeNodeType('ComfyTV.ImageLoaderStage'), 'comfyStage');
		assert.strictEqual(normalizeRuntimeNodeType('ComfyTV.VideoLoaderStage'), 'comfyStage');
		assert.strictEqual(normalizeRuntimeNodeType('ComfyTV.TextLoaderStage'), 'comfyStage');
		// Asset* 未注册本地执行器 → 同走 comfyStage（单链路；若声明 snapshot 交互则同样不执行）
		assert.strictEqual(normalizeRuntimeNodeType('ComfyTV.AssetLoaderStage'), 'comfyStage');
	});

	test('真正的第三方类型不误伤（原样返回）', () => {
		// ★ 2026-09-10 契约更新：ComfyTV.* → comfyStage（原「原样返回」正是
		//   表情包工作流媒体节点被静默跳过的根源，见上方媒体归一用例）。
		//   真正的第三方前缀（非 Saros./ComfyTV./Comfy.）仍原样返回。
		assert.strictEqual(normalizeRuntimeNodeType('KSampler'), 'KSampler');
		assert.strictEqual(normalizeRuntimeNodeType('MyPlugin.Node'), 'MyPlugin.Node');
	});
});

/**
 * FLOW 控制链判定（2026-09-10 用户规则）：
 * 「没有 flow 连线的节点，上下游的图片输出仍然正常执行；只有 flow 连线才可以
 *  在卡片中展示出阶段」——执行不受影响，卡片阶段列表只收 FLOW 链上的节点。
 */
suite('FLOW 控制链判定（flowChain）', () => {
	test('FLOW 边识别（flowOut → flowIn）', () => {
		assert.strictEqual(isFlowConnection({ from: 'a', to: 'b', fromPort: 'flowOut', toPort: 'flowIn' }), true);
		// 数据边（两侧都是业务端口名）不算 FLOW
		assert.strictEqual(isFlowConnection({ from: 'a', to: 'b', fromPort: 'images', toPort: 'batch' }), false);
	});

	test('★ 数据连线的节点不在卡片阶段列表（用户规则）', () => {
		// StatEmojiStage --images--> ImagePicker（纯数据连线，无 FLOW）
		const conns = [
			{ from: 'start', to: 'emoji', fromPort: 'flowOut', toPort: 'flowIn' },
			{ from: 'emoji', to: 'picker', fromPort: 'images', toPort: 'batch' },
		];
		assert.strictEqual(isNodeOnFlowChain(conns, 'emoji'), true, 'emoji 有 FLOW 入边 → 展示');
		assert.strictEqual(isNodeOnFlowChain(conns, 'picker'), false, 'picker 只有数据入边 → 不展示');
		assert.strictEqual(isNodeOnFlowChain(conns, 'start'), true, 'start 有 FLOW 出边 → 展示');
	});

	test('★ picker 接进 FLOW 链后即展示（想看到就连 FLOW）', () => {
		const conns = [
			{ from: 'emoji', to: 'picker', fromPort: 'images', toPort: 'batch' },
			{ from: 'picker', to: 'end', fromPort: 'flowOut', toPort: 'flowIn' },
		];
		assert.strictEqual(isNodeOnFlowChain(conns, 'picker'), true);
	});

	test('端口名缺失（旧工作流）保守视为 FLOW —— 不误隐藏', () => {
		const conns = [{ from: 'a', to: 'b' }];
		assert.strictEqual(isNodeOnFlowChain(conns, 'a'), true);
		assert.strictEqual(isNodeOnFlowChain(conns, 'b'), true);
	});

	test('孤立节点（无任何连线）不在链上', () => {
		assert.strictEqual(isNodeOnFlowChain([], 'lonely'), false);
		assert.strictEqual(isNodeOnFlowChain(undefined, 'lonely'), false);
	});
});

/**
 * 节点显示名（2026-09-10 用户要求「阶段名称要显示为工作流中的节点的名字」）：
 * 画布 stage 节点的 name/label 常是自动生成的机器名，卡片应显示画布 nodeCard
 * 上的可读标题（spec.title），或用户手动改的名字。
 */
suite('节点显示名（nodeDisplayName）', () => {
	const titles = new Map([
		['ComfyTV.StatEmojiStage', 'Emoji Stage'],
		['ComfyTV.ImagePickerStage', 'ImagePicker'],
	]);

	test('机器名识别（连字符/下划线两种形态）', () => {
		assert.strictEqual(isMachineNodeName('ComfyTV.StatEmojiStage-1788782920357-1'), true);
		assert.strictEqual(isMachineNodeName('ComfyTV.ImagePickerStage_1788248643751-2'), true);
		assert.strictEqual(isMachineNodeName('ComfyTV.ImageLoaderStage-1788248643715-2--dup33'), true);
		// 人类可读名不误伤
		assert.strictEqual(isMachineNodeName('Ask User'), false);
		assert.strictEqual(isMachineNodeName('表情包'), false);
		assert.strictEqual(isMachineNodeName('Start'), false);
		assert.strictEqual(isMachineNodeName(undefined), false);
	});

	test('★ 机器名 → 回退画布可读标题（spec.title）', () => {
		assert.strictEqual(resolveNodeDisplayName({
			candidates: ['ComfyTV.StatEmojiStage-1788782920357-1', 'ComfyTV.StatEmojiStage-1788782920357-1'],
			rawType: 'ComfyTV.StatEmojiStage',
			titleByType: titles,
			fallback: 'ComfyTV.StatEmojiStage-1788782920357-1',
		}), 'Emoji Stage');
	});

	test('用户手动命名优先（不被机器名过滤误伤）', () => {
		assert.strictEqual(resolveNodeDisplayName({
			candidates: ['表情包', 'ComfyTV.StatEmojiStage-1788782920357-1'],
			rawType: 'ComfyTV.StatEmojiStage',
			titleByType: titles,
			fallback: 'x',
		}), '表情包');
	});

	test('★ 无标题表时兜底 humanize（Emoji 家族不在 COMFYTV_STAGE_META）', () => {
		// 2026-09-11：Emoji 家族是内置工作流节点（不在 stage meta 表）→ 标题表查不到
		// → 兜底必须 humanize，否则卡片仍显示整串机器名。
		assert.strictEqual(resolveNodeDisplayName({
			candidates: ['ComfyTV.StatEmojiStage-1788782920357-1'],
			rawType: 'ComfyTV.StatEmojiStage',
			fallback: 'ComfyTV.StatEmojiStage-1788782920357-1',
		}), 'StatEmojiStage');
		assert.strictEqual(resolveNodeDisplayName({
			candidates: ['Saros.AnimatedEmoji-1788866814122-1'],
			rawType: 'Saros.AnimatedEmoji',
			fallback: 'Saros.AnimatedEmoji-1788866814122-1',
		}), 'AnimatedEmoji');
	});

	test('humanizeMachineName：去时间戳后缀 + 命名空间前缀', () => {
		assert.strictEqual(humanizeMachineName('ComfyTV.StatEmojiStage-1788782920357-1'), 'StatEmojiStage');
		assert.strictEqual(humanizeMachineName('ComfyTV.ImageLoaderStage-1788248643715-2--dup33'), 'ImageLoaderStage');
		assert.strictEqual(humanizeMachineName('Saros.AnimatedEmoji-1788866814122-1'), 'AnimatedEmoji');
	});

	test('★ 节点清单（catalog）驱动归一化/标题/交互/本地标记', () => {
		// 归一化（含别名）：新增节点只需在 nodeCatalog.ts 登记
		assert.strictEqual(normalizeRuntimeNodeType('ComfyTV.ImagePickerStage'), 'comfyStage');
		assert.strictEqual(normalizeRuntimeNodeType('imagePicker'), 'comfyStage', '别名命中');
		assert.strictEqual(normalizeRuntimeNodeType('ComfyTV.StatEmojiStage'), 'comfyStage');
		// 标题（卡片阶段名）
		assert.strictEqual(catalogTitle('ComfyTV.StatEmojiStage'), '静态表情包');
		// 交互（catalog 优先）
		assert.ok(catalogInteraction('ComfyTV.StatEmojiStage'), '交互来自 catalog');
		// 本地/no-Run 标记
		assert.strictEqual(isCatalogLocalOnly('ComfyTV.ImageLoaderStage'), true);
		assert.strictEqual(isCatalogLocalOnly('ComfyTV.StatEmojiStage'), false);
		// 未登记 → undefined（调用方回退旧逻辑，零影响）
		assert.strictEqual(findNodeCatalogEntry('ComfyTV.Unregistered'), undefined);
		assert.strictEqual(catalogTitle('ComfyTV.Unregistered'), undefined);
	});

	test('选择型声明（apply: snapshot）随 catalog 生效', () => {
		const it = catalogInteraction('ComfyTV.ImagePickerStage');
		assert.ok(it);
		assert.strictEqual(it!.apply, 'snapshot');
		assert.strictEqual(it!.snapshotSource, 'upstreams');
		assert.strictEqual(it!.multiSelect, true);
	});

	test('Ask User / Start 等可读名直接命中（非机器名）', () => {
		assert.strictEqual(resolveNodeDisplayName({
			candidates: ['Ask User'], fallback: 'id',
		}), 'Ask User');
		assert.strictEqual(resolveNodeDisplayName({
			candidates: ['Start'], fallback: 'id',
		}), 'Start');
	});
});

/**
 * 节点交互 UI 框架（2026-09-11 用户需求）：任意节点声明「执行前的卡片表单」，
 * 用户提交后才执行该节点。这里锁定 schema 取值/合并/列表补齐的纯逻辑。
 *
 * 2026-09-11 结构调整：机制（类型 + 纯函数）→ `browser/workflow/nodeInteraction/`；
 * 声明（逐节点）→ `nodeCatalog.ts`（唯一来源）+ `catalogNodes/<node>.ts`。
 * 查表统一走 `catalogInteraction()` —— 旧表 `NODE_INTERACTION_SCHEMAS` 已删除。
 */
suite('节点交互 schema（唯一来源：nodeCatalog + catalogNodes）', () => {
	test('静态表情包 schema 已登记（m×n + 风格 + 每格提示词）', () => {
		const schema = catalogInteraction('ComfyTV.StatEmojiStage');
		assert.ok(schema, 'StatEmojiStage 应有交互 schema');
		const kinds = schema!.fields.map(f => f.kind);
		assert.ok(kinds.includes('grid-size'));
		assert.ok(kinds.includes('select'));
		assert.ok(kinds.includes('list'));
		assert.strictEqual(catalogInteraction('ComfyTV.UnknownStage'), undefined);
		assert.strictEqual(catalogInteraction(undefined), undefined);
	});

	test('★ 框架契约：行为模式声明 + 扩展只改 nodeCatalog 一处', () => {
		// 配置型：不声明 apply → 默认 'values'（提交值合并后执行节点）
		const stat = catalogInteraction('ComfyTV.StatEmojiStage')!;
		assert.strictEqual(stat.apply, undefined, '配置型节点默认 values 模式');
		assert.ok(stat.title && stat.fields.length > 0, 'schema 必须有 title 与非空 fields');
		// 行为模式取值域（执行侧按此分流：合并执行 / 直接输出不执行 / 不执行不产出）
		const modes = ['values', 'snapshot', 'skip'] as const;
		assert.strictEqual(modes.length, 3);
		// 未登记类型不触发交互（零影响，向后兼容）
		assert.strictEqual(catalogInteraction('ComfyTV.SomeBrandNewStage'), undefined);
		// 选择型声明形态（新节点照此加一条即可，无需改执行侧/卡片侧）
		const pickerLike = { title: '选择素材', apply: 'snapshot' as const, snapshotSource: 'upstreams' as const, multiSelect: true, fields: [] };
		assert.strictEqual(pickerLike.apply, 'snapshot');
	});

	test('★ StatEmoji 提示词列表：跟随 m×n + 带默认预设（用户不填也能生成）', () => {
		const schema = catalogInteraction('ComfyTV.StatEmojiStage')!;
		const listField = schema.fields.find(f => f.kind === 'list') as
			{ countFrom?: string; preset?: readonly string[] } | undefined;
		assert.ok(listField, '应有 list 字段（每格提示词）');
		assert.strictEqual(listField!.countFrom, 'grid', '行数跟随 m×n 网格');
		assert.ok(Array.isArray(listField!.preset), '应带默认提示词预设');
		assert.ok((listField!.preset!.length ?? 0) >= 9, '预设数量应覆盖常见表情（≥9）');
		// grid-size 字段的 rowsKey/colsKey 与 countFrom 指向同一字段
		const gridField = schema.fields.find(f => f.kind === 'grid-size') as { key?: string } | undefined;
		assert.strictEqual(gridField?.key, listField!.countFrom, 'countFrom 应指向 grid-size 字段');
	});

	test('buildInteractionInitialValues：从节点现有配置取初值', () => {
		const schema = catalogInteraction('ComfyTV.StatEmojiStage')!;
		const init = buildInteractionInitialValues(schema, { rows: 2, cols: 4, style_preset: '像素' });
		assert.deepStrictEqual(init['grid'], { rows: 2, cols: 4 });
		assert.strictEqual(init['style_preset'], '像素');
		assert.deepStrictEqual(init['cells'], []);
	});

	test('★ applyInteractionValues：grid-size 展开成 rows/cols，提交值覆盖原配置', () => {
		const schema = catalogInteraction('ComfyTV.StatEmojiStage')!;
		const base = { rows: 3, cols: 3, style_preset: 'Q版', prompt: 'keep' };
		const merged = applyInteractionValues(schema, base, {
			grid: { rows: 2, cols: 5 },
			style_preset: '写实',
			cells: [{ prompt: '点赞' }, { prompt: '微笑' }],
		});
		assert.strictEqual(merged['rows'], 2);
		assert.strictEqual(merged['cols'], 5);
		assert.strictEqual(merged['style_preset'], '写实');
		assert.strictEqual(merged['prompt'], 'keep', '未提交的字段保持原值');
		assert.deepStrictEqual(merged['cells'], [{ prompt: '点赞' }, { prompt: '微笑' }]);
	});

	test('applyInteractionValues：null/undefined 不覆盖（防误清空）', () => {
		const schema = catalogInteraction('ComfyTV.StatEmojiStage')!;
		const merged = applyInteractionValues(schema, { style_preset: 'Q版' }, { style_preset: null });
		assert.strictEqual(merged['style_preset'], 'Q版');
	});

	test('★ resizeListToGrid：提示词行数跟随 m×n（含上限保护）', () => {
		const tpl = () => ({ prompt: '' });
		const out = resizeListToGrid([{ prompt: 'a' }], { rows: 2, cols: 2 }, tpl);
		assert.strictEqual(out.length, 4);
		assert.strictEqual(out[0]['prompt'], 'a');
		assert.strictEqual(out[3]['prompt'], '');
		assert.strictEqual(resizeListToGrid([], { rows: 20, cols: 20 }, tpl).length, 64, '上限 64');
		assert.strictEqual(resizeListToGrid(new Array(9).fill({ prompt: 'x' }), { rows: 1, cols: 1 }, tpl).length, 1, '缩小截断');
	});

	test('★ 参考图像字段（image-ref）：默认/取值/合并 + 上游默认参考图', () => {
		// ① schema 已声明该字段，key 指向节点「资产引用」同一存储属性
		const schema = catalogInteraction('ComfyTV.StatEmojiStage')!;
		const declared = schema.fields.find(x => x.kind === 'image-ref') as { key?: string } | undefined;
		assert.ok(declared, 'StatEmoji 应声明 image-ref 字段（2026-09-11 用户需求）');
		assert.strictEqual(declared!.key, 'comfytv_image_refs', '应写入节点「资产引用」同一存储键');

		const f = { kind: 'image-ref' as const, key: 'comfytv_image_refs', label: '参考图像', slot: 0 };

		// ② 默认值 = 空数组（= 未钉资产，执行侧回退上游连线图像）
		assert.deepStrictEqual(defaultFieldValue(f), []);

		// ③ 取值：数组 / JSON 字符串（node.properties 写回形态）/ 脏数据 / 缺失
		assert.deepStrictEqual(
			currentFieldValue(f, { comfytv_image_refs: [{ ref: 'a.png', slot: 0 }] }),
			[{ ref: 'a.png', slot: 0 }]);
		assert.deepStrictEqual(
			currentFieldValue(f, { comfytv_image_refs: '[{"ref":"b.png","slot":1}]' }),
			[{ ref: 'b.png', slot: 1 }], 'JSON 字符串形态应归一为数组');
		assert.deepStrictEqual(currentFieldValue(f, { comfytv_image_refs: 'not-json' }), []);
		assert.deepStrictEqual(currentFieldValue(f, {}), []);

		// ④ 提交值原样写回（条目校验由执行侧 parseAssetRefs 负责，不在此重复）
		assert.deepStrictEqual(
			applyInteractionValues(schema, {}, { comfytv_image_refs: [{ ref: 'c.png', slot: 0 }] })['comfytv_image_refs'],
			[{ ref: 'c.png', slot: 0 }]);

		// ⑤ 默认参考图：有上游图且节点未钉 → 用第一张；已钉 → 不覆盖；无上游 → 无默认
		assert.deepStrictEqual(
			buildImageRefDefaults(schema, { comfytv_image_refs: [] }, ['up1.png', 'up2.png']),
			{ comfytv_image_refs: [{ ref: 'up1.png', slot: 0 }] }, '未钉资产时应默认用上游图');
		assert.deepStrictEqual(
			buildImageRefDefaults(schema, { comfytv_image_refs: [{ ref: 'pinned.png', slot: 0 }] }, ['up1.png']),
			{}, '已钉资产不应被上游覆盖');
		assert.deepStrictEqual(
			buildImageRefDefaults(schema, { comfytv_image_refs: [] }, []),
			{}, '无上游图 → 无默认值（卡片改给「选择图像」按钮）');
	});

	test('★★ 参考图像候选：上游只作默认值，网格候选须含其它节点（修「无法选择」）', () => {
		// 由来（2026-09-11 用户报障「表情包的参考图像无法进行选择」）：
		//   候选**原本只取直接上游** —— 表情包节点上游只有 start（不产图）→ 候选为空 →
		//   卡片按「无候选不渲染按钮」连按钮都不给 → 用户完全无从指定参考图 ✗。
		const states = new Map<string, { snapshot?: Array<{ kind?: string; ref?: string }> }>([
			['start', { snapshot: [] }],
			['emoji', { snapshot: [{ kind: 'image', ref: 'out-1.png' }, { kind: 'image', ref: 'out-2.png' }] }],
			['other', { snapshot: [{ kind: 'image', ref: 'other-1.png' }, { kind: 'video', ref: 'v.mp4' }] }],
		]);

		// ① 上游只有 start（无图）→ 默认值无来源，但**网格候选仍应有其它节点的图** ✓
		const r1 = collectImageRefCandidates([{ from: 'start', to: 'emoji' }], states, 'emoji', id => `节点:${id}`);
		assert.deepStrictEqual(r1.upstream, [], '上游无图 → 默认值无来源');
		assert.deepStrictEqual(
			r1.all.map(c => c.ref),
			['other-1.png'],
			'网格候选须包含本工作流其它节点的图像（否则用户无从选择）');
		assert.strictEqual(r1.all[0].label, '节点:other', '非上游候选带节点名标签（可区分来源）');

		// ② 有上游图时上游**排在前面**（默认值取首张，语义不变）
		const r2 = collectImageRefCandidates([{ from: 'emoji', to: 'other' }], states, 'other', id => `节点:${id}`);
		assert.deepStrictEqual(r2.upstream.map(c => c.ref), ['out-1.png', 'out-2.png']);
		assert.strictEqual(r2.upstream[0].label, '上游图像');
		assert.deepStrictEqual(r2.all.map(c => c.ref), ['out-1.png', 'out-2.png'], '上游已收集，不重复');

		// ③ 节点**自身**产物不得成为自己的候选
		const r3 = collectImageRefCandidates([], states, 'emoji', undefined);
		assert.ok(!r3.all.some(c => c.ref.startsWith('out-')), '不得把节点自身产物当候选');
		// ④ 只收图像：video / audio 不入选
		assert.ok(!r3.all.some(c => c.ref.endsWith('.mp4')), '非图像媒体不入候选');
		// ⑤ 空入参不炸
		assert.deepStrictEqual(collectImageRefCandidates(undefined, undefined, 'x'), { upstream: [], all: [] });
	});

	test('★ 唯一来源守卫：交互声明只存在于 nodeCatalog（不得再有第二张按 type 索引的表）', () => {
		// 由来（2026-09-11）：曾同时存在 `NODE_INTERACTION_SCHEMAS`（旧表）与
		//   `NODE_CATALOG[].interaction`（新表），生产走 catalog、测试却走旧表 →
		//   两边可静默漂移。旧表已删除；本断言**扫描整个 workflow 目录**（位置无关），
		//   防止第二张表或旧查表函数在任何文件里被重新引入。
		const workflowDir = path.join(process.cwd(), 'src/vs/sessions/contrib/agentStudio/browser/workflow');
		const collect = (dir: string): string[] => {
			const out: string[] = [];
			for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
				const p = path.join(dir, ent.name);
				if (ent.isDirectory()) { out.push(...collect(p)); }
				else if (ent.name.endsWith('.ts') && !ent.name.endsWith('.d.ts')) { out.push(p); }
			}
			return out;
		};
		const offenders: string[] = [];
		for (const file of collect(workflowDir)) {
			for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
				const t = raw.trim();
				// 跳过注释行（说明文字里会提到旧表名，避免误报）
				if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) { continue; }
				if (/^(export\s+)?const\s+NODE_INTERACTION_SCHEMAS\s*[:=]/.test(t)
					|| /^export\s+(const|function)\s+getNodeInteractionSchema\b/.test(t)) {
					offenders.push(`${path.relative(process.cwd(), file)}: ${t.slice(0, 100)}`);
				}
			}
		}
		assert.deepStrictEqual(
			offenders,
			[],
			`交互声明的唯一来源应为 nodeCatalog；检测到第二张表 / 旧查表函数：\n${offenders.join('\n')}`,
		);

		// catalog 侧一致性：每个 interaction 都挂在已登记条目上，且形状合法。
		let withInteraction = 0;
		for (const e of NODE_CATALOG) {
			if (!e.interaction) { continue; }
			withInteraction++;
			assert.strictEqual(findNodeCatalogEntry(e.type)?.type, e.type, `${e.type} 的 interaction 必须有对应条目`);
			assert.ok(typeof e.interaction.title === 'string' && e.interaction.title.length > 0, `${e.type} interaction 应有 title`);
			assert.ok(Array.isArray(e.interaction.fields), `${e.type} interaction 应有 fields 数组`);
		}
		assert.ok(withInteraction >= 3, `应至少有 3 个节点声明了 interaction，实际 ${withInteraction}`);
	});
});

/**
 * 工作流 Session（2026-09-11 用户需求）：每个工作流可有多个 session 隔离生成内容，
 * 并与聊天 session 一一对应（同聊天 session 复用；切换聊天 session 新建）。
 */
suite('工作流 Session（workflowSessions）', () => {
	test('id 生成与默认命名', () => {
		const id = newWorkflowSessionId(1700000000000);
		assert.match(id, /^wfs_[0-9a-z]+_[0-9a-z]{6}$/);
		assert.notStrictEqual(newWorkflowSessionId(), newWorkflowSessionId());
		assert.strictEqual(defaultSessionName(1), '会话 1');
		assert.strictEqual(defaultSessionName(0), '会话 1', '至少为 1');
	});

	test('buildWorkflowSession：默认名按现有数量递增 + 绑定聊天 session', () => {
		const a = buildWorkflowSession({ workflowId: 'wf1', chatSessionId: 'chatA', existingCount: 0, now: 1000 });
		assert.strictEqual(a.name, '会话 1');
		assert.strictEqual(a.chatSessionId, 'chatA');
		assert.strictEqual(a.runCount, 0);
		const b = buildWorkflowSession({ workflowId: 'wf1', chatSessionId: 'chatB', existingCount: 1, now: 2000 });
		assert.strictEqual(b.name, '会话 2');
		assert.notStrictEqual(a.id, b.id);
		// 显式名优先
		assert.strictEqual(buildWorkflowSession({ workflowId: 'wf1', name: '我的实验' }).name, '我的实验');
	});

	test('★ pickSessionForChat：同聊天 session 复用，不同聊天 session 不复用', () => {
		const sessions: IWorkflowSessionMeta[] = [
			buildWorkflowSession({ workflowId: 'wf1', chatSessionId: 'chatA', existingCount: 0, now: 1000 }),
			buildWorkflowSession({ workflowId: 'wf1', chatSessionId: 'chatB', existingCount: 1, now: 2000 }),
		];
		assert.strictEqual(pickSessionForChat(sessions, 'chatA')?.chatSessionId, 'chatA');
		assert.strictEqual(pickSessionForChat(sessions, 'chatB')?.chatSessionId, 'chatB');
		// 未绑定过的聊天 session → undefined（调用方新建，实现隔离）
		assert.strictEqual(pickSessionForChat(sessions, 'chatC'), undefined);
		assert.strictEqual(pickSessionForChat(sessions, undefined), undefined);
		assert.strictEqual(pickSessionForChat([], 'chatA'), undefined);
	});

	test('pickSessionForChat：同一聊天 session 多条绑定取最近更新', () => {
		const older: IWorkflowSessionMeta = { ...buildWorkflowSession({ workflowId: 'wf1', chatSessionId: 'chatA', now: 1000 }), id: 's_old', updatedAt: 1000 };
		const newer: IWorkflowSessionMeta = { ...buildWorkflowSession({ workflowId: 'wf1', chatSessionId: 'chatA', now: 5000 }), id: 's_new', updatedAt: 5000 };
		assert.strictEqual(pickSessionForChat([older, newer], 'chatA')?.id, 's_new');
	});

	test('touchWorkflowSession：runCount 累加 + lastRunAt', () => {
		const s = buildWorkflowSession({ workflowId: 'wf1', now: 1000 });
		const t = touchWorkflowSession(s, 9000);
		assert.strictEqual(t.runCount, 1);
		assert.strictEqual(t.updatedAt, 9000);
		assert.ok(t.lastRunAt);
		assert.strictEqual(s.runCount, 0, '原对象不被修改（纯函数）');
	});

	test('sessionDisplayName / sortSessionsByRecent', () => {
		const s1: IWorkflowSessionMeta = { ...buildWorkflowSession({ workflowId: 'wf1', now: 1000 }), runCount: 3, name: '会话 1' };
		const s2: IWorkflowSessionMeta = { ...buildWorkflowSession({ workflowId: 'wf1', now: 9000 }), runCount: 0, name: '会话 2' };
		assert.strictEqual(sessionDisplayName(s1), '会话 1 · 3 次');
		assert.strictEqual(sessionDisplayName(s2), '会话 2');
		assert.deepStrictEqual(sortSessionsByRecent([s1, s2]).map(s => s.name), ['会话 2', '会话 1']);
	});
});

/**
 * 快照库 session 隔离（2026-09-11 用户需求核心）：同一工作流不同 session（对应不同
 * 聊天会话）生成的内容互不可见；切回原 session 仍能看到自己的产物。
 */
suite('快照库 session 隔离（MediaSnapshotStore）', () => {
	const mkStore = () => new MediaSnapshotStore({
		save: async () => '',
		load: async () => null,
		remove: async () => { /* noop */ },
	} as unknown as ConstructorParameters<typeof MediaSnapshotStore>[0]);

	test('★ 不同 session 的同名节点互不可见', () => {
		const store = mkStore();
		store.setActiveSession('wfs_A');
		store.put({ nodeId: 'n1', port: 'output', key: 'n1:output:0', media: { kind: 'image', ref: 'A-1' }, index: 0 });
		assert.strictEqual(store.byNode('n1').length, 1);
		assert.strictEqual(store.byNode('n1')[0].media.ref, 'A-1');

		// 切到 session B → 看不到 A 的内容（隔离）
		store.setActiveSession('wfs_B');
		assert.strictEqual(store.byNode('n1').length, 0, 'B 看不到 A 的产物');
		store.put({ nodeId: 'n1', port: 'output', key: 'n1:output:0', media: { kind: 'image', ref: 'B-1' }, index: 0 });
		assert.strictEqual(store.byNode('n1')[0].media.ref, 'B-1');

		// 切回 A → 自己的产物仍在
		store.setActiveSession('wfs_A');
		assert.strictEqual(store.byNode('n1').length, 1, 'A 的产物未被 B 覆盖');
		assert.strictEqual(store.byNode('n1')[0].media.ref, 'A-1');
	});

	test('byNode 返回的 nodeId 不含 session 前缀（消费方按节点 id 匹配）', () => {
		const store = mkStore();
		store.setActiveSession('wfs_A');
		store.put({ nodeId: 'nodeX', port: 'output', key: 'k', media: { kind: 'image', ref: 'r' }, index: 0 });
		assert.strictEqual(store.byNode('nodeX')[0].nodeId, 'nodeX');
	});

	test('session 内仍按 (nodeId, port) 追加历史（不覆盖）', () => {
		const store = mkStore();
		store.setActiveSession('wfs_A');
		store.put({ nodeId: 'n1', port: 'output', key: 'k0', media: { kind: 'image', ref: 'r0' }, index: 0 });
		store.put({ nodeId: 'n1', port: 'output', key: 'k0', media: { kind: 'image', ref: 'r1' }, index: 0 });
		assert.strictEqual(store.byNode('n1').length, 2);
	});

	test('★ pruneOrphans 不误删 scoped key（session 前缀不参与存活判定）', () => {
		const store = mkStore();
		store.setActiveSession('wfs_A');
		store.put({ nodeId: 'alive', port: 'output', key: 'k', media: { kind: 'image', ref: 'r' }, index: 0 });
		store.put({ nodeId: 'dead', port: 'output', key: 'k', media: { kind: 'image', ref: 'r2' }, index: 0 });
		// liveKeys 只含存活 nodeId（不带 session 前缀，与画布层调用一致）
		const removed = store.pruneOrphans(['alive']);
		assert.strictEqual(removed, 1, '只应删掉 dead 节点');
		assert.strictEqual(store.byNode('alive').length, 1, '存活节点（scoped key）未被误删');
	});

	test('旧数据（无 session 前缀）在当前 session 下仍可读（兼容）', () => {
		const store = mkStore();
		store.setActiveSession('wfs_A');
		// 直接按 legacy key 写入（模拟历史数据）
		(store as unknown as { refs: Map<string, unknown> }).refs.set('legacyNode:output:0', { kind: 'image', ref: 'old' });
		assert.strictEqual(store.byNode('legacyNode').length, 1, 'legacy key 回退可读');
	});
});
