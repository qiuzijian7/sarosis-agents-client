/*---------------------------------------------------------------------------------------------
 *  Unit tests for StatEmojiStage（静态表情包节点）。
 *
 *  ★ 2026-09-11 重写：本文件原断言「逐格 invoke」模型（m×n 次调用 runner），
 *    该模型已被 **v7 整图图集模式**取代 —— 现在只 invoke **一次** 生成 m×n 拼贴
 *    整图，再在前端用 canvas 切分成各格（见 emojiExecutor.ts「整图图集模式（v7）」）。
 *    旧断言（4/9/6 次 invoke、逐格 prompt/seed、逐格归档）已全部失效。
 *
 *  切分（splitStickerSheet）依赖真实 DOM + canvas 2D，**Node 测试环境无法运行**
 *  （`document is not defined`）。但单次 invoke 发生在切分**之前**，因此本文件用
 *  「检查那一次 invoke 的 prompt 内容」的方式，在无 DOM 环境下仍能完整覆盖：
 *   - 整图模式 = 1 次 invoke（含 rows/cols clamp、run_scope）
 *   - prompt 组装：版式约束 + 每格描述 + 四级优先级 + 上游文本拆分
 *   - seed 注入 KSampler
 *   - 取消
 *   - 无 DOM 时的失败可读性（记录环境限制）
 *  纯函数（buildEmojiSheetPrompt / parseSheetCellCrops / defaultSheetCellCrops）直接单测。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	runNodeOrStage,
	buildEmojiSheetPrompt,
	parseSheetCellCrops,
	defaultSheetCellCrops,
} from '../../webview/src/features/workflowEditor/comfyHost/workflowRun.js';
import { MediaSnapshotStore } from '../../webview/src/features/workflowEditor/comfyHost/mediaSnapshotStore.js';
import type { IComfyRunner, ComfyRunResult } from '../../webview/src/features/workflowEditor/comfyHost/comfyRunner.js';
import { isExpiredSignedUrl } from '../../webview/src/features/workflowEditor/comfyHost/animatedEmojiExecutor.js';
import { getNodeSpec } from '../../webview/src/features/workflowEditor/comfyHost/registry.js';
import { STAGE_HIDDEN_FIELDS } from '../../webview/src/features/workflowEditor/comfyHost/stageCardRegistry.js';

/**
 * COS 签名 URL 过期判定（2026-09-12）：阶段作用域残留保护依赖它 —— 旧原片签名
 * 过期后拉取必 403（用户实测：阶段③ `net.fetchAsDataUrl: HTTP 403` 整节点失败）。
 */
suite('isExpiredSignedUrl（COS 签名 URL 过期判定）', () => {
	const now = 1_700_000_000_000;   // 固定「当前时间」便于断言
	const url = (start: number, end: number): string =>
		`https://b.cos-internal.r.tencentcos.cn/a.mp4?q-sign-algorithm=sha1&q-sign-time=${start};${end}&q-signature=x`;

	test('未过期 → false', () => {
		assert.strictEqual(isExpiredSignedUrl(url(now / 1000 - 60, now / 1000 + 3600), now), false);
	});

	test('★ 已过期 → true（阶段③ 会因此回落完整链路）', () => {
		assert.strictEqual(isExpiredSignedUrl(url(now / 1000 - 7200, now / 1000 - 3600), now), true);
	});

	test('边界：end == now → 不算过期（保守）', () => {
		assert.strictEqual(isExpiredSignedUrl(url(0, now / 1000), now), false);
	});

	test('非签名 URL / 空值 / 非法 → 一律 false（保守，交给实际拉取）', () => {
		assert.strictEqual(isExpiredSignedUrl('https://example.com/a.mp4', now), false);
		assert.strictEqual(isExpiredSignedUrl('data:video/mp4;base64,AAAA', now), false);
		assert.strictEqual(isExpiredSignedUrl('', now), false);
		assert.strictEqual(isExpiredSignedUrl(undefined, now), false);
		assert.strictEqual(isExpiredSignedUrl('https://x/a?q-sign-time=abc;def', now), false);
	});
});

