/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 源码写入护栏回归测试（2026-08-21，日志 1787319805992）。
 *
 * 事故：patch 因 CRLF 连败后，模型改用 `python3 - <<'PY'` 直接 open(p,"w") 重写
 * .tsx 并**执行成功** —— shell 路径不留 checkpoint、不过编辑审批。
 *
 * 本测试的核心价值不只在「能拦住」，更在**控制组**：shell 写文件本身完全合法
 * （生成产物、写日志、只读分析），误伤会让 agent 丧失正常能力。因此拦截组与
 * 放行组必须同时为绿。
 */

import assert from 'assert';
import { detectScriptSourceWrite, scriptSourceWriteGuardMessage } from '../../browser/providers/tool/executeCodeGuards.js';

suite('executeCodeGuards - detectScriptSourceWrite', () => {

	// ── 拦截组：必须命中 ──────────────────────────────────────────────

	test('blocks the exact python heredoc from the incident log (var-bound path + open(w))', () => {
		// 逐字取自日志 L18481-18522（缩短了中间无关行）
		const command = [
			"python3 - <<'PY'",
			'p = r"g:\\CustomWorkspaces\\AIProjects\\sarosis-agents-client\\src\\vs\\sessions\\contrib\\agentStudio\\webview\\src\\features\\workflowEditor\\WorkflowEditorPanel.tsx"',
			'with open(p, "r", encoding="utf-8", newline="") as f:',
			'    lines = f.readlines()',
			'block = lines[start:end+1]',
			'del lines[start:end+1]',
			'lines[ins2:ins2] = insertion',
			'with open(p, "w", encoding="utf-8", newline="") as f:',
			'    f.writelines(lines)',
			'PY',
		].join('\n');
		const hit = detectScriptSourceWrite(command);
		assert.ok(hit, 'the incident script must be blocked');
		assert.match(hit!.target, /WorkflowEditorPanel\.tsx/, 'target should name the source file');
	});

	test('blocks inline open() with a literal source path', () => {
		const hit = detectScriptSourceWrite(`python3 -c "open('src/app.ts','w').write('x')"`);
		assert.ok(hit);
	});

	test('blocks pathlib write_text on a source path', () => {
		const command = [
			"python3 - <<'PY'",
			'from pathlib import Path',
			'target = Path(r"src\\vs\\sessions\\foo.ts")',
			'target.write_text("new content", encoding="utf-8")',
			'PY',
		].join('\n');
		assert.ok(detectScriptSourceWrite(command));
	});

	test('blocks node fs.writeFileSync on a source path', () => {
		const command = `node -e "const fs=require('fs'); const p='src/main.js'; fs.writeFileSync(p, 'x')"`;
		assert.ok(detectScriptSourceWrite(command));
	});

	test('blocks sed -i on a source file', () => {
		assert.ok(detectScriptSourceWrite(`sed -i 's/foo/bar/' src/vs/base/common/path.ts`));
	});

	test('blocks PowerShell Set-Content on a source file', () => {
		assert.ok(detectScriptSourceWrite(`Set-Content -Path src/app.tsx -Value $text`));
	});

	test('blocks shell redirection into a source file', () => {
		assert.ok(detectScriptSourceWrite(`echo "export const x = 1" > src/generatedConst.ts`));
	});

	test('blocks writes to config files (json/yaml) — breaking these is as bad as code', () => {
		assert.ok(detectScriptSourceWrite(`python3 -c "open('package.json','w').write(j)"`), 'package.json');
		assert.ok(detectScriptSourceWrite(`sed -i 's/a/b/' .github/workflows/ci.yml`), 'ci.yml');
	});

	// ── 放行组（控制组）：绝不能误伤 ──────────────────────────────────

	test('allows READING source files (analysis / reporting)', () => {
		const command = [
			"python3 - <<'PY'",
			'p = r"src\\vs\\sessions\\foo.ts"',
			'with open(p, "r", encoding="utf-8") as f:',
			'    print(len(f.readlines()))',
			'PY',
		].join('\n');
		assert.strictEqual(detectScriptSourceWrite(command), undefined,
			'read-only open() must not be blocked');
	});

	test('allows reading source while writing a NON-source report', () => {
		// 高频合法形态：扫源码 → 写 .txt/.csv 统计。写目标不是源码，必须放行。
		const command = [
			"python3 - <<'PY'",
			'src = r"src\\vs\\sessions\\foo.ts"',
			'out = r"stats.csv"',
			'rows = open(src, "r").readlines()',
			'open(out, "w").write(str(len(rows)))',
			'PY',
		].join('\n');
		assert.strictEqual(detectScriptSourceWrite(command), undefined);
	});

	test('allows writing generated artifacts under build output dirs', () => {
		assert.strictEqual(detectScriptSourceWrite(`python3 -c "open('out/vs/bundle.js','w').write(x)"`), undefined, 'out/');
		assert.strictEqual(detectScriptSourceWrite(`echo x > dist/app.js`), undefined, 'dist/');
		assert.strictEqual(detectScriptSourceWrite(`node -e "fs.writeFileSync('build/gen.ts', s)"`), undefined, 'build/');
		assert.strictEqual(detectScriptSourceWrite(`echo x > tmp/scratch.py`), undefined, 'tmp/');
	});

	test('allows writing plain data/log files', () => {
		assert.strictEqual(detectScriptSourceWrite(`npm run compile > build.log 2>&1`), undefined);
		assert.strictEqual(detectScriptSourceWrite(`python3 -c "open('data.txt','w').write('x')"`), undefined);
	});

	test('does not treat fd redirection (2>&1 / 1>) as a file write', () => {
		assert.strictEqual(detectScriptSourceWrite(`tsc -p src/tsconfig.json 2>&1`), undefined,
			'2>&1 alongside a .json path must not trip the guard');
	});

	test('allows read-only shell inspection of source files', () => {
		assert.strictEqual(detectScriptSourceWrite(`git --no-pager diff -- src/app.ts`), undefined);
		assert.strictEqual(detectScriptSourceWrite(`Select-String -Pattern 'foo' src/app.ts`), undefined);
		assert.strictEqual(detectScriptSourceWrite(`node --check src/app.js`), undefined);
	});

	test('allows commands with no write API at all', () => {
		assert.strictEqual(detectScriptSourceWrite(`npm run compile-check-ts-native`), undefined);
		assert.strictEqual(detectScriptSourceWrite(``), undefined);
	});

	// ── 消息内容：必须可执行、必须解释原因 ────────────────────────────

	test('guard message names the alternative tools and explains the risk', () => {
		const hit = detectScriptSourceWrite(`sed -i 's/a/b/' src/app.ts`)!;
		const msg = scriptSourceWriteGuardMessage(hit, 'execute_code');
		assert.match(msg, /execute_code/, 'names the tool that was blocked');
		assert.match(msg, /patch/, 'points at patch');
		assert.match(msg, /file_write/, 'points at file_write');
		assert.match(msg, /checkpoint/i, 'explains why (no rollback point)');
		assert.match(msg, /out\/|dist\//, 'documents the artifact escape hatch');
	});

	test('is stateless across calls (module-level regexes carry the g flag)', () => {
		// 若实现直接复用带 g 标志的模块级正则，lastIndex 会跨调用残留 → 第二次漏判。
		const cmd = `sed -i 's/a/b/' src/app.ts`;
		assert.ok(detectScriptSourceWrite(cmd), 'first call');
		assert.ok(detectScriptSourceWrite(cmd), 'second call must behave identically');
		assert.ok(detectScriptSourceWrite(cmd), 'third call must behave identically');
	});
});
