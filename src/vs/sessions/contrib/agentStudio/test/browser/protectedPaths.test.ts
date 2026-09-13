/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isProtectedPath } from '../../common/protectedPaths.js';

/**
 * `isProtectedPath` 是**受保护路径判定的单一真源**（`toolExecutionGuard` 在写路径上查它）。
 *
 * 2026-09-13「方案 C」把本产品自己的数据目录与 `.vscode` 拉平保护：
 *   · `~/.vssaros/`        —— 工具授权表（tool-allow.json）、User/settings.json
 *   · `<workspace>/.sarosworkspace/` —— agent 定义、workflows、checkpoints、会话记录
 * 二者承载**约束性数据**：模型能写它们 = 「被约束者改写约束」。
 *
 * 本文件钉住：①两个新段确实命中；②匹配是**段级**而非子串（`.sarosworkspaceX` 不命中）；
 * ③既有行为零回归。
 */
suite('protectedPaths — 受保护路径判定', () => {

	test('★★ .vssaros 与 .sarosworkspace 命中（含深层路径 / 大小写 / 反斜杠）', () => {
		const cases = [
			'C:\\Users\\qiuzijian\\.vssaros\\tool-allow.json',
			'/home/u/.vssaros/User/settings.json',
			'g:\\SarosWorkspace\\proj\\.sarosworkspace\\agents\\coder\\.agent.md',
			'g:/SarosWorkspace/proj/.sarosworkspace/workflows/wf-1.json',
			'G:\\PROJ\\.SAROSWORKSPACE\\checkpoints\\exec.json',
			'.vssaros',
			'.sarosworkspace',
		];
		for (const p of cases) {
			assert.strictEqual(isProtectedPath(p), true, `应受保护：${p}`);
		}
	});

	test('★★ 反向：段匹配不是子串匹配（前缀相同的普通目录不得误伤）', () => {
		// 若实现退化成 `includes('.sarosworkspace')`，这些会全部误命中 —— 那样模型连
		// `src/sarosworkspace-utils.ts` 都写不了，护栏会被当成 bug 而被整体关掉。
		const cases = [
			'g:\\proj\\src\\vssaros-utils.ts',
			'g:\\proj\\src\\sarosworkspace-utils.ts',
			'g:\\proj\\.vssaros-backup\\x.json',
			'g:\\proj\\.sarosworkspace.bak\\x.json',
			'g:\\proj\\my.vssaros\\x.json',
		];
		for (const p of cases) {
			assert.strictEqual(isProtectedPath(p), false, `不应受保护：${p}`);
		}
	});

	test('既有行为零回归：原有受保护段 / 后缀仍然命中', () => {
		const hits = [
			'g:\\proj\\.git\\config',
			'g:\\proj\\.vscode\\settings.json',
			'g:\\proj\\.env',
			'g:\\proj\\.env.local',
			'C:\\Users\\u\\.ssh\\id_rsa',
			'g:\\proj\\cert.pem',
			'g:\\proj\\app.keystore',
			'g:\\proj\\team.code-workspace',
			'g:\\proj\\secrets\\a.json',
		];
		for (const p of hits) {
			assert.strictEqual(isProtectedPath(p), true, `应受保护：${p}`);
		}
	});

	test('既有行为零回归：普通源码路径不命中（含 .github 不因 .git 误伤）', () => {
		const misses = [
			undefined,
			'',
			'g:\\proj\\src\\vs\\foo.ts',
			'g:\\proj\\.github\\workflows\\ci.yml',
			'g:\\proj\\gitleaks-report.txt',
			'g:\\proj\\environment.ts',
		];
		for (const p of misses) {
			assert.strictEqual(isProtectedPath(p), false, `不应受保护：${String(p)}`);
		}
	});
});
