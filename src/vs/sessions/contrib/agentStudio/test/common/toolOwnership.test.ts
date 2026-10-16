/*---------------------------------------------------------------------------------------------
 *  两侧同名工具（SHARED_TOOL_VERBS）登记守卫 —— 2026-10-12。
 *
 *  要防的**不是撞名**（两侧属于不同引擎、不同会话，模型不会同时看到），而是
 *  **语义/文案漂移**：它们写同一份数据（taskboard.json / 知识库 / 记忆 / 工作流定义 /
 *  Unreal bridge），一侧改了动词含义或用户可见文案、另一侧没跟。
 *  真源见 `common/toolOwnership.ts` 的文件头。
 *
 *  本文件钉四件事（都非空跑）：
 *    ① 表结构合法（唯一、字段齐、条数下限）；
 *    ② **双向核对**：表里每条在 Host 插件与 IDE 实现文件里**真的存在**；
 *    ③ **反向核对**：两侧新出现的同名动词必须已登记（两套判据取并集，已知误报须登记理由）；
 *    ④ 防空跑下限（扫描面缩水时立刻红，而不是"0 个问题"）。
 *
 *  运行（仓库根目录）：
 *      node src/vs/sessions/contrib/agentStudio/test/common/run-toolOwnership-tests.mjs
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	SHARED_TOOL_VERBS,
	SHARED_TOOL_VERB_NAMES,
	isSharedToolVerb,
	sharedToolVerbOf,
} from '../../common/toolOwnership.js';

const DOMAIN_REL = 'src/vs/sessions/contrib/agentStudio';
const IDE_TOOL_DIR_REL = `${DOMAIN_REL}/browser/providers/tool`;
const HOST_TOOL_DIR_REL = 'dsh-plugins';

function readSource(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `源文件不存在（路径基准变了？）：${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

function stripComments(s: string): string {
	return s
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n').filter(line => !/^\s*\/\//.test(line)).map(line => line.replace(/\s\/\/.*$/, '')).join('\n');
}

/** IDE 侧**工具定义文件**（非 test）清单。 */
function ideToolFiles(): string[] {
	const dir = path.join(process.cwd(), IDE_TOOL_DIR_REL);
	return fs.readdirSync(dir)
		.filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
		.sort();
}

/**
 * Host 侧注册的工具名 → 出现在哪些插件（`dsh-plugins/<pkg>/`）。
 *
 * ★ 2026-10-13 扩面：原实现只读 `lib/index.js` 且只认 `name: '<literal>'` ✗ —— 但本仓已有
 * **表驱动**注册（`vssaros-unreal` 走 `UNREAL_TOOLS` 表 + `export const UNREAL_*_TOOL_NAME = 'unreal_x'`
 * 常量；`vssaros-browser` 同型）。那种写法下工具名是**常量**，`index.js` 里只有 `name: tool.name` ✗
 * ⇒ 扫描器**看不见**这些工具 ⇒ 登记表里怎么填都红（"Host 侧没有" ✗），而真相是"它就在那儿" ✓。
 * 修法：扫该插件 `lib/` 下的**全部** js，并同时认两种形态 —— `name: 'x'` ✓ 与 `_TOOL_NAME = 'x'` ✓。
 * （判据仍然严格：`'/bridge/health'` 这种路径串**不会**命中 ✓。）
 */
function hostRegisteredNames(): Map<string, string[]> {
	const out = new Map<string, string[]>();
	const dir = path.join(process.cwd(), HOST_TOOL_DIR_REL);
	const collect = (pkg: string, text: string) => {
		for (const m of text.matchAll(/(?:\bname:\s*|_TOOL_NAME\s*=\s*)'([a-z][a-z0-9_]*)'/g)) {
			if (!out.has(m[1])) { out.set(m[1], []); }
			if (!out.get(m[1]).includes(pkg)) { out.get(m[1]).push(pkg); }
		}
	};
	for (const pkg of fs.readdirSync(dir)) {
		const libDir = path.join(process.cwd(), `${HOST_TOOL_DIR_REL}/${pkg}/lib`);
		if (!fs.existsSync(libDir)) { continue; }
		const walk = (d: string) => {
			for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
				const p = path.join(d, entry.name);
				if (entry.isDirectory()) { walk(p); } else if (p.endsWith('.js')) { collect(pkg, fs.readFileSync(p, 'utf8')); }
			}
		};
		walk(libDir);
	}
	return out;
}

/**
 * 判据 A（精确）：`name: '<literal>'` 或 `name: <CONST>`（同文件 `const CONST = '<literal>'`）。
 * 只有它能排除 `category: 'canvas'` 这类普通字符串 ✗。
 */
function ideDefinedNames(): Set<string> {
	const out = new Set<string>();
	for (const f of ideToolFiles()) {
		const src = stripComments(readSource(`${IDE_TOOL_DIR_REL}/${f}`));
		const consts = new Map<string, string>();
		for (const m of src.matchAll(/const\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*string\s*)?=\s*'([a-z][a-z0-9_]*)'/g)) {
			consts.set(m[1], m[2]);
		}
		for (const m of src.matchAll(/\bname:\s*('([a-z][a-z0-9_]*)'|([A-Za-z_][A-Za-z0-9_]*))/g)) {
			const val = m[2] ?? consts.get(m[3]);
			if (val) { out.add(val); }
		}
	}
	return out;
}

/**
 * 判据 B（宽松）：Host 名字是否作为**引号字面量**出现在 IDE 工具定义文件里。
 *
 * 之所以要并上它：IDE 侧有**表驱动**注册的工具（`unrealTools.ts` 走
 * `registerUnrealTools(ctx)` + 常量），判据 A 抓不到它们的 `name:` 形态 ✗，但常量的
 * **值**是字面量 ⇒ B 能兜住。代价是有已知误报（见下表），逐条登记理由。
 */
