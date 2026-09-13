/*---------------------------------------------------------------------------------------------
 *  媒体生成工具（video_generate / text_to_speech）单元测试
 *
 *  背景（2026-09-11）：两者此前只有 bundled 定义（stub → listTools 跳过 → 模型看不到），
 *  而底层能力早已完整实现（`IModelProvider.generateVideo/generateAudio` + 扩展命令转发 +
 *  host RPC `videogen.generate`/`audiogen.generate` + 画布节点 Saros.ModelVideoGen/AudioGen）。
 *  与已实现的 `image_generate` 完全对称。
 *
 *  覆盖：
 *   - 工具注册（两个工具的 name / inputSchema / 必填参数差异）
 *   - video_generate：prompt 或 image_url 至少一个、能力过滤、成功/失败/空结果
 *   - text_to_speech：text 必填、能力过滤、结果含时长/格式、成功/失败
 *   - 共用解析：显式 provider_id 优先、provider 不存在时明确报错
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/mediaGenTools.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';

import {
	registerMediaGenTools, VIDEO_GEN_TOOL_NAME, TEXT_TO_SPEECH_TOOL_NAME,
} from '../../browser/providers/tool/mediaGenTools.js';

import type { IToolResultContent } from '../../common/providers.js';

const quietLog = { info() { }, warn() { }, error() { }, debug() { }, trace() { } } as any;

interface IProvOpts {
	id: string;
	videoModels?: string[];
	audioModels?: string[];
	videoResult?: { videos: Array<{ url?: string; posterUrl?: string }> };
	audioResult?: { audios: Array<{ url?: string; duration?: number; format?: string }> };
	throwOnVideo?: boolean;
	throwOnAudio?: boolean;
	noVideoMethod?: boolean;
}

function makeProvider(o: IProvOpts) {
	const models = [
		...(o.videoModels ?? []).map(id => ({ id, name: id, supportsVideoGen: true })),
		...(o.audioModels ?? []).map(id => ({ id, name: id, supportsAudioGen: true })),
	];
	const p: any = {
		id: o.id,
		name: o.id,
		priority: 1,
		onDidChangeModels: () => ({ dispose() { } }),
		listModels: async () => models,
		getAuthStatus: () => 'authenticated',
	};
	if (!o.noVideoMethod) {
		p.generateVideo = async () => {
			if (o.throwOnVideo) { throw new Error('video provider exploded'); }
			return o.videoResult ?? { videos: [] };
		};
	}
	p.generateAudio = async () => {
		if (o.throwOnAudio) { throw new Error('audio provider exploded'); }
		return o.audioResult ?? { audios: [] };
	};
	return p;
}

function makeRunner(providers: any[]) {
	const registered: any[] = [];
	registerMediaGenTools({
		register: (d: any) => registered.push(d),
		logService: quietLog,
		getModelProviders: () => providers,
	} as any);

	const byName = (name: string) => registered.find(d => d.definition.name === name)!;
	const invoke = async (name: string, args: Record<string, unknown>): Promise<string> => {
		const res: IToolResultContent[] = await byName(name).handler(args, undefined, 'agent-1');
		assert.ok(Array.isArray(res) && res.length === 1, 'handler 应返回一个内容块');
		return (res[0] as { text: string }).text;
	};
	return { registered, byName, invoke };
}

suite('Media Gen Tools (video_generate / text_to_speech)', () => {

	test('注册两个工具，名字与 bundled / 白名单登记名一致', () => {
		const r = makeRunner([]);
		assert.strictEqual(r.registered.length, 2, '应注册恰好两个工具');
		assert.ok(r.byName(VIDEO_GEN_TOOL_NAME), '应注册 video_generate');
		assert.ok(r.byName(TEXT_TO_SPEECH_TOOL_NAME), '应注册 text_to_speech');
		assert.strictEqual(VIDEO_GEN_TOOL_NAME, 'video_generate');
		assert.strictEqual(TEXT_TO_SPEECH_TOOL_NAME, 'text_to_speech');
	});

	test('definition 结构：video_generate 无必填参数，text_to_speech 必填 text', () => {
		const r = makeRunner([]);
		assert.deepStrictEqual(r.byName('video_generate').definition.inputSchema.required, []);
		assert.deepStrictEqual(r.byName('text_to_speech').definition.inputSchema.required, ['text']);
		assert.ok(r.byName('video_generate').definition.inputSchema.properties.image_url, '应有 image_url（图生视频）');
		assert.ok(r.byName('text_to_speech').definition.inputSchema.properties.voice, '应有 voice');
	});

	// ─── video_generate ────────────────────────────────────────────────────

	test('video_generate：prompt 与 image_url 都为空 → 明确报错', async () => {
		const r = makeRunner([]);
		const text = await r.invoke('video_generate', {});
		assert.ok(text.includes('at least one of "prompt" or "image_url"'), '应提示至少一个输入');
	});

	test('video_generate：仅 image_url 允许（纯图生视频 provider）', async () => {
		const r = makeRunner([makeProvider({
			id: 'p1', videoModels: ['v1'],
			videoResult: { videos: [{ url: 'https://cdn/v.mp4' }] },
		})]);
		const text = await r.invoke('video_generate', { image_url: 'data:image/png;base64,AAA' });
		assert.ok(text.includes('https://cdn/v.mp4'), '应返回视频 URL');
	});

	test('video_generate：成功 → 返回 URL 并标注模型', async () => {
		const r = makeRunner([makeProvider({
			id: 'p1', videoModels: ['minimax-h3'],
			videoResult: { videos: [{ url: 'https://cdn/a.mp4' }, { url: 'https://cdn/b.mp4' }] },
		})]);
		const text = await r.invoke('video_generate', { prompt: '一只猫在跑', duration: 5 });
		assert.ok(text.includes('https://cdn/a.mp4') && text.includes('https://cdn/b.mp4'), '应列出全部视频');
		assert.ok(text.includes('minimax-h3'), '应标注模型');
		assert.ok(text.includes('2 video(s)'), '应说明数量');
	});

	test('★ video_generate：能力过滤 —— 无 supportsVideoGen 模型时报错而非乱选', async () => {
		const r = makeRunner([makeProvider({ id: 'text-only', videoModels: [] })]);
		const text = await r.invoke('video_generate', { prompt: 'x' });
		assert.ok(text.includes('no provider available') || text.includes('no model supporting'), `应明确报错，实际: ${text}`);
	});

	test('video_generate：provider 抛错 → 明确错误', async () => {
		const r = makeRunner([makeProvider({ id: 'p1', videoModels: ['v1'], throwOnVideo: true })]);
		const text = await r.invoke('video_generate', { prompt: 'x' });
		assert.ok(text.includes('video provider exploded'), '应转达底层错误');
	});

	test('video_generate：provider 返回空 videos → 明确说明', async () => {
		const r = makeRunner([makeProvider({ id: 'p1', videoModels: ['v1'], videoResult: { videos: [] } })]);
		const text = await r.invoke('video_generate', { prompt: 'x' });
		assert.ok(text.includes('returned no video URL'), '应说明未返回视频');
	});

	test('★ video_generate：显式 provider_id 生效（跳过自动路由）', async () => {
		const r = makeRunner([
			makeProvider({ id: 'first', videoModels: ['v-first'], videoResult: { videos: [{ url: 'https://first/v.mp4' }] } }),
			makeProvider({ id: 'second', videoModels: ['v-second'], videoResult: { videos: [{ url: 'https://second/v.mp4' }] } }),
		]);
		const text = await r.invoke('video_generate', { prompt: 'x', provider_id: 'second' });
		assert.ok(text.includes('https://second/v.mp4'), '应使用显式指定的 provider');
		assert.ok(!text.includes('first/v.mp4'), '不应回退到第一个 provider');
	});

	test('video_generate：provider_id 不存在 → 明确报错', async () => {
		const r = makeRunner([makeProvider({ id: 'p1', videoModels: ['v1'] })]);
		const text = await r.invoke('video_generate', { prompt: 'x', provider_id: 'nope' });
		assert.ok(text.includes('"nope" not found'), '应指出 provider 不存在');
	});

	// ─── text_to_speech ───────────────────────────────────────────────────

	test('text_to_speech：text 为空 → 明确报错', async () => {
		const r = makeRunner([]);
		assert.ok((await r.invoke('text_to_speech', { text: '   ' })).includes('"text" is required'));
	});

	test('text_to_speech：成功 → 返回音频 URL（含时长/格式）', async () => {
		const r = makeRunner([makeProvider({
			id: 'p1', audioModels: ['tts-1'],
			audioResult: { audios: [{ url: 'https://cdn/a.mp3', duration: 3, format: 'mp3' }] },
		})]);
		const text = await r.invoke('text_to_speech', { text: '你好世界', voice: 'female-1' });
		assert.ok(text.includes('https://cdn/a.mp3'), '应返回音频 URL');
		assert.ok(text.includes('3s'), '应含时长');
		assert.ok(text.includes('mp3'), '应含格式');
		assert.ok(text.includes('tts-1'), '应标注模型');
	});

	test('★ text_to_speech：能力过滤 —— 无 supportsAudioGen 模型时报错', async () => {
		const r = makeRunner([makeProvider({ id: 'p1', audioModels: [] })]);
		const text = await r.invoke('text_to_speech', { text: 'x' });
		assert.ok(text.includes('no provider available') || text.includes('no model supporting'), `应明确报错，实际: ${text}`);
	});

	test('text_to_speech：provider 抛错 → 明确错误', async () => {
		const r = makeRunner([makeProvider({ id: 'p1', audioModels: ['a1'], throwOnAudio: true })]);
		const text = await r.invoke('text_to_speech', { text: 'x' });
		assert.ok(text.includes('audio provider exploded'), '应转达底层错误');
	});

	test('text_to_speech：provider 返回空 audios → 明确说明', async () => {
		const r = makeRunner([makeProvider({ id: 'p1', audioModels: ['a1'], audioResult: { audios: [] } })]);
		const text = await r.invoke('text_to_speech', { text: 'x' });
		assert.ok(text.includes('returned no audio URL'), '应说明未返回音频');
	});

	test('★ 两个工具共用解析：无任何 provider 时各自报错（不抛异常）', async () => {
		const r = makeRunner([]);
		const v = await r.invoke('video_generate', { prompt: 'x' });
		const a = await r.invoke('text_to_speech', { text: 'x' });
		assert.ok(v.includes('video_generate error'), 'video 应报错');
		assert.ok(a.includes('text_to_speech error'), 'tts 应报错');
	});
});
