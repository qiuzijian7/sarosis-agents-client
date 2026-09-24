/*---------------------------------------------------------------------------------------------
 *  `video_analyze` 单元测试 —— 2026-09-24
 *
 *  背景：它此前是 Hermes 迁移过来的**空壳**（只有 bundled 定义、无 handler）⇒ 被注册成
 *  stub ⇒ listTools 跳过 ⇒ 模型根本看不到。实现它 = 把「抽帧 + 字幕 + 多模态模型给结论」
 *  收敛成一次调用（对照：extract_video_frames + N 次 vision_analyze）。
 *
 *  覆盖：
 *   ① 纯函数：提示词的**证据纪律**（防把采样缺口用常识填掉）、多模态 parts 的**顺序**
 *      （图前紧跟时间点标注）、回显素材清单；
 *   ② handler 端到端（注入命令执行器 + 内存文件系统 + 假 provider，不真跑 ffmpeg/网络）：
 *      依赖缺失给指引、成功路径真的把图发给模型、无多模态模型时**降级不静默**、
 *      分析完删除下载的视频、provider 报错原样回传。
 *
 *  运行（仓库根目录）：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/videoAnalyzeTools.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';

import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import {
	registerVideoAnalyzeTools, VIDEO_ANALYZE_TOOL_NAME,
	buildAnalysisPrompt, buildAnalyzeContentParts, buildEvidenceNote,
	type IVideoAnalyzeToolContext,
} from '../../browser/providers/tool/videoAnalyzeTools.js';
import type { IBuiltinToolRegistration } from '../../browser/providers/tool/toolRegistry.js';
// ★ 2026-09-24：探活结果按进程缓存 ⇒ 用例间必须清空（否则「期望 missing」会读到上次的 ok）
import { clearProbeCache } from '../../browser/providers/tool/mediaToolchainProbeCache.js';
import { clearVideoDownloadFailure } from '../../browser/providers/tool/videoMediaPipeline.js';

const quietLog = { info() { }, warn() { }, error() { }, debug() { }, trace() { } } as any;

// ─── 纯函数 ─────────────────────────────────────────────────────────────────

suite('video_analyze · 纯函数（提示词 / 多模态 parts / 素材清单）', () => {

	test('★★ 提示词必须写清「采样≠全片」与证据标记（防用常识填补缺口）', () => {
		const p = buildAnalysisPrompt({
			query: '这游戏的战斗循环是怎么设计的', frameCount: 6,
			startSec: 0, spanSec: 60, videoDurationSec: 125, hasTranscript: true,
		});
		assert.ok(p.includes('这游戏的战斗循环是怎么设计的'), '必须把用户问题原样带上');
		assert.ok(p.includes('无法判断'), '必须允许模型说「无法判断」，否则它会硬编');
		assert.ok(p.includes('[帧 mm:ss]'), '画面结论必须要求挂时间点标记');
		assert.ok(p.includes('[字幕]'), '口播内容必须要求挂字幕标记');
		assert.ok(/采样/.test(p) && /并没有看到/.test(p), '必须点明「帧与帧之间没看到」');
		assert.ok(/禁止.*常识|常识填补/.test(p), '必须禁止用常识填补');
		assert.ok(p.includes('02:05'), '视频总时长应换算成 mm:ss 供模型对齐时间点');
	});

	test('字幕缺失 / 自动字幕 ⇒ 提示词如实区分（不得让模型以为有口播证据）', () => {
		const noSubs = buildAnalysisPrompt({ query: 'q', frameCount: 3, startSec: 0, spanSec: 30, hasTranscript: false });
		assert.ok(noSubs.includes('**没有**'), '无字幕必须明确写「没有」');
		const autoSubs = buildAnalysisPrompt({
			query: 'q', frameCount: 3, startSec: 0, spanSec: 30, hasTranscript: true, transcriptKind: 'auto',
		});
		assert.ok(autoSubs.includes('自动'), '自动字幕要标注可能不准');
		const asrSubs = buildAnalysisPrompt({
			query: 'q', frameCount: 3, startSec: 0, spanSec: 30, hasTranscript: true, transcriptKind: 'asr',
		});
		assert.ok(asrSubs.includes('ASR'), '本地 ASR 转写要标注来源（模型需知道它可能不准）');
		const noSubsNow = buildAnalysisPrompt({ query: 'q', frameCount: 3, startSec: 0, spanSec: 30, hasTranscript: false });
		assert.ok(noSubsNow.includes('ASR'), '「没有」也要说清为什么没有（无字幕轨 + ASR 兜底落空）');
	});

	test('★★ 多模态 parts 顺序：说明 → (帧标注, 图)×N → 字幕（时间点必须紧贴图片）', () => {
		const parts = buildAnalyzeContentParts({
			prompt: 'PROMPT',
			frames: [
				{ label: '帧 1 @ 00:00', data: 'AAA', mimeType: 'image/png' },
				{ label: '帧 2 @ 00:10', data: 'BBB', mimeType: 'image/png' },
			],
			transcript: '口播内容',
		})!;
		assert.strictEqual(parts.length, 6, `应为 说明+2×(标注,图)+字幕 = 6 项，实际 ${parts.length}`);
		assert.deepStrictEqual(parts[0], { type: 'text', text: 'PROMPT' });
		assert.deepStrictEqual(parts[1], { type: 'text', text: '[帧 1 @ 00:00]' });
		assert.strictEqual(parts[2].type, 'image');
		assert.deepStrictEqual(parts[3], { type: 'text', text: '[帧 2 @ 00:10]' });
		assert.strictEqual((parts[2] as { data: string }).data, 'AAA');
		assert.ok((parts[5] as { text: string }).text.includes('口播内容'), '字幕附在最后');

		const noSubs = buildAnalyzeContentParts({ prompt: 'P', frames: [{ label: '帧 1 @ 00:00', data: 'A', mimeType: 'image/png' }] })!;
		assert.strictEqual(noSubs.length, 3, '无字幕时不该凭空多一个文本块');
	});

	test('素材清单：帧路径 + 时间点 + 字幕字数 + 工具链（让调用方知道证据在哪）', () => {
		const note = buildEvidenceNote({
			frames: ['D:/out/frame-01.png'], frameTimesSec: [0], outDir: 'D:/out',
			transcript: { text: 'x'.repeat(120), kind: 'auto', chars: 120 },
			toolchain: 'ffmpeg=内置 D:/bin/ffmpeg.exe', title: '某游戏实机', uploader: '作者',
		});
		assert.ok(note.includes('D:/out/frame-01.png'));
		assert.ok(note.includes('00:00'));
		assert.ok(note.includes('120 字') && note.includes('自动'), '字幕字数与来源标注要在');
		assert.ok(note.includes('ffmpeg=内置'));
		assert.ok(note.includes('某游戏实机'));
		const asrNote = buildEvidenceNote({
			frames: [], frameTimesSec: [], outDir: 'D:/o', toolchain: 't',
			transcript: { text: 'y'.repeat(50), kind: 'asr', chars: 50 },
		});
		assert.ok(asrNote.includes('ASR'), '素材清单要标出 ASR 来源（与平台字幕区分）');
		const noSubs = buildEvidenceNote({ frames: [], frameTimesSec: [], outDir: 'D:/o', toolchain: 't' });
		assert.ok(noSubs.includes('字幕：无'), '没有字幕要如实写「无」');
		assert.ok(noSubs.includes('ASR'), '「无」也要写明 ASR 兜底已落空（否则排查无门）');
	});
});

// ─── handler（注入式端到端）─────────────────────────────────────────────────

/** 内存文件系统：实现抽帧/字幕/读图用到的面。 */
class MemFs {
	readonly files = new Map<string, VSBuffer>();
	readonly dirs = new Set<string>();
	private key(uri: URI): string { return uri.fsPath.toLowerCase(); }
	async exists(uri: URI): Promise<boolean> { return this.files.has(this.key(uri)) || this.dirs.has(this.key(uri)); }
	async createFolder(uri: URI): Promise<void> { this.dirs.add(this.key(uri)); }
	async writeFile(uri: URI, buf: VSBuffer): Promise<void> { this.files.set(this.key(uri), buf); }
	async readFile(uri: URI): Promise<{ value: VSBuffer }> {
		const v = this.files.get(this.key(uri));
		if (!v) { throw new Error('ENOENT'); }
		return { value: v };
	}
	async del(uri: URI): Promise<void> {
		const k = this.key(uri);
		this.dirs.delete(k);
		for (const f of [...this.files.keys()]) { if (f === k || f.startsWith(k + path.sep)) { this.files.delete(f); } }
	}
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async resolve(uri: URI): Promise<any> {
		const dir = this.key(uri) + path.sep;
		const children: Array<{ name: string; isDirectory: boolean; resource: URI }> = [];
		const seen = new Set<string>();
		for (const f of this.files.keys()) {
			if (!f.startsWith(dir)) { continue; }
			const rest = f.slice(dir.length);
			const seg = rest.split(path.sep)[0];
			if (seen.has(seg)) { continue; }
			seen.add(seg);
			children.push({ name: seg, isDirectory: rest.includes(path.sep), resource: URI.file(path.join(uri.fsPath, seg)) });
		}
		return { children };
	}
	names(dir: string): string[] {
		const d = dir.toLowerCase() + path.sep;
		return [...this.files.keys()].filter(f => f.startsWith(d)).map(f => f.slice(d.length)).sort();
	}
}

