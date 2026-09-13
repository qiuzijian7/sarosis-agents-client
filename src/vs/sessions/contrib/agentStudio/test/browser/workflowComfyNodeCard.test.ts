/*---------------------------------------------------------------------------------------------
 *  Unit tests for nodeCard — React card metadata derivation (pure part).
 *  Covers title resolution, kind labelling, widget summary and schema detail.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { getNodeCardMeta, resolveControlOptions, selectEmojiCellOutputs, selectCardOutputs, isStaleEmojiArtifact } from '../../webview/src/features/workflowEditor/comfyHost/nodeCard.js';
import { emojiInputSig } from '../../webview/src/features/workflowEditor/comfyHost/animatedEmojiExecutor.js';
import type { NodeSpec } from '../../webview/src/features/workflowEditor/comfyHost/registry.js';
import type { MediaSnapshotEntry } from '../../webview/src/features/workflowEditor/comfyHost/mediaSnapshot.js';

suite('nodeCard (getNodeCardMeta)', () => {

	suite('resolveControlOptions (provider/model dynamic combos)', () => {

		const providers = [
			{
				id: 'p1', name: 'Provider 1',
				models: [
					{ id: 'm1', name: 'Model 1', supportsImageGen: true },
					{ id: 'm2', name: 'Model 2', supportsImageGen: false },
				],
			},
			{ id: 'p2', name: 'Provider 2', models: [{ id: 'm3', name: 'Model 3', supportsImageGen: true }] },
		];

		test('provider combo lists authenticated image-gen providers as label/value', () => {
			const opts = resolveControlOptions({ name: 'provider', type: 'COMBO', options: [] }, {}, providers);
			assert.deepStrictEqual(opts, [
				{ label: 'Provider 1', value: 'p1' },
				{ label: 'Provider 2', value: 'p2' },
			]);
		});

		test('model combo follows the selected provider and filters image-gen models', () => {
			const opts = resolveControlOptions({ name: 'model', type: 'COMBO', options: [] }, { provider: 'p1' }, providers);
			// m2 has supportsImageGen=false → excluded.
			assert.deepStrictEqual(opts, [{ label: 'Model 1', value: 'm1' }]);
		});

		test('★ model combo 未选 provider 时回退到第一个 provider（激活回退联动）', () => {
			// ★ 契约同步（2026-09-11）：与下一个用例（「激活回退联动」）同源 ——
			//   节点 properties 未选 provider 时，model 下拉**回退到第一个 provider**
			//   的可用模型（仍按 supportsImageGen 过滤），而不再返回 undefined。
			//   旧断言与本 suite 内其它用例自相矛盾（该文件长期无法构建，故未暴露）。
			const opts = resolveControlOptions({ name: 'model', type: 'COMBO', options: [] }, {}, providers);
			assert.deepStrictEqual(opts, [{ label: 'Model 1', value: 'm1' }]);
		});

		test('model combo 在无任何 provider 时返回 undefined', () => {
			// 保留原「无 provider → undefined」语义的空集场景（真无可用 provider 时）。
			const opts = resolveControlOptions({ name: 'model', type: 'COMBO', options: [] }, {}, []);
			assert.strictEqual(opts, undefined);
		});

		test('non-provider/model combos keep their static options', () => {
			const opts = resolveControlOptions({ name: 'workflow', type: 'COMBO', options: ['a', 'b'] }, {}, []);
			assert.deepStrictEqual(opts, ['a', 'b']);
		});

		test('model combo resolves through a provided effective provider draft (激活回退联动)', () => {
			// 节点 properties 为空但调用方已把 provider 兜底为第一个激活 provider 时，
			// model 应能列出该 provider 的可用模型（而非 undefined）。
			const opts = resolveControlOptions({ name: 'model', type: 'COMBO', options: [] }, { provider: 'p1' }, providers);
			assert.deepStrictEqual(opts, [{ label: 'Model 1', value: 'm1' }]);
		});
	});

	suite('title resolution', () => {

		test('prefers properties.title then label then spec.title then type', () => {
			const spec: NodeSpec = { type: 'Test.X', kind: 'react', title: 'SpecTitle', category: 'c', inputs: [], outputs: [] };
			assert.strictEqual(getNodeCardMeta(spec, { title: 'PT' }).title, 'PT');
			assert.strictEqual(getNodeCardMeta(spec, { label: 'PL' }).title, 'PL');
			assert.strictEqual(getNodeCardMeta(spec, {}).title, 'SpecTitle');
			assert.strictEqual(getNodeCardMeta({ ...spec, title: '' }, {}).title, 'Test.X');
		});

		test('falls back to "Node" when nothing known', () => {
			assert.strictEqual(getNodeCardMeta(undefined, {}).title, 'Node');
		});
	});

	suite('kind labelling', () => {

		test('maps spec.kind to display labels', () => {
			assert.strictEqual(getNodeCardMeta({ type: 'A', kind: 'react', category: 'c', inputs: [], outputs: [] }, {}).kindLabel, 'React');
			assert.strictEqual(getNodeCardMeta({ type: 'A', kind: 'schema', category: 'c', inputs: [], outputs: [] }, {}).kindLabel, 'schema→React');
			assert.strictEqual(getNodeCardMeta({ type: 'A', kind: 'native', category: 'c', inputs: [], outputs: [] }, {}).kindLabel, 'ComfyUI 原生');
		});

		test('missing spec defaults to react', () => {
			assert.strictEqual(getNodeCardMeta(undefined, {}).kind, 'react');
		});
	});

	suite('widget summary', () => {

		test('builds summary from spec widgets + property values', () => {
			const spec: NodeSpec = {
				type: 'KSampler', kind: 'native', title: 'KSampler', category: 's',
				inputs: [], outputs: [],
				widgets: [
					{ name: 'seed', type: 'INT', default: 0 },
					{ name: 'steps', type: 'INT', default: 20 },
					{ name: 'cfg', type: 'FLOAT', default: 7 },
				],
			};
			const meta = getNodeCardMeta(spec, { seed: 42 });
			assert.match(meta.widgetSummary ?? '', /seed=42/);
			assert.match(meta.widgetSummary ?? '', /steps/); // missing value → name only
		});

		test('no widgets → no summary', () => {
			assert.strictEqual(getNodeCardMeta({ type: 'X', kind: 'react', category: 'c', inputs: [], outputs: [] }, {}).widgetSummary, undefined);
		});

		test('ComfyTV schema stage shows default widgets (prompt/seed/…)', () => {
			const spec: NodeSpec = {
				type: 'ComfyTV.ImageStage', kind: 'schema', title: '文生图', category: 'c',
				inputs: [], outputs: [],
				widgets: [
					{ name: 'prompt', type: 'TEXT', default: '' },
					{ name: 'seed', type: 'INT', default: -1 },
					{ name: 'width', type: 'INT', default: 512 },
				],
				comfyTV: { stageKind: 'image', workflowKind: 'image' },
			};
			const meta = getNodeCardMeta(spec, { prompt: 'test1', seed: 42 });
			assert.match(meta.widgetSummary ?? '', /prompt=test1/);
			assert.match(meta.widgetSummary ?? '', /seed=42/);
		});

		test('ComfyTV schema stage exposes prompt text + quick actions', () => {
			const spec: NodeSpec = {
				type: 'ComfyTV.ImageStage', kind: 'schema', title: '文生图', category: 'c',
				inputs: [], outputs: [],
				widgets: [{ name: 'prompt', type: 'TEXT', default: '' }],
				comfyTV: { stageKind: 'image', workflowKind: 'image' },
			};
			const meta = getNodeCardMeta(spec, { prompt: 'a cat' });
			assert.strictEqual(meta.prompt, 'a cat');
			// ACTIONS 是 {icon,label} 对象（对齐 ComfyTV STAGE_ACTIONS.icon+label）
			assert.ok(meta.actions?.some(a => a.label === 'Edit Image'));
			assert.ok(meta.actions?.some(a => a.label === 'Relight'));
			// imageActions = 6 个（edit / panorama / multiangle / relight / material /
			// preset），对齐 ComfyTV stageActions.ts 的 imageActions（同 6 项）。
			assert.strictEqual(meta.actions?.length, 6, 'image stage 应有 6 个 actions（对齐 ComfyTV）');
			assert.strictEqual(meta.hasPrompt, true);
			assert.strictEqual(meta.brand, 'ComfyTV');
		});

		test('ComfyTV 服务端返回变体 stageKind（如 image-to-image/t2i）也能命中 5 个 image actions', () => {
			// /comfytv/stages 元数据里 kind 字段不一定是 'image'，可能是 'image-to-image' /
			// 't2i' / 'i2i' 等；归一化后必须回退到 image 家族的 5 个 actions。
			const spec: NodeSpec = {
				type: 'ComfyTV.ImageStage', kind: 'schema', title: 'Image Stage', category: 'comfyTV',
				inputs: [{ name: 'input', type: 'ANY' }],
				outputs: [{ name: 'output', type: 'COMFYTV_IMAGES' }],
				widgets: [],
				comfyTV: { stageKind: 'image-to-image', workflowKind: 't2i' },
			};
			const meta = getNodeCardMeta(spec, { prompt: 'a cat' });
			assert.strictEqual(meta.actions?.length, 6, 'image 变体 stageKind 也应命中 6 个 actions');
			assert.ok(meta.actions?.some(a => a.label === 'Edit Image'));
		});

		test('video / audio 变体 stageKind 也能命中对应 actions', () => {
			const videoSpec: NodeSpec = {
				type: 'ComfyTV.VideoStage', kind: 'schema', title: 'Video', category: 'comfyTV',
				inputs: [], outputs: [], widgets: [],
				comfyTV: { stageKind: 'video-to-video', workflowKind: 'v2v' },
			};
			assert.strictEqual(getNodeCardMeta(videoSpec, {}).actions?.length, 2);
			const audioSpec: NodeSpec = {
				type: 'ComfyTV.AudioStage', kind: 'schema', title: 'Audio', category: 'comfyTV',
				inputs: [], outputs: [], widgets: [],
				comfyTV: { stageKind: 'speech-to-speech', workflowKind: 's2s' },
			};
			assert.strictEqual(getNodeCardMeta(audioSpec, {}).actions?.length, 1);
		});

		test('react node has no prompt/actions', () => {
			const meta = getNodeCardMeta({ type: 'Saros.Prompt', kind: 'react', category: 'c', inputs: [], outputs: [] }, {});
			assert.strictEqual(meta.prompt, undefined);
			assert.strictEqual(meta.actions, undefined);
		});

		test('provider/model controls accept legacy providerId/modelId property names', () => {
			// canvas_generate 等写入 providerId/modelId（旧命名），卡片控件须兼容。
			const spec: NodeSpec = {
				type: 'Saros.ModelImageGen', kind: 'schema', title: '模型文生图', category: 'c',
				inputs: [], outputs: [], widgets: [
					{ name: 'provider', type: 'COMBO', default: '', options: [] },
					{ name: 'model', type: 'COMBO', default: '', options: [] },
				],
				backendKind: 'provider',
			};
			const meta = getNodeCardMeta(spec, { providerId: 'p1', modelId: 'm1' });
			assert.ok(meta.controls);
			assert.strictEqual(meta.controls!.find(c => c.name === 'provider')!.value, 'p1');
			assert.strictEqual(meta.controls!.find(c => c.name === 'model')!.value, 'm1');
		});

		test('ComfyTV schema stage: 参数 DOM 化，controls 含 workflow/batch_size，prompt 走 textarea', () => {
			const spec: NodeSpec = {
				type: 'ComfyTV.ImageStage', kind: 'schema', title: '文生图', category: 'c',
				inputs: [], outputs: [], widgets: [
					{ name: 'prompt', type: 'TEXT', default: '' },
					{ name: 'workflow', type: 'COMBO', default: 'turbo', options: ['turbo', 'ultra'] },
					{ name: 'batch_size', type: 'INT', default: 2, min: 0, max: 10 },
				],
				comfyTV: { stageKind: 'image', workflowKind: 'image' },
			};
			const meta = getNodeCardMeta(spec, { workflow: 'ultra' });
			// ★ 语义已反转（对齐 ComfyTV applyHiddenWidgetFlags）：ComfyTV 节点
			//   的 canvas widget 全 hidden，参数（workflow/batch_size）由 StageCard
			//   的 DOM controls 渲染；prompt（TEXT）由专门 textarea 渲染，**不进**
			//   controls。toControls 对 spec.comfyTV 收集 COMBO/INT/FLOAT/BOOLEAN。
			assert.ok(meta.controls);
			assert.strictEqual(meta.controls!.length, 2, 'ComfyTV DOM controls 含 workflow + batch_size');
			assert.ok(meta.controls!.some(c => c.name === 'workflow'));
			assert.ok(meta.controls!.some(c => c.name === 'batch_size'));
			assert.ok(!meta.controls!.some(c => c.name === 'prompt'), 'prompt 不应在 controls（由 textarea 渲染）');
			const workflow = meta.controls!.find(c => c.name === 'workflow');
			assert.strictEqual(workflow!.value, 'ultra');
			const batch = meta.controls!.find(c => c.name === 'batch_size');
			assert.strictEqual(batch!.value, 2);
		});
	});

	suite('schema detail', () => {

		test('renders comfyTV stage info', () => {
			const spec: NodeSpec = {
				type: 'ComfyTV.ImageStage', kind: 'schema', title: '文生图', category: 'c',
				inputs: [], outputs: [], comfyTV: { stageKind: 'image', workflowKind: 'image' },
			};
			const meta = getNodeCardMeta(spec, {});
			assert.match(meta.schemaDetail ?? '', /stage: image/);
			assert.match(meta.schemaDetail ?? '', /wf: image/);
		});

		test('no comfyTV → undefined detail', () => {
			assert.strictEqual(getNodeCardMeta({ type: 'X', kind: 'react', category: 'c', inputs: [], outputs: [] }, {}).schemaDetail, undefined);
		});
	});

	suite('port passthrough', () => {

		test('copies inputs/outputs from spec', () => {
			const spec: NodeSpec = {
				type: 'Dual', kind: 'react', title: 'D', category: 'c',
				inputs: [{ name: 'in', type: 'TEXT' }],
				outputs: [{ name: 'out', type: 'IMAGE' }],
			};
			const meta = getNodeCardMeta(spec, {});
			assert.strictEqual(meta.inputs[0].name, 'in');
			assert.strictEqual(meta.outputs[0].type, 'IMAGE');
		});

		test('missing spec → empty ports', () => {
			const meta = getNodeCardMeta(undefined, {});
			assert.deepStrictEqual(meta.inputs, []);
			assert.deepStrictEqual(meta.outputs, []);
		});
		});

		suite('selectEmojiCellOutputs (AnimatedEmoji 逐格产物)', () => {

		/** 造一条 AnimatedEmoji 产物条目（cellIndex + index 决定「哪格、多新」）。 */
		const entry = (cellIndex: number, index: number, ref = `r${cellIndex}-${index}`): MediaSnapshotEntry => ({
			nodeId: 'n1', port: 'output', key: `n1:output:${index}`, index,
			media: { kind: 'image', ref, meta: { cellIndex: String(cellIndex) } },
		});

		test('★ 9 格产物全部返回（不按上游格数截断）', () => {
			// 回归：2026-09-12 用户实测「生成 GIF 按钮执行完毕后，预览图没有更新」——
			// picker 由 9 张缩到 8 张（batchSize=8）而产物仍 9 格，旧的 `slice(-batchSize)`
			// 恰好丢掉 **cell 0**（刚跑完 ③ 的那一格）→ 预览永不更新 ✗。
			const cells = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(ci => entry(ci, ci));
			const out = selectEmojiCellOutputs(cells);
			assert.strictEqual(out.length, 9, '不得因上游格数变少而丢弃低位格');
			assert.deepStrictEqual(out.map(e => Number(e.media.meta?.cellIndex)), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
		});

		test('★ 同格多条 → 保留 index 最大（最新），并按格号升序', () => {
			// 执行器「原地替换」只换 index 最大的那条；卡片侧必须与它同口径，
			// 否则会取到「旧媒体 + 更大 index」的孤儿条目（预览看起来没更新）✗。
			const out = selectEmojiCellOutputs([
				entry(1, 3, 'old'),
				entry(0, 5, 'c0'),
				entry(1, 9, 'new'),
			]);
			assert.deepStrictEqual(out.map(e => e.media.ref), ['c0', 'new']);
		});

		test('无 cellIndex 的条目被忽略（非逐格产物）', () => {
			const noCell: MediaSnapshotEntry = { nodeId: 'n1', port: 'output', key: 'n1:output:0', index: 0, media: { kind: 'image', ref: 'x' } };
			assert.deepStrictEqual(selectEmojiCellOutputs([noCell]), []);
			assert.deepStrictEqual(selectEmojiCellOutputs([]), []);
		});

		test('★★ selectCardOutputs：产物格数 > batchSize 时**不得截断**（回归用例）', () => {
			// 用户实测场景：picker 由 9 张缩到 8 张 → batchSize=8，产物仍 9 格。
			// 旧实现 `deduped.slice(-batchSize)` 丢掉 **cell 0** → 刚跑完 ③ 的那格
			// 预览永远不更新 ✗。此断言即锁死该行为（改回截断会立刻失败）。
			const cells = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(ci => entry(ci, ci));
			const out = selectCardOutputs(cells, { isAnimatedEmoji: true, batchSize: 8 });
			assert.strictEqual(out.length, 9, 'AnimatedEmoji 逐格产物不得按 batchSize 截断');
			assert.strictEqual(Number(out[0].media.meta?.cellIndex), 0, 'cell 0 必须保留');
		});

		test('selectCardOutputs：非 AnimatedEmoji 仍按 batchSize 取最后 N 条', () => {
			const items = [0, 1, 2, 3].map(i => entry(i, i));
			const out = selectCardOutputs(items, { isAnimatedEmoji: false, batchSize: 2 });
			assert.deepStrictEqual(out.map(e => e.index), [2, 3]);
		});
		});
});

