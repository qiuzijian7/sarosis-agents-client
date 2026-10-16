/*---------------------------------------------------------------------------------------------
 *  「版本 / 市场版本」区块的 **characterization 测试**（jsdom，真实 DOM）。
 *
 *  ## 为什么先写这个再拆
 *
 *  `agentSettingsEditorPane.ts` 3208 行、超 2500 规模预算，最该外提的是两块：
 *  「版本/市场版本」（约 473 行）与「飞书 CLI」（约 276 行）。但它是 DOM 重的 `EditorPane`
 *  —— 有 21 个注入服务，**整类没法在单测里构造**（`new` 会拉进 `IEditorGroup` + 基类）。
 *  所以本套件用一条**跨重构稳定**的接缝驱动它：
 *
 *      ① `Object.create(AgentSettingsEditorPane.prototype)` —— 不跑构造器；
 *      ② 只注入被驱动方法真正用到的字段/服务（伪实现）；
 *      ③ 入口是 `_buildVersionsTab()`（宿主方法，外提后仍是同一入口，只是内部转发）；
 *      ④ 断言一律**查 DOM**（`parent.querySelector('.version-commit-row')`），
 *         不去读 `pane._versionsListContainer` 这类"即将搬家"的私有字段 ⇒ 搬家后断言不用改。
 *
 *  于是"拆前绿、拆后仍绿"就等价于"行为没变" ✓ —— 这正是这次外提要的证据。
 *  （`../browser/agentSettingsPaneProbe.test.ts` 的探针已并入本文件的第 1 个用例。）
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/agentSettingsVersionsSection.test.ts
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { AgentSettingsEditorPane } from '../../browser/agentSettingsEditorPane.js';
import { AgentVersionsSection } from '../../browser/agentVersionsSection.js';

// `document` / `window` 由 runner 的 domStub（jsdom，惰性装载）提供。

const AGENT_ID = 'agent-under-test';

/** 让行内 `async` 处理器跑完（onclick 是 async 函数，事件派发不等它）。 */
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

interface ICalls {
	history: Array<[string, number]>;
	init: number;
	diff: Array<[string, string]>;
	rollback: Array<[string, string]>;
	autoCommit: Array<[string, string]>;
	getPackage: number;
	download: Array<[string, string, string]>;
	deleteVersion: Array<[string, string]>;
	confirm: Array<{ message: string; detail?: string }>;
	info: string[];
	error: string[];
}

interface IFakes {
	calls: ICalls;
	version: Record<string, unknown>;
	market: Record<string, unknown>;
	notify: Record<string, unknown>;
	dialog: Record<string, unknown>;
	studio: Record<string, unknown>;
}

/**
 * 造全部伪服务。默认：Git 可用、历史 2 条、市场 2 个版本、已装 1.0.0、非作者、确认框会点"下架"。
 * 每个用例可覆写其中任意一项。
 */
function makeFakes(over: {
	commits?: unknown[] | (() => unknown[]);
	isAvailable?: boolean;
	diff?: string | Error;
	versions?: unknown[];
	installed?: Array<{ kind: string; storeId: string; version?: string }>;
	getPackageThrows?: boolean;
	confirm?: boolean;
	canUpload?: boolean;
} = {}): IFakes {
	const calls: ICalls = {
		history: [], init: 0, diff: [], rollback: [], autoCommit: [],
		getPackage: 0, download: [], deleteVersion: [], confirm: [], info: [], error: [],
	};

	// 空历史时会走「init 后再取一次」的分支 ⇒ 允许用函数按次数给不同结果
	const commitsAt = (n: number): unknown[] => {
		const c = over.commits;
		if (typeof c === 'function') { return c() as unknown[]; }
		return (c ?? []) as unknown[];
	};

	const version = {
		isAvailable: () => over.isAvailable ?? true,
		history: async (agentId: string, limit: number) => {
			calls.history.push([agentId, limit]);
			return commitsAt(calls.history.length);
		},
		init: async () => { calls.init++; },
		diff: async (agentId: string, sha: string) => {
			calls.diff.push([agentId, sha]);
			if (over.diff instanceof Error) { throw over.diff; }
			return { unified: over.diff ?? '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n keep' };
		},
		rollback: async (agentId: string, sha: string) => { calls.rollback.push([agentId, sha]); },
		autoCommit: async (agentId: string, message: string) => { calls.autoCommit.push([agentId, message]); },
	};

	const market = {
		getPackage: async (_agentId: string) => {
			calls.getPackage++;
			if (over.getPackageThrows) { throw new Error('marketplace down'); }
			return { versions: over.versions ?? [] };
		},
		getInstalled: async () => over.installed ?? [],
		download: async (agentId: string, version_: string, kind: string) => { calls.download.push([agentId, version_, kind]); },
		deleteVersion: async (agentId: string, version_: string) => { calls.deleteVersion.push([agentId, version_]); },
	};

	const notify = {
		info: (m: string) => { calls.info.push(m); },
		error: (m: string) => { calls.error.push(m); },
		warn: () => { /* noop */ },
	};

	const dialog = {
		confirm: async (opts: { message: string; detail?: string }) => {
			calls.confirm.push(opts);
			return { confirmed: over.confirm ?? true };
		},
	};

	const studio = { canUploadAgent: () => over.canUpload ?? false };

	return { calls, version, market, notify, dialog, studio };
}

