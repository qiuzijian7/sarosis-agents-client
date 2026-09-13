/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 受保护路径 —— 单一真源（2026-09-13 从 `browser/toolExecutionGuard.ts` 抽到 `common/`）。
 *
 * 本文件锁两件事：
 *  1. **搬迁不得夹带行为变更** —— 表项 / 段匹配 / 后缀匹配 / `.env.*` 变体 / `.git` 兜底
 *     逐字回归（`isProtectedPath` 直接照搬，含那条语义上冗余的兜底）。
 *  2. **新增的 shell 命令判定** —— 这是本次抽出要解决的缺口：
 *     原判据只看**工具参数**里的路径，于是「始终允许 terminal」之后
 *     `echo x > .git/hooks/pre-commit` 被**静默放行**（下次 commit 执行任意代码）。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/common/protectedPaths.test.ts
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isProtectedPath, commandTouchesProtectedPath } from '../../common/protectedPaths.js';

suite('protectedPaths — 受保护路径（单一真源）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('isProtectedPath', () => {

		test('★ 段名命中：.git / .vscode / 密钥文件名', () => {
			for (const p of [
				'.git/config', 'repo/.git/hooks/pre-commit', '.vscode/settings.json',
				'~/.ssh/id_rsa', 'id_ed25519', '.netrc', 'secrets', 'credentials',
			]) {
				assert.strictEqual(isProtectedPath(p), true, p);
			}
		});

		test('★ 后缀命中：*.pem / *.key / *.code-workspace', () => {
			for (const p of ['a.pem', 'certs/server.key', 'proj.code-workspace']) {
				assert.strictEqual(isProtectedPath(p), true, p);
			}
		});

		test('★ `.env` 家族变体命中', () => {
			for (const p of ['.env', '.env.local', '.env.production', 'app/.env.development']) {
				assert.strictEqual(isProtectedPath(p), true, p);
			}
		});

		test('★★ 控制组：按**路径段**精确匹配，不得因含子串而误伤', () => {
			for (const p of [
				'.github/workflows/ci.yml', '.gitignore', 'src/git-utils.ts',
				'my.env.example', 'src/a.ts', 'docs/readme.md',
			]) {
				assert.strictEqual(isProtectedPath(p), false, p);
			}
		});

		test('★★ 控制组：空 / undefined 不误伤', () => {
			assert.strictEqual(isProtectedPath(undefined), false);
			assert.strictEqual(isProtectedPath(''), false);
		});

		test('★ Windows 反斜杠同样命中（归一化后按 `/` 分段）', () => {
			assert.strictEqual(isProtectedPath('C:\\repo\\.git\\config'), true);
			assert.strictEqual(isProtectedPath('C:\\Users\\x\\.ssh\\id_rsa'), true);
		});
	});

	/**
	 * ★★ shell 命令里的路径判定（本次抽出要解决的缺口）。
	 *
	 * 缺口原文：`isProtected` 只看 `getToolCallPathArg`（工具参数），而 shell 工具的
	 * 参数是 `command` 字符串 → 恒为 undefined → 用户「始终允许 terminal」之后，
	 * 写 `.git/hooks/*` / `.vscode/tasks.json` 的命令**完全不弹审批**。
	 */
	suite('commandTouchesProtectedPath', () => {

		test('★★ 写受保护路径的命令必须命中', () => {
			for (const cmd of [
				'echo x > .git/hooks/pre-commit',
				'echo x >> .git/config',
				`sed -i 's/a/b/' .git/config`,
				'Set-Content .vscode/tasks.json -Value x',
				'cp /tmp/x ~/.ssh/id_rsa',
				'cp /tmp/x secrets/creds',
				'node -e "require(\'fs\').writeFileSync(\'.env\', \'x\')"',
			]) {
				assert.strictEqual(commandTouchesProtectedPath(cmd), true, cmd);
			}
		});

		test('★ 选项式写法也要命中（`=` 必须参与切分）', () => {
			// `--git-dir=.git/config` 若不按 `=` 切，token 的段名是 `--git-dir=.git`（≠ `.git`）→ 漏判
			assert.strictEqual(commandTouchesProtectedPath('git --git-dir=.git/config status'), true);
			assert.strictEqual(commandTouchesProtectedPath('x --config=.env'), true);
		});

		test('★ 读受保护路径**也**命中（有意为之）', () => {
			// `file_read` 对同一路径本就拒绝（读守卫）；终端读同一路径不该「换个工具就能读」
			assert.strictEqual(commandTouchesProtectedPath('cat ~/.ssh/id_rsa'), true);
			assert.strictEqual(commandTouchesProtectedPath('cat .env'), true);
		});

		test('★★ 控制组：普通命令不得命中（避免把免打扰打没）', () => {
			for (const cmd of [
				'git status', 'npm run build', 'npx tsc --outDir out',
				'ls -la src', 'rg "foo" src/vs', 'node --version',
				'python3 -c "print(1)"',
			]) {
				assert.strictEqual(commandTouchesProtectedPath(cmd), false, cmd);
			}
		});

		test('★ 控制组：只提到名字（无路径形状）不命中', () => {
			// 裸词不做受保护判定 —— 否则 `grep id_rsa src/` 会每次多弹一次审批
			assert.strictEqual(commandTouchesProtectedPath('grep -r id_rsa src'), false);
			assert.strictEqual(commandTouchesProtectedPath('rg credentials'), false);
		});

		test('★ 已知边界：**裸名**不判定 —— 用「路径形状」换取零误报', () => {
			// 判定要求 token 有**路径形状**（含 `/` `\\`、以 `.` `~` 开头、或带受保护后缀）。
			// 代价（明示）：`> secrets`（在当前目录写一个名为 `secrets` 的文件）不会命中。
			// 换来的是 `grep -r id_rsa src` / `rg credentials` 这类**只提到名字**的命令
			// 不会每次多弹一次审批 —— 这是刻意的取舍，不是遗漏。
			assert.strictEqual(commandTouchesProtectedPath('echo x > secrets'), false, '裸名不判（已知边界）');
			// 一旦带上路径形状就会被判
			assert.strictEqual(commandTouchesProtectedPath('cp /tmp/x secrets/creds'), true);
			assert.strictEqual(commandTouchesProtectedPath('echo x > ./secrets'), true);
		});

		test('★ 控制组：空 / undefined 不命中', () => {
			assert.strictEqual(commandTouchesProtectedPath(undefined), false);
			assert.strictEqual(commandTouchesProtectedPath(''), false);
		});
	});
});
