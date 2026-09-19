/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `common/turnLoopConstants.ts` 与宿主 `AgentOSService` 同名 `static readonly`
 * 的一致性守护。
 *
 * 背景：turnLoopConstants 是 2026-09-17 从 `host.constructor.X` 反查抽出的
 * 独立常量模块（动机见该文件头注释）。抽出后 `AgentOSService` 侧的同名静态量
 * **刻意保留未删** —— 它们是该类的公开常量，可能有 executor 之外的消费者。
 * 于是同一个数字有了两个声明处，天然存在「改了一边忘改另一边」的漂移风险，
 * 而漂移不会有任何编译错误。本测试就是那道防线。
 *
 * 为什么用源码文本抽取而不是 import：`agentOSService.ts` 在 `browser/` 下，
 * import 它会拖入整棵 workbench 依赖树（platform service、DOM 等），
 * 在 `test/common` 的 node 环境里既无法 bundle 也无必要。宿主侧这些常量全是
 * 顶层字面量，正则抽取足够可靠，且抽取失败会 fail 而非静默跳过。
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { suite, test } from 'node:test';
import {
	COMPRESSION_COOLDOWN_MS,
	DEFAULT_BUDGET_MAX,
	FILE_MODIFICATION_TOOLS,
	MAX_CONSECUTIVE_TOOL_FAILURES,
	MAX_REFLECT_ITERATIONS,
	MAX_TEXT_SEARCH_STREAK,
	MAX_TEXT_SEARCH_STREAK_HARD,
	MAX_TOOL_ITERATIONS,
	TOOL_USE_ENFORCEMENT_GUIDANCE,
} from '../../common/turnLoopConstants.js';

const HOST_RELATIVE_PATH = 'src/vs/sessions/contrib/agentStudio/browser/agentOSService.ts';

/**
 * 读取宿主源码。
 *
 * runner 约定从仓库根启动（见 `run-turnloopconstants-tests.mjs` 头注释），
 * 故按 cwd 解析。刻意**不做兜底搜索**：路径错了就应该红，
 * 静默 skip 会让这道防线在无人察觉的情况下失效。
 */
function readHostSource(): string {
	const absolute = path.resolve(process.cwd(), HOST_RELATIVE_PATH);
	if (!fs.existsSync(absolute)) {
		throw new Error(
			`找不到宿主源码 ${absolute}。本测试必须从仓库根运行（cwd=${process.cwd()}）。`
		);
	}
	return fs.readFileSync(absolute, 'utf8');
}

/** 抽取 `static readonly NAME = <数字字面量>;`，支持 `60_000` 这类下划线分隔。 */
function extractHostNumber(source: string, name: string): number {
	const pattern = new RegExp(`static\\s+readonly\\s+${name}\\s*=\\s*([0-9_]+)\\s*;`);
	const match = pattern.exec(source);
	assert.ok(match, `未能在 ${HOST_RELATIVE_PATH} 中抽取 static readonly ${name} 的数值`);
	return Number(match[1].replace(/_/g, ''));
}

/** 抽取 `static readonly NAME = new Set([...]);` 中的字符串成员（去重后返回）。 */
function extractHostStringSet(source: string, name: string): Set<string> {
	const pattern = new RegExp(`static\\s+readonly\\s+${name}\\s*=\\s*new Set\\(\\[([^\\]]*)\\]\\)`);
	const match = pattern.exec(source);
	assert.ok(match, `未能在 ${HOST_RELATIVE_PATH} 中抽取 static readonly ${name} 的 Set 成员`);
	const members = match[1].match(/'([^']*)'/g) ?? [];
	return new Set(members.map(quoted => quoted.slice(1, -1)));
}

/** 抽取 `static readonly NAME = [ '...', ... ].join('\n');` 并按同样方式拼接。 */
function extractHostJoinedLines(source: string, name: string): string {
	const startPattern = new RegExp(`static\\s+readonly\\s+${name}\\s*=\\s*\\[`);
	const startMatch = startPattern.exec(source);
	assert.ok(startMatch, `未能在 ${HOST_RELATIVE_PATH} 中定位 static readonly ${name}`);

	const bodyStart = startMatch.index + startMatch[0].length;
	const bodyEnd = source.indexOf(`].join('\\n')`, bodyStart);
	assert.ok(bodyEnd > bodyStart, `未能在 ${HOST_RELATIVE_PATH} 中定位 ${name} 的 .join 结尾`);

	const lines: string[] = [];
	for (const rawLine of source.slice(bodyStart, bodyEnd).split('\n')) {
		const lineMatch = /^\s*'(.*)',\s*$/.exec(rawLine);
		if (lineMatch) {
			lines.push(lineMatch[1]);
		}
	}
	assert.ok(lines.length > 0, `${name} 的数组体解析为空，正则可能已与源码格式脱节`);
	return lines.join('\n');
}