/** In-memory backend so the real MediaSnapshotStore works in tests. */
function makeStore(): MediaSnapshotStore {
	const map = new Map<string, unknown>();
	return new MediaSnapshotStore({
		async save(key, data) { map.set(key, data); return key; },
		async load(key): Promise<string | Blob | null> { return (map.get(key) as string | Blob | undefined) ?? null; },
		async remove(key) { map.delete(key); },
	});
}

function makeRunner(): { runner: IComfyRunner; invocations: Array<Record<string, { class_type?: string; inputs?: Record<string, unknown> }>> } {
	const invocations: Array<Record<string, { class_type?: string; inputs?: Record<string, unknown> }>> = [];
	const runner: IComfyRunner = {
		id: 'test-runner',
		kind: 'local',
		baseUrl: 'http://localhost:8188',
		testConnection: async () => ({ ok: true }),
		invoke: async (opts) => {
			invocations.push(opts.prompt as typeof invocations[number]);
			const i = invocations.length;
			// 同时提供透明模板（resultNode=11）、fallback（resultNode=7）、Qwen 默认
			// （resultNode=13）的输出，三种模板都能从 /history 提取到 image。
			return {
				promptId: `prompt-${i}`,
				status: 'success' as const,
				outputs: {
					'11': { images: [{ filename: `emoji_${i}.png`, subfolder: '', type: 'output' }] },
					'7': { images: [{ filename: `emoji_fb_${i}.png`, subfolder: '', type: 'output' }] },
					'13': { images: [{ filename: `emoji_qwen_${i}.png`, subfolder: '', type: 'output' }] },
				},
			} satisfies ComfyRunResult;
		},
	};
	return { runner, invocations };
}

const emojiSpec = () => ({ kind: 'schema', comfyTV: { stageKind: 'emoji', workflowKind: 'emoji' } });

function baseInput(store: MediaSnapshotStore, runner: IComfyRunner, overrides: Record<string, unknown> = {}) {
	const { values, ...rest } = overrides;
	return {
		runner,
		nodeId: 'emoji-1',
		// ★ 节点已由 nodes/statEmojiNode.ts 声明式注册为 `ComfyTV.StatEmojiStage`
		//   （runNodeOrStage 首位 `getNodeDefinition(type)` 查表分发）。
		type: 'ComfyTV.StatEmojiStage',
		getSpec: emojiSpec,
		values: { workflow: '透明贴纸 (SDXL)', ...((values as Record<string, unknown>) ?? {}) },
		store,
		...rest,
	};
}

/** 从捕获的 prompt 里找 KSampler 节点并取某字段。 */
function ksamplerInput(prompt: Record<string, { class_type?: string; inputs?: Record<string, unknown> }>, key: string): unknown {
	for (const node of Object.values(prompt ?? {})) {
		if (node?.class_type === 'KSampler') { return node.inputs?.[key]; }
	}
	return undefined;
}

