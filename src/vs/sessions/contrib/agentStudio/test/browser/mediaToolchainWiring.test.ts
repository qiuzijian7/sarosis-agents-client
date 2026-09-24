/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 视频工具的**宿主接线守卫**（源码扫描，2026-09-24）。
 *
 * ## 为什么必须是"扫源码"，普通单测验不到
 *
 * `extract_video_frames` / `video_analyze` 的每一步（`-version` 探测、yt-dlp 下载、ffmpeg
 * 抽帧、ffprobe 取时长）都要经 `ctx.runCommand` 出主进程。管线里缺省是
 * `async () => undefined` ⇒ 结论 `no-channel` ⇒ 工具在真实环境里**恒报**
 * "当前环境没有命令执行通道（非桌面版）"。
 *
 * 这个缺陷的特征是「**注册点的实参**错了、被调用方无法自证」：`probeMediaToolchain` 只能
 * 看到"没有通道"，它无从区分"宿主漏传"与"这环境真的没有命令通道"。所以判据只能是
 * 「注册点有没有传」—— 那只有读源码能验。
 *
 * 实测已发生过一次（`builtinToolProvider` 两个视频工具注册都漏了 `runCommand`），
 * 而**当时所有单测都是全绿的**（单测都注入 fake runner）。同源教训另见
 * `toolSchemaShapeGuard.test.ts`（同样的"扫源码"技术路线）。
 *
 * ⚠ 守卫必须**非空跑**：先断言真的读到了那两个注册点。文件被改名/移动后，扫描会静默地
 * 什么都检不到 —— 那种"全绿的守卫"比没有守卫更糟（它把"没检查"伪装成"检查通过"）。
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const DOMAIN_REL = 'src/vs/sessions/contrib/agentStudio';
const PROVIDER_REL = `${DOMAIN_REL}/browser/providers/tool/builtinToolProvider.ts`;

/** 每个需要命令通道的注册点：调用名 + 该调用块里必须出现的东西。 */
const REQUIRED_WIRING: ReadonlyArray<{ call: string; must: RegExp; why: string }> = [
	{
		call: 'registerVideoFrameTools(',
		must: /runCommand\s*:/,
		why: 'extract_video_frames：探测/下载/抽帧/取时长每一步都要出主进程',
	},
	{
		call: 'registerVideoAnalyzeTools(',
		must: /runCommand\s*:/,
		why: 'video_analyze：与抽帧共用同一份管线，缺了同样恒报 no-channel',
	},
	{
		call: 'probeMediaCapabilities(',
		must: /runCommand\s*:/,
		why: '工具列表的能力标注：缺了会让「ffmpeg/yt-dlp 不可用」标注失真（fail-open ⇒ 用户看不到真实状态）',
	},
];

/**
 * 取出 `registerXxx({ … })` 的**整个实参块**（按花括号配对）。
 *
 * 不用正则直接扫全文件：那会把**别处**的 `runCommand:`（例如另一个工具的注册）当成这个
 * 调用点已经接线，于是"漏一处"永远检不出来 —— 那正是这次事故的形态（两个注册点各自独立）。
 *
 * ⚠ 必须跳过"名字里含同名子串"的匹配：本文件同时有私有方法定义 `_registerVideoFrameTools()`
 *   与它在 `registerAll()` 里的调用 `this._registerVideoFrameTools();` —— 两者都**包含**
 *   `registerVideoFrameTools(`，直接取第一个会把块取到方法体/别处（本守卫初版就栽在这里，
 *   报出的是假失败）。判据：前一个字符若是标识符字符，说明这是更长名字的后缀 ⇒ 跳过。
 */
function callBlock(source: string, call: string): string | undefined {
	const needle = call.endsWith('(') ? call : `${call}(`;
	let at = -1;
	for (let from = 0; ;) {
		at = source.indexOf(needle, from);
		if (at < 0) { return undefined; }
		const prev = at > 0 ? source[at - 1] : '';
		if (!/[A-Za-z0-9_$]/.test(prev)) { break; }
		from = at + needle.length;
	}
	const open = source.indexOf('{', at);
	if (open < 0) { return undefined; }
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		const ch = source[i];
		if (ch === '{') { depth++; }
		else if (ch === '}') {
			depth--;
			if (depth === 0) { return source.slice(open, i + 1); }
		}
	}
	return undefined;
}

suite('mediaToolchain — 宿主接线守卫（runCommand 必须注入到每个注册点）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const readProvider = (): string => fs.readFileSync(path.join(process.cwd(), PROVIDER_REL), 'utf8');

	test('★ 先证明守卫**没在空跑**：三个注册点都要读得到实参块', () => {
		const source = readProvider();
		const missing = REQUIRED_WIRING.filter(w => !callBlock(source, w.call)).map(w => w.call);
		assert.deepStrictEqual(missing, [],
			`读不到这些注册点的实参块：${missing.join(', ')}\n`
			+ `${PROVIDER_REL} 是否已改名/搬家？改了就同步本守卫 —— 否则它会静默地什么都检不到。`);
	});

	test('★★ 每个注册点都必须注入 runCommand（漏了 ⇒ 生产恒报"非桌面版"，而单测全绿）', () => {
		const source = readProvider();
		const violations: string[] = [];
		for (const w of REQUIRED_WIRING) {
			const block = callBlock(source, w.call);
			if (!block) { continue; }  // 上一条断言已单独报告"读不到"
			if (!w.must.test(block)) {
				violations.push(`  ${w.call.slice(0, -1)} —— 缺 runCommand（${w.why}）`);
			}
		}
		assert.deepStrictEqual(violations, [],
			`${violations.length} 个注册点漏注入命令通道 ✗\n${violations.join('\n')}\n\n`
			+ '修法：在该注册点的 ctx 里加 `runCommand: (command, timeoutMs) => execShortCommand(command, timeoutMs),`'
			+ '（`execShortCommand` 来自 `knowledge/feishuSyncCore.js`）。\n'
			+ '离线复核：`node scripts/verify-media-toolchain.mjs`（含"不注入必须报 no-channel"的反向对照）。');
	});

	test('★ 注入的必须是真执行器，不是占位：必须点 `execShortCommand`', () => {
		const source = readProvider();
		for (const w of REQUIRED_WIRING) {
			const block = callBlock(source, w.call);
			if (!block) { continue; }
			assert.ok(block.includes('execShortCommand'),
				`${w.call.slice(0, -1)} 的 runCommand 没走 execShortCommand ⇒ 可能是占位实现（那样探测会恒判 missing/no-channel）`);
		}
	});

});