/** 造一个"够用"的 pane：不跑构造器，只注入版本簇会用到的字段与服务。 */
function makePane(over: {
	readOnly?: boolean;
	fakes?: IFakes;
} = {}) {
	const fakes = over.fakes ?? makeFakes();
	const pane = Object.create(AgentSettingsEditorPane.prototype) as unknown as Record<string, unknown>;
	pane._agentId = AGENT_ID;
	pane._readOnly = over.readOnly ?? false;
	pane._agent = { version: '1.0.0' };
	pane.agentVersionService = fakes.version;
	pane.marketplaceService = fakes.market;
	pane.notificationService = fakes.notify;
	pane.dialogService = fakes.dialog;
	pane.agentStudioService = fakes.studio;
	pane.logService = { info: () => { }, warn: () => { }, error: () => { }, trace: () => { }, debug: () => { } };

	const parent = document.createElement('div');
	document.body.appendChild(parent);
	pane._tabContentContainer = parent;
	(pane as { _buildVersionsTab: () => void })._buildVersionsTab();

	return { pane, parent, fakes };
}

const qa = (root: ParentNode, sel: string) => Array.from(root.querySelectorAll(sel)) as HTMLElement[];
const txt = (root: ParentNode, sel: string) => qa(root, sel).map(e => e.textContent ?? '');

const COMMITS = [
	{ sha: 'a'.repeat(40), shortSha: 'aaaaaaa', message: '首次提交', time: '2026-10-12T08:30:00' },
	{ sha: 'b'.repeat(40), shortSha: 'bbbbbbb', message: '第二次提交', time: '2026-10-11T03:05:00' },
];

// ─────────────────────────────────────────────────────────────────────────────

