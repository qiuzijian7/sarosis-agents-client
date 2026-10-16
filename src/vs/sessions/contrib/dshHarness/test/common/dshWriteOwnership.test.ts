/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 写者归属的**守卫**（README 5.60）：把"谁是 `~/.vssaros/` 的写者"从**文档约定**变成**可断言的事实**。
 *
 * 为什么需要它（2026-10-11 摸底结论，证据行见 README 5.60）：
 *   · `owns` 目前是**纯声明** —— schema 里有（`common/vssarosPluginManifest.ts:117-118`）、解析也只做句法
 *     约束（`:301`），全仓**零消费点**：没有运行时校验、也没有守卫测试 ⇒ "唯一写者"只活在文档里 ✗；
 *   · 唯一声明 `owns` 的是 kanban（`taskboard.json` / `boards.json`），而它同时是**唯一两侧实写**的样本：
 *     IDE 侧 `agentTaskBoardService` 写同一批文件、**不参与** dsh 那把锁（kanban `store.js` 自己如实写着）；
 *   · 其余目录分**两类**（2026-10-12 逐条查过读写两侧 ⇒ README 5.118）：
 *     - `knowledge-base/` / `workflows/` / `agents/` / `skills/` / `mcp.json`：**IDE 写、dsh 真读** ✓
 *       —— ⚠ 2026-10-15 起 `knowledge-base/` 的 `库/raw/` **dsh 也写**（`@vssaros/dsh-web-content-import` 的
 *       `content_import` 把 URL 内容落成素材）：**故意不声明 `owns`**（它写自己的 `<slug>.md`，与 IDE 侧
 *       "导入链接"按钮写的是**不同文件**，两侧都写是刻意的 ✓；锁是它自己那把 `库/raw/.content-import.lock` ✓）；
 *     - `context-storage/` / `.agentmemory/`：**IDE 写、dsh 既不读也不写** ✗
 *       （`.agentmemory/` 是**网关**的数据目录，dsh 侧走网关端口 ✓，不碰这个目录 ✓）。
 *   · ⚠ **`dashboard/` 这一格 2026-10-13 变了**（「dashboard → 可编排首页」P2）：该目录里
 *     IDE 写它自己的账本 / 成本落盘 ✓，而 **dsh 自 2026-10-13 起写其中的 `layout.json`**
 *     （首页编排，`<数据根>/dashboard/layout.json` ✓）—— 此前这里写的是"dsh 既不读也不写" ✗，
 *     那句话随这次改动**变成假的** ⇒ 必须改（守卫的注释自己说谎，比没有守卫更糟 ✗）。
 *     ★ **故意不声明 `vssaros.owns`**：那个字段的语义是"**两侧都写**的文件、非 owner 侧停写"
 *     （`resolveWriteOwnership` 在插件未启用时把 writer 翻成 `ide` 并写"仍由旧模块写"）—— 对
 *     `layout.json` 那句话是**假的**（IDE 根本没有"首页编排"这件事 ✗）。先例：memory 的
 *     `<数据根>/memory-audit/` 也是 dsh-only 且同样不声明 ✓。
 *     并发纪律不因此放松：新写者照样**必须取锁 + 原子写**（`lib/layoutStore.js` 拷 kanban 的协议 v2 ✓）——
 *     该文件同时登记在 `check-host-config.mjs` 里当第 8 份 `dataRootOf` ✓。
 *     ⚠ 这里原先一律写成"**dsh 只读**" ✗ —— 那句话把**读**与**写**两件事混在一起 ✓，而"只读"既可能被读成
 *     "dsh 在读"（对后一类是**假的** ✗），也只是**写归属**口径 ✓。本文件钉的始终是**写** ✓（"谁写、要不要取锁" ✓），
 *     所以把读的那半边写清楚，免得守卫说着一件事、读者理解成另一件 ✗。
 *
 * 所以这条守卫钉三件事：① `owns` 声明只能全局唯一，且**新增声明必须显式改这里**（逼一次"非 owner 侧
 * 停写"的决策，而不是在"两个写者、无共享锁"的现状上继续叠加 ✓）；② `kb` 的 `store.js` 只许
 * `writeFile` 写**可再生构建缓存**（2026-10-13 起 ✓，缓存丢了重建即可、不是用户数据 ✓）；而 kb 的
 * **笔记写面**已在 `lib/organize.js`（`kb_organize` / `kb_write_note` / 页面写路由都走它 ✓）—— 那套用例
 * 与 `workflow` 同款：**写可以，但调用方必须取 vault 锁**（README 5.62 ✓）；③ **两侧共用一把锁**这件事
 * 本身要被钉住（看板：kanban 自带锁 + IDE 侧写咽喉 ✓，README 5.65 ✓）—— 同时**不许**留过时的"IDE 不
 * 参与这把锁" ✗，也**不许**把"`owns` 开关仍未实现"这条如实说明抹掉 ✓。
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import { findWriteOwnershipConflicts, resolveWriteOwnership } from '../../common/dshPluginActivation.js';
import { tryParseVssarosManifest } from '../../common/vssarosPluginManifest.js';

