/*---------------------------------------------------------------------------------------------
 *  interruptedDraftGuard.test.ts — 「中断草稿去重守卫」加固的回归护栏（2026-09-23）
 *
 *  背景（用户报「一条回答被拆成 2 段」✓ DOM 取证 ✓）：
 *    `msg_…_interrupted`（中断快照）与真·turn 消息**并存**、开头逐字重复 ✗✓。
 *    旧守卫 `tail.includes(draft)` 有三个漏口（只拼 content / 字符级比较 / 循环上界 ✗）。
 *
 *  ★ 红线（已写成断言 ✓）：**只放宽"丢弃"，不放宽"保留"** ✓✓ —— 真孤儿（崩溃后草稿是唯一副本）
 *    必须照常注入 ✗✓（守卫存在的全部意义 ✓）。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/interruptedDraftGuard.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
	dropCoveredInterruptedDrafts,
	isDraftAlreadyPersisted,
	messageVisibleText,
	normDraftCompareText,
} from '../../common/interruptedDraftGuard.js';

const SVC_REL = 'src/vs/sessions/contrib/agentStudio/browser/agentChatService.ts';
const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

const A = (content: string) => ({ role: 'assistant', content });
const A_P = (text: string) => ({ role: 'assistant', parts: [{ kind: 'text', text }] });  // stage-E：正文只在 parts ✓
const U = (content: string) => ({ role: 'user', content });
const long = (n: number, seed: string) => (seed + '，').repeat(n).slice(0, n);

suite('interruptedDraftGuard —— 中断草稿去重守卫加固（2026-09-23 ✓ 用户「2 段」根治 ✓）', () => {

	test('★★ 全文包含 ⇒ 丢弃 ✓（草稿=累计文本 ⇒ 完整落盘时必中 ✓）', () => {
		const draft = '先看看知识库里有什么。找到了。完成后给表。';
		const msgs = [U('提问'), A('前言'), A('先看看知识库里有什么。找到了。'), A('完成后给表。')];
		assert.strictEqual(isDraftAlreadyPersisted(msgs, draft), true, '尾部拼接已含草稿 ⇒ 必须丢弃 ✓');
	});

	test('★★★ 漏口①：正文只在 **parts**（content 为空 ✗）⇒ 也要能覆盖 ✓', () => {
		const draft = '先看看知识库里有什么。';
		const msgs = [U('提问'), A_P('先看看知识库里'), A_P('有什么。')];
		assert.strictEqual(messageVisibleText(msgs[1]), '先看看知识库里', 'parts 文本必须读出来 ✓');
		assert.strictEqual(isDraftAlreadyPersisted(msgs, draft), true,
			'stage-E 消息正文只在 parts 时 ⇒ 旧守卫（只读 content ✗）会误判"未落盘" ⇒ 多注入 ✗✓');
	});

	test('★★ 漏口②：空白差异（草稿是流式原文、落盘文本过清洗 ✓）⇒ 折叠后仍覆盖 ✓', () => {
		const draft = '第一段。\n第二段。';
		const msgs = [A('第一段。\n\n  第二段。')];
		assert.strictEqual(normDraftCompareText(draft), '第一段。 第二段。', '空白必须折叠 ✓');
		assert.strictEqual(isDraftAlreadyPersisted(msgs, draft), true, '换行差异不得误判 ✗✓');
	});

	test('★★★ 漏口③：草稿比尾部**更长** ⇒ 前缀探针兜住 ✓（头部必然在回合文本里 ✓）', () => {
		const head = long(150, '头部内容');
		const draft = `${head}…（草稿还有很长很长没进 tail 的部分）`;
		const msgs = [A(head)];   // tail 只有头部（中断点之后的部分没落盘成消息 ✓ 但草稿更全 ✗）
		assert.strictEqual(draft.length > 160, true);
		assert.strictEqual(isDraftAlreadyPersisted(msgs, draft), true,
			'草稿比尾部长 ⇒ 旧守卫（tail.length < draft.length 凑不满 ✗）必漏 ⇒ 探针必须兜住 ✗✓');
	});

	test('★★★ 红线：**真孤儿必须保留** ✗✓（进程真崩溃时草稿是唯一副本 —— 守卫存在的全部意义 ✓）', () => {
		const draft = '这段回答进程死前还没落盘，只活在我的草稿里。';
		const msgs = [U('提问'), A('完全不相关的另一条回复。')];
		assert.strictEqual(isDraftAlreadyPersisted(msgs, draft), false,
			'历史里没有草稿内容 ⇒ 必须注入 ✗✓（误删 = 丢用户内容 ✗✗）');
	});

	test('★ 边界：空草稿 / 空历史 / 尾部撞到非 assistant ⇒ 都不丢 ✓', () => {
		assert.strictEqual(isDraftAlreadyPersisted([], 'x'), false);
		assert.strictEqual(isDraftAlreadyPersisted(undefined, 'x'), false);
		assert.strictEqual(isDraftAlreadyPersisted([A('abc')], ''), false);
		// 尾部是 user ⇒ 不取它 ⇒ 覆盖不上 ⇒ 保留 ✓（草稿属于"当前回合" ✗ 不应被更早的内容顶掉 ✓）
		assert.strictEqual(isDraftAlreadyPersisted([A('abc'), U('新提问')], 'abc 追加内容'), false);
	});

	test('★ 前缀探针阈值：头部太短（<24 字）⇒ 不足以判定同源 ✗（不误判 ✓）', () => {
		// 草稿只有 10 字 ⇒ 探针 10 字 ⇒ 长度不足 24 ⇒ 走"整段包含"判据 ⇒ 不中 ⇒ 保留 ✓
		const msgs = [A('前缀相同后文完全不同前缀相同后文完全不同前缀相同')];
		assert.strictEqual(isDraftAlreadyPersisted(msgs, '前缀相同但后文不一样'), false,
			'短草稿只靠整段判据 ⇒ 本例不中 ⇒ 保留 ✓（避免"碰巧同头"误删 ✓）');
	});

	test('★★★ 真凶：迭代边界的分隔符不一致 ⇒ 折叠空白仍差一个字符 ⇒ 覆盖比对必须**去掉所有空白** ✓', () => {
		// 日志实证（两条 KEPT ✗）：草稿 = 流式累计（迭代边界**没有**分隔符 ✓），
		// 落盘 = 按消息拼接（边界有分隔 ✗）⇒ 折叠成单空格后「。找到了」vs「。 找到了」差一个字符
		// ⇒ includes 失配 ✗✓（DOM 探针 at=0 覆盖 ✓、服务里却 KEPT ✗ —— 就是这个 ✓）。
		const draft = '第一段。第二段。';
		const msgs = [A('第一段。'), A('第二段。')];
		assert.strictEqual(isDraftAlreadyPersisted(msgs, draft), true,
			'两段拼起来 == 草稿 ⇒ 必须覆盖 ✓（折叠空白仍会因边界分隔符失配 ✗✓）');
		// ⚠ 读取期那一半（dropCoveredInterruptedDrafts）在**第二个 suite** 里测 ✓（INTR 定义在那 ✗ 别跨 suite ✓）
	});

	test('★★★ 接线：服务必须调用纯函数，旧的私有实现必须被替换 ✓', () => {
		const src = read(SVC_REL);
		// ⚠ 该文件的 import 用**双引号**（项目惯例 ✓）⇒ 断言必须按双引号查 ✓（单引号写法是我写错的 ✗）
		assert.ok(src.includes('from "../common/interruptedDraftGuard.js"'),
			'agentChatService 必须导入守卫模块 ✗✓');
		assert.ok(src.includes('isDraftAlreadyPersisted(messages, draftMsg.content)'),
			'调用点必须换成纯函数 ✓');
		assert.strictEqual(src.includes('private _isDraftAlreadyPersisted('), false,
			'旧的私有实现（三个漏口 ✗）必须删掉 ✗✓');
		assert.ok(src.includes('NOT covered'),
			'保留路径必须落日志 ✓（下次再漏 ⇒ 用 draftHead/tailHead 对照 ✓）');
	});
});

suite('dropCoveredInterruptedDrafts —— 读取期兜底清洗（2026-09-23 ✓ 二次修复 ✓ 用户截图证实旧数据仍在 ✗）', () => {

	const INTR = (content: string) => ({
		role: 'assistant', content, metadata: { streamInterrupted: true },
	});

	test('★★★ 用户实况：中断快照已被 turn 覆盖 ⇒ **滤掉** ✓（id 带 _interrupted 的那种 ✓）', () => {
		const turnText = '先看看知识库里 unrealengine 文件夹现在有什么。找到了——笔记/UnrealEngine/ 下目前只有 1 个文件。……（完整回答）';
		const list = [
			U('帮我对知识库中 unrealengine 文件夹中，根据功能模块，创建文件夹'),
			A(turnText),                    // 真·回合内容（已落盘 ✓）
			INTR('先看看知识库里 unrealengine 文件夹现在有什么。找到了——笔记/UnrealEngine/ 下目前只有 1 个文件。'),  // 旧中断快照 ✗
		];
		const out = dropCoveredInterruptedDrafts(list);
		assert.strictEqual(out.length, 2, `中断快照已被覆盖 ⇒ 必须滤掉（实际 ${out.length} ✗）`);
		assert.ok(!out.some(m => (m as { metadata?: { streamInterrupted?: boolean } }).metadata?.streamInterrupted),
			'结果里不得再有 streamInterrupted ✗✓');
	});

	test('★★★ 红线：**真孤儿必须保留** ✗✓（别的消息里没有它的内容 ⇒ 崩溃后草稿是唯一副本 ✓）', () => {
		const list = [U('提问'), INTR('这段回答进程死前还没落盘，只活在我的草稿里。')];
		const out = dropCoveredInterruptedDrafts(list);
		assert.strictEqual(out.length, 2, '真孤儿必须保留 ✗✓（误删 = 丢用户内容 ✗✗）');
	});

	test('★★ 非中断消息一律不动 + 顺序不变 ✓', () => {
		const list = [U('a'), A('b'), U('c'), A('d')];
		const out = dropCoveredInterruptedDrafts(list);
		assert.strictEqual(out.length, 4);
		assert.deepStrictEqual(out.map(m => messageVisibleText(m)).join(''), 'abcd', '顺序必须不变 ✓');
	});

	test('★★★ 真凶（读取期半边）：迭代边界分隔符不一致 ⇒ 也不得漏 ✓', () => {
		// 与 suite ① 同款真凶 ✓（草稿=流式累计（边界无分隔 ✓）vs 落盘=按消息拼接（边界有分隔 ✗））
		// ⇒ 折叠成单空格仍差一个字符 ⇒ 失配 ✗✓ —— 必须去掉所有空白 ✓。
		// ⚠ 草稿必须 ≥24 字（探针阈值 ✓ 否则按设计不判定同源 ✓ —— 我第一次写成 14 字被阈值挡下 ✗ 那是我写错 ✓）
		const head = '先看看知识库里有什么，先把目录结构摸清。';   // ~20 字
		const tail = '找到了，确认路径无误，准备落笔写入。';       // ~15 字
		const list = [A(head), A(tail), INTR(head + tail)];       // 草稿**跨两条消息** ✓ 边界处无分隔 ✓
		const out = dropCoveredInterruptedDrafts(list);
		assert.strictEqual(out.length, 2,
			'草稿跨两条消息拼接 ⇒ 覆盖必须成立 ✓（旧判据 rest=join(" ") 会在边界塞进一个空格 ⇒ 失配 ✗✓ —— 已被本测试钉死 ✓）');
	});

	test('★ 多条中断快照：只滤掉"被覆盖"的那条 ✓（另一条保留 ✓）', () => {
		const list = [
			A('完整回答甲：先收集指标。然后建表。'),
			INTR('完整回答甲：先收集指标。'),          // 被覆盖 ✓ ⇒ 滤掉
			INTR('完整回答乙：这条没写完进程就死了。'),  // 未被覆盖 ✓ ⇒ 保留（真孤儿 ✓）
		];
		const out = dropCoveredInterruptedDrafts(list);
		assert.strictEqual(out.length, 2, `应剩 完整回合 + 孤儿快照（实际 ${out.length} ✗）`);
		assert.ok(out.some(m => messageVisibleText(m).includes('没写完进程就死了')), '孤儿必须保留 ✗✓');
	});

	test('★★★ 接线：getHistory 必须在**返回前**调用它 ✓（否则已落盘的旧快照仍会再渲染 ✗）', () => {
		const src = read(SVC_REL);
		assert.ok(/dropCoveredInterruptedDrafts\(/.test(src),
			'getHistory 里必须调用读取期清洗 ✗✓（只挡新注入不够 —— 旧数据已在盘上 ✗）');
		assert.ok(src.includes('KEPT ✗ (not covered by history)'),
			'清洗必须有**逐条判定日志** ✓（用户报"洗了还在" ⇒ 需要看到判定时刻的输入 ✗✓ 我的教训 ✓）');
		assert.ok(src.includes('from "../common/interruptedDraftGuard.js"'), '必须导入守卫模块 ✓');
	});
});
