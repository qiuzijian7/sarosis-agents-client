/*---------------------------------------------------------------------------------------------
 *  工具依赖可用性（P1-4）单元测试 —— 2026-09-24
 *
 *  被测的两件事都属于"静默失效"高发区：
 *   ① **策略**：缺依赖时标注（不隐藏）。要钉住的是：未知事实**不得**标注（fail-open）、
 *      标注**幂等**、无关工具**零改动**（热路径每轮都要跑）；
 *   ② **事实来源**：媒体链路的探测必须分别结论、缺命令通道要留下可诊断日志。
 *
 *  ★ 2026-10-20：原第 ③ 块「声明与接线守卫」**已删除** —— 它 `import` 的
 *  `videoFrameTools` / `videoAnalyzeTools` / `feishuDriveTools` 随 legacy 工具整体下线
 *  （`0f01ef10a43`）一起删了，那几个注册函数在仓里已不存在（能力侧由 dsh 插件承担）。
 *  留着只能靠加进 `build-failure-baseline.json` 来"装作绿"⇒ 直接删掉，本文件只测还活着的
 *  「策略 + 媒体事实来源」两块。
 *
 *  运行（仓库根目录）：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/toolAvailabilityNotes.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';

import {
	annotateToolAvailability, createCapabilityFacts, availabilityContextFor, unavailableNotice,
	availabilityGaps, NO_CAPABILITY_FACTS, AVAILABILITY_NOTE_PREFIX,
	CAP_MEDIA_FFMPEG, CAP_MEDIA_YTDLP, CAP_FEISHU_LARK_CLI,
} from '../../browser/providers/tool/toolAvailabilityNotes.js';
import { probeMediaCapabilities, probeMediaToolchain } from '../../browser/providers/tool/videoMediaPipeline.js';
import { clearProbeCache } from '../../browser/providers/tool/mediaToolchainProbeCache.js';
import type { IToolDefinition } from '../../browser/common/providers.js';

const quietLog = { info() { }, warn() { }, error() { }, debug() { }, trace() { } } as never;

/** 造一个带 `availability` 的假定义（其余字段无所谓 —— 标注只读 description/availability）。 */
function def(name: string, condition?: string): IToolDefinition {
	return {
		name,
		description: `${name} 的描述`,
		inputSchema: { type: 'object', properties: { _no_params: { type: 'string' } } },
		...(condition ? { availability: [{ type: 'custom' as const, condition }] } : {}),
	} as IToolDefinition;
}

suite('工具可用性 · 标注策略（纯函数）', () => {

	test('★★ 事实未知 ⇒ **不标注**（fail-open：宁可多显示一个工具，也不误标不可用）', () => {
		const defs = [def('a', CAP_MEDIA_FFMPEG)];
		const out = annotateToolAvailability(defs, NO_CAPABILITY_FACTS);
		assert.strictEqual(out[0], defs[0], '未知时连对象都不该换（热路径零拷贝）');
		assert.ok(!out[0].description.includes(AVAILABILITY_NOTE_PREFIX));
	});

	test('事实为真 ⇒ 不标注；事实为假 ⇒ 追加一行可执行指引', () => {
		const okFacts = createCapabilityFacts([[CAP_MEDIA_FFMPEG, true]]);
		const badFacts = createCapabilityFacts([[CAP_MEDIA_FFMPEG, false]]);
		const d = def('extract_video_frames', CAP_MEDIA_FFMPEG);

		assert.strictEqual(annotateToolAvailability([d], okFacts)[0], d, '就绪时不该改描述');

		const annotated = annotateToolAvailability([d], badFacts)[0];
		assert.notStrictEqual(annotated, d);
		assert.match(annotated.description, /extract_video_frames 的描述/, '原描述必须保留');
		assert.ok(annotated.description.includes(AVAILABILITY_NOTE_PREFIX));
		assert.match(annotated.description, /ffmpeg/, '要点名缺的是哪个依赖');
		assert.match(annotated.description, /winget|brew|FFMPEG_PATH/, '要给出可执行手段，而不是只说"不可用"');
	});

	test('★ 无条件定义**引用不变**（每轮列表都会跑，不能无谓拷贝）', () => {
		const plain = def('file_read');
		const out = annotateToolAvailability([plain], createCapabilityFacts([[CAP_MEDIA_FFMPEG, false]]));
		assert.strictEqual(out[0], plain);
	});

	test('★★ 幂等：重复标注不会叠加（描述里只出现一次标记）', () => {
		const facts = createCapabilityFacts([[CAP_FEISHU_LARK_CLI, false]]);
		const once = annotateToolAvailability([def('feishu_doc_read', CAP_FEISHU_LARK_CLI)], facts)[0];
		const twice = annotateToolAvailability([once], facts)[0];
		const count = twice.description.split(AVAILABILITY_NOTE_PREFIX).length - 1;
		assert.strictEqual(count, 1, `标记应只出现一次，实际 ${count} 次：${twice.description}`);
	});

	test('★ 依赖恢复后标注会被清掉（否则描述会永远挂着"不可用"）', () => {
		const down = createCapabilityFacts([[CAP_FEISHU_LARK_CLI, false]]);
		const up = createCapabilityFacts([[CAP_FEISHU_LARK_CLI, true]]);
		const annotated = annotateToolAvailability([def('feishu_doc_read', CAP_FEISHU_LARK_CLI)], down)[0];
		const restored = annotateToolAvailability([annotated], up)[0];
		assert.ok(!restored.description.includes(AVAILABILITY_NOTE_PREFIX));
		assert.strictEqual(restored.description, 'feishu_doc_read 的描述');
	});

	test('多条件：缺哪个说哪个（不能只报第一个）', () => {
		const d = { ...def('x'), availability: [{ type: 'custom' as const, condition: CAP_MEDIA_FFMPEG }, { type: 'custom' as const, condition: CAP_MEDIA_YTDLP }] } as IToolDefinition;
		const out = annotateToolAvailability([d], createCapabilityFacts([[CAP_MEDIA_FFMPEG, false], [CAP_MEDIA_YTDLP, false]]))[0];
		assert.match(out.description, /ffmpeg/);
		assert.match(out.description, /yt-dlp/);
	});

	test('三类依赖各有专门文案；未知条件退化为通用文案（不静默）', () => {
		assert.match(String(unavailableNotice(CAP_MEDIA_FFMPEG)), /ffmpeg/);
		assert.match(String(unavailableNotice(CAP_MEDIA_YTDLP)), /本地/);
		assert.match(String(unavailableNotice(CAP_FEISHU_LARK_CLI)), /larksuite\/cli|npm/i);
		assert.strictEqual(unavailableNotice('nope.not.exist'), undefined);

		const out = annotateToolAvailability([def('x', 'nope.not.exist')], createCapabilityFacts([['nope.not.exist', false]]))[0];
		assert.match(out.description, /缺少依赖/);
	});

	test('★ 只有 custom 条件走事实表；未知条件名在事实表里查不到 ⇒ 视为满足（不误标）', () => {
		const facts = createCapabilityFacts([[CAP_MEDIA_FFMPEG, false]]);
		assert.deepStrictEqual(availabilityGaps(def('x', 'other.thing').availability, availabilityContextFor(facts)), []);
		assert.strictEqual(availabilityGaps(def('x', CAP_MEDIA_FFMPEG).availability, availabilityContextFor(facts)).length, 1);
	});
});

