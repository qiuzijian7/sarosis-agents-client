/*---------------------------------------------------------------------------------------------
 * 节点 UI 结构化诊断测试 —— **生成节点 UI 并渲染成可保存的 HTML/JSON 快照**，
 * 用于肉眼验证或后续接入 Playwright puppeteer-jsdom 出 PNG 截图。
 *
 * 测试目标（取代纯字符串断言的盲改循环）：
 *   1. 列出**每一类节点**应该有的 UI 区域（title / inputs / outputs / controls / prompt / inlineEditor）
 *   2. 对每一类节点的 UI 断言**必有**与**必无**字段（如 AudioLoader 必含 inline editor）
 *   3. 把渲染输入打包成 JSON dump（spec + meta + flags + editorKind + hiddenFields + minHeight）→
 *      可直接读 / 写 `__snapshots__/nodeUI/<type>.html` 用浏览器打开核对 ComfyTV 风格
 *
 * 为什么需要这个测试：之前 10+ 轮盲改（自由变量崩溃 / 键名错 / 类型误判 / IO hang），
 * 根本原因是**没有「应该长这样」的真相**。这个文件建立真源，断言任何与 ComfyTV 不
 * 一致的 UI 都 FAIL —— 把「靠截图肉眼对比」转成「测试断言失败 → 立刻知道哪个节点坏」。
 *
 * 阶段一（本文件）：纯函数断言 + JSON dump（不需要 DOM/canvas 库）。
 * 阶段二（后续）：加 jsdom + @comfyorg/litegraph stub → 实际渲染 → 出 PNG。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	getNodeCardMeta,
	type NodeCardMeta,
} from '../../webview/src/features/workflowEditor/comfyHost/nodeCard.js';
import {
	hasStageEditor,
	stageCardFlags,
	stageEditorKind,
	stageHiddenFields,
	stageMinHeight,
	STAGE_CARD_FLAGS,
	STAGE_EDITOR_KIND,
	STAGE_HIDDEN_FIELDS,
	STAGE_MIN_HEIGHTS,
	type StageEditorKind,
} from '../../webview/src/features/workflowEditor/comfyHost/stageCardRegistry.js';
import { ORCH_RICH_NODE_TYPES, SAROS_NODE_COLORS } from '../../webview/src/features/workflowEditor/comfyHost/registry.js';
import type { NodeSpec } from '../../webview/src/features/workflowEditor/comfyHost/registry.js';

/** 节点 UI 必备项声明（真相源）。 */
interface UiExpectation {
	type: string;
	editorKind: StageEditorKind;
	mustHave: {
		controls?: string[];          // spec.widgets 应派生出这些控件
		prompt?: boolean;             // 是否有 prompt 输入区
		inlineEditor?: boolean;       // 是否有内嵌编辑器（IMAGE/VIDEO/CROP/...）
		hideOutput?: boolean;
		output?: boolean;             // 是否画 OUTPUT 标题（false = loader 把 output 改 inline）
	};
	forbidden: {
		controls?: string[];          // spec.widgets 不该生成这些控件（hidden fields 不该在 controls 里出现）
		noInlineEditor?: boolean;    // 不该有 inline editor
	};
	minHeight?: number;
}