interface ChatCall { modelId: string; messages: any[] }

function makeProvider(o: { modelId?: string; supportsImages?: boolean; deltas?: Array<{ type: string; content?: string; error?: string }>; throwOnChat?: boolean }, calls: ChatCall[]) {
	const modelId = o.modelId ?? 'vision-1';
	return {
		id: modelId, name: modelId, priority: 1,
		onDidChangeModels: () => ({ dispose() { } }),
		listModels: async () => [{ id: modelId, name: modelId, supportsImages: o.supportsImages !== false }],
		getAuthStatus: () => 'authenticated',
		// eslint-disable-next-line require-yield
		async *chat(mid: string, messages: any[]) {
			calls.push({ modelId: mid, messages });
			if (o.throwOnChat) { throw new Error('provider exploded'); }
			for (const d of o.deltas ?? [{ type: 'text', content: '分析结论' }]) { yield d; }
		},
	} as any;
}

const argsOf = (cmd: string): string[] => [...cmd.matchAll(/"([^"]*)"/g)].map(x => x[1]);

/**
 * 假命令执行器：ffmpeg 抽帧产图、yt-dlp 下载产视频/字幕、`--print` 给元信息。
 * `custom` 里的行为优先匹配（用于构造故障场景）。
 */
function makeRunner(custom: Array<{ match: RegExp; run: (cmd: string) => { stdout?: string; stderr?: string; exitCode?: number } }> = []) {
	const calls: string[] = [];
	let fs: MemFs | undefined;
	const writeFrames = (cmd: string): void => {
		const a = argsOf(cmd);
		const pattern = a[a.length - 1];
		const n = Number(a[a.indexOf('-frames:v') + 1]) || 0;
		for (let i = 1; i <= n; i++) {
			fs?.writeFile(URI.file(pattern.replace(/%0?2d/, String(i).padStart(2, '0'))), VSBuffer.fromString('png-bytes'));
		}
	};
	const defaults = [
		// ⚠ ASR 提音轨规则必须**排在抽帧规则之前**：两条命令都以 `-hide_banner` 开头，
		//   抽帧规则先匹配会吃掉提音轨命令（且不产 wav ⇒ ASR 静默判"提音轨失败"）。
		{
			match: /^"ffmpeg" "-hide_banner".*"-vn"/, run: (cmd: string) => {
				const a = argsOf(cmd);
				fs?.writeFile(URI.file(a[a.length - 1]), VSBuffer.fromString('wav-bytes'));
				return {};
			},
		},
		{ match: /^"ffmpeg" "-hide_banner"/, run: (cmd: string) => { writeFrames(cmd); return {}; } },
		{ match: /^"ffprobe"/, run: () => ({ stdout: '120\n' }) },
		{
			match: /^"yt-dlp"/, run: (cmd: string) => {
				const a = argsOf(cmd);
				if (a.includes('--version')) { return { stdout: '2026.08.19\n' }; }
				if (a.includes('--print')) { return { stdout: '125\t某游戏实机演示\t某UP主\n' }; }
				const i = a.indexOf('-o');
				const tpl = i >= 0 ? a[i + 1] : '';
				if (a.includes('--write-subs')) {
					fs?.writeFile(URI.file(tpl.replace(/%\(ext\)s$/, 'zh-Hans.srt')), VSBuffer.fromString(
						'1\n00:00:00,000 --> 00:00:02,000\n大家好\n\n2\n00:00:02,000 --> 00:00:04,000\n讲讲战斗\n'));
					return {};
				}
				if (tpl) { fs?.writeFile(URI.file(tpl.replace(/\.%\(ext\)s$/, '.mp4')), VSBuffer.fromString('video')); }
				return {};
			},
		},
	];
	const runner = async (cmd: string) => {
		calls.push(cmd);
		for (const b of [...custom, ...defaults]) {
			if (!b.match.test(cmd)) { continue; }
			const r = b.run(cmd);
			return { ok: (r.exitCode ?? 0) === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 };
		}
		return { ok: true, stdout: '', stderr: '', exitCode: 0 };
	};
	return { runner, calls, bind: (f: MemFs) => { fs = f; } };
}

