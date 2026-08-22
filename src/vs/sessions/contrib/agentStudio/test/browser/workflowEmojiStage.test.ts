/*---------------------------------------------------------------------------------------------
 *  Unit tests for EmojiStage（表情包节点）— full execution chain through runNodeOrStage.
 *
 *  覆盖 runEmojiStageGrid 的完整功能：
 *   - 网格展开（rows × cols → m×n 次单图执行）
 *   - run_scope = 'all' / 'cell' 两种运行范围
 *   - prompt 四级优先级（严格 JSON cell > 手填 cells > 启发式拆分 > 全局）
 *   - 上游文本端口接入（text/texts）→ 拆分逐格分配
 *   - seed 传递（严格 cell 的 seed 注入 KSampler）
 *   - 透明模板失败 → 自动 fallback「普通贴纸」→ 成功
 *   - 全部失败 → 含 LayeredDiffusion 诊断提示
 *   - 取消
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { runNodeOrStage } from '../../webview/src/features/workflowEditor/comfyHost/workflowRun.js';
import { MediaSnapshotStore } from '../../webview/src/features/workflowEditor/comfyHost/mediaSnapshotStore.js';
import type { IComfyRunner, ComfyRunResult } from '../../webview/src/features/workflowEditor/comfyHost/comfyRunner.js';

/** In-memory backend so the real MediaSnapshotStore works in tests. */
function makeStore(): MediaSnapshotStore {
	const map = new Map<string, unknown>();
	return new MediaSnapshotStore({
		async save(key, data) { map.set(key, data); return key; },
		async load(key) { return map.get(key) ?? null; },
		async remove(key) { map.delete(key); },
	});
}

/** responder 每次 invoke 返回自定义结果；返回 undefined 则用默认成功结果。 */
type InvokeResponder = (callIndex: number, prompt: unknown) => ComfyRunResult | undefined;

function makeRunner(responder?: InvokeResponder): { runner: IComfyRunner; invocations: unknown[] } {
	const invocations: unknown[] = [];
	const runner: IComfyRunner = {
		id: 'test-runner',
		kind: 'local',
		baseUrl: 'http://localhost:8188',
		testConnection: async () => ({ ok: true }),
		invoke: async (opts) => {
			invocations.push(opts.prompt);
			const i = invocations.length;
			if (responder) {
				const r = responder(i, opts.prompt);
				if (r) { return r; }
			}
			// 同时提供透明模板（resultNode=9）和 fallback（resultNode=7）的输出，
			// 两种模板都能从 /history 提取到 image。
			return {
				promptId: `prompt-${i}`,
				status: 'success' as const,
				outputs: {
					'9': { images: [{ filename: `emoji_${i}.png`, subfolder: '', type: 'output' }] },
					'7': { images: [{ filename: `emoji_fb_${i}.png`, subfolder: '', type: 'output' }] },
				},
			};
		},
	};
	return { runner, invocations };
}

const emojiSpec = () => ({ kind: 'schema', comfyTV: { stageKind: 'emoji', workflowKind: 'emoji' } });

function baseInput(store: MediaSnapshotStore, runner: IComfyRunner, overrides: Record<string, unknown> = {}) {
	return {
		runner,
		nodeId: 'emoji-1',
		type: 'ComfyTV.EmojiStage',
		getSpec: emojiSpec,
		values: {},
		store,
		...overrides,
	};
}

/** 从 mock 捕获的 prompt 里取某节点的 class_type。 */
function classTypeOf(prompt: unknown, nodeId: string): string | undefined {
	const n = (prompt as Record<string, { class_type?: string }>)?.[nodeId];
	return n?.class_type;
}

/** 从 mock 捕获的 prompt 里取某节点的 input。 */
function inputOf(prompt: unknown, nodeId: string, key: string): unknown {
	const n = (prompt as Record<string, { inputs?: Record<string, unknown> }>)?.[nodeId];
	return n?.inputs?.[key];
}