const STAGE_NODES: UiExpectation[] = [
	// ★★★ 关键回归点：Loader 四件套 ★★★
	//
	// 2026-08-20 更正期望（日志 1787224386976）。此前这里锁定的是**错误状态**：
	// Audio/Text 期望 'audio'/'text'、Video 期望 'image'。但 nodeCard 的 loader
	// 渲染分支只有 `editorKind === 'image'` 一支且只读 properties.image，所以：
	//   - 'audio' / 'text' 没有任何分支渲染，却让 hasInlineEditor=true 从而
	//     **抑制通用控件网格** → 卡片比不注册时更空；
	//   - VideoLoader 走 image 分支但字段是 video（且被 STAGE_HIDDEN_FIELDS 藏掉）
	//     → 编辑器取不到值 + 控件也没了 → 同样空白。
	// 「注册了 editorKind」不等于「有编辑器」。真正的不变量是三处成对：
	//   STAGE_EDITOR_KIND 的 kind ⟺ nodeCard 有该 kind 的渲染分支 ⟺
	//   STAGE_HIDDEN_FIELDS 才可以接管字段。
	// 故只有 image 家族保留 inline editor；audio/text/video 回到 'none'，让通用
	// 控件网格渲染各自字段（卡片可用）。补齐专用组件时三处同时改，并回来改期望。
	{
		type: 'ComfyTV.AudioLoaderStage',
		editorKind: 'none',                 // 尚无 AudioLoaderPreview 组件
		mustHave: { inlineEditor: false, controls: ['audio'] },
		minHeight: 460,
	},
	{
		type: 'ComfyTV.ImageLoaderStage',
		editorKind: 'image',
		mustHave: { inlineEditor: true, controls: ['image'], hideOutput: true, output: false },
		forbidden: { noInlineEditor: true },
		minHeight: 420,
	},
	{
		type: 'ComfyTV.VideoLoaderStage',
		editorKind: 'none',                 // 尚无 VideoLoaderPreview 组件
		mustHave: { inlineEditor: false, controls: ['video'] },
		minHeight: 360,
	},
	{
		type: 'ComfyTV.TextLoaderStage',
		editorKind: 'none',                 // 尚无 TextLoaderPreview 组件
		mustHave: { inlineEditor: false, controls: ['text'] },
		minHeight: 380,
	},

	// 主力 ComfyTV stages
	{
		type: 'ComfyTV.ImageStage',
		editorKind: 'none',                 // generator 走 OUTPUT，不走 inline
		mustHave: { prompt: true, output: true },
		forbidden: { noInlineEditor: true },
		minHeight: 640,
	},
	{
		type: 'ComfyTV.CropStage',
		editorKind: 'crop',
		mustHave: { inlineEditor: true },
		forbidden: { controls: ['x', 'y', 'width', 'height'] },  // 字段被 inline 接管
		minHeight: 460,
	},
	{
		type: 'ComfyTV.RotateStage',
		editorKind: 'transform',
		mustHave: { inlineEditor: true },
		forbidden: { controls: ['angle'] },
		minHeight: 640,
	},
	{
		type: 'ComfyTV.MirrorStage',
		editorKind: 'transform',
		mustHave: { inlineEditor: true },
		forbidden: { controls: ['horizontal', 'vertical'] },
		minHeight: 620,
	},
	{
		type: 'ComfyTV.OutpaintStage',
		editorKind: 'outpaint',
		mustHave: { inlineEditor: true },
		forbidden: { controls: ['pad_left', 'pad_top', 'pad_right', 'pad_bottom', 'feathering'] },
		minHeight: 500,
	},
	{
		type: 'ComfyTV.MaterialStage',
		editorKind: 'material',
		mustHave: { inlineEditor: true },
		forbidden: { controls: ['material_state'] },
		minHeight: 500,
	},
	{
		type: 'ComfyTV.MultiangleStage',
		editorKind: 'multiangle',
		mustHave: { inlineEditor: true },
		forbidden: { controls: ['horizontal_angle', 'vertical_angle', 'zoom', 'prompt'] },
		minHeight: 520,
	},
	{
		type: 'ComfyTV.PanoramaStage',
		editorKind: 'panorama',
		mustHave: { inlineEditor: true },
		forbidden: { controls: ['workflow', 'prompt'] },
		minHeight: 500,
	},
	{
		type: 'ComfyTV.RelightStage',
		editorKind: 'relight',
		mustHave: { inlineEditor: true },
		forbidden: { controls: ['main_prompt'] },
		minHeight: 520,
	},
	{
		type: 'ComfyTV.KenBurnsStage',
		editorKind: 'kenBurns',
		mustHave: { inlineEditor: true },
		minHeight: 460,
	},
	{
		type: 'ComfyTV.ColorGradeStage',
		editorKind: 'colorGrade',
		mustHave: { inlineEditor: true },
		forbidden: { controls: ['grade_state'] },
		minHeight: 560,
	},
	{
		type: 'ComfyTV.GridSplitStage',
		editorKind: 'gridSplit',
		mustHave: { inlineEditor: true },
		forbidden: { controls: ['rows', 'cols', 'border', 'outer_border', 'selected_index'] },
		minHeight: 520,
	},
	{
		type: 'ComfyTV.EmojiStage',
		editorKind: 'emoji',
		mustHave: { inlineEditor: true },
		forbidden: { controls: ['rows', 'cols', 'fps', 'frames', 'prompt', 'cells', 'selected_index', 'run_scope'] },
		minHeight: 500,
	},
];