/**
 * ⚠ 命名为 `makeTool` 而**不是** `setup`：`setup` 是 mocha(tdd) 的 `beforeEach` 全局，
 *   同名局部函数会把它遮蔽 —— `setup(() => clearProbeCache())` 会静默变成"建一个 ctx"，
 *   钩子形同不存在（2026-09-24 实际踩过）。
 */
function makeTool(opts: {
	custom?: Array<{ match: RegExp; run: (cmd: string) => { stdout?: string; stderr?: string; exitCode?: number } }>;
	providers?: any[];
	noChannel?: boolean;
	/** 注入媒体二进制的环境变量表（如 WHISPER_MODEL_PATH 指向 MemFs 里的假模型）。 */
	env?: Record<string, string>;
} = {}) {
	const registered: IBuiltinToolRegistration[] = [];
	const fs = new MemFs();
	const r = makeRunner(opts.custom ?? []);
	r.bind(fs);
	const chatCalls: ChatCall[] = [];
	const ctx: IVideoAnalyzeToolContext = {
		register: d => { registered.push(d); },
		fileService: fs as any,
		logService: quietLog,
		resolveAndCheckWorkspacePath: async (_a, p) => p,
		defaultOutRoot: path.join(os.tmpdir(), 'va-test'),
		runCommand: opts.noChannel ? (async () => undefined) : r.runner,
		// 显式钉住运行时：env 默认空（不受开发机 FFMPEG_PATH 影响）、无内置目录 ⇒ 走裸名（单测口径）。
		// env 空还意味着 WHISPER_MODEL_PATH 未设 ⇒ ASR 默认关闭；要测 ASR 的用例显式传 opts.env。
		mediaBinaryRuntime: { resourcesPath: undefined, env: opts.env ?? {}, platform: 'win32' },
		getModelProviders: () => opts.providers ?? [],
	};
	registerVideoAnalyzeTools(ctx);
	const tool = registered.find(t => t.definition.name === VIDEO_ANALYZE_TOOL_NAME);
	assert.ok(tool, '未注册 video_analyze');
	return { tool: tool!, fs, calls: r.calls, chatCalls };
}