suite('工具可用性 · 媒体事实来源', () => {

	const base = () => ({
		fileService: {} as never,
		logService: quietLog,
		mediaBinaryRuntime: { env: {}, platform: 'win32' as const },
		// 直接注入解析结果，避免依赖真实文件系统布局
		resolveBinary: async (name: string) => ({ name, command: name, source: 'path' as const }),
	});

	test('★★ 两个二进制**分别**给结论（不能像 probeMediaToolchain 那样在第一个缺失处提前返回）', async () => {
		clearProbeCache();
		const r = await probeMediaCapabilities({
			...base(),
			// ⚠ 判定是 `r.ok || r.exitCode === 0`（管线只看退出码）⇒ 模拟"命令不存在"时
			//   `ok` 必须为 false，否则 `ok:true` 会把 exit 127 掩盖成可用（本用例早先就踩了这个）。
			runCommand: async cmd => ({ ok: !cmd.includes('yt-dlp'), stdout: '', stderr: '', exitCode: cmd.includes('yt-dlp') ? 127 : 0 }),
		} as never);
		assert.strictEqual(r.ffmpeg, true);
		assert.strictEqual(r.ytdlp, false, 'ffmpeg 成功也不能掩盖 yt-dlp 缺失');
	});

	test('★★ 无命令通道 / 探测异常 ⇒ 事实为 undefined（保持未知 ⇒ fail-open，不误标"不可用"）', async () => {
		clearProbeCache();
		const noChannel = await probeMediaCapabilities({ ...base() } as never);
		assert.deepStrictEqual(noChannel, { ffmpeg: undefined, ytdlp: undefined });
	});

	test('★ 探活缓存生效：两次探测只 spawn 一次（同一命令行）', async () => {
		clearProbeCache();
		let calls = 0;
		const ctx = { ...base(), runCommand: async () => { calls++; return { ok: true, stdout: '', stderr: '', exitCode: 0 }; } } as never;
		await probeMediaCapabilities(ctx);
		const after = calls;
		await probeMediaCapabilities(ctx);
		assert.strictEqual(calls, after, `第二次应命中缓存，实际又多了 ${calls - after} 次`);
	});

	test('★★ 工具路径缺命令通道 ⇒ 打 error 日志（这类"接线漏了"以前是静默的）', async () => {
		// ⚠ 必须清缓存：探活缓存是**进程级单例**，上一个用例写入的 ok 会在探测前短路，
		//   于是"缺通道"根本走不到（no-channel 本身不进缓存，但已缓存的确定结论会先命中）。
		clearProbeCache();
		const errors: string[] = [];
		const probingLog = {
			info() { }, warn() { }, debug() { }, trace() { },
			error(msg: string) { errors.push(String(msg)); },
		} as never;
		const r = await probeMediaToolchain({ fileService: {} as never, logService: probingLog }, { remote: false });
		assert.strictEqual(r.status, 'no-channel');
		assert.strictEqual(errors.length, 1, '必须留一条可诊断的日志');
		assert.match(errors[0], /runCommand|命令通道/);
		assert.match(errors[0], /builtinToolProvider|接线/, '要指向接线位置，否则排查无从下手');
	});
});