/** 从 cwd 往上找仓库根（同时有 `dsh-plugins/` 与 `src/` 的那层）；找不到就如实跳过（裸 CI / 异构 cwd）。 */
function repoRoot(): string | undefined {
	let dir = path.resolve(process.cwd());
	for (let depth = 0; depth < 6; depth += 1) {
		if (fs.existsSync(path.join(dir, 'dsh-plugins')) && fs.existsSync(path.join(dir, 'src'))) {
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) { break; }
		dir = parent;
	}
	return undefined;
}

/** 读某插件 `package.json` 的 `vssaros.owns`（没有/形态不对 ⇒ 空数组）。 */
function ownsOf(pluginsDir: string, dirName: string): readonly string[] {
	const file = path.join(pluginsDir, dirName, 'package.json');
	if (!fs.existsSync(file)) { return []; }
	const json = JSON.parse(fs.readFileSync(file, 'utf8')) as { vssaros?: { owns?: unknown } };
	const raw = json.vssaros?.owns;
	return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string') : [];
}

/** 写 API 名（**只在 import 行上**判定，见第二个用例的用意）。 */
const WRITE_API = /(?:^|[^\w.])(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rm|rmSync|rename|renameSync|unlink|unlinkSync|createWriteStream|copyFile|copyFileSync|cpSync|truncate)\b/;