function ideLiteralNames(hostNames: Iterable<string>): Set<string> {
	const texts = ideToolFiles().map(f => stripComments(readSource(`${IDE_TOOL_DIR_REL}/${f}`)));
	const out = new Set<string>();
	for (const n of hostNames) {
		if (texts.some(t => t.includes(`'${n}'`))) { out.add(n); }
	}
	return out;
}

/** 判据 B 在本仓的**已知误报**（单词名撞普通字符串）。守卫会断言它不扩大。 */
const KNOWN_LITERAL_FALSE_POSITIVES: Record<string, string> = {
	browser: 'Host 侧 `browser` 是单工具 + op 参数形态；IDE 侧 `browserTools.ts` 命中的是 category 字符串 "browser"',
	canvas: '同上：IDE 侧 `canvasTools.ts` 命中 toolset/category 字符串 "canvas"，不是工具名',
	mindmap: '同上：IDE 侧 `mindmapTools.ts` 命中 toolset 字符串 "mindmap"，不是工具名',
};

suite('两侧同名工具 — 登记表与两侧源码双向核对', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('表结构合法：名字唯一、字段齐、条数不低于实测基线', () => {
		// ⚠ 加条目时**同步抬这个下限**（防空跑：只涨不抬 = 有人删掉半张表也不会红 ✗）。
		// 2026-10-14：21 → **33**（补进记忆族 12 个；上一版下限 20 已明显滞后 ✓）。
		// 若哪天**故意**退役某条（工具整体下移到 dsh 侧那种），把下限跟着减 1 并在此写明理由 ✓（不是删断言 ✓）。
		assert.ok(SHARED_TOOL_VERBS.length >= 33,
			`登记条数异常（${SHARED_TOOL_VERBS.length}）：实测基线是 33 条，少于此说明有人删条目 ✗`);
		const names = SHARED_TOOL_VERBS.map(v => v.name);
		assert.strictEqual(new Set(names).size, names.length, '登记表里存在重复名字');
		for (const v of SHARED_TOOL_VERBS) {
			assert.ok(/^[a-z][a-z0-9_]*$/.test(v.name), `名字不规范：${v.name}`);
			assert.ok(v.hostPlugin && v.ideFile && v.sharedStore, `${v.name} 缺字段（hostPlugin/ideFile/sharedStore 都要 ✓）`);
			assert.ok(v.ideFile.startsWith('browser/providers/tool/'), `${v.name} 的 ideFile 不在工具定义目录：${v.ideFile}`);
			assert.ok(isSharedToolVerb(v.name) && sharedToolVerbOf(v.name) === v, `${v.name} 与查询函数不一致`);
		}
	});

	test('★ 双向核对：每条在 Host 插件与 IDE 实现文件里都真的存在', () => {
		const host = hostRegisteredNames();
		const missing: string[] = [];
		for (const v of SHARED_TOOL_VERBS) {
			const pkgs = host.get(v.name) ?? [];
			if (!pkgs.includes(v.hostPlugin)) {
				missing.push(`${v.name}: Host 侧 \`${v.hostPlugin}\` 里没有 \`name: '${v.name}'\`（实际在：${pkgs.join(', ') || '无'}）`);
			}
			const ideText = stripComments(readSource(`${DOMAIN_REL}/${v.ideFile}`));
			if (!ideText.includes(`'${v.name}'`)) {
				missing.push(`${v.name}: IDE 文件 \`${v.ideFile}\` 里找不到字面量 '${v.name}'（改名了？或改了注册形态？）`);
			}
		}
		assert.deepStrictEqual(missing, [], `登记表与源码脱节：\n${missing.join('\n')}`);
	});

	test('★★ 反向核对：两侧新出现的同名动词必须已登记（并集判据）', () => {
		const host = hostRegisteredNames();
		assert.ok(host.size >= 40, `Host 侧只扫到 ${host.size} 个名字 —— 扫描面缩水了，别当成通过 ✗`);
		const defined = ideDefinedNames();
		assert.ok(defined.size >= 100, `IDE 侧只扫到 ${defined.size} 个工具名 —— 扫描面缩水了，别当成通过 ✗`);

		const literals = ideLiteralNames(host.keys());
		const candidates = new Set<string>([...host.keys()].filter(n => defined.has(n) || literals.has(n)));

		const unregistered = [...candidates]
			.filter(n => !SHARED_TOOL_VERB_NAMES.has(n) && !KNOWN_LITERAL_FALSE_POSITIVES[n])
			.sort();
		assert.deepStrictEqual(unregistered, [],
			'两侧出现新的同名工具 ⇒ 请登记到 SHARED_TOOL_VERBS（写明两侧实现 + 共享数据面）：\n' + unregistered.join('\n'));
	});

	test('★ 已知误报清单不得扩大（误报要逐条给理由，不许当垃圾桶）', () => {
		for (const [name, reason] of Object.entries(KNOWN_LITERAL_FALSE_POSITIVES)) {
			assert.ok(reason.trim().length >= 10, `${name} 的排除理由太短`);
			assert.ok(!SHARED_TOOL_VERB_NAMES.has(name), `${name} 已登记进表，就不该再留在误报清单里`);
		}
		assert.ok(Object.keys(KNOWN_LITERAL_FALSE_POSITIVES).length <= 3,
			'误报清单在扩大 —— 说明判据 B 开始不可用，请改判据而不是继续加例外 ✗');
	});
});