/** 断言宿主上**不存在**某个静态成员（固化「该常量只在 turnLoopConstants 中定义」这一事实）。 */
function assertHostLacksStatic(source: string, name: string): void {
	const pattern = new RegExp(`static\\s+(readonly\\s+)?${name}\\s*=`);
	assert.ok(
		!pattern.test(source),
		`${HOST_RELATIVE_PATH} 新增了 static ${name}。该常量原先只存在于 turnLoopConstants，` +
		`executor 已不再经 host.constructor 读取它 —— 宿主侧的新声明不会生效，请确认是否应改 turnLoopConstants。`
	);
}

suite('turnLoopConstants — 与 AgentOSService 静态常量的一致性', () => {

	test('数值常量必须与宿主 static readonly 完全一致', () => {
		const source = readHostSource();

		assert.strictEqual(MAX_TOOL_ITERATIONS, extractHostNumber(source, 'MAX_TOOL_ITERATIONS'));
		assert.strictEqual(
			MAX_CONSECUTIVE_TOOL_FAILURES,
			extractHostNumber(source, 'MAX_CONSECUTIVE_TOOL_FAILURES')
		);
		assert.strictEqual(MAX_TEXT_SEARCH_STREAK, extractHostNumber(source, 'MAX_TEXT_SEARCH_STREAK'));
		assert.strictEqual(MAX_REFLECT_ITERATIONS, extractHostNumber(source, 'MAX_REFLECT_ITERATIONS'));
		assert.strictEqual(COMPRESSION_COOLDOWN_MS, extractHostNumber(source, 'COMPRESSION_COOLDOWN_MS'));
	});

	test('FILE_MODIFICATION_TOOLS 成员必须与宿主一致（宿主字面量含重复项，按 Set 语义比较）', () => {
		const hostTools = extractHostStringSet(readHostSource(), 'FILE_MODIFICATION_TOOLS');

		assert.deepStrictEqual(
			[...FILE_MODIFICATION_TOOLS].sort(),
			[...hostTools].sort()
		);
	});

	test('TOOL_USE_ENFORCEMENT_GUIDANCE 文本必须与宿主逐字一致', () => {
		const hostGuidance = extractHostJoinedLines(readHostSource(), 'TOOL_USE_ENFORCEMENT_GUIDANCE');

		assert.strictEqual(TOOL_USE_ENFORCEMENT_GUIDANCE, hostGuidance);
	});

	test('幂等标记必须是首行（注入前靠它检测是否已注入）', () => {
		const [firstLine] = TOOL_USE_ENFORCEMENT_GUIDANCE.split('\n');

		assert.strictEqual(firstLine, '<!-- TOOL_USE_ENFORCEMENT -->');
	});

	test('DEFAULT_BUDGET_MAX / MAX_TEXT_SEARCH_STREAK_HARD 在宿主上不存在（抽出前恒走兜底）', () => {
		const source = readHostSource();

		assertHostLacksStatic(source, 'DEFAULT_BUDGET_MAX');
		assertHostLacksStatic(source, 'MAX_TEXT_SEARCH_STREAK_HARD');
	});

	test('抽出时固化的兜底取值必须保持不变（抽出不改变行为）', () => {
		// 抽出前：`request.budgetMaxTotal ?? (host.constructor.DEFAULT_BUDGET_MAX ?? 90)`
		assert.strictEqual(DEFAULT_BUDGET_MAX, 90);
		// 抽出前：`typeof host.constructor.MAX_TEXT_SEARCH_STREAK_HARD === 'number' ? ... : MAX_TEXT_SEARCH_STREAK * 2`
		assert.strictEqual(MAX_TEXT_SEARCH_STREAK_HARD, MAX_TEXT_SEARCH_STREAK * 2);
	});

	test('硬上限必须严格大于软上限（否则软引导永无机会注入）', () => {
		assert.ok(
			MAX_TEXT_SEARCH_STREAK_HARD > MAX_TEXT_SEARCH_STREAK,
			`硬上限 ${MAX_TEXT_SEARCH_STREAK_HARD} 必须大于软上限 ${MAX_TEXT_SEARCH_STREAK}`
		);
	});
});