/**
 * 换批检测（2026-09-12 用户反馈「预览中的图像和输入端口引用的图像不匹配」）：
 * 产物与当前上游输入不一致 → 必须从预览剔除，否则用户看到的是**上一批输入**的产物 ✗。
 */
suite('isStaleEmojiArtifact（动态表情包产物换批检测）', () => {

	const refs = ['refA', 'refB', 'refC'];
	const entry = (cellIndex: number, srcSig?: string): MediaSnapshotEntry => ({
		nodeId: 'n1', port: 'output', key: `n1:output:${cellIndex}`, index: cellIndex,
		media: { kind: 'image', ref: `gif-${cellIndex}`, meta: { cellIndex, ...(srcSig ? { srcSig } : {}) } },
	});
	const opts = (over: Partial<{ enabled: boolean; upstreamRefs: readonly string[]; hasSigBearingArtifact: boolean }> = {}) => ({
		enabled: true, upstreamRefs: refs, hasSigBearingArtifact: false, ...over,
	});

	test('未启用（非动态表情包 / 无上游输入）→ 一律不判过期', () => {
		assert.strictEqual(isStaleEmojiArtifact(entry(0, 'x'), opts({ enabled: false })), false);
	});

	test('无 cellIndex（非逐格产物）→ 不判过期', () => {
		const e: MediaSnapshotEntry = { nodeId: 'n1', port: 'output', key: 'n1:output:0', index: 0, media: { kind: 'image', ref: 'x', meta: { srcSig: 'x' } } };
		assert.strictEqual(isStaleEmojiArtifact(e, opts()), false);
	});

	test('★ 格号越界（输入已缩到 3 格、产物是第 5 格）→ 必过期', () => {
		assert.strictEqual(isStaleEmojiArtifact(entry(5, emojiInputSig('whatever')), opts()), true);
	});

	test('★ 单图输入（length===1，图集整图兜底）→ 不得按格号判过期', () => {
		// 图集整图会本地切分成 N 格，产物格号 0..N-1 合法 —— 按 length 判会把它们全误杀 ✗。
		const sheetSig = emojiInputSig('sheetRef');
		assert.strictEqual(isStaleEmojiArtifact(entry(8, sheetSig), opts({ upstreamRefs: ['sheetRef'] })), false);
	});

	test('指纹与当前输入一致 → 不过期', () => {
		assert.strictEqual(isStaleEmojiArtifact(entry(1, emojiInputSig('refB')), opts()), false);
	});

	test('★ 旧版「按图集切格」产物（srcSig = 图集指纹）→ 与当前图集一致即不过期', () => {
		// 日志实证：旧版执行器走 sheetOnly（只吃图集整图）→ 产物 srcSig 记的是**图集**
		// 指纹 ✗。只比「第 i 格独立格」会把这一批全部误判过期（8 条视频集体隐藏）✗✗。
		const sheetSig = emojiInputSig('sheetRef');
		assert.strictEqual(isStaleEmojiArtifact(entry(1, sheetSig), opts({ sheetRef: 'sheetRef' })), false);
		// 图集也换过了（指纹不同）→ 才算过期
		assert.strictEqual(isStaleEmojiArtifact(entry(1, sheetSig), opts({ sheetRef: 'newSheet' })), true);
		// 未提供图集候选 → 仍按格指纹判定（保持原语义）
		assert.strictEqual(isStaleEmojiArtifact(entry(1, sheetSig), opts()), true);
	});

	test('指纹与当前输入不一致 → 过期', () => {
		assert.strictEqual(isStaleEmojiArtifact(entry(1, emojiInputSig('refB_old')), opts()), true);
	});

	test('★★ 无指纹的旧产物：本节点已有带指纹产物 → 判过期（本次修复核心）', () => {
		// 场景：旧版本生成的 9 个 GIF（无 srcSig）＋ 新版跑出的视频（有 srcSig）——
		// 旧 GIF 无法证明与当前输入一致 → 必须隐藏，否则用户看到上一批输入的图 ✗。
		// ★ 格号用 2（**在范围内**）：否则会被「格号越界」那条规则命中，测不到本规则 ✗。
		assert.strictEqual(isStaleEmojiArtifact(entry(2), opts({ hasSigBearingArtifact: true })), true);
	});

	test('无指纹的旧产物：整节点都无指纹 → 保留显示（升级瞬间不清空既有结果）', () => {
		assert.strictEqual(isStaleEmojiArtifact(entry(2), opts({ hasSigBearingArtifact: false })), false);
	});
});
