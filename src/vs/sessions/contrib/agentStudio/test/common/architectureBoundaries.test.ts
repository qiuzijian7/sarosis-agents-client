/*---------------------------------------------------------------------------------------------
 *  架构边界断言（P0-3，2026-09-21）。
 *
 *  来源：与 pi 上游的对比分析结论 —— 我们的**差距在基础设施/护栏**，不在内核行为面 ✓。
 *  上游 pi 用 `biome + check:pinned-deps + check:ts-imports + check:entry-graphs` 等
 *  一组 check 脚本把架构约束**变成 CI 可执行的门** ✓；我们此前只有 tsgo + 单测 ⇒
 *  约束靠"记得" ✗。本文件把三条**当前为真**的结构约束钉成断言 ✓（写实，不留例外 ✓）。
 *
 *  钉住的不变量：
 *   ① `piLoop/`（手工复刻的 pi 内核）**零服务层依赖** ✓ —— 这是它可移植、可对拍、
 *      上游升级只需重写适配层的前提 ✓；一旦它 import 宿主服务，就退化成"第二个 legacy" ✗。
 *   ② `common/` 对 `browser/` 只允许 **type** 依赖 ✓ —— 否则 browser 代码会被拖进
 *      common 的每个消费者（分层方向反转 ✗）。
 *   ③ 浏览器层不得**在模块顶层** `require('child_process')` ✗ —— 顶层 require 会让
 *      模块在 renderer 沙箱里直接崩（正常写法是函数内按能力探测后再 require ✓）。
 *
 *  运行：
 *      npm run test-agentstudio-common
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';

const DOMAIN_REL = 'src/vs/sessions/contrib/agentStudio';

function readSource(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `源文件不存在（路径基准变了？）：${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

/** 去掉块注释与整行注释 ⇒ 只对**活代码**断言 ✓（注释里会刻意引用被禁的名字作教训 ✓）。 */
function stripComments(s: string): string {
	return s
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.filter(line => !/^\s*\/\//.test(line))
		.map(line => line.replace(/\s\/\/.*$/, ''))
		.join('\n');
}

function listTsFiles(relDir: string): string[] {
	const abs = path.join(process.cwd(), relDir);
	if (!fs.existsSync(abs)) { return []; }
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === 'node_modules' || entry.name === 'webview' || entry.name === 'test') { continue; }
				walk(full);
				continue;
			}
			if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) { continue; }
			out.push(path.relative(process.cwd(), full).replace(/\\/g, '/'));
		}
	};
	walk(abs);
	return out;
}

suite('架构边界（P0-3）', () => {

	test('★★★ piLoop 内核**零服务层依赖**（可移植性的前提 ✓）', () => {
		const kernelFiles = listTsFiles(`${DOMAIN_REL}/browser/piLoop`);
		assert.ok(kernelFiles.length >= 10, `piLoop 文件数异常（${kernelFiles.length}）—— 路径基准变了？`);

		// 这些名字一旦出现在 import 里 ⇒ 内核被宿主服务绑死 ✗（升级成本会立刻失去可预测性）
		const forbidden = [
			'agentOSService', 'agentChatService', 'agentTurnExecutor', 'nativeChatEditorPane',
			'agentStudioService', 'agentStudio.contribution', 'taskOrchestrationService',
			'workflowExecutionService', 'codebaseGraphService',
		];
		const violations: string[] = [];
		for (const rel of kernelFiles) {
			const code = stripComments(readSource(rel));
			for (const line of code.split('\n')) {
				if (!/^\s*import\b/.test(line)) { continue; }
				for (const bad of forbidden) {
					if (line.includes(bad)) { violations.push(`${rel}: ${line.trim()}`); }
				}
				if (/from '(vs\/)?(workbench|code)\//.test(line) || /from '.*\/workbench\//.test(line)) {
					// 允许 `workbench/services/lifecycle` 这类**平台服务契约**（已存在 ✓），
					// 但禁止引入 workbench/code 的**实现层**（浏览器 → 工作台/Electron 的实现依赖 ✗）
					if (!/workbench\/services\/(lifecycle|log|storage|configuration)\//.test(line)) {
						violations.push(`${rel}（workbench/code 实现层）: ${line.trim()}`);
					}
				}
			}
		}
		assert.deepStrictEqual(violations, [],
			`piLoop 必须宿主无关（否则复刻内核的可移植性/可对拍性失效 ✗）：\n${violations.join('\n')}`);
	});

	test('★★★ agentStudio/common 对 browser 只允许 **type** 依赖（分层方向 ✓）', () => {
		const commonFiles = listTsFiles(`${DOMAIN_REL}/common`);
		const violations: string[] = [];
		for (const rel of commonFiles) {
			const code = stripComments(readSource(rel));
			for (const line of code.split('\n')) {
				if (!/^\s*import\b/.test(line)) { continue; }
				if (!/from '\.\.\/browser\//.test(line)) { continue; }
				// `import type {...}` / `import { type A }` 都算类型依赖 ✓（运行时被擦除 ✓）
				const isTypeOnly = /^\s*import\s+type\b/.test(line);
				assert.ok(isTypeOnly,
					`common → browser 的值导入会反转分层方向 ✗：${rel}\n  ${line.trim()}\n` +
					`  （修法：把该值下沉到 common，或在 browser 侧**再导出**——调用点零改动 ✓）`);
				violations.push(line);
			}
		}
		assert.deepStrictEqual(violations.filter(v => !/^\s*import\s+type\b/.test(v)), []);
	});

	test('★★ 浏览器层不得在**模块顶层** require(\'child_process\')（renderer 沙箱会直接崩 ✗）', () => {
		const browserFiles = listTsFiles(`${DOMAIN_REL}/browser`);
		const violations: string[] = [];
		for (const rel of browserFiles) {
			const code = stripComments(readSource(rel));
			for (const line of code.split('\n')) {
				if (!/require\('child_process'\)|require\("child_process"\)/.test(line)) { continue; }
				if (!/^\s/.test(line)) {
					violations.push(`${rel}: ${line.trim()}`);
				}
			}
		}
		assert.deepStrictEqual(violations, [],
			`顶层 require 会在渲染进程（无 nodeIntegration 时）导致模块加载即崩 ✗：\n${violations.join('\n')}`);
	});

	test('★ 域内不存在被 git 跟踪的 .js 实现文件（构建产物不得提交进 src ✗）', () => {
		let tracked;
		try {
			tracked = cp.execSync(
				`git ls-files "${DOMAIN_REL}"`,
				{ cwd: process.cwd(), encoding: 'utf8' },
			);
		} catch {
			return; // 无 git 环境（导出包 / 纯产物）⇒ 跳过，不让本用例变成环境依赖 ✗
		}
		const strays = tracked.split('\n')
			.filter(f => f.endsWith('.js') && !f.includes('/media/') && !f.includes('/webview/'));
		assert.deepStrictEqual(strays, [], `src 下不应提交 .js 产物：\n${strays.join('\n')}`);
	});
});