suite('版本区块 · 结构（外提前后都必须一致）', () => {

	test('外提后的契约：宿主只保留 3 个入口，9 个内部方法**不得**留在宿主（防第二套实现）', () => {
		assert.strictEqual(typeof AgentSettingsEditorPane, 'function');
		const paneProto = AgentSettingsEditorPane.prototype as unknown as Record<string, unknown>;

		// 保留：`:291` 建 tab、`:1905-1906` 切 tab 时加载 —— 这三个调用点不变 ✓
		for (const m of ['_buildVersionsTab', '_loadVersionHistory', '_loadMarketplaceVersions']) {
			assert.strictEqual(typeof paneProto[m], 'function', `宿主缺入口 ${m}（调用点会断）`);
		}
		// 搬走的 9 个：宿主侧**必须没有**（否则就是"两套实现"，改一处忘一处 ✗）
		for (const m of [
			'_renderVersionList', '_renderVersionCommitRow', '_handleVersionRollback',
			'_renderMarketplaceVersions', '_renderMarketplaceVersionRow',
			'_handleInstallMarketVersion', '_handleDeleteMarketVersion',
			'_formatVersionTime', '_colorizeVersionDiff',
		]) {
			assert.strictEqual(paneProto[m], undefined,
				`宿主侧不应再有 ${m} —— 真源已搬到 agentVersionsSection.ts，宿主只准转发 ✗`);
		}

		// 新版：9 个实现挂在 AgentVersionsSection 上（搬家后的真源）
		const sectionProto = AgentVersionsSection.prototype as unknown as Record<string, unknown>;
		for (const m of [
			'build', 'refreshHistory', 'refreshMarketplace',
			'_renderVersionList', '_renderVersionCommitRow', '_handleVersionRollback',
			'_renderMarketplaceVersions', '_renderMarketplaceVersionRow',
			'_handleInstallMarketVersion', '_handleDeleteMarketVersion',
			'_formatVersionTime', '_colorizeVersionDiff',
		]) {
			assert.strictEqual(typeof sectionProto[m], 'function', `agentVersionsSection 缺 ${m}`);
		}
	});

	test('初始结构：两个区块标题 + 刷新按钮 + 列表占位文案', () => {
		const { parent } = makePane();
		assert.deepStrictEqual(
			txt(parent, '.versions-section-title'),
			['商城版本（Releases）', '本地历史（Git）'],
		);
		assert.strictEqual(qa(parent, 'button.agent-settings-btn').length, 1, '工具栏只有「刷新」一个按钮');
		assert.strictEqual(qa(parent, 'button.agent-settings-btn')[0].textContent, '🔄 刷新');
		assert.strictEqual(txt(parent, '.versions-list')[0], '点击上方刷新按钮加载版本历史');
		assert.ok(qa(parent, '.marketplace-versions-list').length === 1);
	});

	test('点「刷新」会同时触发两个加载器', async () => {
		const { parent, fakes } = makePane();
		qa(parent, 'button.agent-settings-btn')[0].click();
		await tick();
		assert.ok(fakes.calls.history.length >= 1, '刷新应拉本地历史');
		assert.ok(fakes.calls.getPackage >= 1, '刷新应拉商城版本');
	});
});

suite('版本区块 · 本地历史（Git）', () => {

	test('空历史（含 init 后再取一次）⇒ 空状态文案 + 左对齐 + 零行', async () => {
		const fakes = makeFakes({ commits: [] });
		const { pane, parent } = makePane({ fakes });
		await (pane as { _loadVersionHistory: () => Promise<void> })._loadVersionHistory();

		assert.deepStrictEqual(fakes.calls.history, [[AGENT_ID, 50], [AGENT_ID, 50]], '两次都按 (agentId, 50) 取');
		assert.strictEqual(fakes.calls.init, 1, '空历史要自动 init 一次（旧 agent 无 .git 的懒初始化）');
		assert.strictEqual(qa(parent, '.version-commit-row').length, 0);
		const list = parent.querySelector('.versions-list') as HTMLElement;
		assert.ok((list.textContent ?? '').includes('暂无版本历史（可能是尚未初始化 Git 仓库）'));
		assert.strictEqual(list.style.textAlign, 'left');
	});

	test('有历史 ⇒ 计数行 + 每行 sha/消息/时间 + 折叠区默认收起', async () => {
		const { pane, parent, fakes } = makePane({ fakes: makeFakes({ commits: COMMITS }) });
		await (pane as { _loadVersionHistory: () => Promise<void> })._loadVersionHistory();

		assert.strictEqual(fakes.calls.history.length, 1, '有历史就不再 init');
		assert.strictEqual(fakes.calls.init, 0);
		assert.ok((parent.querySelector('.versions-list')!.textContent ?? '').includes('共 2 条记录'));

		const rows = qa(parent, '.version-commit-row');
		assert.strictEqual(rows.length, 2);
		assert.deepStrictEqual(qa(parent, '.version-commit-row code').map(e => e.textContent), ['aaaaaaa', 'bbbbbbb']);
		// 行结构：children = [head(sha+时间), msg(提交消息), detail(折叠区)]。
		// ⚠ 不用 `span` 选择器取消息 —— 行内只有「时间」是 span（消息是 div）⇒ 用 children 定位才非空跑 ✓。
		assert.deepStrictEqual(rows.map(r => r.children[1].textContent), ['首次提交', '第二次提交']);
		// 时间格式：不是原样 ISO，且含月/日/时:分
		const timeText = rows[0].children[0].querySelector('span')!.textContent ?? '';
		assert.notStrictEqual(timeText, COMMITS[0].time);
		assert.ok(timeText.includes('10') && timeText.includes('12') && timeText.includes(':'), `时间格式异常：${timeText}`);

		const details = qa(parent, '.version-commit-detail');
		assert.deepStrictEqual(details.map(d => d.style.display), ['none', 'none'], '折叠区默认收起');
		assert.deepStrictEqual(txt(parent, 'button.agent-settings-btn').slice(1), ['回滚到此版本', '回滚到此版本']);
	});

	test('只读模式 ⇒ 回滚按钮 disabled + 给标题解释（且点了不触发回滚）', async () => {
		const { pane, parent, fakes } = makePane({ readOnly: true, fakes: makeFakes({ commits: COMMITS }) });
		await (pane as { _loadVersionHistory: () => Promise<void> })._loadVersionHistory();

		const btns = qa(parent, 'button.agent-settings-btn').filter(b => b.textContent === '回滚到此版本') as HTMLButtonElement[];
		assert.strictEqual(btns.length, 2);
		for (const b of btns) {
			assert.strictEqual(b.disabled, true);
			assert.strictEqual(b.title, '只读模式下不可回滚');
		}
		btns[0].click();
		await tick();
		assert.deepStrictEqual(fakes.calls.rollback, [], '只读时不得调回滚');
	});
});

