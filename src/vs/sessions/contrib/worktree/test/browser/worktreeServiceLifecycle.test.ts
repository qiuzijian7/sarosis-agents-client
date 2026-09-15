/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * worktree 生命周期不变量 —— **源码级**断言（2026-09-15）。
 *
 * ## 为什么是源码级
 *
 * `WorktreeService` 的每个方法都要真的跑 git，单测成本高；而这些缺陷的共同特征是
 * 「**顺序/条件写错了**」，不是"某行算错了"：
 *
 *   · 删分支时**猜**分支名（硬编码 `opencode/<name>`，而实际建的是 `worktree/<name>`）
 *     ⇒ 分支从来没被删掉，只增不减；
 *   · 删除流程**不幂等** ⇒ 重复删除报错；
 *   · 删 worktree 时**无条件** `branch -D` ⇒ 未推送的提交被静默销毁；
 *   · 创建失败**不回滚** ⇒ 留下半成品 worktree + 孤立分支；
 *   · 清理"残留目录"前不校验 ⇒ 路径其实是真实仓库根时**删掉用户的仓库**。
 *
 * 这类问题用「读源码断言顺序与条件」来守，手法与 `workspaceFolderWriters.test.ts` /
 * `guardrailWiring.test.ts` 一致。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/worktree/test/browser/worktreeServiceLifecycle.test.ts
 */

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { Extensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { ConfigurationModel } from '../../../../../platform/configuration/common/configurationModels.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
// 副作用导入：触发 sessions 默认值注册 —— 本套件要查**真实注册表**，不是扫源码。
import '../../../configuration/browser/configuration.contribution.js';
// 副作用导入：触发 worktree 的**设置 schema 注册**（`sessions.worktree.pushBranchOnCreate`）。
import '../../browser/worktree.contribution.js';
import { DEFAULT_WORKTREE_BASE_BRANCH, DEFAULT_WORKTREE_PUSH_BRANCH_ON_CREATE, resolveWorktreeBaseBranchMode, WORKTREE_BASE_BRANCH_SETTING, WORKTREE_PUSH_BRANCH_ON_CREATE_SETTING } from '../../common/worktreeTypes.js';

const SERVICE = 'src/vs/sessions/contrib/worktree/browser/worktreeService.ts';
const IFACE = 'src/vs/sessions/contrib/worktree/common/worktreeService.ts';

/**
 * 剥掉注释 —— 否则注释里提到的名字会误判（本仓既有做法）。
 *
 * ⚠ 块注释**必须**要求注释起始符出现在行首（含缩进），不能用「起始符 + 任意字符 + 结束符」
 * 的裸全局正则：本文件里有 refspec 字符串
 * `'+refs/heads/*:refs/remotes/origin/*'`，其中的斜杠加星号会被裸正则当成注释开头，
 * 一路吞到下一个注释结束符 —— 实测吞掉 **3766 字符**，正好把 `removeWorktree` 整个方法
 * 吃掉，断言随即报「找不到方法定义」（症状离根因极远，很难猜）。
 */
function stripComments(source: string): string {
	return source
		.replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
		.replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function read(rel: string): string {
	return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

/**
 * 取某个方法体（从签名到**下一个同级成员**为止），用于局部断言。
 *
 * ⚠ 不能只按固定长度切：那会吃到下一个方法，导致"本方法里不得出现 X"的断言
 * 被**下一个方法**里的 X 误判为失败（本轮实测踩到过）。
 * 判据：下一行以「一个制表符 + 标识符 + (」开头 —— 类成员缩进恰好是 1 个 tab，
 * 方法体内至少 2 个，故不会误切。
 */
function methodBody(src: string, signature: string, span = 6000): string {
	const idx = src.indexOf(signature);
	assert.ok(idx > 0, `应能找到 ${signature}`);
	const afterSignature = idx + signature.length;
	const nextMember = src.slice(afterSignature).search(/\n\t(?:private |protected |public )?(?:async )?[A-Za-z_$][\w$]*\s*[(:<]/);
	const end = nextMember >= 0 ? afterSignature + nextMember : Math.min(src.length, idx + span);
	return src.slice(idx, end);
}

suite('WorktreeService 生命周期不变量（2026-09-15）', () => {

	test('★★ 删除不得硬编码分支前缀 —— 必须用 git 报告的真实分支', () => {
		// 原实现写死 `opencode/${worktreeName}`，而 `makeWorktreeInfo` 建的是
		// `worktree/<name>` ⇒ 分支永远删不掉（只增不减），且删错名字还会静默失败。
		const src = stripComments(read(SERVICE));
		const body = methodBody(src, 'async removeWorktree(worktreePath: string, force: boolean = false)');

		assert.ok(
			!body.includes('opencode/'),
			'删除流程不得再出现硬编码的 `opencode/` 分支前缀',
		);
		assert.ok(
			body.includes('branchToDelete'),
			'必须先取出该 worktree 的真实分支名（branchToDelete）再删',
		);
		// 取分支必须在 `worktree remove` 之前 —— 之后 git 就不再报告它了。
		const listAt = body.indexOf('listWorktrees(repoRoot)');
		const removeAt = body.indexOf(`'worktree', 'remove'`);
		assert.ok(listAt > 0 && removeAt > 0, '应同时存在 listWorktrees 与 worktree remove');
		assert.ok(
			listAt < removeAt,
			'取真实分支必须发生在 `git worktree remove` **之前**（之后 git 不再报告该 worktree）',
		);
	});

	test('★★ 删除必须幂等（git 不认识且目录不存在 ⇒ 当作成功）', () => {
		const src = stripComments(read(SERVICE));
		const body = methodBody(src, 'async removeWorktree(worktreePath: string, force: boolean = false)');
		assert.ok(
			body.includes('!entry && !dirExists'),
			'必须有「既不在 git 列表、目录也不存在 ⇒ 直接成功」的早返回（opencode 同做法）',
		);
	});

	test('★★★ 删除前必须挡住主工作树与真实仓库（否则会删掉用户的仓库）', () => {
		// 第 ⑤ 步会清理「残留目录」。若传入路径其实是仓库根，那一步等于删掉仓库。
		// `worktreeBinding.ts:19-29` 记载过 worktreePath 可以等于主仓路径。
		const src = stripComments(read(SERVICE));
		const body = methodBody(src, 'async removeWorktree(worktreePath: string, force: boolean = false)');

		assert.ok(
			body.includes('entry?.isMain'),
			'必须拒绝删除主工作树（isMain）',
		);
		assert.ok(
			body.includes('_looksLikeGitRepo('),
			'git 不认识但目录存在时，必须先确认它**不是** git 仓库再清理',
		);

		// 闸门必须在任何删除动作之前。
		const guardAt = body.indexOf('entry?.isMain');
		const cleanupAt = body.indexOf('fileService.del(dirUri');
		assert.ok(guardAt > 0 && cleanupAt > 0, '应同时存在安全闸门与残留目录清理');
		assert.ok(
			guardAt < cleanupAt,
			'安全闸门必须在残留目录清理**之前**',
		);
	});

	test('★★ 删分支不得销毁未推送的工作（force 才允许）', () => {
		const src = stripComments(read(SERVICE));
		const body = methodBody(src, 'async removeWorktree(worktreePath: string, force: boolean = false)');
		assert.ok(
			body.includes('hasUnpushedCommits('),
			'删分支前必须查未推送提交 —— `git worktree remove` 只删目录，提交留在分支上',
		);
		assert.ok(
			body.includes('!force &&'),
			'非 force 且有未推送提交时必须**保留分支**（force 才删）',
		);
	});

	test('★ hasUnpushedCommits 必须用 --not --remotes，且无 remote 时返回 false', () => {
		// 判据本体在 `_hasUnpushedCommits(cwd, ref)` —— `hasUnpushedCommits` 只是以 HEAD 转发。
		// 抽出 ref 参数是为了让「孤儿分支」也能用同一判据（`_hasUnpushedCommits(repo, branch)`）。
		const src = stripComments(read(SERVICE));
		const publicBody = methodBody(src, 'async hasUnpushedCommits(worktreePath: string)', 400);
		assert.ok(
			publicBody.includes('_hasUnpushedCommits('),
			'hasUnpushedCommits 必须转发到 _hasUnpushedCommits（HEAD）',
		);

		const body = methodBody(src, 'private async _hasUnpushedCommits(cwd: string, ref: string)', 1200);
		assert.ok(
			body.includes(`'--not'`) && body.includes(`'--remotes'`),
			'判据必须是 `git log --oneline <ref> --not --remotes`（hermes-agent-studio 同做法）',
		);
		assert.ok(
			body.includes(`['remote']`),
			'必须显式处理「无 remote」：否则 --not --remotes 不排除任何提交 ⇒ 分支只增不减',
		);
		// 接口也要声明（否则调用方拿不到）。
		assert.ok(
			stripComments(read(IFACE)).includes('hasUnpushedCommits('),
			'IWorktreeService 必须声明 hasUnpushedCommits',
		);
	});

	test('★★ 创建失败必须回滚半成品（worktree + 刚建的分支）', () => {
		const src = stripComments(read(SERVICE));
		const createBody = methodBody(src, 'async createFromInfo(info: IWorktreeInfo)');

		assert.ok(
			createBody.includes('worktreeCreated'),
			'必须记录「worktree add 是否已成功」，只有成功过才需要回滚',
		);
		assert.ok(
			createBody.includes('rollbackCreateFromInfo('),
			'后续步骤失败时必须调用回滚',
		);
		assert.ok(
			createBody.includes('WorktreeStatus.Failed'),
			'回滚后仍要把状态置为 Failed（保留原因给 UI）',
		);

		const rollback = methodBody(src, 'async rollbackCreateFromInfo(repoRoot: string, info: IWorktreeInfo, cause: string)');
		assert.ok(
			rollback.includes(`'worktree', 'remove'`),
			'回滚必须移除已登记的 worktree',
		);
		assert.ok(
			rollback.includes(`'branch', '-D'`),
			'回滚必须删掉本次 `-b` 刚创建的分支（创建失败 ⇒ 分支上不可能有用户工作）',
		);
		assert.ok(
			rollback.includes(`'prune'`),
			'回滚后必须 prune 元数据',
		);
	});
});

const TYPES = 'src/vs/sessions/contrib/worktree/common/worktreeTypes.ts';
const COMMANDS = 'src/vs/sessions/contrib/files/browser/files.contribution.ts';
const SCM = 'src/vs/sessions/contrib/sourceControl/browser/sourceControl.contribution.ts';

suite('WorktreeService lock / cleanup 不变量（2026-09-15）', () => {

	test('★ lock/unlock 必须真的调 git worktree lock/unlock', () => {
		// `locked` 此前只解析不操作：UI 能显示锁定图标、上下文键也声明了，但没有设置入口。
		const src = stripComments(read(SERVICE));
		const lock = methodBody(src, 'async lockWorktree(worktreePath: string, reason?: string)', 900);
		assert.ok(lock.includes(`'worktree', 'lock'`), 'lockWorktree 必须调用 git worktree lock');
		assert.ok(lock.includes(`'--reason'`), '必须支持 --reason（git worktree list 会展示它）');

		const unlock = methodBody(src, 'async unlockWorktree(worktreePath: string)', 600);
		assert.ok(unlock.includes(`'worktree', 'unlock'`), 'unlockWorktree 必须调用 git worktree unlock');

		const iface = stripComments(read(IFACE));
		assert.ok(iface.includes('lockWorktree(') && iface.includes('unlockWorktree('), '接口必须声明二者');
	});

	test('★★★ 清理扫描必须是**只读**的（删不删由用户确认）', () => {
		// 本仓 worktree 是用户长期资产（不像 hermes 那种一次会话一个的一次性目录），
		// 按龄自动删会销毁用户工作 ⇒ 扫描与删除必须分成两步。
		const src = stripComments(read(SERVICE));
		const scan = methodBody(src, 'async listCleanupCandidates(repoPath: string, options?: IWorktreeCleanupOptions)');

		for (const forbidden of [`'worktree', 'remove'`, `'branch', '-D'`, 'removeWorktree(']) {
			assert.ok(
				!scan.includes(forbidden),
				`listCleanupCandidates 不得出现 ${forbidden} —— 它必须是只读扫描`,
			);
		}
		assert.ok(
			scan.includes('_hasUnpushedCommits('),
			'候选必须经过「无未推送提交」过滤 —— 那是会丢的真实工作',
		);
		// 两类候选各过滤一次 ⇒ 至少出现两次。
		assert.ok(
			(scan.match(/_hasUnpushedCommits\(/g) ?? []).length >= 2,
			'陈旧 worktree 与孤儿分支**两类**候选都要过滤未推送提交',
		);
		assert.ok(
			scan.includes('isMain') && scan.includes('isBare') && scan.includes('locked'),
			'陈旧 worktree 候选必须排除主树 / 裸库 / 已锁定',
		);
	});

	test('★ 清理执行必须逐个容错（失败不中断、且如实上报）', () => {
		const src = stripComments(read(SERVICE));
		const body = methodBody(src, 'async cleanupWorktrees(repoPath: string, candidates: readonly IWorktreeCleanupCandidate[])');
		assert.ok(body.includes('try {') && body.includes('catch'), '每条候选必须独立 try/catch —— 一条失败不能中断整批');
		assert.ok(body.includes('failed.push('), '失败必须收集（否则"部分失败"被吞掉）');
		assert.ok(body.includes('removeWorktree(candidate.path, false)'), '删 worktree 必须用 force=false（扫描后状态可能已变）');
	});

	test('★★ Cleanup 命令必须**先列候选、再确认**', () => {
		const src = stripComments(read(COMMANDS));
		const idx = src.indexOf('id: WorktreeCommands.Cleanup');
		assert.ok(idx > 0, '应能找到 Cleanup 命令注册');
		const body = src.slice(idx, idx + 3200);
		const scanAt = body.indexOf('listCleanupCandidates(');
		const confirmAt = body.indexOf('.confirm(');
		const cleanupAt = body.indexOf('cleanupWorktrees(');
		assert.ok(scanAt > 0, '必须先扫描候选');
		assert.ok(confirmAt > 0, '必须弹确认框 —— 不得静默/按龄自动删');
		assert.ok(scanAt < confirmAt && confirmAt < cleanupAt, '顺序必须是 扫描 → 确认 → 执行');
		assert.ok(body.includes('if (!confirmed)'), '用户取消时必须提前 return');
	});

	test('★★★ 菜单判据必须用 viewItem（上下文键未绑定，用它们菜单会失效）', () => {
		// 实测：`WorktreeContextKeys` 里的 WorktreeIsMain/IsDetached/IsLocked/IsPrunable
		// **全仓只声明、从未绑定**（worktreeDataProvider 只绑了 HasWorktrees / WorktreeCount）。
		// 原先 `WT_RESET_WHEN` 用 notEquals(WorktreeIsMain, true) ⇒ 恒真 ⇒ 主树上也显示 Reset
		// （对主 checkout 做 reset --hard + clean 属破坏性误操作）。
		const src = stripComments(read(SCM));
		assert.ok(
			!src.includes('WorktreeContextKeys.'),
			'不得用未绑定的 WorktreeContextKeys 写 when 判据 —— 会导致菜单恒出现或永不出现',
		);
		assert.ok(
			src.includes('wtItemIs(') && src.includes('WorktreeItemType.'),
			'必须用 viewItem（= 树项 contextValue）做精确判据',
		);
		// lock / unlock 互斥：普通分支树才能锁，已锁定树才能解锁。
		assert.ok(src.includes('WT_ITEM_BRANCH') && src.includes('WT_ITEM_LOCKED'), 'lock 与 unlock 必须有互斥判据');
	});

	test('★ 分支前缀必须收敛到常量（曾因漂移导致分支删不掉）', () => {
		// `makeWorktreeInfo` 建 `worktree/<slug>`，而 `removeWorktree` 曾写死 `opencode/<name>`
		// ⇒ 分支只增不减。清理「孤儿分支」也按同一常量扫描，否则会扫错集合。
		const src = stripComments(read(SERVICE));
		assert.ok(src.includes('WORKTREE_BRANCH_PREFIX'), '服务层必须使用 WORKTREE_BRANCH_PREFIX 常量');
		assert.ok(
			!src.includes(`'worktree/'`) && !src.includes('`worktree/'),
			'不得再出现字面量 worktree/ 前缀（必须走常量）',
		);
		assert.ok(
			stripComments(read(TYPES)).includes(`WORKTREE_BRANCH_PREFIX = 'worktree/'`),
			'常量定义必须只有一处',
		);
	});
});

suite('worktree 目录排除不变量 — 不得污染用户 SCM（2026-09-15）', () => {

	test('★★ 创建 worktree 前必须注册 `.worktrees/` 排除', () => {
		// 原实现只在注释里要求用户自己加 `.gitignore` ⇒ 忘加时 worktree（**一整份源码副本**）
		// 会以成千上万条「未跟踪」涌进 SCM，且可能被「全部暂存」提交进仓库。
		const src = stripComments(read(SERVICE));
		const create = methodBody(src, 'async createFromInfo(info: IWorktreeInfo)', 3000);
		assert.ok(
			create.includes('_ensureWorktreeDirIgnored('),
			'createFromInfo 必须调用 _ensureWorktreeDirIgnored（否则排除仍依赖用户手动配置）',
		);
	});

	test('★★★ 必须写 `.git/info/exclude`，**绝不能**写 `.gitignore`', () => {
		// `.gitignore` 是**受版本控制的用户资产** —— 程序改它就是 2026-09-14
		// 「用户手写的 .code-workspace 被回写」那类事故的同一条路。
		// `.git/info/exclude` 才是 git 为「本仓库本地忽略规则」提供的官方位置。
		const src = stripComments(read(SERVICE));
		const helper = methodBody(src, 'private async _ensureWorktreeDirIgnored(repoRoot: string)', 2200);
		assert.ok(
			helper.includes(`'.git', 'info', 'exclude'`),
			'必须写 .git/info/exclude（本地、不进版本控制）',
		);
		assert.ok(
			!helper.includes(`'.gitignore'`) && !helper.includes(`".gitignore"`),
			'绝不能在 helper 里触碰 .gitignore —— 那是受版本控制的用户资产',
		);
	});

	test('★★ 必须用 `git check-ignore` 做幂等闸门（已被 .gitignore 忽略时不重复追加）', () => {
		const src = stripComments(read(SERVICE));
		const helper = methodBody(src, 'private async _ensureWorktreeDirIgnored(repoRoot: string)', 2200);
		const checkAt = helper.indexOf(`'check-ignore'`);
		const writeAt = helper.indexOf('writeFile(');
		assert.ok(checkAt > 0, '必须先用 git check-ignore 询问是否已被忽略');
		assert.ok(
			checkAt < writeAt,
			'check-ignore 必须在 writeFile **之前** —— 否则每次创建 worktree 都会往 exclude 里追加一遍',
		);
	});

	test('★ 注册失败必须只 warn（不能阻断 worktree 创建）', () => {
		const src = stripComments(read(SERVICE));
		const helper = methodBody(src, 'private async _ensureWorktreeDirIgnored(repoRoot: string)', 2200);
		assert.ok(helper.includes('logService.warn('), '失败必须只 warn');
		assert.ok(!helper.includes('throw '), '排除是便利措施，绝不能因它抛错阻断创建');
	});

	test('★ `.git/info/exclude` 不存在时不得凭空创建（.git 可能是文件）', () => {
		// repoRoot 本身是个 worktree / submodule 时 `.git` 是**文件**，
		// `.git/info/exclude` 不存在 ⇒ 应跳过，而不是 createFolder 造出目录结构。
		const src = stripComments(read(SERVICE));
		const helper = methodBody(src, 'private async _ensureWorktreeDirIgnored(repoRoot: string)', 2200);
		assert.ok(helper.includes('exists(excludeUri)'), '必须先判断 exclude 文件是否存在');
		assert.ok(
			!helper.includes('createFolder('),
			'不得 createFolder —— 宁可不做，也别在陌生布局里凭空造文件',
		);
	});
});

suite('原生 watcher 排除 `.worktrees` / `node_modules`（2026-09-15）', () => {

	/** 从真实注册表取出 sessions 默认值里注册的 `files.watcherExclude`。 */
	function sessionsWatcherExclude(): Record<string, boolean> {
		const registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
		const registered = registry.getRegisteredDefaultConfigurations()
			.filter(d => d.source === 'sessionsDefaults');
		assert.ok(registered.length > 0, '应能找到 source=sessionsDefaults 的默认值注册');

		const merged: Record<string, boolean> = {};
		for (const d of registered) {
			const value = d.overrides['files.watcherExclude'];
			if (value && typeof value === 'object') {
				Object.assign(merged, value);
			}
		}
		return merged;
	}

	test('★★★ sessions 默认值必须把 `.worktrees/**` 与 `node_modules/**` 排除出原生 watcher', () => {
		// worktree 建在仓库内（`<repoRoot>/.worktrees/<name>`）= **一整份源码副本**；
		// 而 VS Code 的默认 `files.watcherExclude` 只含 `.git/objects/**` 那几个
		// ⇒ 递归 watcher 会盯着「当前源码 + 每个 worktree 副本 + node_modules」。
		// （`workspaceView.ts` 的注释声称「原生默认也跳过这些」—— 那是**错的**，故此处补上。）
		const excludes = sessionsWatcherExclude();
		assert.strictEqual(excludes['**/.worktrees/**'], true, '必须排除 .worktrees（仓库内的 worktree 副本）');
		assert.strictEqual(excludes['**/node_modules/**'], true, '必须排除 node_modules');
	});

	test('★★★ defaults override 对对象型设置是**深合并**（不得丢掉上游的 .git 排除）', () => {
		// 本仓依赖这个语义：上面只列**新增**项，上游的 `.git/objects/**` 等必须保留。
		// 若哪天配置模型改成「整对象替换」，watcher 就会重新去盯 .git/objects —— 这里当场失败。
		const base = new ConfigurationModel(
			{ files: { watcherExclude: { '.git/objects/**': true } } },
			[], [], undefined, new NullLogService(),
		);
		const override = new ConfigurationModel(
			{ files: { watcherExclude: { '**/.worktrees/**': true } } },
			[], [], undefined, new NullLogService(),
		);

		const excludes = (base.merge(override).contents as {
			files: { watcherExclude: Record<string, boolean> };
		}).files.watcherExclude;

		assert.strictEqual(excludes['.git/objects/**'], true, '上游默认必须被保留（深合并语义）');
		assert.strictEqual(excludes['**/.worktrees/**'], true, '新增排除必须生效');
	});

	test('★ 排除的目录名必须与 `WorktreeService` 实际使用的基目录一致（防漂移）', () => {
		// 若有人把 worktree 基目录改名/改位置，这条会失败 —— 提醒同步更新 watcher 排除。
		const src = stripComments(read(SERVICE));
		const makeInfo = methodBody(src, 'async makeWorktreeInfo(options?: IWorktreeInfoOptions)', 3000);
		assert.ok(
			makeInfo.includes('.worktrees'),
			'WorktreeService 的基目录仍是 .worktrees ⇒ 与 watcherExclude 的 **/.worktrees/** 对应',
		);
		assert.strictEqual(
			sessionsWatcherExclude()['**/.worktrees/**'], true,
			'两处必须一致，否则改了一边就会漏',
		);
	});
});

suite('worktree checkpoint 不变量 — 必须是**真快照**（2026-09-15 修复）', () => {

	const CHECKPOINT = 'src/vs/sessions/contrib/worktree/browser/worktreeCheckpointServiceImpl.ts';
	const APP = 'src/vs/code/electron-main/app.ts';

	test('★★★ 快照必须走「隔离索引 + add -A + write-tree + commit-tree」，不能只记 HEAD', () => {
		// 旧实现只有 `rev-parse HEAD` + `update-ref` ⇒ agent 不 commit 时 HEAD 不动
		// ⇒ 所有 checkpoint 指向同一 commit，且回滚 `reset --hard` 等于**销毁**未提交工作。
		const src = stripComments(read(CHECKPOINT));
		const capture = methodBody(src, 'private async _captureWorkingTreeAsCommit(');
		assert.ok(capture.includes(`'add', '-A'`), '必须 stage 工作树全部内容（含未跟踪文件 —— agent 产出的主要形态）');
		assert.ok(capture.includes(`'write-tree'`), '必须 write-tree 生成 tree 对象');
		assert.ok(capture.includes(`'commit-tree'`), '必须 commit-tree 建**悬挂 commit**（不动 HEAD / 分支）');
		assert.ok(capture.includes(`'update-ref'`), '必须 update-ref 让 checkpoint ref 指向它');

		for (const method of ['async createBaselineCheckpoint(', 'async createPostTurnCheckpoint(']) {
			const body = methodBody(src, method);
			assert.ok(
				!body.includes(`'rev-parse', 'HEAD'`),
				`${method} 不得再「只记 HEAD」—— 那是"回滚即销毁"的根因`,
			);
			assert.ok(body.includes('_captureWorkingTreeAsCommit('), `${method} 必须走真快照`);
		}
	});

	test('★★★ 临时索引必须在**工作树之外**（放仓库内会被 add -A 自己快照进去）', () => {
		// 实测教训：第一版把索引放在仓库根 ⇒ `ls-tree` 里出现 `.tmp-ckpt.index.lock`，
		// 且 `git status` 多出一条未跟踪项。
		const src = stripComments(read(CHECKPOINT));
		const capture = methodBody(src, 'private async _captureWorkingTreeAsCommit(');
		assert.ok(capture.includes('GIT_INDEX_FILE'), '必须用 GIT_INDEX_FILE 走隔离索引');
		assert.ok(
			capture.includes(`'--absolute-git-dir'`),
			'必须用 --absolute-git-dir 定位 git 目录：linked worktree 下 `.git` 是**文件**，硬拼路径会错',
		);
		assert.ok(
			!capture.includes('tmpDir'),
			'不得把索引放在工作树内 —— 实测会被 add -A 快照进去并污染 git status',
		);
	});

	test('★★★ 回滚必须用 `restore`，**不得**用 `reset --hard`', () => {
		// `reset --hard` 会：① 把 HEAD/分支指到 checkpoint commit（污染 agent 分支）；
		// ② 不还原快照里的未跟踪文件。
		const src = stripComments(read(CHECKPOINT));
		const rollback = methodBody(src, 'async rollbackToCheckpoint(');
		assert.ok(rollback.includes(`'restore'`), '必须用 git restore --source=<ref>');
		assert.ok(
			!rollback.includes(`'reset', '--hard'`),
			'不得用 reset --hard —— 会移动 HEAD/分支且不还原未跟踪文件',
		);
		assert.ok(
			rollback.includes(`'--worktree'`) && rollback.includes(`'--staged'`),
			'必须同时还原工作树与暂存区',
		);
	});

	test('★ 临时索引必须在 finally 里清理（系统临时目录/`.git` 内都不能泄漏）', () => {
		const src = stripComments(read(CHECKPOINT));
		const capture = methodBody(src, 'private async _captureWorkingTreeAsCommit(');
		assert.ok(capture.includes('finally'), '必须有 finally 清理临时索引');
		assert.ok(capture.includes('fileService.del('), 'finally 里必须真的删掉索引文件');
	});

	test('★ git IPC 必须白名单放行 `GIT_INDEX_FILE` 且允许覆盖超时', () => {
		// 必要性：① 隔离索引必须能把 GIT_INDEX_FILE 传到 git（renderer→main 通道原本不支持 env）；
		// ② `add -A` 用全新索引需逐文件算 hash，大仓会超默认 30s —— 超时过短会把**本会成功**的
		//    操作杀掉（`git worktree add` 在大仓同理，上游给的是 180s）。
		const app = stripComments(read(APP));
		const idx = app.indexOf(`'vscode:execGit'`);
		assert.ok(idx > 0, '应能找到 vscode:execGit handler');
		// 白名单常量声明在 handler **之前** ⇒ 窗口必须往前取。
		const body = app.slice(Math.max(0, idx - 2500), idx + 2000);
		assert.ok(body.includes('GIT_ENV_WHITELIST'), 'env 必须走**白名单**（避免变成"设置任意环境变量"的通用能力）');
		assert.ok(body.includes(`'GIT_INDEX_FILE'`), '白名单必须包含 GIT_INDEX_FILE');
		assert.ok(body.includes('effectiveTimeoutMs'), '超时必须可被调用方覆盖');
		assert.ok(body.includes('600_000') && body.includes('1_000'), '超时必须钳制在合理区间');
	});
});

suite('破坏性 worktree 操作必须「先确认」+ checkpoint 必须可达（2026-09-15）', () => {

	const COMMANDS = 'src/vs/sessions/contrib/files/browser/files.contribution.ts';
	const CONTRIB = 'src/vs/sessions/contrib/worktree/browser/worktree.contribution.ts';
	const SCM = 'src/vs/sessions/contrib/sourceControl/browser/sourceControl.contribution.ts';

	test('★★★ `Reset Worktree` 必须弹确认（`resetWorktree` 会 reset --hard + clean -ffdx）', () => {
		// `resetWorktree()` = fetch + reset --hard <默认分支> + **clean -ffdx** + submodule reset
		// ⇒ 丢弃全部未提交改动 + **删除所有未跟踪文件**（实测会删掉 node_modules junction；
		// 同时带走 .env 与 Agent 未提交产出）。原实现零确认直接执行。
		const src = stripComments(read(COMMANDS));
		const idx = src.indexOf('id: WorktreeCommands.Reset');
		assert.ok(idx > 0, '应能找到 Reset 命令注册');
		const body = src.slice(idx, idx + 2600);
		const confirmAt = body.indexOf('.confirm(');
		const resetAt = body.indexOf('resetWorktree(');
		assert.ok(confirmAt > 0, 'Reset 必须先弹确认框');
		assert.ok(confirmAt < resetAt, 'confirm() 必须在 resetWorktree() **之前**');
		assert.ok(body.includes('if (!confirmed)'), '用户取消时必须提前 return');
		assert.ok(body.includes('clean -ffdx'), '确认文案必须说明会跑 `clean -ffdx`（删未跟踪文件）');
	});

	test('★★★ checkpoint 回滚必须可达（先列 → 再确认 → 再回滚）', () => {
		// 此前 `rollbackToCheckpoint()` **没有任何可达调用点**（唯一调用者在从未注册的命令文件里）
		// ⇒ checkpoint "只进不出"：快照写进去，用户无法回滚。
		const src = stripComments(read(COMMANDS));
		const idx = src.indexOf('id: WorktreeCommands.RollbackCheckpoint');
		assert.ok(idx > 0, '应能找到 RollbackCheckpoint 命令注册');
		const body = src.slice(idx, idx + 3200);
		const listAt = body.indexOf('listCheckpointsForWorktree(');
		const confirmAt = body.indexOf('.confirm(');
		const rollbackAt = body.indexOf('rollbackToCheckpoint(');
		assert.ok(listAt > 0, '必须先按 worktree 反查还原点（视图不知道 sessionId）');
		assert.ok(listAt < confirmAt && confirmAt < rollbackAt, '顺序必须是 列出 → 确认 → 回滚');
		assert.ok(body.includes('if (!confirmed)'), '用户取消时必须提前 return');
		assert.ok(body.includes('length === 0'), '没有还原点时必须给提示而不是静默失败');
	});

	test('★★ checkpoint 命令必须真的被注册（否则那 4 条命令仍是死代码）', () => {
		// `registerWorktreeCheckpointContributions()` 全仓曾**只有定义、无调用点**。
		const src = stripComments(read(CONTRIB));
		assert.ok(
			src.includes('registerWorktreeCheckpointContributions();'),
			'worktree.contribution.ts 必须调用它 —— 否则 4 条 checkpoint 命令从未注册',
		);
	});

	test('★ 回滚菜单项必须挂上（有入口才叫可达）', () => {
		const src = stripComments(read(SCM));
		assert.ok(
			src.includes('WorktreeCommands.RollbackCheckpoint'),
			'Worktree 视图必须挂回滚菜单项 —— 与已有的「Create Checkpoint」按钮成对',
		);
	});
});

suite('创建 worktree 的远端副作用 + 就绪语义（2026-09-15）', () => {

	test('★★★ 推分支必须受设置门控，且默认**不推送**', () => {
		// 原实现无条件 `git push -u origin <branch>` —— 远端可见副作用（团队看到一堆
		// worktree/* 分支、可能触发 CI），而上游 agentHost **从不 push**。
		const src = stripComments(read(SERVICE));
		const create = methodBody(src, 'async createFromInfo(info: IWorktreeInfo)', 4000);
		assert.ok(
			create.includes('_shouldPushBranchOnCreate()'),
			'push 必须被 _shouldPushBranchOnCreate() 门控',
		);
		assert.ok(
			create.indexOf('_shouldPushBranchOnCreate()') < create.indexOf(`'push', '-u', 'origin'`),
			'门控判断必须在实际 push 之前',
		);

		// 判定必须是 `=== true`（设置未注册/读取失败时 getValue 返回 undefined ⇒ 按"不推送"处理）
		const gate = methodBody(src, 'private _shouldPushBranchOnCreate()', 900);
		assert.ok(gate.includes('=== true'), '必须用 `=== true` 判定：读取失败时宁可不推送');
		assert.ok(gate.includes('DEFAULT_WORKTREE_PUSH_BRANCH_ON_CREATE'), '兜底必须走常量默认值');
	});

	test('★★ 设置必须真的注册进配置表，且默认 false（查真实注册表）', () => {
		const registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
		const props = registry.getConfigurationProperties();
		const entry = props[WORKTREE_PUSH_BRANCH_ON_CREATE_SETTING];
		assert.ok(
			entry,
			`sessions.worktree.pushBranchOnCreate 必须注册 schema（否则设置 UI 看不到、无补全）`,
		);
		assert.strictEqual(entry.type, 'boolean', '类型必须是 boolean');
		assert.strictEqual(entry.default, false, '默认必须是 false（远端副作用 opt-in）');
		assert.strictEqual(DEFAULT_WORKTREE_PUSH_BRANCH_ON_CREATE, false, '常量默认值也必须是 false');
	});

	test('★★★ `bootWorktree` 必须在置 Ready **之前**做项目准备（否则是"虚假就绪"）', () => {
		// 原实现只跑 `git status --porcelain` 就置 Ready，而 node_modules junction 等准备
		// 埋在「点调试」的路径里 ⇒ 不点调试就永远没准备，调用方却以为可用。
		const src = stripComments(read(SERVICE));
		const boot = methodBody(src, 'private async bootWorktree(info: IWorktreeInfo)', 2200);
		const prepAt = boot.indexOf('_prepareWorktree(');
		const readyAt = boot.indexOf('WorktreeStatus.Ready');
		assert.ok(prepAt > 0, 'bootWorktree 必须调用 _prepareWorktree');
		assert.ok(
			prepAt < readyAt,
			'准备必须在 setWorktreeState(Ready) **之前** —— 否则 Ready 依然名不副实',
		);

		const prep = methodBody(src, 'private async _prepareWorktree(worktreePath: string)', 1200);
		assert.ok(prep.includes('resolveDebugPlan('), '必须复用调试策略的 prep 路径（同一套项目探测）');
		assert.ok(prep.includes('logService.warn('), '准备失败必须只 warn');
		assert.ok(!prep.includes('throw '), '准备失败绝不能把 worktree 判为 Failed（git 层面已可用）');
	});
});

suite('worktree 分支起点与跟踪（2026-09-15）', () => {

	test('★★★ `worktree add` 建新分支时必须传 `--no-track`', () => {
		// 不传的话，仓库若把 `branch.autoSetupMerge` 设为 always，新分支会自动跟踪起点 ⇒
		// `git status` 对一个**从未推送过**的分支显示"落后/领先 origin/…"，极具误导性。
		// 上游 agentHost 同样显式传 `--no-track`。
		const src = stripComments(read(SERVICE));
		const create = methodBody(src, 'async createFromInfo(info: IWorktreeInfo)', 4000);
		assert.ok(create.includes(`'--no-track'`), '建新分支必须传 --no-track');
		const noTrackAt = create.indexOf(`'--no-track'`);
		const bAt = create.indexOf(`'-b'`);
		assert.ok(noTrackAt > 0 && bAt > 0 && noTrackAt < bAt, '--no-track 必须在 -b 之前（同一条 add 命令）');
	});

	test('★★ 起点必须可配置，且**默认保留 git 原行为**（current HEAD）', () => {
		const src = stripComments(read(SERVICE));
		const create = methodBody(src, 'async createFromInfo(info: IWorktreeInfo)', 4000);
		assert.ok(create.includes('_resolveStartPoint('), '起点必须由 _resolveStartPoint 解析');

		const resolve = methodBody(src, 'private async _resolveStartPoint(repoRoot: string)', 2000);
		assert.ok(
			resolve.includes(`!== 'default'`),
			'非 default 模式必须返回 undefined（= 让 git 用当前 HEAD）—— 不得改变既有行为',
		);
		assert.ok(resolve.includes('origin/${base}'), 'default 模式必须优先用远端基线 origin/<默认分支>');
		assert.ok(resolve.includes('logService.warn('), '起点解析失败必须只 warn（回落 git 默认）');
		// ★ 远端与本地兜底**都必须先探测**：`worktree add <不存在的 ref>` 会
		// `fatal: invalid reference` **整体失败**（实测 exit 128）⇒ 起点配置不能把创建搞挂。
		assert.ok(
			(resolve.match(/'--verify', '--quiet'/g) ?? []).length >= 2,
			'远端 ref 与本地兜底 ref 都必须先 show-ref 探测（否则起点不存在会让创建整体失败）',
		);
	});

	test('★★ 设置必须注册进配置表，默认 `current`（查真实注册表）', () => {
		const registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
		const entry = registry.getConfigurationProperties()[WORKTREE_BASE_BRANCH_SETTING];
		assert.ok(entry, 'sessions.worktree.baseBranchOnCreate 必须注册 schema');
		assert.strictEqual(entry.type, 'string', '类型必须是 string');
		assert.strictEqual(entry.default, 'current', '默认必须是 current（保留既有行为）');
		assert.deepStrictEqual(entry.enum, ['current', 'default'], '枚举必须只有两个合法值');
	});

	test('★ 纯函数：未知/缺失值一律回落默认（不抛错）', () => {
		assert.strictEqual(resolveWorktreeBaseBranchMode('default'), 'default');
		assert.strictEqual(resolveWorktreeBaseBranchMode('current'), 'current');
		assert.strictEqual(resolveWorktreeBaseBranchMode(undefined), DEFAULT_WORKTREE_BASE_BRANCH);
		assert.strictEqual(resolveWorktreeBaseBranchMode('DEFAULT'), DEFAULT_WORKTREE_BASE_BRANCH);
		assert.strictEqual(resolveWorktreeBaseBranchMode({}), DEFAULT_WORKTREE_BASE_BRANCH);
		assert.strictEqual(DEFAULT_WORKTREE_BASE_BRANCH, 'current');
	});
});