/** 从捕获的 prompt 里取所有 CLIPTextEncode 的 text（正/负向）。 */
function clipTexts(prompt: Record<string, { class_type?: string; inputs?: Record<string, unknown> }>): string[] {
	return Object.values(prompt ?? {})
		.filter(n => n?.class_type === 'CLIPTextEncode')
		.map(n => String(n.inputs?.['text'] ?? ''));
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数：整图 prompt 组装
// ─────────────────────────────────────────────────────────────────────────────

suite('buildEmojiSheetPrompt（整图 prompt 组装，纯函数）', () => {
	test('含 m×n 版式约束 + 每格描述', () => {
		const p = buildEmojiSheetPrompt(2, 3, ['橘猫', '黑猫', '白猫', '花猫', '灰猫', '黄猫']);
		assert.match(p, /2 rows/i, '应含行数版式约束');
		assert.match(p, /3 columns/i, '应含列数版式约束');
		for (const c of ['橘猫', '黑猫', '白猫', '花猫', '灰猫', '黄猫']) {
			assert.ok(p.includes(c), `应含每格描述 ${c}`);
		}
	});

	test('格子描述为空时不抛异常', () => {
		const p = buildEmojiSheetPrompt(1, 1, ['']);
		assert.strictEqual(typeof p, 'string');
		assert.ok(p.length > 0, '即使描述为空也应给出图集版式约束');
	});
});

suite('parseSheetCellCrops / defaultSheetCellCrops（纯函数）', () => {
	test('默认裁剪 = 等分 m×n，数量与网格一致', () => {
		const crops = defaultSheetCellCrops(2, 3);
		assert.strictEqual(crops.length, 6);
	});

	test('非法输入 → null（回退默认等分）', () => {
		assert.strictEqual(parseSheetCellCrops(undefined, 2, 2), null);
		assert.strictEqual(parseSheetCellCrops('not json', 2, 2), null);
		assert.strictEqual(parseSheetCellCrops([{ bad: 1 }], 2, 2), null);
	});

	test('合法 JSON 字符串 → 解析出对应数量的裁剪框', () => {
		const raw = JSON.stringify(defaultSheetCellCrops(1, 2));
		const parsed = parseSheetCellCrops(raw, 1, 2);
		assert.ok(parsed, '应解析成功');
		assert.strictEqual(parsed!.length, 2);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 集成：整图模式 = 单次 invoke（DOM 无关，断言 prompt 内容）
// ─────────────────────────────────────────────────────────────────────────────

suite('StatEmojiStage 整图图集模式（单次 invoke）', () => {
	test('★ 2×2 → 只 invoke 1 次（整图），不再是逐格 4 次', async () => {
		const store = makeStore();
		const { runner, invocations } = makeRunner();
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 2, cols: 2, run_scope: 'all', prompt: '卡通猫' },
		}));
		assert.strictEqual(invocations.length, 1, 'v7 整图模式：一次生成 m×n 拼贴整图');
	});

	test('★ 3×3 → 仍只 invoke 1 次，prompt 版式约束为 3×3', async () => {
		const store = makeStore();
		const { runner, invocations } = makeRunner();
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 3, cols: 3, run_scope: 'all', prompt: '猫' },
		}));
		assert.strictEqual(invocations.length, 1);
		const texts = clipTexts(invocations[0]).join('\n');
		assert.match(texts, /3 rows/i);
		assert.match(texts, /3 columns/i);
	});

	test('rows/cols 越界被 clamp（rows=99 → 6）', async () => {
		const store = makeStore();
		const { runner, invocations } = makeRunner();
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 99, cols: 1, run_scope: 'all', prompt: '猫' },
		}));
		assert.strictEqual(invocations.length, 1);
		const texts = clipTexts(invocations[0]).join('\n');
		assert.match(texts, /6 rows/i, 'rows=99 应被 clamp 到 6');
	});

	test('run_scope=cell + selected_index=2 → 同样 1 次 invoke（整图后取单格）', async () => {
		const store = makeStore();
		const { runner, invocations } = makeRunner();
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 2, cols: 2, run_scope: 'cell', selected_index: 2, prompt: '猫' },
		}));
		assert.strictEqual(invocations.length, 1);
	});
});

suite('StatEmojiStage prompt 组装（经整图 prompt）', () => {
	test('★ 主题模板兜底（style_preset；顶部全局 prompt 已被刻意取代）', async () => {
		// ★ 2026-09-11 契约同步：emojiExecutor.ts 注释明写「主题专属完整 prompt 模板：
		//   作为每格 prompt 的兜底主体（**取代原顶部全局 prompt**）」。故断言应针对
		//   `style_preset`（→ STYLE_PROMPT_TEMPLATE），而非 values.prompt。
		const store = makeStore();
		const { runner, invocations } = makeRunner();
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 1, cols: 1, run_scope: 'all', style_preset: 'Q版' },
		}));
		const texts = clipTexts(invocations[0]).join('\n');
		assert.match(texts, /chibi/i, '无手填时应回退所选主题的完整模板');
	});

	test('手填 cells prompt 逐格生效（并入整图 prompt）', async () => {
		const store = makeStore();
		const { runner, invocations } = makeRunner();
		await runNodeOrStage(baseInput(store, runner, {
			values: {
				rows: 1, cols: 2, run_scope: 'all',
				cells: JSON.stringify([{ prompt: '第一格猫' }, { prompt: '第二格狗' }]),
			},
		}));
		const texts = clipTexts(invocations[0]).join('\n');
		assert.ok(texts.includes('第一格猫'), '第 1 格描述应并入');
		assert.ok(texts.includes('第二格狗'), '第 2 格描述应并入');
	});

	test('seed 注入 KSampler（数值型）', async () => {
		const store = makeStore();
		const { runner, invocations } = makeRunner();
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 1, cols: 1, run_scope: 'all', cells: JSON.stringify([{ prompt: '猫', seed: 12345 }]) },
		}));
		const seed = ksamplerInput(invocations[0], 'seed');
		assert.strictEqual(typeof seed, 'number', 'KSampler 应收到数值 seed');
	});
});

