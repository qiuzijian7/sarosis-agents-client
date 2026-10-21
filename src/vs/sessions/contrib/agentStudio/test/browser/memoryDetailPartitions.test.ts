/*---------------------------------------------------------------------------------------------
 *  记忆详情面板的**跨分区读取**守卫（2026-10-21）
 *
 *  现场（用户报障）：IDE 的「记忆详情」面板各页签**全是空的**（槽位 8 个全 "(空)"）。
 *  真因：dsh 聊天框那一侧（Host → 引擎）写记忆用的是**纯 agent id**（`saros-claw` /
 *  `default` / `knowledge-base-expert` …，实测 episodic 4039 / 4970 / 401 条），
 *  而面板读的是**工作区分区**（`ws-<workspaceId>`）⇒ **分区键不同 ⇒ 读到一个空分区** ✗✗。
 *  （真机 provider 实测：工作区分区 episodic=0，只有 8 个空缺省槽位。）
 *
 *  ⇒ 修法：面板改成**工作区 + 所有有数据的 agent 分区**合并读取（与 dsh 侧「记忆库」页同口径），
 *    并标注来源分区；会话按「分区 + sessionId」配对；观察按**会话自己的分区**查。
 *
 *  本守卫是**源级**的（读实现文件断言结构）—— 面板是浏览器态的，整页渲染测不起；
 *  但"又退回单分区"这种回归**必须**被抓住（否则用户看到的又是全空的页面，且没有任何报错）✗✗。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// ⚠ 这个 runner 用 esbuild 编译成 **CJS** ⇒ `import.meta.url` 是 undefined（实测报
//   "The path argument must be of type string… Received undefined" ✗）⇒ 路径要自己算。
// ⚠ 而且 runner **会改 cwd**（实测 cwd = %TEMP%\AppData\browser）⇒ `process.cwd()` 也不可靠 ✗
//   ⇒ 唯一稳的基准是 **runner 脚本自己的路径**（`process.argv[1]`，在仓库里）✓。
declare const __dirname: string;
const runnerDir = path.dirname(process.argv[1] ?? '');
const repoRoot = runnerDir
	? path.resolve(runnerDir, '..', '..', '..', '..', '..', '..', '..')  // browser→test→agentStudio→contrib→sessions→vs→src→仓库根
	: path.resolve(process.cwd());
const PANE = path.join(repoRoot, 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'browser', 'memoryDetailEditorPane.ts');
const src = fs.readFileSync(PANE, 'utf8');

/**
 * 抽出某个方法体（粗粒度但够用）。
 *
 * ⚠⚠ **不能用"配平花括号"来找方法体** —— 返回类型里就有花括号
 *   （`Promise<Array<T & { partition: string }>>`）⇒ 第一个 `{` 落在**类型标注**里
 *   ⇒ 配平出来的"方法体"是一小截签名 ⇒ 断言会假红（本次实测踩到 ✗）。
 * ⇒ 改用"到**下一个同缩进方法**为止"的窗口法：可靠且够用 ✓。
 */
function methodBody(name: string): string {
	// ⚠ 要容忍**泛型参数**（`private async _fanout<T>(`）⇒ 只匹配到方法名 ✓
	const iAsync = src.indexOf(`private async ${name}`);
	const iPlain = src.indexOf(`private ${name}`);
	const i = iAsync >= 0 ? iAsync : iPlain;
	assert.ok(i >= 0, `实现里找不到方法 ${name}`);
	const next = src.indexOf('\n\tprivate ', i + 1);
	return src.slice(i, next > 0 ? next : src.length);
}

suite('记忆详情面板 · 跨分区读取', () => {
	test('① 有「读分区集合」与「分区扇出」两个入口（工作区 + 所有有数据的 agent 分区）', () => {
		assert.ok(src.includes('_readPartitions'), '必须有 _readPartitions（算出要读哪些分区）');
		assert.ok(src.includes('_fanout'), '必须有 _fanout（逐分区取数并合并）');
		const body = methodBody('_readPartitions');
		assert.ok(body.includes('listAllAgentsWithData'), '分区清单必须来自 listAllAgentsWithData（所有有数据的 agent 分区）');
		assert.ok(body.includes('this._agentId'), '当前分区（工作区）也必须在清单里（两边口径都保留）');
	});

	test('② 扇出对单个分区失败**不**影响其它分区（一个分区读不出来就整页空白是最坑的形态）', () => {
		const body = methodBody('_fanout');
		assert.ok(/catch\s*\{/.test(body), '扇出必须有逐分区的 catch');
		assert.ok(body.includes('partition'), '合并后的行必须带来源分区（partition）');
	});

	test('③ 记忆页走**跨分区**（不再只查当前分区）', () => {
		const body = methodBody('_doLoadMemory');
		assert.ok(!/memProvider\.searchMemory\(this\._agentId/.test(body), 'searchMemory 不能再只查当前分区（那正是全空的根因）');
		assert.ok(body.includes('searchMemory(aid'), '必须逐分区 searchMemory');
		assert.ok(body.includes('_loadScopedMemories(memProvider, aid'), 'working/semantic/procedural 三个 scope 也要逐分区取');
	});

	test('④ 槽位页 / 教训页 / 固化页都走跨分区', () => {
		assert.ok(!/getSlots\(this\._agentId\)/.test(src), '槽位页不能再只查当前分区');
		assert.ok(!/getLessons\(this\._agentId\)/.test(src), '教训页不能再只查当前分区');
		const cons = methodBody('_renderConsolidationView');
		assert.ok(!/tier\.fn\]\?\.\(this\._agentId\)/.test(cons), '固化三层不能再只查当前分区');
	});

	test('⑤ 会话页：跨分区 + 按「分区+sessionId」配对 + 观察按会话自己的分区查', () => {
		const body = methodBody('_renderSessionsView');
		assert.ok(!/listSessions\(this\._agentId\)/.test(body), 'listSessions 不能再只查当前分区');
		assert.ok(!/listSummaries\(this\._agentId\)/.test(body), 'listSummaries 不能再只查当前分区');
		assert.ok(/keyOf\(s\['partition'\], sid\)/.test(body), '摘要必须按「分区+sessionId」配对（不同分区同名 session 不串）');
		assert.ok(/observeList\(partition \|\| this\._agentId, sid\)/.test(src), '观察必须按会话自己的分区查（用当前分区查必然空）');
	});

	test('⑥ 标题如实显示合并了几个分区（只写当前分区会误导：数据其实是跨分区来的）', () => {
		assert.ok(src.includes('_scopeText'), '必须有 _scopeText（标题里的分区口径）');
		assert.ok(/this\._agentId\} \+ \$\{extra\} 个 agent 分区/.test(src), '标题要写出合并了几个 agent 分区');
	});

	test('⑦ 反向突变：把扇出改回单分区 ⇒ 必须变红（这就是"全空又回来了"）', () => {
		const mutated = src.replace('memProvider.searchMemory(aid', 'memProvider.searchMemory(this._agentId');
		assert.notEqual(mutated, src, '突变必须真的改到了代码');
		assert.ok(
			/memProvider\.searchMemory\(this\._agentId/.test(mutated),
			'突变后确实退化成单分区 ⇒ 本守卫的判据能抓住它（否则守卫是假绿）',
		);
		// 反向：原实现里**不能**出现单分区调用
		assert.ok(
			!/memProvider\.searchMemory\(this\._agentId/.test(src),
			'原实现必须是跨分区（否则守卫自己就是错的）',
		);
	});
});