suite('EmojiStage 网格展开', () => {
	test('2×2 网格 → runner.invoke 调用 4 次，store 归档 4 张图', async () => {
		const store = makeStore();
		const { runner, invocations } = makeRunner();
		const r = await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 2, cols: 2, run_scope: 'all', prompt: '卡通猫' },
		}));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(invocations.length, 4);
		const imgs = store.byNode('emoji-1').filter(e => e.media.kind === 'image');
		assert.strictEqual(imgs.length, 4);
	});

	test('3×3 网格 → 9 次执行', async () => {
		const store = makeStore();
		const { runner, invocations } = makeRunner();
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 3, cols: 3, run_scope: 'all', prompt: '猫' },
		}));
		assert.strictEqual(invocations.length, 9);
	});

	test('run_scope=cell + selected_index=2 → 只执行 1 次（第 2 格）', async () => {
		const store = makeStore();
		const { runner, invocations } = makeRunner();
		const r = await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 2, cols: 2, run_scope: 'cell', selected_index: 2, prompt: '猫' },
		}));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(invocations.length, 1);
	});

	test('rows/cols 越界被 clamp（rows=99 → 6）', async () => {
		const store = makeStore();
		const { runner, invocations } = makeRunner();
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 99, cols: 1, run_scope: 'all', prompt: '猫' },
		}));
		// rows clamp 到 6 → 6 次
		assert.strictEqual(invocations.length, 6);
	});
});

suite('EmojiStage prompt 四级优先级', () => {
	test('全局 prompt 注入 CLIPTextEncode（无 cells / 无上游）', async () => {
		const store = makeStore();
		const { runner, invocations } = makeRunner();
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 1, cols: 1, run_scope: 'all', prompt: '橘猫' },
		}));
		// 透明模板节点 3 = positive CLIPTextEncode，text = prompt + suffix
		const text = String(inputOf(invocations[0], '3', 'text'));
		assert.ok(text.startsWith('橘猫'), `期望以「橘猫」开头，实际=${text}`);
	});

	test('手填 cells prompt 逐格生效', async () => {
		const store = makeStore();
		const { runner, invocations } = makeRunner();
		const cells = JSON.stringify([{ prompt: '格0', seed: 0, text: '' }, { prompt: '格1', seed: 0, text: '' }]);
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 1, cols: 2, run_scope: 'all', cells, prompt: '全局兜底' },
		}));
		assert.ok(String(inputOf(invocations[0], '3', 'text')).startsWith('格0'));
		assert.ok(String(inputOf(invocations[1], '3', 'text')).startsWith('格1'));
	});

	test('上游 JSON 数组（严格 cell）覆盖手填 cells', async () => {
		const store = makeStore();
		// 上游文本节点输出 JSON 数组
		store.put({ nodeId: 'up-text', port: 'output', key: '', media: { kind: 'text', ref: '["猫","狗"]' } });
		const { runner, invocations } = makeRunner();
		const cells = JSON.stringify([{ prompt: '手填0', seed: 0, text: '' }, { prompt: '手填1', seed: 0, text: '' }]);
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 1, cols: 2, run_scope: 'all', cells },
			upstreams: ['up-text'],
		}));
		// 严格 cell 覆盖手填
		assert.ok(String(inputOf(invocations[0], '3', 'text')).startsWith('猫'));
		assert.ok(String(inputOf(invocations[1], '3', 'text')).startsWith('狗'));
	});

	test('上游多行文本 → 启发式逐行拆分', async () => {
		const store = makeStore();
		store.put({ nodeId: 'up-text', port: 'output', key: '', media: { kind: 'text', ref: '猫\n狗' } });
		const { runner, invocations } = makeRunner();
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 1, cols: 2, run_scope: 'all' },
			upstreams: ['up-text'],
		}));
		assert.ok(String(inputOf(invocations[0], '3', 'text')).startsWith('猫'));
		assert.ok(String(inputOf(invocations[1], '3', 'text')).startsWith('狗'));
	});

	test('上游文本不足 m×n 时循环复用', async () => {
		const store = makeStore();
		store.put({ nodeId: 'up-text', port: 'output', key: '', media: { kind: 'text', ref: '猫,狗' } });
		const { runner, invocations } = makeRunner();
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 1, cols: 4, run_scope: 'all' },
			upstreams: ['up-text'],
		}));
		// 2 条文本循环分配 4 格：猫 狗 猫 狗
		assert.ok(String(inputOf(invocations[0], '3', 'text')).startsWith('猫'));
		assert.ok(String(inputOf(invocations[1], '3', 'text')).startsWith('狗'));
		assert.ok(String(inputOf(invocations[2], '3', 'text')).startsWith('猫'));
		assert.ok(String(inputOf(invocations[3], '3', 'text')).startsWith('狗'));
	});

	test('全局 prompt 兜底（cells 空 + 无上游）', async () => {
		const store = makeStore();
		const { runner, invocations } = makeRunner();
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 1, cols: 1, run_scope: 'all', prompt: '全局猫' },
		}));
		assert.ok(String(inputOf(invocations[0], '3', 'text')).startsWith('全局猫'));
	});
});

