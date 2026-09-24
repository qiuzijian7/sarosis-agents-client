/*---------------------------------------------------------------------------------------------
 *  工具 schema 形状守卫：**不得有空 properties**。
 *
 *  背景：`properties: {}` 的 object schema 会被 IOA 网关判为不兼容并自动改写成 `_no_params`，
 *  每次请求刷一条 sanitize 告警；更麻烦的是"我们声明的 schema"与"模型收到的 schema"不再
 *  一致。此问题**已第 N 次发生**（最近一次：mindmapTools.ts 的 3 个无参工具），所以固化成断言。
 *
 *  ── 为什么是"扫源码"而不是"实例化注册表后遍历工具"
 *
 *  本来更自然的是拿到真实注册表 `listTools()` 逐条查 schema，但实测不可行：
 *   ① 32 个 registerXxxTools 的 ctx 形状各不相同（CoreToolContext / BrowserToolContext /
 *      CompatToolContext / …），且部分模块**在加载期**就依赖 DOM 或 workbench
 *      （mindmapTools → canvasEditorPane、codebaseTools → codebaseGraphService）；
 *   ② 本套件是 esbuild + Node，DOM 全局并不存在；
 *   ③ 全仓**零**测试实例化过 BuiltinToolProvider / ToolRegistry，没有可复用的装配范式。
 *  一个模块加载失败 → 分片 worker 记 `@@CRASH` → 整个护栏失效（且它"红得不明显"）。
 *
 *  源码扫描是"已注册工具 schema 来源"的**超集**（连未被注册函数调用的定义也覆盖），不会崩、
 *  能报 file:line，且不需要任何 mock。代价：它是文本层面的，认不出 `properties: SOME_EMPTY`
 *  这种绕过写法 —— 但那种写法在本仓从未出现过，而"直接写字面量"正是反复发生的那种。
 *
 *  ── 扫描集合是**动态发现**的（这一点是刻意的）
 *
 *  规则：agentStudio 下**凡出现 `inputSchema:` 的文件**都进扫描集合。
 *
 *  曾经想只扫 `browser/providers/tool/`，但那会留下真漏洞：`common/bundled-tools/bundledTools.ts`
 *  有 72 处 inputSchema（比任何单文件都多）却不在该目录里。硬编码目录清单必然随重构漂移，
 *  所以改成"由内容触发发现" —— 新增 schema 来源**自动**纳入，不会再漏。
 *
 *  顺带的好处：`browser/codebaseGraphService.ts` 里也有 `properties: {}`，但那是**图存储记录字段**
 *  （upsertNode / insertEdge 的 payload）不是 schema，该文件不含 `inputSchema` ⇒ 自动被排除，
 *  无需维护排除清单。
 *
 *  ── 刻意不覆盖的范围
 *  `platform/agentHost/node/copilot/*` 里有两个同类写法，但那是**上游 VS Code 代码**
 *  （commit 为 #313679 / #313789 等上游 PR）—— 守它会让每次合上游都红，且改上游文件会持续冲突。
 *
 *  运行：npm run test-agentstudio-browser
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	EMPTY_PROPERTIES_FIX_HINT,
	findEmptyPropertiesSchemas,
	stripTsComments,
} from '../../browser/providers/tool/toolSchemaGuards.js';
import { NO_PARAMS_SCHEMA } from '../../common/providers.js';

const DOMAIN_REL = 'src/vs/sessions/contrib/agentStudio';

/** 只用于**遍历**时剪枝；不参与"该不该扫"的判定（那个由内容决定）。 */
const PRUNE_DIRS = ['node_modules', 'webview', 'test', 'media'];

/**
 * 覆盖率下限（防空跑：目录改名 / 读取不到内容时，守卫必须**红**而不是静默变绿）。
 * 实测值见下方断言消息；留足余量，避免正常增减导致假红。
 */
const MIN_SCHEMA_DECLARING_FILES = 25;
const MIN_INPUT_SCHEMA_OCCURRENCES = 100;

/**
 * 必须出现在扫描集合里的代表性文件 —— 发现逻辑一旦失效（目录改名、内容判定写错），
 * 这几条会立刻红。含 `common/bundled-tools/bundledTools.ts`：它正是"只看 providers/tool
 * 会漏掉的那个最大 schema 来源"（回归守卫）。
 */
const MUST_INCLUDE = [
	'browser/providers/tool/browserTools.ts',
	'browser/providers/tool/mindmapTools.ts',
	'browser/providers/tool/codebaseTools.ts',
	'common/bundled-tools/bundledTools.ts',
];

const INPUT_SCHEMA_MARKER = /inputSchema\s*:/;
const INPUT_SCHEMA_ALL = /inputSchema\s*:/g;

interface IScannedFile {
	readonly rel: string;
	readonly source: string;
}

/** 动态发现所有"声明了工具 schema"的文件（见文件头注释）。 */
function listSchemaDeclaringFiles(): IScannedFile[] {
	const root = path.join(process.cwd(), DOMAIN_REL);
	const out: IScannedFile[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (PRUNE_DIRS.includes(entry.name)) { continue; }
				walk(full);
				continue;
			}
			if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) { continue; }
			const source = fs.readFileSync(full, 'utf8');
			if (!INPUT_SCHEMA_MARKER.test(source)) { continue; }
			out.push({ rel: path.relative(process.cwd(), full).replace(/\\/g, '/'), source });
		}
	};
	walk(root);
	return out;
}