suite('dshHarness / write ownership boundary', () => {

	test('★ `owns` 声明全局唯一；新增声明必须在这里同步（逼一次"非 owner 侧停写"的决策）', function () {
		const root = repoRoot();
		if (!root) { this.skip(); }
		const pluginsDir = path.join(root!, 'dsh-plugins');
		const declarers = fs.readdirSync(pluginsDir)
			.filter(name => fs.existsSync(path.join(pluginsDir, name, 'package.json')))
			.map(name => ({ name, owns: ownsOf(pluginsDir, name) }))
			.filter(entry => entry.owns.length > 0);

		const owner = new Map<string, string>();
		for (const { name, owns } of declarers) {
			for (const target of owns) {
				assert.ok(!owner.has(target),
					`${target} 被 ${owner.get(target)} 与 ${name} **同时**声明 owns ⇒ 那就是两个写者 ✗`);
				owner.set(target, name);
			}
		}
		assert.deepStrictEqual(
			declarers.map(entry => `${entry.name}:${entry.owns.join('+')}`).sort(),
			['vssaros-kanban:taskboard.json+boards.json'],
			'owns 声明集合变了：新增/移除声明之前，请先确认非 owner 侧**已经停写**（README 5.60 的写者归属表），再改这条期望值');
		assert.strictEqual(owner.get('taskboard.json'), 'vssaros-kanban');
		assert.strictEqual(owner.get('boards.json'), 'vssaros-kanban');
	});

	test('★ 只读边界：kb 的 store.js 不许 import 写 API；workflow 已成写者 ⇒ 必须**全程带锁**', function () {
		const root = repoRoot();
		if (!root) { this.skip(); }
		// ⚠ 只看 **import 行**：模块里合法的临时目录用法（kb 的 `mkdtemp`/`rm` 都在 `tmpdir()` 下）
		// 不在本用例的判定面内 —— 这里要挡的是"**开了一条通往数据根的写通道**" ✓。

		// ① kb：store.js 只写**可再生**构建缓存（`writeFile` 限定在 cacheFile ✓，下面已钉 ✓）；
		//   ⚠ 而 kb 的**笔记写面**（`lib/organize.js` ＋ 页面写路由 ✓）不在 store.js 里 ⇒ 这条边界只钉 store.js ✓，
		//   那半边的纪律钉在 ①-b（`lib/index.js` 的写路径必须取 vault 锁 ✓）。
		// ⚠ 2026-10-13 起 kb 会写一份**可再生**的构建缓存（`registerBuildCacheEntries` → `writeFile(cacheFile)`，
		//   `cacheFile = <vault>/BUILD_CACHE_FILE`；构建预览 P1 用）：缓存丢了重建即可、**不是用户数据**，且作者在
		//   store.js 里如实记了"只增不删、读不动就整份重写 ⇒ 可能丢更新"的残余风险。⇒ 这条边界对 kb 放宽成
		//   "**只放行 `writeFile` 这一个写 API（且只落在构建缓存上）**"；其余写 API（appendFile/rm/rename/unlink/…）
		//   仍一律不许 —— 它们才意味着开了条通往数据根的**通用**写通道 ✗。
		const kbStore = path.join(root!, 'dsh-plugins', 'vssaros-kb', 'lib', 'store.js');
		assert.ok(fs.existsSync(kbStore), 'vssaros-kb/lib/store.js 不见了（写者归属表要跟着改）');
		const kbText = fs.readFileSync(kbStore, 'utf8');
		for (const line of kbText.split('\n').filter(line => /^\s*import\s/.test(line))) {
			const hit = WRITE_API.exec(line);
			assert.ok(!hit || hit[1] === 'writeFile',
				`vssaros-kb/lib/store.js 的 import 里出现了写 API \`${hit?.[1]}\` ⇒ 超出"只写可再生构建缓存"的边界 ✗`
				+ '（kb 只许用 writeFile 写构建缓存；要开更宽的写通道必须取锁 + 原子写，见 README 5.60/5.62）');
		}
		// 且 `writeFile` 只能落在构建缓存文件上（`cacheFile` 由 `BUILD_CACHE_FILE` 派生），不许落到别的路径。
		assert.ok(!/writeFile\(\s*(?!cacheFile)/.test(kbText.replace(/writeFile\(\s*cacheFile/g, '')),
			'vssaros-kb 的 writeFile 只能写构建缓存（cacheFile = BUILD_CACHE_FILE）⇒ 出现了写别处的写点 ✗');
		assert.ok(/只读/.test(kbText), 'vssaros-kb/lib/store.js 丢了"只读"标记（那是这块的对外契约）');

		// ①-b kb 的**笔记写面**（2026-10-13 起 ✓）：`lib/organize.js` ＋ 页面写路由 —— 那套与 workflow 同款：
		//   "**写可以，但必须带锁**" ✓（否则又回到"两个写者、无共享锁" ✗）。钉法：凡有写路径 ⇒ 必须取 vault 锁 ✓。
		const kbIndex = fs.readFileSync(path.join(root!, 'dsh-plugins', 'vssaros-kb', 'lib', 'index.js'), 'utf8');
		assert.ok(/from '\.\/lock\.js'/.test(kbIndex),
			'vssaros-kb/lib/index.js 有写路径（kb_organize/页面写路由）却不 import 锁模块 ⇒ 又回到"两个写者、无共享锁" ✗');
		assert.ok(/acquireFileLock/.test(kbIndex),
			'vssaros-kb 的写路径必须**取锁** ✗（原子写只保证"不半截"，不保证"不丢更新" ✓）');

		// ② workflow：**2026-10-11 起它不再是只读模块** ✓（README 5.62 把线性步骤层的写搬了过来）
		// ⇒ 这条边界从"不许写"改成"**写可以，但必须带锁**" ✓ —— 否则又回到"两个写者、无共享锁"，
		// 而那正是 5.60 点名要避免的状态 ✗（本用例第一版就是"不许写"，这一站它按设计亮了红灯 ✓）。
		const wfText = fs.readFileSync(path.join(root!, 'dsh-plugins', 'vssaros-workflow', 'lib', 'store.js'), 'utf8');
		assert.ok(/from '\.\/lock\.js'/.test(wfText),
			'vssaros-workflow/lib/store.js 有写路径却不 import 锁模块 ⇒ 又回到"两个写者、无共享锁" ✗（README 5.62）');
		assert.ok(/acquireFileLock/.test(wfText) && /atomicWriteFile/.test(wfText),
			'vssaros-workflow 的写路径必须**取锁 + 原子写**，缺一不可 ✗（原子写只保证"不半截"，不保证"不丢更新" ✓）');
	});

	test('★ 归属表由**真实清单**派生（不是手抄）＋ 两条分支与冲突判定', function () {
		const root = repoRoot();
		if (!root) { this.skip(); }
		const pluginsDir = path.join(root!, 'dsh-plugins');
		const plugins = fs.readdirSync(pluginsDir)
			.filter(name => fs.existsSync(path.join(pluginsDir, name, 'package.json')))
			.map(name => {
				const json = JSON.parse(fs.readFileSync(path.join(pluginsDir, name, 'package.json'), 'utf8')) as { name?: unknown; vssaros?: unknown };
				// ⚠ 必须带 `{ builtin: true }`：不带时解析器按**第三方插件**规则卡（order 200–899 / 容器 id 不许
				// `vssaros.*`）⇒ 仓库自家的 agents / codebase / dashboard 会**整条被拒** ✗（2026-10-11 实测，
				// 表现为"归属表莫名是空的"✓）。与 `dshPluginPackages.test.ts:140` 同款 ✓。
				const parsed = json.vssaros === undefined ? undefined : tryParseVssarosManifest(json.vssaros, { builtin: true });
				const manifest = parsed && 'manifest' in parsed ? parsed.manifest : undefined;
				return typeof json.name === 'string'
					? {
						name: json.name,
						owns: manifest?.owns,
						legacyCounterpart: manifest?.legacyCounterpart,
						parseError: parsed && 'error' in parsed ? parsed.error : undefined,
					}
					: undefined;
			})
			// ⚠ 谓词必须写成「参数类型去掉 undefined」（`NonNullable<typeof entry>`）：map 里的对象是**显式
			// `| undefined` 的必填属性**，而"属性可选"（`owns?:`）的形状对不上它 ⇒ TS2677，且 filter 不收窄
			// 会让下游 138/143/146 一起崩 ✗（2026-10-11 watch-client 实测）。
			.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
		assert.ok(plugins.length >= 10, `dsh-plugins 下应有 10+ 个包，实际 ${plugins.length}`);

		// ① 启用态：只有 kanban 声明 owns ⇒ 表里正好这两条，且都指向它 ✓
		const whenEnabled = resolveWriteOwnership(plugins, () => true);
		assert.deepStrictEqual(
			whenEnabled.map(entry => `${entry.path}@${entry.writer}<-${entry.owner}`),
			['boards.json@dsh<-@vssaros/dsh-kanban', 'taskboard.json@dsh<-@vssaros/dsh-kanban'],
			`归属表变了：新增/移除 \`owns\` 声明前请先确认非 owner 侧已停写（README 5.60/5.64）；实际=${JSON.stringify(whenEnabled)}`
			+ `；清单解析错误=${JSON.stringify(plugins.filter(entry => entry.parseError).map(entry => `${entry.name}: ${entry.parseError}`).slice(0, 3))}`);
		assert.deepStrictEqual(findWriteOwnershipConflicts(whenEnabled), []);
		// ② 未启用分支：writer 翻成 ide，理由里必须说清"仍由旧模块写" ✓
		const whenDisabled = resolveWriteOwnership(plugins, () => false);
		assert.ok(whenDisabled.length === whenEnabled.length
			&& whenDisabled.every(entry => entry.writer === 'ide' && /仍由旧模块写/.test(entry.reason)),
			JSON.stringify(whenDisabled));
		// ③ `legacyCounterpart` 要原样带出来（"旧模块"的名字来源就是这个字段 ✓）
		assert.ok(whenEnabled.every(entry => /^agentStudio\./.test(entry.legacyCounterpart ?? '')),
			JSON.stringify(whenEnabled.map(entry => entry.legacyCounterpart)));
		// ④ 冲突判定：同一路径被两个声明者认领必须**报出来**（绝不"取第一个" ✗）
		const conflicts = findWriteOwnershipConflicts(resolveWriteOwnership([
			{ name: '@vssaros/dsh-a', owns: ['x.json'] },
			{ name: '@vssaros/dsh-b', owns: ['x.json'] },
		], () => true));
		assert.strictEqual(conflicts.length, 1, JSON.stringify(conflicts));
	});

	test('★ IDE 侧 workflow 的三个写点都在锁里（接线不许被回退）', function () {
		const root = repoRoot();
		if (!root) { this.skip(); }
		const service = fs.readFileSync(
			path.join(root!, 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'browser', 'workflowStorageService.ts'), 'utf8');
		assert.ok(/from '\.\.\/common\/fileWriteLock\.js'/.test(service),
			'workflowStorageService 没有 import 锁模块 ⇒ 接线被回退了 ✗（README 5.63）');
		assert.ok((service.match(/acquireFileLock\(/g) ?? []).length >= 2,
			'workflowStorageService 里应至少 2 处直接取锁（sessions.json + workflow.json 的公共辅助）✗');
		assert.ok((service.match(/_writeWorkflowJsonLocked\(/g) ?? []).length >= 3,
			'`_writeWorkflowJsonLocked` 应至少出现 3 次（定义 + create + save）⇒ 少了的写点又回到"无锁覆盖" ✗（README 5.63）');
		assert.ok(!/this\._fileService\.writeFile\(\s*uri, VSBuffer\.fromString\(JSON\.stringify\((workflow|updated), null, 2\)\)\)/.test(service),
			'`workflow.json` 的写点又直接调 writeFile 了（绕过锁 + 原子写）✗');
	});

	test('★ 看板两侧共锁：kanban 的 store.js 与 IDE 的写点都在同一把锁里', function () {
		const root = repoRoot();
		if (!root) { this.skip(); }
		// ① dsh 侧：kanban 自带锁，且注释必须如实说明"现在两侧都进锁了"（README 5.65）
		const kanbanStore = fs.readFileSync(path.join(root!, 'dsh-plugins', 'vssaros-kanban', 'lib', 'store.js'), 'utf8');
		assert.ok(/两侧都进锁了/.test(kanbanStore),
			'kanban store.js 应如实写明"两侧都进锁了"（README 5.65）；若被改回"IDE 不参与这把锁"，说明边界又退回去了 ✗');
		assert.ok(/不参与这把锁/.test(kanbanStore) === false,
			'"IDE 不参与这把锁"这句已经过时（5.65 已接上 IDE 侧）⇒ 不许留着当现状 ✗');
		assert.ok(/owns/.test(kanbanStore), 'kanban store.js 应仍说明 owns 与这把锁的关系（`owns` 开关仍未实现 ✓）');

		// ② IDE 侧：`agentTaskBoardService` 的写咽喉必须取同一把锁（`<file>.lock`，同协议 ✓）
		const service = fs.readFileSync(
			path.join(root!, 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'browser', 'agentTaskBoardService.ts'), 'utf8');
		assert.ok(/from '\.\.\/common\/fileWriteLock\.js'/.test(service),
			'agentTaskBoardService 没有 import 锁模块 ⇒ 看板又回到"两个写者、无共享锁" ✗（README 5.65）');
		assert.ok(/acquireFileLock\(lockResourceFor\(uri\)/.test(service),
			'`_atomicWriteFile`（taskboard.json / boards.json 的**唯一咽喉**）必须取锁 ✗');
		assert.ok(/finally \{\s*await release\(\);\s*\}/.test(service),
			'锁必须在 `finally` 里释放（否则一次异常就永久卡住另一个写者 ✗）');
	});
});
