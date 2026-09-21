/*---------------------------------------------------------------------------------------------
 * Copyright (c) Sarosis. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `fileReadHints` 回归测试（2026-09-21，P2-⑦：超长行必须给可执行出路）。
 *
 * 背景（pi 对照）：pi 的 read 遇到超长单行会回一句**可直接执行**的取行命令；
 * 本仓 file_read 早已截断长行（2000 字符），但没说「怎么拿到其余部分」⇒
 * 模型要么误以为内容就这么多，要么重读整个大文件 ✗。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/common/fileReadHints.test.ts
 */
import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { longLineTruncationHint } from '../../common/fileReadHints.js';

suite('fileReadHints — longLineTruncationHint', () => {

	test('★★★ 单行超长：给出**行号 + 两条可执行命令**（按方言分支）', () => {
		const hint = longLineTruncationHint({ firstLine: 42, truncatedCount: 1, maxChars: 2000 }, 'src/data.ts');
		assert.ok(hint.includes('第 42 行'), '必须点名具体行号（否则模型还得自己找）✗');
		assert.ok(hint.includes('2000 字符'), '必须说明截断阈值 ✗');
		// 两条出路都必须**可直接复制执行**：带行号与路径
		assert.ok(/sed -n '42p' src\/data\.ts/.test(hint), 'Git Bash 出路必须可直接执行（带行号与路径）✗');
		assert.ok(/Get-Content src\/data\.ts -TotalCount 42/.test(hint), 'PowerShell 出路必须可直接执行 ✗');
		assert.ok(hint.includes('execute_code'), '两条出路都应经 execute_code（本仓唯一能跑单行命令的工具）✗');
		assert.ok(hint.includes('不要') && hint.includes('重读整个文件'),
			'必须劝阻"重读整个文件"这种昂贵规避（长行文件往往极大）✗');
	});

	test('★ 多行超长：报「第 N 行起共 K 行」', () => {
		const hint = longLineTruncationHint({ firstLine: 7, truncatedCount: 3, maxChars: 2000 }, 'a.min.js');
		assert.ok(hint.includes('第 7 行起共 3 行'), `多行措辞不对：${hint.slice(0, 60)}`);
		// 命令仍指向**第一处**（足够定位），不逐行罗列（避免提示本身变长）
		assert.ok(hint.includes("sed -n '7p' a.min.js"));
	});

	test('★ 提示自包含：不含模板占位符（模型可直接照抄）', () => {
		const hint = longLineTruncationHint({ firstLine: 1, truncatedCount: 1, maxChars: 2000 }, 'f.txt');
		assert.ok(!/<path>|<N>|\$\{/.test(hint), '不得残留占位符 —— 否则模型要自己替换，等于没说 ✗');
	});
});

/** 接线钉（source-level）：纯函数被测了，但「有没有真的接上 file_read」是另一回事。 */
suite('fileReadHints — 接线钉（coreTools.file_read）', () => {

	const code = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');
	const CORE = 'src/vs/sessions/contrib/agentStudio/browser/providers/tool/coreTools.ts';

	test('★★★ file_read 必须统计被截断的行号，并在尾部追加提示', () => {
		const src = code(CORE);
		assert.ok(src.includes('const truncatedLines: number[] = [];'),
			'必须记录被截断的行号（否则无法点名"哪一行"）✗');
		assert.ok(src.includes('truncatedLines.push(i + 1);'), '必须记录绝对行号（1-based）✗');
		assert.ok(src.includes('truncatedLines }'), '必须随 readFileLines 返回值透出 ✗');
		assert.ok(src.includes('truncatedLines = result.truncatedLines;'), '调用侧必须接收 ✗');
		assert.ok(src.includes('longLineTruncationHint({'),
			'必须在 file_read 输出尾部追加长行提示（只有截断没有出路 = 模型只能重读整文件）✗');
		assert.ok(src.includes('maxChars: READ_LINE_MAX_CHARS'), '提示里的阈值必须取自真实常量（防漂移）✗');
	});
});
