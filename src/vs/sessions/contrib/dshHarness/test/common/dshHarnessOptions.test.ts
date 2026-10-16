/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { IDshHostStartOptions, sameStartOptions, shouldRestartForWorkspaceChange } from '../../common/dshHarness.js';

suite('dshHarness / startup options equality', () => {

	const base: IDshHostStartOptions = {
		runtimePath: 'G:\\rt\\dsh\\lib\\bin.js',
		nodePath: 'D:\\node\\node.exe',
		dshHome: 'C:\\u\\dsh-home',
		profile: 'vssaros',
		workspaceId: 'ws-1',
		mcpConfigPath: 'C:\\u\\mcp.json',
		skillDirs: ['G:\\skills', 'C:\\u\\skills'],
		// 内置那条**单列**（走 bundledSkillDir ⇒ rank 600，见 `common/dshSkillDirs.ts` ✓）
		bundledSkillDir: 'G:\\rt\\resources\\.agents\\skills',
		keepAlive: true,
	};

	test('identical options (absent vs empty treated the same)', () => {
		assert.ok(sameStartOptions(base, { ...base }));
		assert.ok(sameStartOptions({}, {}));
		assert.ok(sameStartOptions({ profile: '' }, {}));
	});

	test('material differences are detected (would need a restart)', () => {
		assert.ok(!sameStartOptions(base, { ...base, runtimePath: 'other' }));
		assert.ok(!sameStartOptions(base, { ...base, nodePath: undefined }));
		assert.ok(!sameStartOptions(base, { ...base, dshHome: undefined }));
		assert.ok(!sameStartOptions(base, { ...base, profile: 'other' }));
		assert.ok(!sameStartOptions(base, { ...base, workspaceId: undefined }));
		// ★ 换一个**非空**的工作区 id 也算实质不同——这是"看板卡片会写到旧工作区"那条边界的判断依据：
		// Host 在跑时 `start()` 会原样复用（不重启，见 supervisor 里的日志），所以这里必须把它算作"不同"，
		// 否则重启决策（以及那条日志）就永远不触发。
		assert.ok(!sameStartOptions(base, { ...base, workspaceId: 'ws-2' }), '工作区换了就必须重启才生效');
		// 同理：工作区**根**换了也必须重启才生效——代码图谱的 `config.workspaceRoot` 只在启动时注入
		// （README 4.83）；不算作"实质不同"的话，换工作区后图谱会一直看着旧目录。
		assert.ok(!sameStartOptions(base, { ...base, workspaceRoot: '/ws/other' }), '工作区根换了就必须重启才生效');
		assert.ok(!sameStartOptions(base, { ...base, mcpConfigPath: undefined }));
		assert.ok(!sameStartOptions(base, { ...base, keepAlive: false }));
	});

	test('skill dirs compare by order and content', () => {
		assert.ok(!sameStartOptions(base, { ...base, skillDirs: ['C:\\u\\skills', 'G:\\skills'] }));
		assert.ok(!sameStartOptions(base, { ...base, skillDirs: ['G:\\skills'] }));
		assert.ok(!sameStartOptions(base, { ...base, skillDirs: undefined }));
	});

	test('★ 内置技能目录（bundledSkillDir）同样参与比较', () => {
		// 为什么必须比：它决定覆盖层里 `bundledSkillDir` 那一行的内容（rank 600）。dev 是仓库根、
		// 打包版是 `resources/` ⇒ 两者切换时不重启就会让 Host 继续扫**另一个**内置目录 ✗（静默少技能）。
		assert.ok(!sameStartOptions(base, { ...base, bundledSkillDir: 'G:\\other\\resources\\.agents\\skills' }));
		assert.ok(!sameStartOptions(base, { ...base, bundledSkillDir: undefined }),
			'去掉内置（或它解析失败）也算实质不同 —— 那时覆盖层里就没有 bundled 那一行了 ✓');
		// 反向：**换了别的字段、内置没动**时不能因为这一项而误判为"没变" ✓（防止写成常量比较 ✗）
		assert.ok(sameStartOptions(base, { ...base }));
	});

	test('★ 喂给覆盖层的"设置 → config"字段必须参与比较（2026-10-14 补的那三条）', () => {
		// 为什么必须比（同 `agentsRoot` / `dataRoot` 那条的理由）：这四项决定覆盖层里对应那几行**写什么**。
		// 漏比的现场很具体：主进程抢先预热那份来自 `last-start.json`（**旧值**）→ 渲染进程随后带**新值**
		// → `sameStartOptions` 判成"相同" ⇒ **复用**一个带旧覆盖层的 Host ⇒ 用户改了设置**不生效**，
		// 而且日志里连一句都没有 ✗（`agentsRoot` 曾经就是这么漏的 ✓）。
		// 1）kbRoot：改了知识库存储根 ⇒ 不重启的话资料库/画布会一直读旧根 ✗
		assert.ok(!sameStartOptions(base, { ...base, kbRoot: '/custom/kb' }), 'kbRoot 变了必须重启才生效');
		// 2）unrealBridgeUrl：改了 bridge 地址 ⇒ 不重启 host 仍连旧的 8765 ✗
		assert.ok(!sameStartOptions(base, { ...base, unrealBridgeUrl: 'http://127.0.0.1:9999' }), 'unreal bridge 地址变了必须重启才生效');
		// 3）browser 三键 —— **`false` 是有意义的值**：用户关掉「自动拉起调试实例」就是要把专属实例关掉，
		//    漏比或按真值判断 ⇒ 照样复用一个"还会拉起空 profile"的 Host ✗（本项存在的唯一理由就是它）
		assert.ok(!sameStartOptions(base, { ...base, browser: { launchDedicated: false } }), '关掉专属实例必须算实质不同');
		assert.ok(!sameStartOptions({ ...base, browser: { launchDedicated: false } }, { ...base, browser: { launchDedicated: true } }),
			'false 与 true 是两种配置（不能按真值判断 —— 那会把两者当同一件事 ✗）');
		assert.ok(!sameStartOptions({ ...base, browser: { port: 9222 } }, { ...base, browser: { port: 9333 } }), '端口变了也要重启');
		assert.ok(!sameStartOptions({ ...base, browser: { headless: true } }, { ...base, browser: {} }),
			'去掉某个键（如 headless）同样算不同 —— 覆盖层里那一行会少一个键 ✓');
		// 反向：三项完全一致（含两个 false）⇒ 仍是"相同"（防止把比较写成常量/恒不等 ✗）
		assert.ok(sameStartOptions({ ...base, browser: { port: 9333, launchDedicated: false, headless: false } },
			{ ...base, browser: { port: 9333, launchDedicated: false, headless: false } }));
		assert.ok(!sameStartOptions({ ...base, browser: { launchDedicated: false } }, { ...base, browser: { launchDedicated: false, headless: true } }),
			'多出一个键也是不同（覆盖层内容变了 ✓）');
	});
});