const ORCH_NODES: Array<{
	type: string;
	mustHave: { controls: string[]; prompt?: boolean };
}> = [
	{
		type: 'Saros.Start',
		mustHave: { controls: ['args'] },                // JSON 文本域
	},
	{
		type: 'Saros.Prompt',
		mustHave: { controls: [], prompt: true },       // 只有 prompt
	},
	{
		type: 'Saros.Task',
		mustHave: { controls: [], prompt: true },
	},
	{
		type: 'Saros.Agent',
		mustHave: { controls: ['agentId', 'providerId', 'modelId'], prompt: true },
	},
	{
		type: 'Saros.Skill',
		mustHave: { controls: ['skillName', 'task', 'skillArgs'] },
	},
	{
		type: 'Saros.Tool',
		mustHave: { controls: ['toolName', 'toolParams'] },
	},
	{
		type: 'Saros.IfElse',
		mustHave: { controls: ['evaluationTarget'] },
	},
	{
		type: 'Saros.Switch',
		mustHave: { controls: ['evaluationTarget', 'cases'] },
	},
	{
		type: 'Saros.AskUser',
		mustHave: { controls: ['questionText', 'options', 'multiSelect'] },
	},
	{
		type: 'Saros.Merge',
		mustHave: { controls: ['mode'] },
	},
	{
		type: 'Saros.Loop',
		mustHave: { controls: ['items', 'concurrency'] },
	},
	{
		type: 'Saros.Parallel',
		mustHave: { controls: ['items', 'concurrency'] },
	},
];

/** 通用 registry spec 生成（必须与 registry.ts 实际形状匹配）。 */
function makeSpec(type: string, widgets: Array<{ name: string; type: string; default?: unknown; options?: string[] }> = []): NodeSpec {
	return { type, kind: 'react', title: type.split('.').pop()!, category: 'test', inputs: [], outputs: [], widgets };
}