suite('EmojiStage seed 传递', () => {
	test('严格 cell 的 seed 注入 KSampler', async () => {
		const store = makeStore();
		store.put({ nodeId: 'up-text', port: 'output', key: '', media: { kind: 'text', ref: '[{"prompt":"猫","seed":123}]' } });
		const { runner, invocations } = makeRunner();
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 1, cols: 1, run_scope: 'all' },
			upstreams: ['up-text'],
		}));
		// 透明模板 KSampler = 节点 6，seed 绑定 option:seed
		assert.strictEqual(inputOf(invocations[0], '6', 'seed'), 123);
	});

	test('seed=0 时随机（每格 seed 互不相同）', async () => {
		const store = makeStore();
		const { runner, invocations } = makeRunner();
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 1, cols: 3, run_scope: 'all', prompt: '猫' },
		}));
		const seeds = invocations.map(p => inputOf(p, '6', 'seed'));
		const unique = new Set(seeds);
		assert.strictEqual(unique.size, 3, `期望 3 个不同 seed，实际=${JSON.stringify(seeds)}`);
	});
});

suite('EmojiStage 自动 fallback', () => {
	test('透明模板失败 → 自动 fallback「普通贴纸」→ 成功', async () => {
		const store = makeStore();
		const { runner, invocations } = makeRunner((i) => {
			// 第一次（透明模板）失败
			if (i === 1) {
				return { promptId: 'p1', status: 'error', error: 'node not found: LayeredDiffusionApply', outputs: {} };
			}
			return undefined; // 后续（fallback）成功
		});
		const r = await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 1, cols: 1, run_scope: 'all', prompt: '猫' },
		}));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(invocations.length, 2, '透明模板 + fallback 各一次');
		// 第二次是 fallback：无 LayeredDiffusionApply 节点
		const second = invocations[1] as Record<string, { class_type?: string }>;
		const hasLayered = Object.values(second).some(n => n?.class_type === 'LayeredDiffusionApply');
		assert.strictEqual(hasLayered, false, 'fallback 模板不应含 LayeredDiffusionApply');
	});

	test('透明 + fallback 都失败 → error 含 LoRA 诊断提示', async () => {
		const store = makeStore();
		const { runner } = makeRunner(() => ({
			promptId: 'p',
			status: 'error' as const,
			error: 'node not found: layer_xl_transparent_conv',
			outputs: {},
		}));
		const r = await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 1, cols: 1, run_scope: 'all', prompt: '猫' },
		}));
		assert.strictEqual(r.status, 'error');
		assert.ok(r.error && r.error.includes('layer_xl_transparent_conv.safetensors'), `诊断提示缺失，实际=${r.error}`);
	});

	test('透明模板直接成功 → 不触发 fallback（invoke 仅 1 次）', async () => {
		const store = makeStore();
		const { runner, invocations } = makeRunner();
		const r = await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 1, cols: 1, run_scope: 'all', prompt: '猫' },
		}));
		assert.strictEqual(r.status, 'success');
		assert.strictEqual(invocations.length, 1);
		// 第一次即透明模板：含 LayeredDiffusionApply
		const first = invocations[0] as Record<string, { class_type?: string }>;
		const hasLayered = Object.values(first).some(n => n?.class_type === 'LayeredDiffusionApply');
		assert.strictEqual(hasLayered, true, '默认应走透明模板（含 LayeredDiffusionApply）');
	});

	test('用户显式选「普通贴纸」→ 直接走 fallback（不先试透明）', async () => {
		const store = makeStore();
		const { runner, invocations } = makeRunner();
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 1, cols: 1, run_scope: 'all', prompt: '猫', workflow: '普通贴纸 (SDXL, 无需 LoRA)' },
		}));
		assert.strictEqual(invocations.length, 1);
		const first = invocations[0] as Record<string, { class_type?: string }>;
		const hasLayered = Object.values(first).some(n => n?.class_type === 'LayeredDiffusionApply');
		assert.strictEqual(hasLayered, false, '显式选普通贴纸应跳过透明模板');
	});
});

suite('EmojiStage 取消', () => {
	test('signal.aborted → 返回 canceled', async () => {
		const store = makeStore();
		const { runner } = makeRunner();
		const r = await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 2, cols: 2, run_scope: 'all', prompt: '猫' },
			signal: { aborted: true } as unknown as AbortSignal,
		}));
		assert.strictEqual(r.status, 'canceled');
	});
});