const call = (tool: IBuiltinToolRegistration, args: Record<string, unknown>): Promise<any> => tool.handler(args, undefined, 'agent-1');

function textOf(r: unknown): string {
	const arr = Array.isArray(r)
		? r as Array<{ text?: string }>
		: (r as { content?: Array<{ text?: string }> })?.content ?? [];
	return String(arr[0]?.text ?? '');
}

suite('video_analyze · handler（注入式端到端）', () => {

	// 探活缓存与下载失败备忘都是进程级共享，用例之间必须隔离（后者 2026-09-25 在 videoFrameTools 实测毒化过用例）
	setup(() => { clearProbeCache(); clearVideoDownloadFailure(); });

	test('definition：必需 video_url + query（与 bundled 定义一致，防调用方按旧 schema 传参）', () => {
		const { tool } = makeTool();
		assert.strictEqual(tool.definition.name, 'video_analyze');
		assert.deepStrictEqual(tool.definition.inputSchema.required, ['video_url', 'query']);
	});

	test('缺 video_url / query ⇒ 明确报错（不静默跑一遍抽帧）', async () => {
		const { tool, calls } = makeTool();
		assert.match(textOf(await call(tool, { query: 'q' })), /缺少 video_url/);
		assert.match(textOf(await call(tool, { video_url: 'https://a/b' })), /缺少 query/);
		assert.deepStrictEqual(calls, [], '参数不全时不该发起任何命令');
	});

	test('★ 缺 ffmpeg ⇒ 给可执行指引（并说明安装包本应自带）', async () => {
		const { tool } = makeTool({ custom: [{ match: /^"ffmpeg" "-version"/, run: () => ({ exitCode: 127, stderr: 'not found' }) }] });
		const out = textOf(await call(tool, { video_url: 'https://a/b', query: 'q' }));
		assert.match(out, /未检测到 ffmpeg/);
		assert.match(out, /resources\/saros\/bin/, '要指出正常安装包自带的位置');
		assert.match(out, /FFMPEG_PATH|winget|brew/, '要给可执行的下一步');
	});

	test('★ 无命令通道（非桌面版）⇒ 不误报成「未安装」', async () => {
		const { tool } = makeTool({ noChannel: true });
		const out = textOf(await call(tool, { video_url: 'https://a/b', query: 'q' }));
		assert.match(out, /没有命令执行通道|非桌面版/);
		assert.ok(!/winget|brew/.test(out));
	});

	test('★★ 成功路径：下载 → 抽帧 → 抓字幕 → **把 N 张图交给多模态模型** → 回显素材', async () => {
		const chatCalls: ChatCall[] = [];
		const { tool, fs, calls } = makeTool({
			providers: [makeProvider({ deltas: [{ type: 'text', content: '战斗循环是…' }] }, chatCalls)],
		});
		const r = await call(tool, { video_url: 'https://www.douyin.com/video/7301', query: '战斗循环怎么设计的', frames: 3, durationSec: 30 });

		const out = textOf(r);
		assert.match(out, /\[Video Analysis\]/);
		assert.match(out, /战斗循环是…/);
		assert.match(out, /── 素材 ──/);
		assert.strictEqual(r.details.frames.length, 3);
		// 字幕解析：去序号/时间轴后是「大家好\n讲讲战斗」= 8 字
		assert.strictEqual(r.details.transcriptChars, 8, '字幕应被解析成纯文本（去序号/时间轴）');
		assert.match(out, /8 字/, '回显里要如实写字幕字数');

		// 模型只被调用一次（这正是本工具相对「逐张 vision_analyze」的价值）
		assert.strictEqual(chatCalls.length, 1);
		const parts = chatCalls[0].messages[0].contentParts as Array<{ type: string; text?: string }>;
		assert.strictEqual(parts.filter(p => p.type === 'image').length, 3, '3 张帧都应作为图片块发出');
		assert.ok(parts.some(p => p.type === 'text' && p.text?.includes('[帧 1 @')), '每张图前应紧跟时间点标注');
		assert.ok(parts.some(p => p.type === 'text' && p.text?.includes('讲讲战斗')), '字幕应附在最后');

		// 命令顺序：下载 → 取元信息 → 抽帧（元信息要在抽帧前；字幕抓取在抽帧后）
		const idx = (re: RegExp): number => calls.findIndex(c => re.test(c));
		assert.ok(idx(/^"yt-dlp".*"-o" /) < idx(/^"yt-dlp".*"--print"/), '先下载再取元信息');
		assert.ok(idx(/^"yt-dlp".*"--print"/) < idx(/^"ffmpeg" "-hide_banner"/), '先拿时长再抽帧');
		assert.ok(idx(/^"ffmpeg" "-hide_banner"/) < idx(/^"yt-dlp".*"--write-subs"/), '字幕尽量在抽帧后抓（不阻塞抽帧）');

		// 下载的视频必须清理（默认不囤视频）
		const outDir = r.details.outDir as string;
		assert.strictEqual(fs.names(path.join(outDir, '_src')).length, 0, '分析完应删除下载的视频与临时目录');
		assert.ok(fs.names(outDir).some(n => n.startsWith('frame-')), '帧图应保留（可再被 vision_analyze 引用）');
	});

	test('★ withTranscript=false ⇒ 不抓字幕，且不得假装有字幕', async () => {
		const chatCalls: ChatCall[] = [];
		const { tool, calls } = makeTool({ providers: [makeProvider({}, chatCalls)] });
		const r = await call(tool, { video_url: 'https://a/b', query: 'q', withTranscript: false });
		assert.ok(!calls.some(c => c.includes('--write-subs')), '不该发起字幕抓取');
		assert.ok(!calls.some(c => c.includes('whisper-cli')), 'withTranscript=false 时也不该跑 ASR');
		assert.match(textOf(r), /字幕：无/);
		assert.ok(!(chatCalls[0].messages[0].contentParts as any[]).some(p => p.type === 'text' && p.text?.includes('字幕全文')));
	});

	// ─── 本地 ASR（whisper.cpp 兜底，2026-09-25）───────────────────────────
	// 测试口径：模型经 WHISPER_MODEL_PATH 指向 MemFs 里的假文件；whisper-cli 走裸名由
	// custom runner 接管。env 不传 ⇒ 模型解析不到 ⇒ ASR 关闭（既有用例全在这个口径下）。

	test('★★ 无字幕轨 ⇒ 本地 ASR 兜底：转写文本进 contentParts 并标注来源', async () => {
		const chatCalls: ChatCall[] = [];
		const { tool, fs } = makeTool({
			env: { WHISPER_MODEL_PATH: 'D:/models/ggml-base.bin' },
			providers: [makeProvider({}, chatCalls)],
			custom: [
				// 该视频没有字幕轨：yt-dlp --write-subs 不产出任何文件
				{ match: /--write-subs/, run: () => ({}) },
				{ match: /^"whisper-cli" "--help"/, run: () => ({ stdout: 'usage: whisper-cli [options]  (whisper.cpp)' }) },
				{ match: /^"whisper-cli" "-m"/, run: () => ({ stdout: '[00:00:00.000 --> 00:00:02.000] 大家好\n[00:00:02.000 --> 00:00:04.500] 讲讲战斗\n' }) },
			],
		});
		fs.writeFile(URI.file('D:/models/ggml-base.bin'), VSBuffer.fromString('lmgg-fake-model-bytes'));
		const r = await call(tool, { video_url: 'https://www.douyin.com/video/7301', query: 'q', frames: 2, durationSec: 20 });

		assert.ok(r.details.transcriptChars > 0, 'ASR 转写应有字数');
		const parts = chatCalls[0].messages[0].contentParts as Array<{ type: string; text?: string }>;
		const sub = parts.find(p => p.type === 'text' && p.text?.includes('字幕全文'));
		assert.ok(sub, '字幕块应在 contentParts 里');
		assert.ok(sub!.text!.includes('[00:00] 大家好') && sub!.text!.includes('[00:02] 讲讲战斗'), 'whisper 时间轴要压成 [mm:ss]');
		assert.match(textOf(r), /ASR/, '素材清单要如实标注字幕来自本地 ASR');
	});

	test('★ ASR 转写失败 ⇒ 如实退回仅帧（绝不拿空字幕冒充有口播证据）', async () => {
		const chatCalls: ChatCall[] = [];
		const { tool, fs } = makeTool({
			env: { WHISPER_MODEL_PATH: 'D:/models/ggml-base.bin' },
			providers: [makeProvider({}, chatCalls)],
			custom: [
				{ match: /--write-subs/, run: () => ({}) },
				{ match: /^"whisper-cli" "--help"/, run: () => ({ stdout: 'whisper.cpp' }) },
				{ match: /^"whisper-cli" "-m"/, run: () => ({ stdout: '', exitCode: 1 }) },
			],
		});
		fs.writeFile(URI.file('D:/models/ggml-base.bin'), VSBuffer.fromString('lmgg-fake-model-bytes'));
		const r = await call(tool, { video_url: 'https://a/b', query: 'q' });
		assert.strictEqual(r.details.transcriptChars, 0, 'ASR 失败 ⇒ 字幕为 0，不许伪造');
		assert.match(textOf(r), /字幕：无/);
		assert.match(textOf(r), /ASR/, '要写明 ASR 兜底也落空（否则排查无门）');
	});

	test('★ 本地视频文件同样走 ASR（本地文件没有「平台字幕」一说）', async () => {
		const chatCalls: ChatCall[] = [];
		const { tool, fs } = makeTool({
			env: { WHISPER_MODEL_PATH: 'D:/models/ggml-base.bin' },
			providers: [makeProvider({}, chatCalls)],
			custom: [
				{ match: /^"whisper-cli" "--help"/, run: () => ({ stdout: 'whisper.cpp usage' }) },
				{ match: /^"whisper-cli" "-m"/, run: () => ({ stdout: '[00:00:10.000 --> 00:00:12.000] 本地口播内容\n' }) },
			],
		});
		fs.writeFile(URI.file('D:/models/ggml-base.bin'), VSBuffer.fromString('lmgg-fake-model-bytes'));
		fs.writeFile(URI.file('D:/v/clip.mp4'), VSBuffer.fromString('video'));
		const r = await call(tool, { video_url: 'D:/v/clip.mp4', query: 'q', frames: 2, durationSec: 20 });
		assert.ok(r.details.transcriptChars > 0, '本地文件的口播也应转写出来');
		const parts = chatCalls[0].messages[0].contentParts as Array<{ type: string; text?: string }>;
		assert.ok(parts.some(p => p.type === 'text' && p.text?.includes('本地口播内容')));
	});

	test('★ 已 abort ⇒ 步间止步：不跑 ASR、不调模型（whisper 不响应 signal，只能在步间拦）', async () => {
		// 2026-09-25（生产日志 20260925T020714）：60s 守卫 abort 后 whisper 仍白跑 3.5 分钟
		// —— 步间检查把"已取消"拦在 ASR 与模型调用之前。
		const chatCalls: ChatCall[] = [];
		const { tool, fs, calls } = makeTool({
			env: { WHISPER_MODEL_PATH: 'D:/models/ggml-base.bin' },
			providers: [makeProvider({}, chatCalls)],
		});
		fs.writeFile(URI.file('D:/models/ggml-base.bin'), VSBuffer.fromString('lmgg-fake-model-bytes'));
		const ac = new AbortController();
		ac.abort();
		const r = await tool.handler({ video_url: 'https://a/b', query: 'q' }, ac.signal, 'agent-1');
		assert.match(textOf(r), /cancelled/);
		assert.ok(!calls.some(c => c.includes('whisper-cli')), 'abort 后不许再跑 ASR（白烧几分钟 CPU）');
		assert.strictEqual(chatCalls.length, 0, 'abort 后不许调模型');
	});

	test('★★ 无多模态模型 ⇒ **降级不静默**：把已抽好的帧交回，让调用方用 vision_analyze', async () => {
		const { tool, fs } = makeTool({ providers: [makeProvider({ supportsImages: false }, [])] });
		const r = await call(tool, { video_url: 'https://a/b', query: 'q', frames: 2 });
		const out = textOf(r);
		assert.match(out, /no vision-capable model/);
		assert.match(out, /frame-01\.png/, '要把帧路径给回去（否则用户白等一场）');
		assert.match(out, /vision_analyze/, '要给出可执行的替代路径');
		// 降级路径同样要清理下载的视频
		const dir = path.join(os.tmpdir(), 'va-test', 'video-analyze');
		const anyWork = [...fs.files.keys()].filter(k => k.includes('_src'));
		assert.deepStrictEqual(anyWork, [], `降级时也必须清理下载的视频：${anyWork.join(', ')}（${dir}）`);
	});

	test('provider 抛错 ⇒ 原样回传原因（并仍给出素材清单）', async () => {
		const { tool } = makeTool({ providers: [makeProvider({ throwOnChat: true }, [])] });
		const out = textOf(await call(tool, { video_url: 'https://a/b', query: 'q' }));
		assert.match(out, /video_analyze error/);
		assert.match(out, /provider exploded/);
		assert.match(out, /── 素材 ──/);
	});

	test('抽帧失败 ⇒ 报错（不带着 0 帧去调模型）', async () => {
		const chatCalls: ChatCall[] = [];
		const { tool } = makeTool({
			custom: [{ match: /^"ffmpeg" "-hide_banner"/, run: () => ({ exitCode: 1, stderr: 'Invalid data' }) }],
			providers: [makeProvider({}, chatCalls)],
		});
		const out = textOf(await call(tool, { video_url: 'https://a/b', query: 'q' }));
		assert.match(out, /抽帧失败/);
		assert.strictEqual(chatCalls.length, 0, '没帧就不要调模型');
	});

	test('★ 越界产物目录 ⇒ 拒绝且不发起下载/抽帧', async () => {
		const registered: IBuiltinToolRegistration[] = [];
		const fs = new MemFs();
		const r = makeRunner();
		r.bind(fs);
		registerVideoAnalyzeTools({
			register: d => { registered.push(d); },
			fileService: fs as any,
			logService: quietLog,
			resolveAndCheckWorkspacePath: async () => { throw new Error('路径越界（沙箱拒绝）'); },
			defaultOutRoot: path.join(os.tmpdir(), 'va-test'),
			runCommand: r.runner,
			mediaBinaryRuntime: { env: {}, platform: 'win32' },
			getModelProviders: () => [],
		});
		const out = textOf(await registered[0].handler({ video_url: 'https://a/b', query: 'q' }, undefined, 'agent-1'));
		assert.match(out, /不可写/);
		assert.match(out, /越界/);
		assert.deepStrictEqual(r.calls.filter(c => /"-o" /.test(c) || /"-hide_banner"/.test(c)), [], '不该已经下载/抽帧');
	});
});