suite('dshHarness / restart on workspace switch', () => {

	// 这条判定的背景（README 4.70/4.71）：Host 的选项是启动时快照，看板的 `config.workspaceId` 不重启
	// 就不更新 ⇒ 卡片会**静默写进旧工作区**。但重启会杀掉在跑的会话 ⇒ 只在**空闲**时重启。
	const decide = (over: Partial<Parameters<typeof shouldRestartForWorkspaceChange>[0]>) =>
		shouldRestartForWorkspaceChange({ previousWorkspaceId: 'ws-1', nextWorkspaceId: 'ws-2', running: true, blockingSessionCount: 0, ...over });

	test('换了工作区、Host 在跑且空闲 ⇒ 重启（让新 workspaceId 生效）', () => {
		assert.ok(decide({}));
	});

	test('★ 有会话在跑 ⇒ 不重启（不打断人家的活；由 supervisor 那行日志说明为什么不生效）', () => {
		assert.ok(!decide({ blockingSessionCount: 1 }));
		assert.ok(!decide({ blockingSessionCount: 3 }));
	});

	test('★ 取不到活动状态 ⇒ 保守不重启（宁可选项晚一步，也不误杀在跑的会话）', () => {
		assert.ok(!decide({ blockingSessionCount: undefined }));
	});

	test('没换（同一个 id）⇒ 不重启——工作区改名之类的通知走的就是这条路', () => {
		assert.ok(!decide({ nextWorkspaceId: 'ws-1' }));
	});

	test('Host 没在跑 ⇒ 不重启（下次 Start 自然带上新值）', () => {
		assert.ok(!decide({ running: false }));
	});

	test('第一次观测（还不知道 Host 里那份是什么）⇒ 不打扰', () => {
		assert.ok(!decide({ previousWorkspaceId: undefined }));
		// 反过来：已经观测过、这次变成"没有活动工作区"（用户取消了选择）⇒ 空闲就重启，
		// 把插件里那份旧 id **清掉**（它宁可 fail-closed，也不要继续往旧工作区写）
		assert.ok(decide({ nextWorkspaceId: undefined }));
	});
});

