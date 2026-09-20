/*---------------------------------------------------------------------------------------------
 *  subAgentTraceDedupe.test.ts — 子代理事件风暴收敛（2026-09-20，源码级断言）
 *
 *  背景（真机日志 vscode-app-1789898608763 取证 ✓）：
 *   4 个 sub-agent 并发 ~8 分钟内 `fireSubAgentTrace` 打了 **1554** 条 info、
 *   `SubAgentAttach` 打了 **885** 条（占全量日志 ~30%）；18:00:04 的 5338ms 主线程
 *   阻塞正落在风暴密集窗口。生产者虽各有 100ms 节流（delegationTools scheduleFlush），
 *   但多生产者聚合 + 事件驱动下仍有逐字重复的冗余 fire，下游 pane 每次都
 *   合并 → 重挂 → 重渲染卡片。
 *
 *  修法（本文件钉住 ✓）：
 *   ① `fireSubAgentTrace` 内容签名逐字相同 ⇒ 丢弃（不 fire、不记录）；
 *   ② info 日志只在结构签名（数量/挂载/状态集）变化时打，内容-only 降 trace；
 *   ③ `SubAgentAttach` 日志按挂载签名去重（不变不打）——映射异常（:0 空挂 /
 *      groups≠cards）必然改变签名，诊断力不损。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/subAgentTraceDedupe.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

suite('子代理事件风暴收敛：快照去重 + 日志分级（2026-09-20）', () => {

	const SVC_REL = 'src/vs/sessions/contrib/agentStudio/browser/agentOSService.ts';
	const PANE_REL = 'src/vs/sessions/contrib/agentStudio/browser/nativeChatEditorPane.ts';
	const readSrc = (rel: string): string => {
		const abs = path.join(process.cwd(), rel);
		assert.ok(fs.existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
		return fs.readFileSync(abs, 'utf8');
	};
	// 剥注释（本仓教训：注释里刻意引用旧写法作取证，连注释一起查会假红 ✓）
	const stripComments = (src: string): string => src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');

	test('★★★ fireSubAgentTrace：内容签名逐字相同 ⇒ 不 fire（在去重之后才 _onDidSubAgentTrace.fire）', () => {
		const code = stripComments(readSrc(SVC_REL));
		assert.ok(code.includes('_lastSubAgentTraceContentSig'), '必须有内容签名缓存 ✗');
		// 去重 return 必须出现在 fire 之前
		const dedupeIdx = code.indexOf('this._lastSubAgentTraceContentSig.get(groupId) === contentSig');
		const fireIdx = code.indexOf('this._onDidSubAgentTrace.fire(snapshot)');
		assert.ok(dedupeIdx !== -1 && fireIdx !== -1 && dedupeIdx < fireIdx,
			'签名相同的快照必须在 fire 之前被丢弃 ✗');
		// 签名须覆盖内容维度（长度 + 尾段指纹），否则内容更新会被误吞 ✗
		for (const dim of ['progress', 'output', 'toolTraces', 'slice(-8)']) {
			assert.ok(code.includes(dim), `内容签名必须覆盖 ${dim} 维度 ✗`);
		}
		// 防无界累积 ✓
		assert.ok(code.includes('_lastSubAgentTraceContentSig.size > 64'), '签名缓存必须有上限 ✗');
	});

	test('★★★ fireSubAgentTrace：info 只在结构签名变化时打，内容-only 降 trace（刷屏消除 ✓）', () => {
		const code = stripComments(readSrc(SVC_REL));
		assert.ok(code.includes('_lastSubAgentTraceStructSig'), '必须有结构签名缓存 ✗');
		assert.ok(code.includes("this._logService.trace(`[fireSubAgentTrace] content-only update"),
			'内容-only 更新必须降 trace（否则风暴期仍是每 fire 一条 info ✗）');
		// info 必须留在结构变化分支（诊断力保留 ✓）
		const infoIdx = code.indexOf('this._logService.info(`[fireSubAgentTrace] count=');
		const traceIdx = code.indexOf('this._logService.trace(`[fireSubAgentTrace] content-only update');
		assert.ok(infoIdx !== -1 && traceIdx !== -1 && infoIdx < traceIdx,
			'info（结构变化）与 trace（内容-only）两个分支必须并存且顺序正确 ✗');
	});

	test('★★★ SubAgentAttach：挂载签名不变 ⇒ 不打日志（885 条/8min 的刷屏收敛 ✓）', () => {
		const code = stripComments(readSrc(PANE_REL));
		assert.ok(code.includes('_lastSubAgentAttachLogSig'), '必须有 attach 日志去重签名字段 ✗');
		const sigIdx = code.indexOf('sig !== this._lastSubAgentAttachLogSig');
		const logIdx = code.indexOf("this._logService.info(`[SubAgentAttach] ${sig}`)");
		assert.ok(sigIdx !== -1 && logIdx !== -1 && sigIdx < logIdx,
			'attach 日志必须被签名守卫包住 ✗');
		// 签名维度必须含 attached 明细（映射异常「:0 空挂 / groups≠cards」靠它区分 ✓）
		assert.ok(code.includes('attached=[${rows.join'), '签名必须含 attached 明细行 ✗');
	});

	test('★★ 生产者侧 100ms 节流不得回归（delegationTools scheduleFlush ✓）', () => {
		const code = stripComments(readSrc('src/vs/sessions/contrib/agentStudio/browser/providers/tool/delegationTools.ts'));
		assert.ok(code.includes('scheduleFlush'), '生产者节流入口必须在 ✗');
		assert.ok(code.includes('flushNow(); }, 100)'), '生产者 100ms 节流窗口不得删（与服务端去重是两层互补 ✓）');
	});
});
