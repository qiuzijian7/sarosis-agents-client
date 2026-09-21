/*---------------------------------------------------------------------------------------------
 * Copyright (c) Sarosis. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工具「错误契约」回归钉（2026-09-21，P1-⑤，对齐 pi）。
 *
 * ## 缺陷形态
 *
 * 工具把**失败**用 `return text('xxx error: ...')` 返回 ⇒ `executeTool` 记 OK ⇒
 * 熔断统计、失败提示、Dashboard 全部看不见这次失败；模型也常把"有结果"读成成功
 * （本仓已多次踩：patch 失败记 OK、terminal 空产出记 OK）。pi 的契约相反 ——
 * 工具内部 **throw**，由 loop 统一转成 `{isError:true}`，工具从不自造"像成功的错误"。
 *
 * ## 本文件钉住三条
 *
 *  1. **工具层不得再把失败写成成功形状**（扫描整个 `providers/tool/` 目录的源码）；
 *  2. **抛错必须能到达模型** —— `toolExecutor` 把错误文案同时塞进 `content`
 *     （否则模型收到空结果，不知道失败也不知道原因）；
 *  3. **确定性失败用 `NonRetryableToolError`**（参数/策略类），服务层异常用普通 `Error`
 *     （瞬时性未知）。前者让 `metadata.retryable=false`（若将来重新开启工具级重试，
 *     同参数重发不会被自动重试 3 次）。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/browser/toolErrorContract.test.ts
 */
import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const TOOL_DIR = 'src/vs/sessions/contrib/agentStudio/browser/providers/tool';

suite('工具错误契约（成功形状错误必须清零）', () => {

	const listToolSources = (): Array<{ file: string; lines: string[] }> => {
		const abs = path.join(process.cwd(), TOOL_DIR);
		assert.ok(fs.existsSync(abs), `工具目录不存在（路径基准变了？）：${abs}`);
		return fs.readdirSync(abs)
			.filter(f => f.endsWith('.ts'))
			.map(f => ({ file: f, lines: fs.readFileSync(path.join(abs, f), 'utf8').split(/\r?\n/) }));
	};

	test('★★★ 工具层不得用 `return text(...)` 返回失败（error/failed/invalid/cannot/unavailable）', () => {
		// 判据只看**同一行的字符串字面量**：`return text('X error: …')` 这类形态。
		// 合法豁免（见下）刻意不在此列 —— 需要豁免时必须显式加进 ALLOWED 并写明原因。
		const SUCCESS_SHAPED = /return text\((?:`|'|")[^`'"]*\b(?:error|failed|invalid|cannot|unavailable)\b/i;
		/** 允许清单：`文件:行文本片段` → 原因。目前为空（读工具的空状态提示不含这些关键词）。 */
		const ALLOWED: Array<{ file: string; snippet: string; why: string }> = [];

		const offenders: string[] = [];
		for (const { file, lines } of listToolSources()) {
			for (let i = 0; i < lines.length; i++) {
				if (!SUCCESS_SHAPED.test(lines[i])) { continue; }
				const allowed = ALLOWED.some(a => a.file === file && lines[i].includes(a.snippet));
				if (!allowed) { offenders.push(`${file}:${i + 1}  ${lines[i].trim().slice(0, 120)}`); }
			}
		}
		assert.deepStrictEqual(offenders, [],
			'工具把失败当成功返回 ⇒ executeTool 记 OK、熔断/统计/失败提示全看不见 ✗\n' +
			'请改为 `throw new NonRetryableToolError(...)`（确定性）或 `throw new Error(...)`（服务层异常），文案可逐字保留：\n' +
			offenders.join('\n'));
	});

	test('★★★ 抛错必须同时进 content —— 否则模型收到空结果（不知道失败也不知道原因）', () => {
		const src = fs.readFileSync(
			path.join(process.cwd(), `${TOOL_DIR}/toolExecutor.ts`), 'utf8');
		assert.ok(src.includes('content: [{ type: \'text\', text: msg }],'),
			'toolExecutor 必须把错误文案放进 content（三条结果映射路径都只读 content ✗）');
		assert.ok(src.includes('const retryable = (err as NonRetryableToolError)?.isNonRetryableToolError !== true;'),
			'必须按 NonRetryableToolError 计算 retryable ✗');
	});

	test('★★ 确定性失败用 NonRetryableToolError：codebaseTools / compatibilityTools 已批量收敛', () => {
		const cb = fs.readFileSync(path.join(process.cwd(), `${TOOL_DIR}/codebaseTools.ts`), 'utf8');
		assert.ok(cb.includes('NonRetryableToolError'), 'codebaseTools 必须导入并使用 NonRetryableToolError ✗');
		const cbThrows = (cb.match(/throw new NonRetryableToolError\(/g) ?? []).length;
		assert.ok(cbThrows >= 10,
			`codebaseTools 的确定性失败应至少 10 处走 NonRetryableToolError（实测 ${cbThrows}）✗`);

		const compat = fs.readFileSync(path.join(process.cwd(), `${TOOL_DIR}/compatibilityTools.ts`), 'utf8');
		const compatThrows = (compat.match(/throw new NonRetryableToolError\(/g) ?? []).length;
		// ★ 2026-09-21：原为 ≥6（含 switch_paradigm 2 处 + plan_register 1 处）——这两个工具已**正式退役**
		// （随 `if (!isPiKernelEnabled())` 门控一并删除，见该文件的「已正式退役」注释块），
		// 故门槛降为 update_plan 的 4 处。
		assert.ok(compatThrows >= 4,
			`compatibilityTools（update_plan）应至少 4 处走 NonRetryableToolError（实测 ${compatThrows}）✗`);
	});

	test('★ 服务层异常保留普通 Error（瞬时性未知 ⇒ 不做"确定性"判定）', () => {
		const cb = fs.readFileSync(path.join(process.cwd(), `${TOOL_DIR}/codebaseTools.ts`), 'utf8');
		// query_graph / get_architecture / detect_changes / ingest_traces / manage_adr / export|import_artifact
		const plainThrows = (cb.match(/throw new Error\(`(?:query_graph|get_architecture|detect_changes|ingest_traces|manage_adr|export_artifact|import_artifact) error:/g) ?? []).length;
		assert.ok(plainThrows >= 7,
			`服务层 catch 分支应保留普通 Error（实测 ${plainThrows}/7）—— 别把它们也标成"确定性失败"✗`);
	});
});