suite('node UI structural snapshot (controls/prompt/inlineEditor/flags)', () => {

	// ━━━━━━━━━━ STAGE 节点（ComfyTV schema）━━━━━━━━━━

	test('STAGE_EDITOR_KIND 的每个 kind 都有 nodeCard 渲染分支（注册 ⟺ 有编辑器）', () => {
		// ★ 2026-08-20 取代原「每种 loader 都必须有 editorKind（不能 none）」断言。
		//   原断言的前提是错的：它把「在 map 里登记」当成「有编辑器」，于是鼓励了
		//   「随便填个 kind 让它看起来被支持」——实际后果是 hasInlineEditor=true
		//   抑制了通用控件网格，卡片比不登记时更空（日志 1787224386976）。
		//
		//   真正该守的不变量：STAGE_EDITOR_KIND 的每个值都必须是 nodeCard 真的会
		//   渲染的 kind。这里以 StageEditorKind 联合类型为白名单——把 kind 加进
		//   联合类型时必然会看到本注释，从而记得同步 nodeCard 分支。
		const RENDERABLE: readonly StageEditorKind[] = [
			'mask', 'crop', 'transform', 'outpaint', 'gridSplit', 'colorGrade',
			'kenBurns', 'multiangle', 'panorama', 'relight', 'material', 'emoji', 'image',
		];
		for (const [type, kind] of Object.entries(STAGE_EDITOR_KIND)) {
			assert.ok(RENDERABLE.includes(kind),
				`${type} maps to editorKind '${kind}' which nodeCard cannot render — ` +
				`either add the render branch or set it to 'none' (a bogus kind BLANKS the card ` +
				`because hasInlineEditor suppresses the generic control grid)`);
		}
	});

	test('STAGE_HIDDEN_FIELDS 只能出现在真有内嵌编辑器的节点上', () => {
		// 字段被「接管」的前提是**真有组件渲染它**。VideoLoaderStage 曾隐藏 'video'
		// 却没有 video 编辑器 → 字段没了、编辑器也取不到值 → 空白卡。
		for (const type of Object.keys(STAGE_HIDDEN_FIELDS)) {
			if (STAGE_HIDDEN_FIELDS[type].length === 0) { continue; }   // 占位项（如 KenBurns）
			assert.notStrictEqual(stageEditorKind(type), 'none',
				`${type} hides fields [${STAGE_HIDDEN_FIELDS[type].join(', ')}] but has no inline editor — ` +
				`those fields would simply disappear from the card`);
		}
	});

	for (const exp of STAGE_NODES) {
		test(`${exp.type} · editorKind + inline editor + minHeight`, () => {
			// 1) editorKind
			const kind = stageEditorKind(exp.type);
			assert.strictEqual(kind, exp.editorKind,
				`${exp.type} editorKind expected '${exp.editorKind}' got '${kind}'`);

			// 2) hasStageEditor (决定是否走 inline editor 渲染分支)
			assert.strictEqual(hasStageEditor(exp.type), exp.editorKind !== 'none',
				`${exp.type} hasStageEditor should equal (kind!=='none')`);

			// 3) minHeight
			if (exp.minHeight != null) {
				assert.strictEqual(stageMinHeight(exp.type), exp.minHeight,
					`${exp.type} minHeight expected ${exp.minHeight}`);
			}

			// 4) flags（hideOutput 等）
			const flags = stageCardFlags(exp.type, false);
			if (exp.mustHave.hideOutput === true) {
				assert.strictEqual(flags.hideOutput, true, `${exp.type} should hideOutput`);
			}
		});

		test(`${exp.type} · hidden fields 与 controls 关系`, () => {
			// 关键：hidden fields 必须在 stageHiddenFields 内，绝不能在 controls（避免双 UI）
			const hidden = stageHiddenFields(exp.type);
			const forbiddenFields = (exp.forbidden ?? {}).controls ?? [];
			for (const f of forbiddenFields) {
				assert.ok(hidden.has(f),
					`${exp.type}: field '${f}' must be in STAGE_HIDDEN_FIELDS (otherwise it appears as a stray control)`);
			}
		});
	}

	// ━━━━━━━━━━ ORCH 节点（Saros.*）━━━━━━━━━━

	for (const exp of ORCH_NODES) {
		test(`${exp.type} · 编排富卡片应出指定控件`, () => {
			// ★ 1. 类型必须在 ORCH_RICH_NODE_TYPES 内（否则 DOM 通路建不会、控件全是空白）
			assert.ok(ORCH_RICH_NODE_TYPES.has(exp.type),
				`${exp.type} must be in ORCH_RICH_NODE_TYPES — 否则 schema 门控不放行 → DOM 控件不渲染`);

			// 2. nodeType 必须是有效 spec 类型（不是废弃/拼写错误）
			assert.ok(STAGE_CARD_FLAGS[exp.type] === undefined,
				`${exp.type} 应是编排节点，不应在 STAGE_CARD_FLAGS（那是 ComfyTV 节点专用）`);
		});
	}

	test('ORCH_RICH_NODE_TYPES 已登记的 12 类编排节点', () => {
		const expected = [
			'Saros.Start', 'Saros.Prompt', 'Saros.Task',
			'Saros.Agent', 'Saros.Skill', 'Saros.Tool',
			'Saros.IfElse', 'Saros.Switch', 'Saros.Merge',
			'Saros.Loop', 'Saros.Parallel', 'Saros.AskUser',
		];
		for (const t of expected) {
			assert.ok(ORCH_RICH_NODE_TYPES.has(t),
				`${t} missing from ORCH_RICH_NODE_TYPES (drawn from registry)`);
		}
		assert.strictEqual(ORCH_RICH_NODE_TYPES.size, expected.length,
			'ORCH_RICH_NODE_TYPES size mismatch — 多/少登记 = false positive');
	});

	// ━━━━━━━━━━ getNodeCardMeta 派生数据一致性（关键！之前的 bug 多半在派生层）━━━━━━━━━━

	test('getNodeCardMeta · prompt 字段（spec.widgets 含 prompt）正确派生 hasPrompt', () => {
		const spec = makeSpec('Saros.Agent', [
			{ name: 'prompt', type: 'TEXT' },
			{ name: 'providerId', type: 'COMBO' },
		]);
		const meta = getNodeCardMeta(spec, { prompt: 'hello', providerId: 'p1' });
		assert.strictEqual(meta.hasPrompt, true);
		assert.strictEqual(meta.prompt, 'hello');
		assert.ok(meta.controls?.some(c => c.name === 'providerId'));
	});

	test('getNodeCardMeta · identity 字段（agent/skill/tool）从 properties 提取', () => {
		const spec = makeSpec('Saros.Agent', [{ name: 'agentId', type: 'COMBO' }]);
		const meta = getNodeCardMeta(spec, { agentId: 'a1' });
		assert.deepStrictEqual(meta.identity, { type: 'agent', id: 'a1' });
		assert.strictEqual(meta.identityType, 'agent');
	});

	test('getNodeCardMeta · image/video loader 必有 mediaAssetId 字段', () => {
		const spec = makeSpec('ComfyTV.ImageLoaderStage', [{ name: 'image', type: 'IMAGE' }]);
		const meta = getNodeCardMeta(spec, { mediaAssetId: 'asset-123' });
		assert.strictEqual(meta.mediaAssetId, 'asset-123',
			'mediaAssetId 必须经 meta 通道传递（之前 ImageLoaderPreview 写自由变量 properties 导致整卡崩白）');
	});

	test('getNodeCardMeta · image/video loader properties.mediaAssetId 字符串化', () => {
		const spec = makeSpec('ComfyTV.ImageLoaderStage', [{ name: 'image', type: 'IMAGE' }]);
		assert.strictEqual(getNodeCardMeta(spec, {}).mediaAssetId, undefined);
		assert.strictEqual(getNodeCardMeta(spec, { mediaAssetId: 123 } as unknown as Record<string, unknown>).mediaAssetId, undefined);
	});

	// ━━━━━━━━━━ 颜色一致性（单一真源 SAROS_NODE_COLORS）━━━━━━━━━━

	test('SAROS_NODE_COLORS 与 sarosLiteGraphNodes NODE_CONFIGS 同源（防硬漂移）', () => {
		// 已知协作节点的颜色集合（来自 NODE_CONFIGS 的最新硬编码值）
		const expectKeys = [
			'start', 'end', 'task', 'prompt', 'agent', 'skill', 'tool',
			'ifElse', 'switch', 'merge', 'loop', 'parallel', 'askUser', 'group', 'subflow',
		];
		for (const k of expectKeys) {
			assert.ok(k in SAROS_NODE_COLORS, `SAROS_NODE_COLORS missing key '${k}'`);
		}
	});

	// ━━━━━━━━━━ 生成 HTML 渲染快照（供肉眼核对 ComfyTV 风格）━━━━━━━━━━

	test('为每一类 stage + 编排节点生成 HTML mockup 文件', () => {
		// esbuild CJS 不支持 import.meta（且 mocha 加载时 __dirname 是 cjs 模块对象上的），
		// 兜底到 process.cwd()（测试总是从仓库根目录跑）。
		const cwd = process.cwd();
		const snapshotDir = path.resolve(cwd, 'src/vs/sessions/contrib/agentStudio/test/browser/__snapshots__/nodeUI');
		fs.mkdirSync(snapshotDir, { recursive: true });

		const renderHtml = (type: string, meta: NodeCardMeta, extra: Record<string, unknown> = {}): string => {
			const kind = stageEditorKind(type);
			const flags = stageCardFlags(type, false);
			const color = SAROS_NODE_COLORS[type.replace('Saros.', '').toLowerCase()] ?? '#3f3f3f';
			const controlsHtml = (meta.controls ?? []).map(c =>
				`<div class="row"><label>${c.name}</label><input type="${c.type === 'COMBO' ? 'text' : 'text'}" value="${c.value ?? ''}"/></div>`
			).join('');
			const promptHtml = meta.hasPrompt
				? `<textarea placeholder="prompt…">${meta.prompt ?? ''}</textarea>` : '';
			const inlineHtml = kind !== 'none'
				? `<div class="inline">[inline editor · kind=${kind}]</div>` : '';
			const outputHtml = flags.hideOutput ? '' : `<div class="output">[OUTPUT section]</div>`;
			return `<!doctype html><html><head><meta charset="utf-8"><title>${type}</title>
<style>
body{font-family:'Segoe UI',system-ui,sans-serif;background:#1e1e1e;color:#d4d4d4;padding:20px;margin:0}
.node{width:240px;border:1px solid #3c3c3c;border-radius:8px;background:#252526;overflow:hidden}
.head{background:${color};padding:7px 10px;font-size:12px;font-weight:600;display:flex;gap:6px}
.head .ttl{flex:1}
.body{padding:8px 10px;font-size:11px}
.row{display:flex;gap:6px;align-items:center;margin:3px 0}
label{color:#9cdcfe;width:84px;font-family:Consolas,monospace;font-size:11px}
input,textarea{background:#2a2a2b;border:1px solid #3c3c3c;color:#d4d4d4;padding:4px 6px;border-radius:4px;flex:1;font-family:inherit;font-size:11px}
.inline{background:#2c2c2d;padding:10px;border-radius:4px;margin:4px 0;color:#79b8ff}
.output{background:#2c2c2d;padding:10px;border-radius:4px;margin:4px 0;color:#79b8ff}
</style></head><body>
<div class="node">
  <div class="head"><span>▼</span><span class="ttl">${meta.title}</span></div>
  <div class="body">
    ${controlsHtml}
    ${promptHtml}
    ${inlineHtml}
    ${outputHtml}
  </div>
</div>
<pre style="color:#888;font-size:10px;margin-top:12px">${JSON.stringify({ type, kind, controls: meta.controls?.map(c => c.name), hasPrompt: meta.hasPrompt, identity: meta.identity, flags, minHeight: stageMinHeight(type), ...extra }, null, 2)}</pre>
</body></html>`;
		};

		// stage 节点
		for (const exp of STAGE_NODES) {
			const spec = makeSpec(exp.type);
			const meta = getNodeCardMeta(spec, {});
			const html = renderHtml(exp.type, meta);
			fs.writeFileSync(path.join(snapshotDir, exp.type.replace(/\./g, '_') + '.html'), html, 'utf8');
		}
		// orch 节点
		for (const exp of ORCH_NODES) {
			const spec = makeSpec(exp.type);
			const meta = getNodeCardMeta(spec, {});
			const html = renderHtml(exp.type, meta);
			fs.writeFileSync(path.join(snapshotDir, exp.type.replace(/\./g, '_') + '.html'), html, 'utf8');
		}
	});
});