suite('EmojiStage 上游文本容错', () => {
	test('上游 markdown 代码块 JSON 数组 → 正确解析', async () => {
		const store = makeStore();
		store.put({ nodeId: 'up-text', port: 'output', key: '', media: { kind: 'text', ref: '```json\n["猫","狗"]\n```' } });
		const { runner, invocations } = makeRunner();
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 1, cols: 2, run_scope: 'all' },
			upstreams: ['up-text'],
		}));
		assert.ok(String(inputOf(invocations[0], '3', 'text')).startsWith('猫'));
		assert.ok(String(inputOf(invocations[1], '3', 'text')).startsWith('狗'));
	});

	test('上游前后缀说明 + 内嵌数组 → 提取', async () => {
		const store = makeStore();
		store.put({ nodeId: 'up-text', port: 'output', key: '', media: { kind: 'text', ref: '好的，结果是：["猫","狗"]，共 2 个' } });
		const { runner, invocations } = makeRunner();
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 1, cols: 2, run_scope: 'all' },
			upstreams: ['up-text'],
		}));
		assert.ok(String(inputOf(invocations[0], '3', 'text')).startsWith('猫'));
		assert.ok(String(inputOf(invocations[1], '3', 'text')).startsWith('狗'));
	});

	test('上游非 JSON 纯文本 → 单条 prompt（不误拆逗号）', async () => {
		const store = makeStore();
		store.put({ nodeId: 'up-text', port: 'output', key: '', media: { kind: 'text', ref: '一只可爱的橘猫' } });
		const { runner, invocations } = makeRunner();
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 2, cols: 2, run_scope: 'all' },
			upstreams: ['up-text'],
		}));
		// 单条文本 → 所有格子共用（不同 seed 出变体）
		for (const p of invocations) {
			assert.ok(String(inputOf(p, '3', 'text')).startsWith('一只可爱的橘猫'));
		}
	});
});

/*---------------------------------------------------------------------------------------------
 *  归档顺序与去重 —— 覆盖「表情两两重复」那一类缺陷。
 *
 *  ★ 为什么单独立 suite：上面的用例只断言「invoke 调了几次 / prompt 注入对不对」，
 *    以及归档**数量**（`imgs.length === 4`）。而真实事故是**内容错位**：
 *    收尾重放误用 `port:'images'`（`comfyOutputsToSnapshots` 写入的是 `'output'`），
 *    store 里并存两组前缀、各自从 0 独立编号，`byNode` 按 index 排序后两组交错，
 *    于是「生成此表情」拿到的 `imagesOf().at(-1)` 是别的格子的图 →
 *    目标格被别格图覆盖、看起来两两重复。数量断言完全抓不到。
 *
 *  ⇒ 本 suite 一律断言**ref 的身份**（mock 的 filename 带 invoke 序号，
 *    第 N 次 invoke 的产物 ref 含 `emoji_N.png`），以及归档 key 的 port 唯一性。
 *--------------------------------------------------------------------------------------------*/

/** 该节点名下按 index 升序的图 ref 列表。 */
function imageRefs(store: MediaSnapshotStore, nodeId = 'emoji-1'): string[] {
	return store.byNode(nodeId).filter(e => e.media.kind === 'image').map(e => e.media.ref);
}
/** 归档 key 里出现过的 port 集合（`nodeId:port:index` 的中段）。 */
function archivedPorts(store: MediaSnapshotStore, nodeId = 'emoji-1'): Set<string> {
	return new Set(store.byNode(nodeId).filter(e => e.media.kind === 'image').map(e => e.port));
}