/**
 * ★ 启动竞态（2026-10-15 现场，启动太慢的根因之一）：聊天框挂载可能**抢在**活动工作区恢复之前。
 *
 * 现场：窗口恢复了 3 个聊天标签 ⇒ 聊天框随布局挂载即发 `ensureStarted()`，而 `_activeWorkspaceId`
 * 由 `workspaceFolderSync` 的启动段**异步**恢复 ⇒ 那次 Start 的 `workspaceId`/`relatedRoots` 是空的，
 * 与上次落盘的预热选项不同 ⇒ 主进程判"选项变了"⇒ **把已经跑了 35s 的预热 Host 杀掉重起**（覆盖层对比
 * 取证：预热 spawn 有 `kanban-<hash>.yml`（workspaceId 有值）、渲染进程那次没有）⇒ 双份冷启动 +
 * 双份插件判定/安装 ≈ 83s 才 ready，三个聊天页全程停在"正在启动 DeepSeek Harness…"。
 *
 * 修法：renderer 两条真正启动 Host 的路径（`ensureStarted`/`restart`）在内存游标为空时按**启动恢复
 * 同一套解析**（`resolveDefaultActiveWorkspaceId()`）兜底 ⇒ 与上次落盘的预热选项一致 ⇒ 复用预热 ✓。
 */
suite('dshHarness / 启动竞态：聊天框抢在活动工作区恢复之前', () => {

	const REL = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts';
	const src = (() => {
		const abs = path.join(process.cwd(), REL);
		assert.ok(fs.existsSync(abs), `读不到 ${REL}（cwd=${process.cwd()}）—— 守卫不能空跑`);
		const text = fs.readFileSync(abs, 'utf8');
		assert.ok(text.length > 0, `${REL} 是空文件（守卫不能空跑）`);
		return text;
	})();

	/** 取一个类成员的正文：签名 → 下一个 `\n\tprivate |async |readonly `（防"方法变长后守卫静默截断"）。 */
	function fnBody(signature: string, fallbackLen = 1200): string {
		const at = src.indexOf(signature);
		assert.ok(at > 0, `找不到 \`${signature}\`（改名/挪走就要同步改这条守卫 ✗）`);
		const next = src.slice(at + signature.length).search(/\n\t(?:private |async |readonly |\/\*\*)/);
		return src.slice(at, next > 0 ? at + signature.length + next : at + fallbackLen);
	}

	test('★ ensureStarted / restart 必须先解析工作区 id（不能直接用可能为空的内存游标）', () => {
		for (const sig of ['async ensureStarted(', 'async restart(']) {
			const body = fnBody(sig);
			assert.ok(body.includes('_startWorkspaceId('),
				`${sig} 必须经 _startWorkspaceId() 兜底（裸用 getActiveWorkspaceId() ⇒ 启动竞态下 undefined ⇒ 杀预热重起 ✗）`);
			assert.ok(body.includes('_relatedRoots(workspaceId)') && body.includes('_startOptions('),
				`${sig} 必须把同一个解析值同时传给 _relatedRoots 与 _startOptions（各传各的 ⇒ workspaceId 与 relatedRoots 不一致 ✗）`);
		}
	});

	test('★ 兜底解析必须与启动恢复同源（resolveDefaultActiveWorkspaceId）', () => {
		const body = fnBody('private async _startWorkspaceId(');
		assert.ok(body.includes('getActiveWorkspaceId()'), '内存里有就先用内存的（已恢复 ⇒ 零等待 ✓）');
		assert.ok(body.includes('resolveDefaultActiveWorkspaceId('),
			'内存没有时必须按 workspaceFolderSync 启动段的同一套解析兜底 ⇒ 与预热落盘的值一致 ⇒ 复用预热 ✓');
	});

	test('★ _startOptions / _relatedRoots 必须接受外部解析值', () => {
		assert.ok(src.includes('_startOptions(relatedRoots?: readonly string[], workspaceId?: string)'),
			'_startOptions 要接受外部 workspaceId（只在内部读同步游标 ⇒ 竞态窗口里还是空 ✗）');
		assert.ok(src.includes('workspaceId: workspaceId ?? this._studio.getActiveWorkspaceId()'),
			'workspaceId 优先用外部解析值');
		assert.ok(src.includes('_relatedRoots(workspaceId?: string)'),
			'_relatedRoots 同样要接受外部 id（否则 relatedRoots 还是会空 ⇒ 照样判成"选项变了" ✗）');
	});
});