suite('ToolSchemaShapeGuard — 工具 schema 不得带空 properties', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// 本套件内多次调用，读取结果缓存（遍历 + 读全量 .ts 不该在每个用例里重复付代价）。
	let scannedCache: IScannedFile[] | undefined;
	const scanned = (): IScannedFile[] => (scannedCache ??= listSchemaDeclaringFiles());

	// ─── ① 检测器自测：护栏本身不能"永远绿" ─────────────────────────────
	// 没有这一组，扫描逻辑写错（正则失效、注释剥离吃掉代码）会让②静默通过 —— 假绿比没有护栏更糟。

	suite('① 检测器自测（保证②不是假绿）', () => {

		test('命中：单行空 properties', () => {
			const hits = findEmptyPropertiesSchemas(`inputSchema: { type: 'object', properties: {} },`);
			assert.strictEqual(hits.length, 1);
			assert.strictEqual(hits[0].line, 1);
		});

		test('命中：跨行 + 多余空白（properties: { 换行 }）', () => {
			const src = [
				'inputSchema: {',
				"\ttype: 'object',",
				'\tproperties: {',
				'\t},',
				'}',
			].join('\n');
			const hits = findEmptyPropertiesSchemas(src);
			assert.strictEqual(hits.length, 1);
			assert.strictEqual(hits[0].line, 3, '行号必须指向 properties 那一行');
		});

		test('不命中：★ 注释里的反例（本守卫的关键防误报）', () => {
			const lineComment = `// 不能写 { type: 'object', properties: {} } —— 网关会改写`;
			const blockComment = [
				'/*',
				' * 反例：',
				' *   inputSchema: { type: "object", properties: {} }',
				' */',
			].join('\n');
			assert.deepStrictEqual(findEmptyPropertiesSchemas(lineComment), [], '行注释里的反例不算违规');
			assert.deepStrictEqual(findEmptyPropertiesSchemas(blockComment), [], '块注释里的反例不算违规');
		});

		test('不命中：字符串里的 "//" 不得把该行后续代码当成注释吃掉', () => {
			// 若 stripTsComments 不认识字符串，`'https://…'` 的 `//` 会被当行注释起始，
			// 于是真正违规的 properties 反而漏报（假绿）。
			const src = `const u = 'https://example.com'; inputSchema: { properties: {} };`;
			const hits = findEmptyPropertiesSchemas(src);
			assert.strictEqual(hits.length, 1, '字符串里的 // 不能吞掉同一行的真实违规');
		});

		test('命中：反斜杠转义不会提前结束字符串（状态机不误判）', () => {
			const src = `const s = 'it\\'s ok'; inputSchema: { properties: {} };`;
			assert.strictEqual(findEmptyPropertiesSchemas(src).length, 1);
		});

		test('不命中：非空的 properties（含 _no_params 约定写法）', () => {
			assert.deepStrictEqual(
				findEmptyPropertiesSchemas(`inputSchema: { type: 'object', properties: { _no_params: { type: 'boolean' } } }`),
				[],
			);
		});

		test('不命中：只有 type 没有 properties（另一种合法形状）', () => {
			assert.deepStrictEqual(findEmptyPropertiesSchemas(`inputSchema: { type: 'object' }`), []);
		});

		test('stripTsComments 保留字符偏移（否则行号会漂）', () => {
			const src = 'a\n/* x\ny */\nb';
			const stripped = stripTsComments(src);
			assert.strictEqual(stripped.length, src.length, '长度必须一致（注释替换成空格）');
			assert.strictEqual(stripped.split('\n').length, src.split('\n').length, '换行必须原样保留');
		});

	});

	// ─── ② 真实扫描 ────────────────────────────────────────────────────

	test('★ 所有声明 inputSchema 的文件里都不得出现空 properties 的 schema', () => {
		const violations: string[] = [];
		for (const file of scanned()) {
			for (const hit of findEmptyPropertiesSchemas(file.source)) {
				violations.push(`  ${file.rel}:${hit.line}  ${hit.text}`);
			}
		}
		assert.deepStrictEqual(violations, [],
			`发现 ${violations.length} 处空 properties 的 schema ✗\n${violations.join('\n')}\n\n${EMPTY_PROPERTIES_FIX_HINT}`);
	});

	test('★★ 扫描必须真的读到内容（防空跑假绿）', () => {
		const files = scanned();
		assert.ok(files.length >= MIN_SCHEMA_DECLARING_FILES,
			`只发现 ${files.length} 个声明 schema 的文件（下限 ${MIN_SCHEMA_DECLARING_FILES}）—— 发现逻辑已失效？`);

		const rels = new Set(files.map(f => f.rel));
		const missing = MUST_INCLUDE.filter(rel => !rels.has(`${DOMAIN_REL}/${rel}`));
		assert.deepStrictEqual(missing, [],
			`代表性 schema 文件未被发现 —— 动态发现逻辑已失效（这些文件确实含 inputSchema）`);

		let occurrences = 0;
		for (const file of files) {
			occurrences += (file.source.match(INPUT_SCHEMA_ALL) ?? []).length;
		}
		assert.ok(occurrences >= MIN_INPUT_SCHEMA_OCCURRENCES,
			`发现的 inputSchema 只有 ${occurrences} 处（下限 ${MIN_INPUT_SCHEMA_OCCURRENCES}）—— 读到的内容不像是真实的工具定义`);
	});

	// ─── ③ 共享常量自身 ────────────────────────────────────────────────

	test('★★★ 共享常量 NO_PARAMS_SCHEMA 不得被改空（"清理死参数"是本约定的已知威胁）', () => {
		const schema = NO_PARAMS_SCHEMA as { type?: unknown; properties?: Record<string, unknown> };
		assert.strictEqual(schema.type, 'object', '必须是 object schema');
		assert.deepStrictEqual(Object.keys(schema.properties ?? {}), ['_no_params'],
			'必须恰好带一个 _no_params 占位参数 —— 删掉它就退回空 properties，会被 IOA 网关自动改写；'
			+ '这条断言把它变成"删了就红"，而不是靠后人记得');
	});

});