suite('EmojiStage 归档顺序与去重', () => {
	test('生成全部 2×2 → 4 张图互不重复，且按格序对应第 1~4 次 invoke', async () => {
		const store = makeStore();
		const { runner } = makeRunner();
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 2, cols: 2, run_scope: 'all', prompt: '猫' },
		}));
		const refs = imageRefs(store);
		assert.strictEqual(refs.length, 4, `期望 4 张，实际 ${refs.length}`);
		assert.strictEqual(new Set(refs).size, 4, `图 ref 出现重复：${JSON.stringify(refs)}`);
		// 归档顺序必须 == 格顺序（cellRefs 依赖这一点）
		for (let i = 0; i < 4; i++) {
			assert.ok(refs[i].includes(`emoji_${i + 1}.png`), `第 ${i} 格应是第 ${i + 1} 次 invoke 的产物，实际=${refs[i]}`);
		}
	});

	test('归档 port 唯一（不得并存 output / images 两组前缀）', async () => {
		const store = makeStore();
		const { runner } = makeRunner();
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 2, cols: 2, run_scope: 'all', prompt: '猫' },
		}));
		const ports = archivedPorts(store);
		assert.strictEqual(ports.size, 1, `归档 port 应唯一，实际=${JSON.stringify([...ports])}`);
		assert.ok(ports.has('output'), `port 应与 comfyOutputsToSnapshots 一致（output），实际=${JSON.stringify([...ports])}`);
	});

	test('★ 生成全部 → 再生成单格：只有目标格换成新图，其余格不动', async () => {
		const store = makeStore();
		const { runner, invocations } = makeRunner();
		// 第 1 轮：生成全部 4 格（invoke #1~#4）
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 2, cols: 2, run_scope: 'all', prompt: '猫' },
		}));
		const before = imageRefs(store);
		assert.strictEqual(before.length, 4);

		// 第 2 轮：只重生成第 1 格（invoke #5）
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 2, cols: 2, run_scope: 'cell', selected_index: 1, prompt: '猫' },
		}));
		assert.strictEqual(invocations.length, 5, '单格模式应只多跑 1 次');

		const after = imageRefs(store);
		assert.strictEqual(after.length, 4, `总数应仍为 4，实际 ${after.length}`);
		// 目标格 = 第 5 次 invoke 的新图
		assert.ok(after[1].includes('emoji_5.png'), `第 1 格应更新为 emoji_5.png，实际=${after[1]}`);
		// 其余格保持原样（这里曾被别格图覆盖 → 两两重复）
		assert.strictEqual(after[0], before[0], '第 0 格不应变化');
		assert.strictEqual(after[2], before[2], '第 2 格不应变化');
		assert.strictEqual(after[3], before[3], '第 3 格不应变化');
		assert.strictEqual(new Set(after).size, 4, `更新后出现重复图：${JSON.stringify(after)}`);
	});

	test('连续单格生成 3 次（不同格）→ 各格互不串号', async () => {
		const store = makeStore();
		const { runner } = makeRunner();
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 2, cols: 2, run_scope: 'all', prompt: '猫' },
		}));
		// 依次重生成 #0 / #2 / #3（invoke #5 / #6 / #7）
		for (const [idx, expect] of [[0, 5], [2, 6], [3, 7]] as Array<[number, number]>) {
			await runNodeOrStage(baseInput(store, runner, {
				values: { rows: 2, cols: 2, run_scope: 'cell', selected_index: idx, prompt: '猫' },
			}));
			const refs = imageRefs(store);
			assert.ok(
				refs[idx].includes(`emoji_${expect}.png`),
				`第 ${idx} 格应是 emoji_${expect}.png，实际=${refs[idx]}`,
			);
		}
		const final = imageRefs(store);
		assert.strictEqual(final.length, 4, `总数应仍为 4，实际 ${final.length}`);
		assert.strictEqual(new Set(final).size, 4, `出现重复图：${JSON.stringify(final)}`);
		// #1 未重生成，应保持第 1 轮的 emoji_2.png
		assert.ok(final[1].includes('emoji_2.png'), `第 1 格不应变化，实际=${final[1]}`);
	});

	test('首次即单格生成（store 为空）→ 图入库但落在 index 0（store 顺序语义的已知限制）', async () => {
		const store = makeStore();
		const { runner } = makeRunner();
		// 没有先「生成全部」，直接单格生成第 2 格
		await runNodeOrStage(baseInput(store, runner, {
			values: { rows: 2, cols: 2, run_scope: 'cell', selected_index: 2, prompt: '猫' },
		}));
		const refs = imageRefs(store);
		// ⚠ 记录**实际**行为而非理想行为：`store.put` 只能顺序追加分配 index、
		//   无法表达空洞，故 before 比 selIdx 短时该格图只能落在 index 0。
		//   要落在 index 2 需给 MediaSnapshotStore 加稀疏写入 API。
		//   本用例的价值是「图没被丢弃」+ 把该限制钉成显式契约（若哪天实现了
		//   稀疏写入，这里会红，提醒同步更新期望）。
		assert.strictEqual(refs.length, 1, `图不应被丢弃，实际 ${refs.length} 张`);
		assert.ok(refs[0].includes('emoji_1.png'), `应入库本次产物，实际=${refs[0]}`);
	});
});
