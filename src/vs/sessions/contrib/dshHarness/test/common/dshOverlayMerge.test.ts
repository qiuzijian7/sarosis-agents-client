/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「覆盖层并成一个 `--patch`」的守卫（2026-11-02，P0）。
 *
 * 背景：我们每次启动要生成 **10** 个覆盖层（bridge / kanban / codebase / mcp / skills / agents /
 * roots / memory / sandbox / office），一条一个 `--patch` 文件交给 dsh。而 dsh 对每条 `--patch`
 * 都要单独读盘 + 解析 YAML；这些文件本来就是"一个文件里可以有多段 `- insert:` / 逐行 config"的语义。
 * 对比 `dsh-desktop`：它只传 **1** 个静态 patch（+ 可选 market/safe）。
 *
 * 改法：各条**照旧单条落盘**（run 目录里能逐条看，排查不用解合并文件），但 `--patch` 只传
 * 合并后的 `overlays-<runId>.yml`（顺序 = 原 push 顺序，跨条顺序不影响语义）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshOverlayMerge
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const SUPERVISOR = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

function code(rel: string): string {
	return read(rel).split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('覆盖层合并成单个 --patch', () => {

	test('1) 单条仍落盘，但不再逐条 push（只收文本）', () => {
		const src = code(SUPERVISOR);
		const at = src.indexOf('const writeOverlay = async (kind: DshHostOverlayKind, text: string): Promise<void> => {');
		assert.ok(at > 0, '找不到 writeOverlay');
		const body = src.slice(at, at + 1200);
		assert.match(body, /hostOverlayFileName\(kind, runId\)/, '单条文件仍要写（排查时逐条看）');
		assert.match(body, /mergedParts\.push\(text\);/, '必须把文本收进 mergedParts');
		assert.ok(!/overlays\.push\(file\);/.test(body), '不许再逐条 push 到 --patch 列表（否则等于没合并）');
	});

	test('2) 最后只 push 合并文件，并留日志', () => {
		const src = code(SUPERVISOR);
		assert.match(src, /const mergedFile = join\(this\._opts\.runDir, `overlays-\$\{runId\}\.yml`\);/,
			'合并文件名必须是 overlays-<runId>.yml（与单条文件区分）');
		assert.match(src, /await fsp\.writeFile\(mergedFile, mergedParts\.join\('\\n'\), \{ mode: 0o600 \}\);/,
			'合并内容按原顺序以换行拼接');
		assert.match(src, /overlays\.push\(mergedFile\);/, '合并文件要进 --patch 列表');
		assert.match(src, /overlay 合并：\$\{mergedParts\.length\} 条 → 1 个 --patch/, '必须留一行日志（现场要能看出合并了几条）');
		// 默认路径只有"合并文件"这一处 push；另有一处是**逃生开关**的逐条回退（必须能用）
		assert.match(src, /const mergeOverlays = \(process\.env\['VSSAROS_HOST_OVERLAY_MERGE'\] \?\? '1'\) !== '0';/,
			'必须有 VSSAROS_HOST_OVERLAY_MERGE 逃生开关（合并是新行为，出问题要能一键退回）');
		assert.match(src, /for \(const f of individualFiles\) \{ overlays\.push\(f\); \}/,
			'开关关闭时必须把逐条文件按原顺序传回去（否则 Host 一个覆盖层都没有）');
	});

	test('3) MCP 那条也要并进合并文件（它原来单独 push 一个文件）', () => {
		const src = code(SUPERVISOR);
		assert.match(src, /mergedParts\.push\(mcpOverlay\.text\);/, 'MCP 的 YAML 文本必须并进 mergedParts');
		assert.ok(!/overlays\.push\(mcpOverlayFile\)/.test(src), 'MCP 不许再单独 push（会让 --patch 变回 2 个）');
		assert.match(src, /return \{ file: this\._mcpOverlayFile, text: mcpText \};/, '_writeMcpOverlay 要把文本交回');
	});
});