suite('版本区块 · 展开 diff / 回滚交互', () => {

	test('点行展开 ⇒ 拉 diff + 按 +/-/@@ 着色；再点收起；第三次点复用缓存（不再拉）', async () => {
		const { pane, parent, fakes } = makePane({ fakes: makeFakes({ commits: [COMMITS[0]] }) });
		await (pane as { _loadVersionHistory: () => Promise<void> })._loadVersionHistory();

		const row = qa(parent, '.version-commit-row')[0];
		const detail = row.querySelector('.version-commit-detail') as HTMLElement;
		const pre = detail.querySelector('pre') as HTMLElement;

		row.click();
		await tick();
		assert.strictEqual(detail.style.display, 'block');
		assert.deepStrictEqual(fakes.calls.diff, [[AGENT_ID, COMMITS[0].sha]]);
		assert.ok((pre.textContent ?? '').includes('+new'), 'diff 原文应写入 pre');

		// 着色：pre 的子 span 逐行，颜色按行首符号
		// 默认 diff 共 6 行：--- / +++ / @@ / -old / +new / ' keep'
		const spans = Array.from(pre.children) as HTMLElement[];
		assert.strictEqual(spans.length, 6, '6 行 diff ⇒ 6 个 span');
		assert.strictEqual(spans[0].style.color, '', '`---` 不算删除行（不染色）');
		assert.strictEqual(spans[1].style.color, '', '`+++` 不算新增行');
		assert.strictEqual(spans[2].style.color, 'var(--vscode-textLink-foreground, #3794ff)', '`@@` 用链接色');
		assert.strictEqual(spans[3].style.color, 'var(--vscode-testing-iconFailed, #f14c4c)', '删除行用 failed 色');
		assert.strictEqual(spans[4].style.color, 'var(--vscode-testing-iconPassed, #73c991)', '新增行用 passed 色');
		assert.strictEqual(spans[5].style.color, '', '上下文行不染色');
		assert.ok(spans.every(s => (s.textContent ?? '').endsWith('\n')), '每行补换行');

		row.click();
		await tick();
		assert.strictEqual(detail.style.display, 'none', '第二次点收起');
		row.click();
		await tick();
		assert.strictEqual(detail.style.display, 'block', '第三次点直接展开');
		assert.strictEqual(fakes.calls.diff.length, 1, '缓存命中：不再调 diff');
	});

	test('diff 失败 ⇒ pre 显示「加载失败: …」，且不抛到调用方', async () => {
		const { pane, parent } = makePane({ fakes: makeFakes({ commits: [COMMITS[0]], diff: new Error('boom') }) });
		await (pane as { _loadVersionHistory: () => Promise<void> })._loadVersionHistory();
		const row = qa(parent, '.version-commit-row')[0];
		row.click();
		await tick();
		assert.strictEqual((row.querySelector('pre')!.textContent ?? ''), '加载失败: boom');
	});

	test('回滚：按钮不冒泡到行（折叠区不展开）+ 调服务 + 通知带短 sha + 刷新历史', async () => {
		const { pane, parent, fakes } = makePane({ fakes: makeFakes({ commits: [COMMITS[0]] }) });
		await (pane as { _loadVersionHistory: () => Promise<void> })._loadVersionHistory();
		const before = fakes.calls.history.length;

		const row = qa(parent, '.version-commit-row')[0];
		const btn = qa(row, 'button.agent-settings-btn')[0];
		btn.click();
		await tick();

		assert.deepStrictEqual(fakes.calls.rollback, [[AGENT_ID, COMMITS[0].sha]]);
		assert.ok(fakes.calls.info.some(m => m.includes('aaaaaaa')), '通知应带 7 位短 sha');
		assert.strictEqual(fakes.calls.diff.length, 0, '按钮 stopPropagation ⇒ 不触发展开');
		assert.strictEqual((row.querySelector('.version-commit-detail') as HTMLElement).style.display, 'none');
		assert.ok(fakes.calls.history.length > before, '回滚后应刷新历史');
	});

	test('回滚失败 ⇒ 走 notification.error，不冒泡', async () => {
		const fakes = makeFakes({ commits: [COMMITS[0]] });
		(fakes.version as { rollback: () => Promise<void> }).rollback = async () => { throw new Error('nope'); };
		const { pane, parent } = makePane({ fakes });
		await (pane as { _loadVersionHistory: () => Promise<void> })._loadVersionHistory();
		qa(parent, '.version-commit-row')[0].querySelector('button')!.click();
		await tick();
		assert.ok(fakes.calls.error.some(m => m.includes('回滚失败: nope')));
	});

	test('Git 不可用 ⇒ 给出具体原因或环境提示（不误报"尚未初始化"）', async () => {
		const { pane, parent } = makePane({ fakes: makeFakes({ isAvailable: false }) });
		await (pane as { _loadVersionHistory: () => Promise<void> })._loadVersionHistory();
		const text = parent.querySelector('.versions-list')!.textContent ?? '';
		assert.ok(/^Git 版本管理暂不可用：|^当前环境不支持 Git 版本管理/.test(text), `文案异常：${text}`);
		assert.ok(!text.includes('暂无版本历史'), '不得把"不可用"说成"没有历史" ✗');
	});

	test('取历史抛错 ⇒ 显示「加载失败: …」', async () => {
		const fakes = makeFakes();
		(fakes.version as { history: () => Promise<never> }).history = async () => { throw new Error('git boom'); };
		const { pane, parent } = makePane({ fakes });
		await (pane as { _loadVersionHistory: () => Promise<void> })._loadVersionHistory();
		assert.ok((parent.querySelector('.versions-list')!.textContent ?? '').includes('加载失败: git boom'));
	});
});

