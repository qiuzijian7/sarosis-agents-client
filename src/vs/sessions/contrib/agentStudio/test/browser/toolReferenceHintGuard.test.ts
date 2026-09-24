/*---------------------------------------------------------------------------------------------
 *  交叉提示「唯一来源」守卫。
 *
 *  背景：`browser_navigate` 描述尾部那句"简单检索时优先用 web_search / web_extract"曾在**两个文件**
 *  各写一份（工具模块的常量 + schemaCorrector 里的精确匹配串），口径是"先无条件写进去、不可用时再按
 *  字符串删掉"。两处字面量 = 漂移即静默失效（删不掉 ⇒ 模型看到指向不可用工具的引用 → 幻觉调用），
 *  而"先写后删"本身就 fail-unsafe。2026-09-24 改成「可用才加」，句子收敛到 `TOOL_REFERENCE_HINTS`，
 *  本守卫钉住"只剩一处"。
 *
 *  ── 为什么扫源码而不是断言注册结果
 *  全仓**零**测试调用过 `registerBrowserTools`；且 32 个 registrar 的 ctx 形状各异、部分模块加载期
 *  就依赖 DOM/workbench（详见 toolSchemaShapeGuard 文件头）。源码扫描是"那句话可能被写死的所有位置"
 *  的**超集**，不会崩、能报 file:line。
 *
 *  ── 为什么连注释也算
 *  注释里抄一份同样是隐患（下一个人会把它复制出去），所以扫描**不**剥注释。代价：解释这条规则的注释
 *  里也不能出现那句话本身（用"那句话"指代即可）—— 本仓注释已按此写。
 *
 *  运行：npm run test-agentstudio-browser
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TOOL_REFERENCE_HINTS } from '../../common/schemaCorrector.js';

const DOMAIN_REL = 'src/vs/sessions/contrib/agentStudio';

/** 只用于遍历剪枝。`test` 也在其中：本文件自己就带着那句话的片段（判定用的 marker）。 */
const PRUNE_DIRS = ['node_modules', 'webview', 'test', 'media'];

/** 判定"这个文件写死了那句话"用的特征片段。 */
const HINT_MARKER = 'prefer web_search or web_extract';

/** 唯一允许出现它的文件（相对仓库根）。 */
const ALLOWED_FILE = `${DOMAIN_REL}/common/schemaCorrector.ts`;

/** 防空跑下限：cwd 不对时扫描会返回 0 个文件 —— 那种情况必须**红**，而不是静默变绿。 */
const MIN_SCANNED_FILES = 100;

interface IScanResult {
	readonly scanned: number;
	readonly hits: string[];
}

function scanHintSources(): IScanResult {
	let scanned = 0;
	const hits: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (PRUNE_DIRS.includes(entry.name)) { continue; }
				walk(full);
				continue;
			}
			if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) { continue; }
			scanned++;
			if (fs.readFileSync(full, 'utf8').includes(HINT_MARKER)) {
				hits.push(path.relative(process.cwd(), full).replace(/\\/g, '/'));
			}
		}
	};
	walk(path.join(process.cwd(), DOMAIN_REL));
	return { scanned, hits };
}

suite('ToolReferenceHintGuard — 交叉提示只能有一处来源', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let cached: IScanResult | undefined;
	const scan = (): IScanResult => (cached ??= scanHintSources());

	test('★★★ 全仓只有一个文件写死那句话（两处 = 漂移即静默失效）', () => {
		const { hits } = scan();
		assert.deepStrictEqual(hits, [ALLOWED_FILE],
			'那句话必须只由 TOOL_REFERENCE_HINTS 持有。若在某处又抄了一份：'
			+ '① 先删掉那份副本；② 若确实要换地方声明，本守卫的 ALLOWED_FILE 也要一起改。'
			+ `当前命中：${JSON.stringify(hits)}`);
	});

	test('★ 那句话确实在 TOOL_REFERENCE_HINTS 里（扫描 0 处说明声明被删了 / 文案被改了）', () => {
		assert.ok(TOOL_REFERENCE_HINTS.some(h => h.text.includes(HINT_MARKER)),
			`规则表里找不到 "${HINT_MARKER}" —— 声明没了，提示就永远不会出现`);
	});

	test('★ 扫描规模下限（防"目录改名 / 读不到内容"造成的假绿）', () => {
		const { scanned } = scan();
		assert.ok(scanned >= MIN_SCANNED_FILES,
			`只扫到 ${scanned} 个 .ts（下限 ${MIN_SCANNED_FILES}）—— 读到的内容不像真实源码树`);
	});

});
