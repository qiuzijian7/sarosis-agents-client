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

	// ── P1（2026-09-13）：补齐就地编辑 / 下载落盘 / 原地清空类写形态 ──────
	// 与 Cline 的 plan-mode command-guard 对照后发现本表覆盖面偏窄，补齐其已拦的等价写法。

	test('★ P1：blocks tee / truncate / perl -i / awk -i inplace', () => {
		assert.ok(detectScriptSourceWrite(`npm run build 2>&1 | tee src/generatedConst.ts`), 'tee');
		assert.ok(detectScriptSourceWrite(`truncate -s 0 src/app.ts`), 'truncate -s');
		assert.ok(detectScriptSourceWrite(`perl -pi -e 's/foo/bar/' src/app.ts`), 'perl -pi');
		assert.ok(detectScriptSourceWrite(`awk -i inplace '{print}' src/app.ts`), 'awk -i inplace');
	});

	test('★ P1：blocks sort -o / curl -o / wget -O', () => {
		assert.ok(detectScriptSourceWrite(`sort -o src/app.ts src/other.ts`), 'sort -o');
		assert.ok(detectScriptSourceWrite(`curl -o src/app.ts https://example.com/x`), 'curl -o');
		assert.ok(detectScriptSourceWrite(`wget -O src/app.ts https://example.com/x`), 'wget -O');
	});

	// ── 放行组（控制组）：绝不能误伤 ──────────────────────────────────

	/**
	 * ★★ 裸文件名：**无 `cwd`** 时按源码处理（fail-closed，2026-09-13）。
	 *
	 * 裸名无法判定落在哪个目录 → 宁可按源码拦下，由拒绝文案引导补 `cwd` 或写全路径。
	 * 本用例把该行为**显式固化**，避免将来有人「顺手」把它改成**无条件**放行。
	 */
	test('★ 裸文件名 + **无 cwd** → 拦（fail-closed，cwd 未知）', () => {
		assert.ok(
			detectScriptSourceWrite('echo "<html></html>" > admin.html'),
			'裸名目标无 cwd 时一律按源码处理',
		);
	});

	/**
	 * ★★ `cwd` 参与产物判定（2026-09-13 补）—— 修「产物写入被误拦」。
	 *
	 * 实测日志 `vscode-app-1789281483413` 与后续日志：模型在 `docs/kb-mockups/` 下生成
	 * mockup，命令写成 `cwd: "docs/kb-mockups"` + `> admin.html` → 目标**其实是产物**，
	 * 却因「三条豁免规则都要求路径含目录段」而被拦，只能逐个 `file_write`。
	 *
	 * `cwd` 是**真实生效**的运行目录（shell 确实在那里执行）→ 拼接结果就是文件真实落点，
	 * 故模型无法靠伪造 `cwd` 够到目录外的源码：它给什么 `cwd`，文件就真落在那里。
	 */
	test('★★ 同一裸文件名 + cwd 指向豁免目录 → **放行**（本次修复的核心）', () => {
		assert.strictEqual(
			detectScriptSourceWrite('echo "<html></html>" > admin.html', 'docs/kb-mockups'),
			undefined,
			'cwd 在 mockup 目录内 → 目标是产物，必须放行',
		);
		assert.strictEqual(
			detectScriptSourceWrite('echo x > bundle.js', 'out'),
			undefined,
			'cwd 在产物目录内 → 放行',
		);
		assert.strictEqual(
			detectScriptSourceWrite('echo x > _render.url.json', 'docs'),
			undefined,
			'`_` 前缀命名 + 任意 cwd → 放行',
		);
	});

	test('★★ 控制组：cwd 指向**非产物**目录 → 仍拦（不得扩大化）', () => {
		assert.ok(
			detectScriptSourceWrite('echo x > app.ts', 'src/vs/base'),
			'cwd 在源码目录内 → 仍是写源码，必须拦',
		);
		assert.ok(
			detectScriptSourceWrite('echo x > admin.html', 'docs/design'),
			'cwd 不在任何豁免目录内 → 仍拦',
		);
	});

	/**
	 * ★★ **安全边界**：`..` 穿透不得被 `cwd` 伪装成产物。
	 *
	 * 这是「拼 `cwd`」引入的**唯一**新攻击面：若不归一化，`cwd: "out"` +
	 * `> ../../src/app.ts` 会因字符串前缀含 `out/` 而被判为产物 ——
	 * 而**真实落点是 `src/app.ts`**（shell 真的会写到那里）。
	 */
	test('★★ `..` 穿透 cwd 伪装 → 必须拦（否则等于开了个后门）', () => {
		assert.ok(
			detectScriptSourceWrite('echo x > ../src/app.ts', 'out'),
			'`out/../src/app.ts` 归一化后是 `src/app.ts` —— 不是产物',
		);
		assert.ok(
			detectScriptSourceWrite('echo x > ../../src/app.ts', 'dist/nested'),
			'多级 `..` 同样必须归一化',
		);
		// 控制组：`..` 之后**仍落在豁免目录内** → 放行（归一化不是「见 `..` 就拦」）
		assert.strictEqual(
			detectScriptSourceWrite('echo x > ../out/a.html', 'docs'),
			undefined,
			'`docs/../out/a.html` → `out/a.html`，仍是产物',
		);
	});

	test('★★ 绝对路径 / `~` 不受 cwd 影响', () => {
		assert.ok(
			detectScriptSourceWrite('echo x > /abs/src/app.ts', 'out'),
			'绝对路径的落点与 cwd 无关',
		);
		assert.ok(
			detectScriptSourceWrite('echo x > ~/src/app.ts', 'out'),
			'`~` 由 shell 展开，与 cwd 无关',
		);
	});

	test('★★ 控制组：同一目标带上豁免目录段（无需 cwd）→ 放行', () => {
		assert.strictEqual(
			detectScriptSourceWrite('echo "<html></html>" > docs/kb-mockups/admin.html'),
			undefined,
			'mockup 原型目录是豁免目录，**完整相对路径**必须放行',
		);
	});

	test('★★ 控制组：`_` 前缀命名（本项目产物约定）→ 放行', () => {
		assert.strictEqual(
			detectScriptSourceWrite('echo "<html></html>" > _admin.html'),
			undefined,
			'下划线前缀 = throwaway 产物，按 .gitignore 约定放行',
		);
	});

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

	// ── P1 控制组（2026-09-13）：新增写形态不得误伤产物 / 只读用法 ──────────

	test('★★ P1 控制组 E：这些写形态指向产物时仍必须放行', () => {
		assert.strictEqual(detectScriptSourceWrite(`npm run build 2>&1 | tee out/build.log`), undefined, 'tee → out/');
		assert.strictEqual(detectScriptSourceWrite(`truncate -s 0 tmp/scratch.py`), undefined, 'truncate → tmp/');
		assert.strictEqual(detectScriptSourceWrite(`sort -o dist/app.js dist/app.raw.js`), undefined, 'sort -o → dist/');
		assert.strictEqual(detectScriptSourceWrite(`curl -o tmp/x.json https://example.com/x`), undefined, 'curl → tmp/');
		assert.strictEqual(detectScriptSourceWrite(`wget -O _render.url.json https://example.com/x`), undefined, 'wget → `_` 前缀');
		assert.strictEqual(detectScriptSourceWrite(`perl -pi -e 's/a/b/' docs/_draft.md`), undefined, 'perl → `_` 前缀');
	});

	test('★★ P1 控制组 F：只读用法 / 同名文本不得误伤', () => {
		// 无 -i 的 perl、无 -o 的 sort 都是只读 / 只写 stdout
		assert.strictEqual(detectScriptSourceWrite(`perl -pe 's/a/b/' src/app.ts`), undefined, 'perl 无 -i = 只读流');
		assert.strictEqual(detectScriptSourceWrite(`sort src/app.ts`), undefined, 'sort 无 -o = 只输出到 stdout');
		assert.strictEqual(detectScriptSourceWrite(`git log --sort=date --oneline src/app.ts`), undefined,
			'`--sort=` 不是 sort 命令（判据要求命令起始位置）');
		assert.strictEqual(detectScriptSourceWrite(`git --no-pager diff --stat src/app.ts`), undefined);
		assert.strictEqual(detectScriptSourceWrite(`wc -l src/app.ts`), undefined);
	});

	test('★ P1：源在前、目标在后时不得误判（sort -o 的收紧判据）', () => {
		// `sort <source> -o <artifact>`：源是源码、目标是产物 → 必须放行
		assert.strictEqual(detectScriptSourceWrite(`sort src/app.ts -o dist/app.js`), undefined,
			'-o 未紧跟 sort → 不匹配（避免误伤）');
	});

	// ── 「下划线前缀」产物（2026-09-13；同日修订为**任意深度**）────────────
	// 项目约定：临时 / mockup / 渲染产物以 `_` 开头命名（仓库根实测 10+ 个：
	// _askuser_editor_mockup.html、_kb_tag_cloud_search_mockup.html …）。
	// 日志实证：`fs.writeFileSync('_render.url.json')` 曾被拦 → 模型只能逐个 file_write。
	// ★ 修订依据：本仓 .gitignore:151-157（`_*.ts/_*.js/_*.py…`，注释原文
	// 「underscore-prefixed = throwaway debug scripts」）**无前导斜杠 → 任意深度生效**。
	// git check-ignore 实证 src/_internal.ts、docs/deep/_draft.ts 被忽略；src/internal.ts 不忽略。

	test('★ 放行：工作区根的下划线产物（无目录分隔符）', () => {
		assert.strictEqual(
			detectScriptSourceWrite(`node -e "fs.writeFileSync('_render.url.json', JSON.stringify(x))"`), undefined,
			'_render.url.json（日志原案）');
		assert.strictEqual(detectScriptSourceWrite(`node -e "fs.writeFileSync('_mockup.html', html)"`), undefined);
		assert.strictEqual(detectScriptSourceWrite(`python3 -c "open('_draft.md','w').write(md)"`), undefined);
		assert.strictEqual(detectScriptSourceWrite(`echo x > _scratch.ts`), undefined, 'shell 重定向形态同样适用');
	});

	test('★ 放行：任意深度的下划线前缀（2026-09-13 修订，与 .gitignore 同口径）', () => {
		assert.strictEqual(detectScriptSourceWrite(`node -e "fs.writeFileSync('src/_internal.ts', code)"`), undefined,
			'src/ 下的下划线文件与 .gitignore 同口径 → 放行');
		assert.strictEqual(detectScriptSourceWrite(`node -e "fs.writeFileSync('docs/_draft.md', md)"`), undefined);
		assert.strictEqual(detectScriptSourceWrite(`node -e "fs.writeFileSync('./src/_x.ts', c)"`), undefined);
		assert.strictEqual(detectScriptSourceWrite(`node -e "fs.writeFileSync('_kb-mockups/a.html', h)"`), undefined,
			'目录段带下划线也放行');
		assert.strictEqual(detectScriptSourceWrite(`node -e "fs.writeFileSync('src\\\\_internal.ts', c)"`), undefined,
			'反斜杠分隔同样识别 → 放行');
	});

	test('★★ 控制组 B：两条例外都不满足 → 仍必须拦', () => {
		assert.ok(detectScriptSourceWrite(`node -e "fs.writeFileSync('render.url.json', x)"`),
			'根目录但没有 `_` 前缀 → 仍拦（放行面只针对 `_*` 约定）');
		assert.ok(detectScriptSourceWrite(`node -e "fs.writeFileSync('mockup.html', h)"`));
		assert.ok(detectScriptSourceWrite(`node -e "fs.writeFileSync('my_file.ts', c)"`),
			'`_` 在段内（非段首）不算产物');
		assert.ok(detectScriptSourceWrite(`node -e "fs.writeFileSync('docs/research/a.md', x)"`),
			'docs/research/ 既无 `_` 前缀段也不是 mockup 目录 → 仍拦');
	});

	test('★ 放行：mockup 原型目录（2026-09-13，仓库实测 4 个）', () => {
		assert.strictEqual(
			detectScriptSourceWrite(`node -e "fs.writeFileSync('docs/kb-mockups/index.html', h)"`), undefined,
			'docs/kb-mockups/（日志原案）');
		assert.strictEqual(
			detectScriptSourceWrite(`node -e "fs.writeFileSync('docs/design-mockups/planA.html', h)"`), undefined,
			'docs/design-mockups/');
		assert.strictEqual(
			detectScriptSourceWrite(`node -e "fs.writeFileSync('doc/layout-mockup/layout-mockup.html', h)"`), undefined,
			'doc/layout-mockup/（单数 mockup）');
		assert.strictEqual(
			detectScriptSourceWrite(`node -e "fs.writeFileSync('mockups/a.html', h)"`), undefined,
			'裸 mockups/');
	});

	test('★★ 控制组 D：mockup 只作定语 / 前缀的目录仍必须拦', () => {
		assert.ok(detectScriptSourceWrite(`node -e "fs.writeFileSync('src/mockupRenderer/a.ts', c)"`),
			'mockupRenderer/ 是真源码目录（mockup 仅作定语）');
		assert.ok(detectScriptSourceWrite(`node -e "fs.writeFileSync('src/mockup-utils/a.ts', c)"`),
			'mockup-utils/ 是前缀式命名，不属产物目录');
	});

	test('★ 变量绑定形态同样适用（下划线产物放行，普通源码仍拦）', () => {
		assert.strictEqual(
			detectScriptSourceWrite(`const p = '_cache.json'; require('fs').writeFileSync(p, d)`), undefined,
			'绑定到根下划线产物 → 放行');
		assert.strictEqual(
			detectScriptSourceWrite(`const p = 'docs/_draft.md'; require('fs').writeFileSync(p, d)`), undefined,
			'绑定到任意深度的下划线产物 → 放行');
		assert.ok(
			detectScriptSourceWrite(`const p = 'src/real.ts'; require('fs').writeFileSync(p, c)`),
			'绑定到普通源码路径 → 仍拦');
	});

	/**
	 * ★★ 变量绑定的**右值形态扩展**（2026-09-13）。
	 *
	 * 原实现只认**单个**字面量，于是这些自然写法全被漏掉 —— 扩展名被 join/拼接拆开，
	 * 写调用的参数区里只剩变量名，看不到扩展名：
	 *   · `path.join("src", "a.ts")`     —— Node 最常见
	 *   · `os.path.join("src", "a.ts")`  —— Python 最常见
	 *   · `"src/" + "a.ts"`              —— 拼接
	 *   · `Path("src") / "a.ts"`         —— pathlib 的 `/` 运算符
	 *
	 * 取舍：**只认纯字面量表达式**，右值里出现未知标识符就不绑定（见 `_literalPathFromRhs`
	 * 的注释：产物豁免依赖完整路径，丢掉未知前缀会把 `out/a.ts` 误判成非产物而误拦）。
	 */
	suite('★ 变量绑定右值扩展：join / 拼接 / pathlib', () => {

		test('★★ path.join 字面量 → 必须拦（此前完全漏拦）', () => {
			assert.ok(
				detectScriptSourceWrite(`const p = path.join("src", "real.ts");\nrequire("fs").writeFileSync(p, code)`),
				'path.join 绑定此前不被识别 → 漏拦',
			);
		});

		test('★★ os.path.join 字面量 → 必须拦', () => {
			assert.ok(
				detectScriptSourceWrite('p = os.path.join("src", "real.ts")\nopen(p, "w").write("x")'),
			);
		});

		test('★★ 字符串拼接 → 必须拦', () => {
			assert.ok(
				detectScriptSourceWrite(`const p = "src/" + "real.ts";\nrequire("fs").writeFileSync(p, code)`),
			);
		});

		test('★★ pathlib 的 `/` 运算符 → 必须拦', () => {
			assert.ok(
				detectScriptSourceWrite('p = Path("src") / "real.ts"\nopen(p, "w").write("x")'),
			);
		});

		test('★★ 控制组：产物目录经 join 构造 → 仍须放行（不得误伤）', () => {
			assert.strictEqual(
				detectScriptSourceWrite(`const p = path.join("out", "gen.ts");\nrequire("fs").writeFileSync(p, code)`),
				undefined,
				'out/ 是产物目录 → 放行（这正是「只认纯字面量」要保住的能力）',
			);
			assert.strictEqual(
				detectScriptSourceWrite(`const p = path.join("dist", "a.js");\nrequire("fs").writeFileSync(p, code)`),
				undefined,
			);
		});

		test('★★ 控制组：右值含未知标识符 → 不绑定（宁少拦不误伤）', () => {
			// `__dirname` 未知 → 完整路径不可知 → 不绑定。
			// 若强行绑定成 `a.ts`，`path.join(__dirname, "a.ts")` 这类会因丢掉前缀被误拦。
			assert.strictEqual(
				detectScriptSourceWrite(`const p = path.join(__dirname, "a.ts");\nrequire("fs").writeFileSync(p, code)`),
				undefined,
			);
			assert.strictEqual(
				detectScriptSourceWrite(`const p = ROOT + "a.ts";\nrequire("fs").writeFileSync(p, code)`),
				undefined,
			);
		});

		test('★ 控制组：join 出的非源码扩展名不进入绑定表', () => {
			assert.strictEqual(
				detectScriptSourceWrite(`const p = path.join("out", "report.csv");\nrequire("fs").writeFileSync(p, data)`),
				undefined,
			);
		});
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