suite('版本区块 · 商城版本', () => {

	const VERSIONS = [
		{ version: '1.0.0', changelog: '初始版本', isLatest: false },
		{ version: '1.2.0', changelog: '新增 X 能力', isLatest: true },
	];

	test('按 semver 降序 + latest 徽章 + changelog（含 title）+ 当前版本标记', async () => {
		const fakes = makeFakes({
			versions: VERSIONS,
			installed: [{ kind: 'agent', storeId: AGENT_ID, version: '1.0.0' }],
		});
		const { pane, parent } = makePane({ fakes });
		await (pane as { _loadMarketplaceVersions: () => Promise<void> })._loadMarketplaceVersions();

		const rows = qa(parent, '.marketplace-version-row');
		assert.strictEqual(rows.length, 2);
		assert.deepStrictEqual(qa(parent, '.marketplace-version-row code').map(e => e.textContent), ['v1.2.0', 'v1.0.0'],
			'最新在前');
		const first = rows[0];
		assert.ok(Array.from(first.children).some(c => c.textContent === 'latest'), 'latest 徽章');
		const changelogEl = Array.from(first.children).find(c => c.textContent === '新增 X 能力') as HTMLElement;
		assert.ok(changelogEl, 'changelog 文本');
		assert.strictEqual(changelogEl.title, '新增 X 能力', 'changelog 同时进 title（截断后可看全）');
		assert.ok(!Array.from(first.children).some(c => c.textContent === '当前版本'), '最新版不是本地版本 ⇒ 无「当前版本」标记');
		assert.ok(Array.from(first.children).some(c => c.textContent === '安装此版本'));
		assert.ok(Array.from(rows[1].children).some(c => c.textContent === '当前版本'), '本地 1.0.0 ⇒ 标「当前版本」');
		assert.ok(!Array.from(rows[1].children).some(c => c.textContent === '安装此版本'), '当前版本不给安装按钮');
	});

	test('本地版本回落：installed 无记录时用 agent.version', async () => {
		const fakes = makeFakes({ versions: VERSIONS, installed: [] });
		const { pane, parent } = makePane({ fakes });   // makePane 里 _agent.version = '1.0.0'
		await (pane as { _loadMarketplaceVersions: () => Promise<void> })._loadMarketplaceVersions();
		const rows = qa(parent, '.marketplace-version-row');
		assert.ok(Array.from(rows[1].children).some(c => c.textContent === '当前版本'), '应回落到 agent.version');
	});

	test('空版本列表 / 商城不可达 两种空态文案', async () => {
		const a = makePane({ fakes: makeFakes({ versions: [] }) });
		await (a.pane as { _loadMarketplaceVersions: () => Promise<void> })._loadMarketplaceVersions();
		assert.strictEqual(a.parent.querySelector('.marketplace-versions-list')!.textContent, '商城暂无已发布版本');

		const b = makePane({ fakes: makeFakes({ getPackageThrows: true }) });
		await (b.pane as { _loadMarketplaceVersions: () => Promise<void> })._loadMarketplaceVersions();
		assert.strictEqual(b.parent.querySelector('.marketplace-versions-list')!.textContent, '尚未发布到商城（或商城不可达）');
	});

	test('「下架」按钮：仅作者 + 非只读 + 仅最新版本才出现', async () => {
		// ⚠ 判据用**按钮文本**，不要用 `txt(...).includes('下架')` —— 那是数组的 includes（整元素相等）✗，
		//   永远为假 ⇒ 断言变成空跑（本用例初版就是这么写错的）。
		const delBtns = (root: ParentNode) =>
			qa(root, '.marketplace-version-row button').filter(b => b.textContent === '下架');

		const asAuthor = makePane({ fakes: makeFakes({ versions: VERSIONS, canUpload: true }) });
		await (asAuthor.pane as { _loadMarketplaceVersions: () => Promise<void> })._loadMarketplaceVersions();
		const authorRows = qa(asAuthor.parent, '.marketplace-version-row');
		assert.strictEqual(delBtns(asAuthor.parent).length, 1, '作者 + 仅 latest 可下架 ⇒ 全列表只应有 1 个下架按钮');
		assert.ok(Array.from(authorRows[0].children).some(c => c.textContent === '下架'), '下架的应是 latest 那一行');

		const readOnly = makePane({ readOnly: true, fakes: makeFakes({ versions: VERSIONS, canUpload: true }) });
		await (readOnly.pane as { _loadMarketplaceVersions: () => Promise<void> })._loadMarketplaceVersions();
		assert.strictEqual(delBtns(readOnly.parent).length, 0, '只读模式不给下架（对照组：作者身份已满足）');

		const notAuthor = makePane({ fakes: makeFakes({ versions: VERSIONS, canUpload: false }) });
		await (notAuthor.pane as { _loadMarketplaceVersions: () => Promise<void> })._loadMarketplaceVersions();
		assert.strictEqual(delBtns(notAuthor.parent).length, 0, '非作者不给下架');
	});

	test('只读模式 ⇒ 安装按钮 disabled + 标题解释（且点了不安装）', async () => {
		const { pane, parent, fakes } = makePane({ readOnly: true, fakes: makeFakes({ versions: VERSIONS }) });
		await (pane as { _loadMarketplaceVersions: () => Promise<void> })._loadMarketplaceVersions();
		// `makePane` 注入 `_agent.version = '1.0.0'` 且无 installed 记录 ⇒ 1.0.0 标「当前版本」，
		// 只剩 1.2.0 那个安装按钮 ✓（断言 2 个会因"当前版本不给按钮"而误报）。
		const installs = qa(parent, '.marketplace-version-row button').filter(b => b.textContent === '安装此版本') as HTMLButtonElement[];
		assert.strictEqual(installs.length, 1);
		assert.strictEqual(installs[0].disabled, true);
		assert.strictEqual(installs[0].title, '只读模式下不可安装');
		installs[0].click();
		await tick();
		assert.deepStrictEqual(fakes.calls.download, [], '只读 ⇒ 点击不安装');
	});

	test('点「安装此版本」⇒ download(agent, version, agent) + autoCommit + 两条 info + 刷新两个列表', async () => {
		const fakes = makeFakes({ versions: VERSIONS });
		const { pane, parent } = makePane({ fakes });
		await (pane as { _loadMarketplaceVersions: () => Promise<void> })._loadMarketplaceVersions();
		const historyBefore = fakes.calls.history.length;
		const pkgBefore = fakes.calls.getPackage;

		const installBtn = qa(parent, '.marketplace-version-row button').find(b => b.textContent === '安装此版本')!;
		installBtn.click();
		await tick();
		await tick();

		assert.deepStrictEqual(fakes.calls.download, [[AGENT_ID, '1.2.0', 'agent']], '最新在前的第一行是 1.2.0');
		assert.deepStrictEqual(fakes.calls.autoCommit, [[AGENT_ID, 'install: v1.2.0 from marketplace']]);
		assert.ok(fakes.calls.info.some(m => m.includes('正在安装 v1.2.0')));
		assert.ok(fakes.calls.info.some(m => m.includes('已安装 v1.2.0')));
		assert.ok(fakes.calls.history.length > historyBefore, '安装后刷新本地历史（双轨一致）');
		assert.ok(fakes.calls.getPackage > pkgBefore, '安装后刷新商城列表');
	});

	test('点「下架」⇒ 先确认；取消则不发请求，确认则 deleteVersion + info', async () => {
		const cancelled = makePane({ fakes: makeFakes({ versions: VERSIONS, canUpload: true, confirm: false }) });
		await (cancelled.pane as { _loadMarketplaceVersions: () => Promise<void> })._loadMarketplaceVersions();
		qa(cancelled.parent, '.marketplace-version-row button').find(b => b.textContent === '下架')!.click();
		await tick();
		await tick();
		assert.strictEqual(cancelled.fakes.calls.confirm.length, 1, '先弹确认');
		assert.ok(cancelled.fakes.calls.confirm[0].message.includes('确定下架 v1.2.0 吗？'));
		assert.ok((cancelled.fakes.calls.confirm[0].detail ?? '').includes('最新版本'), 'latest 的解释文案');
		assert.deepStrictEqual(cancelled.fakes.calls.deleteVersion, [], '取消 ⇒ 不发请求');

		const confirmed = makePane({ fakes: makeFakes({ versions: VERSIONS, canUpload: true, confirm: true }) });
		await (confirmed.pane as { _loadMarketplaceVersions: () => Promise<void> })._loadMarketplaceVersions();
		qa(confirmed.parent, '.marketplace-version-row button').find(b => b.textContent === '下架')!.click();
		await tick();
		await tick();
		assert.deepStrictEqual(confirmed.fakes.calls.deleteVersion, [[AGENT_ID, '1.2.0']]);
		assert.ok(confirmed.fakes.calls.info.some(m => m.includes('v1.2.0 已下架')));
	});
});

suite('版本区块 · _formatVersionTime 的边界', () => {

	test('非法输入 ⇒ 固定 "Invalid Date"（跨时区/ICU 稳定）', () => {
		// 2026-10-12 外提后，格式化是 `AgentVersionsSection` 的私有方法（真源已搬）⇒ 从新家取。
		const section = AgentVersionsSection.prototype as unknown as { _formatVersionTime: (s: string) => string };
		assert.strictEqual(section._formatVersionTime('not-a-date'), 'Invalid Date');
	});

	test('合法本地时间 ⇒ 含月/日与时分，且不是原样 ISO', () => {
		const section = AgentVersionsSection.prototype as unknown as { _formatVersionTime: (s: string) => string };
		const iso = '2026-10-12T08:30:00';   // 不带时区 ⇒ 按本地解析，跨时区稳定
		const out = section._formatVersionTime(iso);
		assert.notStrictEqual(out, iso);
		assert.ok(out.includes('10') && out.includes('12') && out.includes(':'), `格式异常：${out}`);
	});
});
