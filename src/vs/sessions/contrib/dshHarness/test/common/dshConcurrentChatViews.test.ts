/*---------------------------------------------------------------------------------------------
 *  「中间栏并排多个聊天、同时执行」的守卫（2026-10-21）。
 *
 *  需求：桌面版 IDE 的**中间栏**要能同时跑多个聊天窗口（各自独立会话、各自同时执行）。
 *
 *  查过的现状（别重复查）：
 *  - VS Code 的 pane 是**按 editor group 复用**的（`EditorPanes` 是 group 的实例字段）⇒
 *    两个 group ⇒ 两个 `NativeChatEditorPane` ⇒ 两个 dsh 承载 ⇒ 两个 `WebContentsView`
 *    ⇒ 两个页面实例（各自的 `currentSessionId` 互不干扰）⇒ **承载层不需要改造**；
 *  - dsh Host 侧**没有**全局串行闸门（`ctx.agents.get(sessionId)` / `vssarosRuns` 都按会话分片）
 *    ⇒ **引擎侧天然支持并发**。
 *  ⇒ 真正的阻塞只有三个：① 聊天不准落中间栏；② 6 条 HTTP/1.1 连接/分区 ⇒ 互相饿死；
 *     ③ "活动聊天"单槽被"最后重算的那个"占用 ⇒ 外部操作打到错的聊天。
 *
 *  本文件把这些"必须成立"钉死：
 *  - 纯判定（`common/dshChatPartition.ts`）⇒ 有单测；
 *  - 宿主接线（源码契约）⇒ 防止"纯函数对了但没人调用"。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import fs from 'node:fs';
import { decideChatPartition } from '../../common/dshChatPartition.js';

const VIEW_HOST = 'src/vs/sessions/contrib/dshHarness/electron-main/dshViewHost.ts';
const CHAT_HOST = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshChatInstanceHost.ts';
const SERVICE = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts';
const PANE = 'src/vs/sessions/contrib/agentStudio/browser/nativeChatEditorPane.ts';
const CONTRIBUTION = 'src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts';

const BASE = {
	isolatedPool: false,
	surface: 'chat',
	mainPartitionBusy: false,
	poolSeq: 0,
	desktopPartition: 'vssaros-dsh-desktop',
	mainPartition: 'persist:vssaros-dsh',
	poolPrefix: 'vssaros-dsh-chat-',
};

suite('并发聊天视图：中间栏能并排跑多个聊天', () => {

	// ── ① 分区判定（纯逻辑）───────────────────────────────────────────────
	test('第一个聊天视图用主分区（单聊天场景行为完全不变）', () => {
		const d = decideChatPartition({ ...BASE, mainPartitionBusy: false });
		assert.strictEqual(d.kind, 'main');
		assert.strictEqual(d.partition, 'persist:vssaros-dsh');
	});

	test('★ 主分区已被占用 ⇒ 后来者独占池分区（否则 6 条连接互相饿死）', () => {
		const d = decideChatPartition({ ...BASE, mainPartitionBusy: true, poolSeq: 1 });
		assert.strictEqual(d.kind, 'pool');
		assert.strictEqual(d.partition, 'vssaros-dsh-chat-2', '池分区名必须带递增序号（不复用 ⇒ 不撞旧 cookie）');
	});

	test('池分区名互不相同（两个并发聊天不能落同一个分区）', () => {
		const a = decideChatPartition({ ...BASE, mainPartitionBusy: true, poolSeq: 0 });
		const b = decideChatPartition({ ...BASE, mainPartitionBusy: true, poolSeq: 1 });
		assert.notStrictEqual(a.partition, b.partition);
	});

	test('弹窗永远独立分区（既有语义，不被聊天规则改写）', () => {
		const d = decideChatPartition({ ...BASE, isolatedPool: true, mainPartitionBusy: false });
		assert.strictEqual(d.kind, 'desktop');
		assert.strictEqual(d.partition, 'vssaros-dsh-desktop');
	});

	test('非聊天表面（插件页）一律主分区（要共享登录态/偏好）', () => {
		const d = decideChatPartition({ ...BASE, surface: 'plugin-page', mainPartitionBusy: true });
		assert.strictEqual(d.kind, 'main');
	});

	// ── ② 宿主接线（源码契约）──────────────────────────────────────────────
	test('主进程：create() 必须走分区判定，且池分区要登记（供续期遍历）', () => {
		const src = fs.readFileSync(VIEW_HOST, 'utf8');
		assert.ok(/decideChatPartition\(\{/.test(src), 'create() 必须调用分区判定（不能自己另写一套 ✗）');
		assert.ok(/decision\.kind === 'pool'\) \{[\s\S]{0,240}_acquireChatPoolSession/.test(src),
			'pool 分支必须真的去拿池分区（写成别的分支 ⇒ 并发聊天仍共用主分区 ✗）');
		assert.ok(/_chatPoolSessions\.set\(/.test(src), '池分区必须登记（否则不会被续期 ⇒ 几分钟后黑屏 ✗）');
	});

	test('★ 认证 cookie 必须给**所有活分区**续期（否则并排的第二个聊天几分钟后黑屏）', () => {
		const src = fs.readFileSync(VIEW_HOST, 'utf8');
		const at = src.indexOf('private async _refreshAuth(');
		assert.ok(at > 0, '要能定位 _refreshAuth');
		const body = src.slice(at, at + 2000);
		// ⚠ 断言必须钉住"循环体里真的续了期"，不能只钉 `values()`（那玩意改个尾巴照样匹配 ⇒ 恒真 ✗）。
		assert.ok(/for \(const ses of this\._chatPoolSessions\.values\(\)\) \{[\s\S]{0,400}_refreshAuthIn\(ses/.test(body),
			'_refreshAuth 必须遍历池分区**并对每个分区续期**（漏了 ⇒ 那个分区的 cookie 过期 ⇒ 页面变 authentication required ✗）');
		assert.ok(/_hasViewOnSession\(/.test(body), '只续"还有活跃视图"的分区（别给没人看的分区白续）');
	});

	test('活动聊天位只由**焦点**占用；在场不得占位（否则并排时打到错的聊天）', () => {
		const host = fs.readFileSync(CHAT_HOST, 'utf8');
		const at = host.indexOf('private _updateVisibility(');
		assert.ok(at > 0, '要能定位 _updateVisibility');
		const body = host.slice(at, at + 2500);
		assert.ok(!/noteActiveChatView\(/.test(body),
			'在场路径不得占用活动位（谁最后重算谁占位 ⇒ 未必是用户在看的那一个 ✗）');
		assert.ok(/noteChatViewPresent\(/.test(body), '在场路径必须走 noteChatViewPresent（仲裁仍需要"在场"记录）✗');

		const pane = fs.readFileSync(PANE, 'utf8');
		// ⚠ 钉到"真的在监听"的那一处：文件里另有 `IEditorGroup.onDidActiveEditorChange`
		//    与文档注释里的同名链接 ⇒ 只钉方法名会恒真 ✗。
		assert.ok(/_editorService\.onDidActiveEditorChange\(/.test(pane),
			'pane 必须监听活动编辑器变化（焦点的唯一可靠信号）✗');
		assert.ok(/noteActive\?\.\(\)/.test(pane), '拿到焦点时必须登记活动位 ✗');
	});

	test('★ 焦点登记**不得**抢 DOM 焦点（否则用户正在输入的输入框会被抢走）', () => {
		const host = fs.readFileSync(CHAT_HOST, 'utf8');
		const at = host.indexOf('noteActive(): void {');
		assert.ok(at > 0, '宿主必须实现 noteActive（焦点登记）✗');
		const body = host.slice(at, at + 700);
		assert.ok(!body.includes('originalHtmlElementFocus'),
			'noteActive 里不得调 DOM focus（那会把用户正在输入的输入框抢走 ✗✗）');
		assert.ok(body.includes('noteActiveChatView'), 'noteActive 必须登记活动位 ✗');
	});

	test('中间栏能开聊天：newChatInEditor 必须有 mainPart 分支', () => {
		const src = fs.readFileSync(CONTRIBUTION, 'utf8');
		const at = src.indexOf("id: 'agentStudio.newChatInEditor'");
		assert.ok(at > 0, '要能定位 newChatInEditor');
		const body = src.slice(at, at + 6000);
		// ⚠ 钉**完整条件**（含 `activePart === mainPart`）：只钉子串的话，
		//    把它改成 `false && …` 照样匹配 ⇒ 守卫恒真 ✗。
		assert.ok(/if \(activeGroup && activePart && mainPart && activePart === mainPart\) \{/.test(body),
			'必须真的判断"活动编辑器在中间栏"（否则中间栏永远开不出聊天 ✗）');
		assert.ok(/mainPart\.addGroup\(/.test(body),
			'中间栏的新聊天必须**独占一个新 group**（同一 group 只能有一个可见编辑器 ⇒ 不分栏就没有"并排" ✗）');
		assert.ok(/targetGroup\.openEditor\(input/.test(body), '必须在目标 group 里打开聊天编辑器 ✗');
	});

	test('service：预占集合参与"能不能复用"的判断', () => {
		const svc = fs.readFileSync(SERVICE, 'utf8');
		assert.ok(/boundChatSessionIds\(\): Set<string> \{[\s\S]{0,400}this\._reservedChatSessions/.test(svc),
			'boundChatSessionIds 必须含预占的会话（否则并发开两个聊天会绑同一条）✗');
	});
});

// ── 中间栏的**入口 UI**（2026-10-21 补）────────────────────────────────────
// 背景：桌面版主窗口用上游 `MainNativeTitlebarPart`，**没有**我们自绘的顶部标题栏
//   ⇒ app 顶栏那个「新建聊天」按钮在桌面版**不存在** ⇒ 中间栏零入口。
// ⇒ 入口必须挂在**上游渲染**的地方：组标题栏动作区（MenuId.EditorTitle）与
//   空组动作区（MenuId.EmptyEditorGroup）—— 所有窗口都有 ✓。
suite('中间栏的入口 UI：桌面版也要有「新建聊天」按钮', () => {
	const CONTRIB = 'src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts';
	const ENTRY = 'src/vs/sessions/contrib/agentStudio/browser/middleColumnChatEntry.ts';
	const KEYS = 'src/vs/sessions/common/contextkeys.ts';

	test('★ newChatInEditor 必须注册三处菜单（组标题栏 / 空组 / 页签右键）', () => {
		const src = fs.readFileSync(CONTRIB, 'utf8');
		const at = src.indexOf("id: 'agentStudio.newChatInEditor'");
		assert.ok(at > 0, '要能定位 newChatInEditor');
		const body = src.slice(at, at + 3000);
		// ⚠ 只钉子串会恒真（文件别处也可能有这些 MenuId）⇒ 钉**完整条目形态**。
		assert.ok(/id: MenuId\.EditorTitle, group: 'navigation', order: \d+, when: EditorGroupInMainPartContext/.test(body),
			'必须挂 MenuId.EditorTitle（组标题栏 ＋ 按钮；桌面版才有）✗');
		assert.ok(/id: MenuId\.EmptyEditorGroup, group: 'navigation', order: \d+, when: EditorGroupInMainPartContext/.test(body),
			'必须挂 MenuId.EmptyEditorGroup（中间栏空组右上角 ＋）✗');
		assert.ok(/id: MenuId\.EditorTitleContext, group: 'navigation', order: \d+, when: EditorGroupInMainPartContext/.test(body),
			'必须挂 MenuId.EditorTitleContext（聊天页签右键 → 再并排开一个）✗');
	});

	test('★ when 必须是**组作用域** key（否则别栏也长出同一个 ＋，落点还会跑偏）', () => {
		const keys = fs.readFileSync(KEYS, 'utf8');
		assert.ok(/EditorGroupInMainPartContext = new RawContextKey<boolean>\('vssaros\.editorGroupInMainPart'/.test(keys),
			'必须定义组作用域的 EditorGroupInMainPartContext ✗');
		const entry = fs.readFileSync(ENTRY, 'utf8');
		assert.ok(/scopedContextKeyService\.createKey\(EditorGroupInMainPartContext\.key,/.test(entry),
			'必须写进**组的** scopedContextKeyService（组作用域）✗');
		assert.ok(/onDidAddGroup/.test(entry),
			'新组（含窗口恢复时重建的）必须立刻打标（否则新组的按钮不出现 ✗）');
	});

	test('★ 命令必须按「按钮所在 group」路由（点第 2 组的 ＋ 不能开去别处）', () => {
		const src = fs.readFileSync(CONTRIB, 'utf8');
		const at = src.indexOf("id: 'agentStudio.newChatInEditor'");
		const body = src.slice(at, at + 6000);
		assert.ok(/editorGroupsService\.getGroup\(/.test(body),
			'必须按传入的 groupId 定位组（上游 EditorCommandsContextActionRunner 会带 groupId）✗');
		assert.ok(/clickedGroup \?\? activePane\?\.group/.test(body),
			'点击所在组优先，其次才是活动组 ✗');
	});
});