suite('StatEmojiStage 取消与失败可读性', () => {
	test('signal.aborted → 返回 canceled', async () => {
		const store = makeStore();
		const { runner } = makeRunner();
		const ac = new AbortController();
		ac.abort();
		const r = await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 2, cols: 2, run_scope: 'all', prompt: '猫' },
			signal: ac.signal,
		}));
		assert.strictEqual(r.status, 'canceled');
	});

	test('★ 无 DOM 环境：整图切分不可用 → 返回可读 error（Node 测试环境已知限制）', async () => {
		// 切分（splitStickerSheet）依赖 document.createElement('canvas') + 2D 上下文，
		// Node 无 DOM → 生成成功但切分失败。本用例锁定「失败必须可读、不得静默」，
		// 并记录该环境限制（切分逻辑本身需浏览器环境验证）。
		const store = makeStore();
		const { runner, invocations } = makeRunner();
		const r = await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 2, cols: 2, run_scope: 'all', prompt: '猫' },
		}));
		assert.strictEqual(invocations.length, 1, '生成（invoke）本身应成功');
		assert.strictEqual(r.status, 'error', '切分失败应报 error 而非静默成功');
		assert.ok((r.error ?? '').length > 0, 'error 必须可读');
	});
});

/**
 * 动态表情包阶段①「提示词」字段的**接线契约**（2026-09-12 用户需求
 * 「视频生成 增加提示词 字段」）。
 *
 * 取值链：`spec.widgets.prompt`（TEXT）→ `node.properties.prompt` →
 * `getNodeCardMeta.prompt`（**meta 直传** —— TEXT 不进 `meta.controls` ✗）→
 * AnimatedEmojiEditor `initial.prompt` → 用户输入 → `onCommit({ prompt })` →
 * `node.properties.prompt` → 执行器 `runAnimatedEmoji` 读 `values.prompt`
 * （**优先于**上游 `texts` 端口的 TEXT 快照）。
 *
 * 链条上任何一环断开，症状都是「填了提示词却不生效 / 重开面板即丢」——这里锁住
 * 静态可查的两环（React 内部的两环由 UI 手测覆盖）。
 */
suite('AnimatedEmoji 阶段① 提示词字段接线契约', () => {

	test('★ spec 必须声明 prompt widget（编辑器 initial.prompt 走 meta.prompt 直传，依赖它）', () => {
		const spec = getNodeSpec('Saros.AnimatedEmoji');
		assert.ok(spec, 'Saros.AnimatedEmoji spec 必须存在（nodes/index.ts 副作用注册）');
		const w = (spec!.widgets ?? []).find(x => x.name === 'prompt');
		assert.ok(w, 'spec.widgets 必须含 prompt —— 否则 getNodeCardMeta.prompt 恒 undefined，'
			+ '编辑器读不回已存值（重开面板即丢），onCommit 还会把空串写回覆盖');
		assert.strictEqual(w!.type, 'TEXT', 'prompt 必须是 TEXT（执行器按字符串读 values.prompt）');
	});

	test('★ prompt 必须在 STAGE_HIDDEN_FIELDS（否则编辑器自绘 + 通用控件网格 = 双 UI）', () => {
		const hidden = STAGE_HIDDEN_FIELDS['Saros.AnimatedEmoji'] ?? [];
		assert.ok(hidden.includes('prompt'),
			'prompt 已由 AnimatedEmojiEditor 阶段① 自绘 → 必须列入隐藏字段，避免同一参数两套 UI');
	});
});
