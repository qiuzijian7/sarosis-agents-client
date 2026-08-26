/*---------------------------------------------------------------------------------------------
 *  Unit tests for Vox 口播视频节点（Vox.DirectorStage / Vox.ScriptStage）本地 pipeline 执行。
 *
 *  覆盖：
 *   - buildVoxBeats：上游 beats JSON 透传（含 beats 字段对象 / 纯 beats 数组）+ topic 模板化
 *   - runVoxDirectorNode：mock runVoxPipeline 成功归档 video 快照 / 失败 error / 取消
 *   - runVoxScriptNode：生成本地 beats.json 文本
 *   - 类型判定 isVoxDirectorNode / isVoxScriptNode
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { runNodeOrStage, buildVoxBeats, isVoxDirectorNode, isVoxScriptNode } from '../../webview/src/features/workflowEditor/comfyHost/workflowRun.js';
import { MediaSnapshotStore } from '../../webview/src/features/workflowEditor/comfyHost/mediaSnapshotStore.js';
import type { IComfyRunner } from '../../webview/src/features/workflowEditor/comfyHost/comfyRunner.js';

function makeStore(): MediaSnapshotStore {
	const map = new Map<string, unknown>();
	return new MediaSnapshotStore({
		async save(key, data) { map.set(key, data); return key; },
		async load(key) { return map.get(key) ?? null; },
		async remove(key) { map.delete(key); },
	});
}

function makeRunner(): IComfyRunner {
	return {
		id: 'test-runner',
		kind: 'local',
		baseUrl: 'http://localhost:8188',
		testConnection: async () => ({ ok: true }),
		invoke: async () => ({ promptId: 'p', status: 'success', outputs: {} }),
	};
}

const voxSpec = () => ({ kind: 'schema', comfyTV: { stageKind: 'vox-director', workflowKind: 'vox-director' } });

suite('buildVoxBeats（上游透传 + topic 模板）', () => {
	test('上游含 beats 字段的 JSON 对象 → 透传', () => {
		const upstream = ['{"beats":[{"id":1,"narration":"你好","scene":"场景"}]}'];
		const out = buildVoxBeats({}, upstream) as { beats: Array<{ narration: string }> };
		assert.strictEqual(out.beats[0].narration, '你好');
	});

	test('上游纯 beats 数组 → 包装透传（保留 narration）', () => {
		const upstream = ['[{"id":1,"narration":"第一段","scene":"s1"},{"id":2,"narration":"第二段","scene":"s2"}]'];
		const out = buildVoxBeats({ aspect: '16:9' }, upstream) as { beats: Array<{ narration: string }>; aspect: string };
		assert.strictEqual(out.beats.length, 2);
		assert.strictEqual(out.beats[1].narration, '第二段');
		assert.strictEqual(out.aspect, '16:9');
	});

	test('上游 markdown 代码块 beats JSON → 提取', () => {
		const upstream = ['```json\n{"beats":[{"id":1,"narration":"猫"}]}\n```'];
		const out = buildVoxBeats({}, upstream) as { beats: Array<{ narration: string }> };
		assert.strictEqual(out.beats[0].narration, '猫');
	});

	test('无上游 → topic 模板化生成 beats_count 个 beat', () => {
		const out = buildVoxBeats({ topic: 'AI 未来', beats_count: 3 }, []) as { beats: unknown[] };
		assert.strictEqual(out.beats.length, 3);
	});

	test('topic 模板化的 beat：narration 用中文，scene 必须是英文（SDXL CLIP 拒中文）', () => {
		const out = buildVoxBeats({ topic: 'AI 未来', beats_count: 2, camera_move: 'zoom_in', duration: 5 }, []) as {
			beats: Array<{ narration: string; scene: string; shots: Array<{ camera_move: string; duration: number; scene: string }> }>;
		};
		// ★ narration 用中文（给 edge-tts 念，OK）
		assert.strictEqual(out.beats[0].narration, 'AI 未来');
		// ★ scene 不能是中文（SDXL 的 CLIP 文本编码器只认英文，中文会被忽略，
		//   导致 keyframe 图只根据英文风格描述随机生成，跟文章内容完全脱钩）
		assert.ok(/[一-龥]/.test(out.beats[0].narration), 'narration 应保留中文供 TTS');
		assert.ok(!/[一-龥]/.test(out.beats[0].scene), 'scene 不能含中文（SDXL 拒）');
		assert.ok(/english/i.test('thematic visual composition') || out.beats[0].scene.length > 10, 'scene 是英文占位描述');
		assert.strictEqual(out.beats[0].shots[0].camera_move, 'zoom_in');
		assert.strictEqual(out.beats[0].shots[0].duration, 5);
		// ★ shot 级 scene 是 python keyframes.py shots_of() 的硬依赖（KeyError 若无）
		assert.strictEqual(out.beats[0].shots[0].scene, out.beats[0].scene);
		assert.ok(!/[一-龥]/.test(out.beats[0].shots[0].scene), 'shot 级 scene 也不能含中文');
	});

	test('topic 模板化的 scene 包含 theme 风格信息', () => {
		const out = buildVoxBeats({ topic: 'x', theme: 'chinese-ink' }, []) as { beats: Array<{ scene: string }> };
		assert.ok(out.beats[0].scene.includes('chinese-ink'), 'scene 应包含 theme 风格');
	});

	test('topic 空 → beat narration 回退「第 N 段」', () => {
		const out = buildVoxBeats({ beats_count: 2 }, []) as { beats: Array<{ narration: string }> };
		assert.strictEqual(out.beats[0].narration, '第 1 段');
		assert.strictEqual(out.beats[1].narration, '第 2 段');
	});
});

suite('runVoxDirectorNode（本地 pipeline）', () => {
	test('成功 → 归档 video 快照（ref 为 file:// 路径）', async () => {
		const store = makeStore();
		const runner = makeRunner();
		const r = await runNodeOrStage({
			runner, nodeId: 'vox-1', type: 'Vox.DirectorStage', getSpec: voxSpec,
			values: { topic: 'AI 未来', beats_count: 2 },
			store,
			runVoxPipeline: async ({ projectId, beats, onStage }) => {
				onStage?.('keyframes', 25);
				// 校验 beats 已组装
				assert.ok((beats as { beats: unknown[] }).beats.length === 2);
				assert.ok(projectId.startsWith('vox-'));
				return { ok: true, finalMp4Path: 'G:\\vox\\out\\p\\final.mp4', finalMp4Url: 'http://127.0.0.1:8191/p/final.mp4' };
			},
		});
		assert.strictEqual(r.status, 'success');
		const vids = store.byNode('vox-1').filter(e => e.media.kind === 'video');
		assert.strictEqual(vids.length, 1);
		// ★ 免费方案 + 视频显示层：ref 用静态服务 http URL（webview 可播放），
		//   本地绝对路径存 meta.localPath。
		assert.strictEqual(vids[0].media.ref, 'http://127.0.0.1:8191/p/final.mp4');
		assert.strictEqual(vids[0].media.meta?.localPath, 'G:\\vox\\out\\p\\final.mp4');
	});

	test('pipeline 失败 → 返回 error', async () => {
		const store = makeStore();
		const runner = makeRunner();
		const r = await runNodeOrStage({
			runner, nodeId: 'vox-1', type: 'Vox.DirectorStage', getSpec: voxSpec,
			values: { topic: 'AI' }, store,
			runVoxPipeline: async () => ({ ok: false, error: 'MUAPI_API_KEY 未设置' }),
		});
		assert.strictEqual(r.status, 'error');
		assert.ok(r.error?.includes('MUAPI_API_KEY 未设置'));
	});

	test('signal.aborted → canceled', async () => {
		const store = makeStore();
		const runner = makeRunner();
		const r = await runNodeOrStage({
			runner, nodeId: 'vox-1', type: 'Vox.DirectorStage', getSpec: voxSpec,
			values: { topic: 'AI' }, store, signal: { aborted: true } as unknown as AbortSignal,
			runVoxPipeline: async () => ({ ok: true, finalMp4Path: 'G:\\x\\final.mp4' }),
		});
		assert.strictEqual(r.status, 'canceled');
	});

	test('未注入 runVoxPipeline → 明确报错', async () => {
		const store = makeStore();
		const runner = makeRunner();
		const r = await runNodeOrStage({
			runner, nodeId: 'vox-1', type: 'Vox.DirectorStage', getSpec: voxSpec,
			values: { topic: 'AI' }, store,
		});
		assert.strictEqual(r.status, 'error');
		assert.ok(r.error?.includes('runVoxPipeline 未注入'));
	});
});

suite('runVoxScriptNode（生成 beats.json 文本）', () => {
	test('生成 beats.json 文本并归档 text 快照', async () => {
		const store = makeStore();
		const runner = makeRunner();
		const r = await runNodeOrStage({
			runner, nodeId: 'script-1', type: 'Vox.ScriptStage', getSpec: voxSpec,
			values: { topic: 'AI 未来', beats_count: 3 }, store,
		});
		assert.strictEqual(r.status, 'success');
		const texts = store.byNode('script-1').filter(e => e.media.kind === 'text');
		assert.strictEqual(texts.length, 1);
		const parsed = JSON.parse(texts[0].media.ref) as { beats: unknown[] };
		assert.strictEqual(parsed.beats.length, 3);
	});
});

suite('类型判定', () => {
	test('isVoxDirectorNode / isVoxScriptNode', () => {
		assert.strictEqual(isVoxDirectorNode('Vox.DirectorStage'), true);
		assert.strictEqual(isVoxDirectorNode('Vox.ScriptStage'), false);
		assert.strictEqual(isVoxScriptNode('Vox.ScriptStage'), true);
		assert.strictEqual(isVoxScriptNode('ComfyTV.ImageStage'), false);
	});
});
