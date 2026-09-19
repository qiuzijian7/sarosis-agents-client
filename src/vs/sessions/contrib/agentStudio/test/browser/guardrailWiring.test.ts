/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 护栏「接线」不变量 —— **源码级**断言（2026-09-13）。
 *
 * ## 为什么需要源码级断言，而不是再写一个单测
 *
 * 2026-09-13 一天内修了 11 处，其中 **6 处属于同一类**：
 * **判据本身正确，但只挂在了部分路径上** ——
 *   · 混淆 / 裸源码护栏只挂 `execute_code` → 同一句命令走 `terminal` 就绕过；
 *   · 写敏感路径硬拒只挂 `file_write` → `patch` 点一次「允许」就能写；
 *   · 脱敏只挂部分读路径 → `patch` 的回显成了绕过 `file_read` 的读文件通道；
 *   · MCP 工具不经过沙箱 → 整层安全体系（沙箱 + 黑名单 + checkpoint）对它失效。
 *
 * 这类缺陷**单元测试测不出来**：被测的纯函数完全正确，错的是「谁调用了它」。
 * 于是这里直接扫源码，把「接线」钉成不变量 —— 任何一条路径被漏掉、被删掉、
 * 或退回手抄实现，本文件当场失败。
 *
 * 手法与 `agentMediaEditorInput.test.ts`（扫贡献点源码）和
 * `messageProtocolConsistency.test.ts`（防协议漂移）一致。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/browser/guardrailWiring.test.ts
 */

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/** 所有路径都相对它（与其它扫源码的测试保持一致）。 */
const AGENT_STUDIO = 'src/vs/sessions/contrib/agentStudio';

/**
 * 去掉注释 —— 源码级不变量必须只看**代码**。
 *
 * 为什么必要（2026-09-13 实测）：本文件的断言第一版就被自己的注释骗了 ——
 * 一句「这里曾经用 `ConfigurationTarget.WORKSPACE`」的说明让**负向**断言失败；
 * 同理，注释里提到某个护栏函数也会让**正向**断言「通过」。两者都让不变量失真。
 *
 * 实现刻意简单（不求完美）：先剥块注释，再剥行注释。行注释那条带一个前导字符守卫，
 * 避免把 `https://…` 这类字符串里的 `//` 当成注释起点。
 */
function stripComments(src: string): string {
	// 只剥**整行**的 `//` 注释。
	//
	// 为什么不剥块注释（实测教训，2026-09-13）：`/\/\*[\s\S]*?\*\//` 会被源码里
	// **非注释**的 `/*` 序列带偏（字符串/正则字面量里的 `/*`，或块注释里提前出现的 `*/`），
	// 实测把 `toolExecutionGuard.ts` 从 39896 字符砍到 **21315** —— 代码被整段吃掉，
	// 正向断言随之失败。行注释规则不跨行，没有这个风险。
	//
	// 已知残留（**两个方向**都要知道）：
	//   · **正向**断言：块注释里提到某个标识符，会让断言「看起来」通过；
	//   · **负向**断言（「不得出现 X」）：块注释里**提到 X 本身**会让断言**假失败**
	//     —— 2026-09-15 实测：`sidebarPart.ts` 一段 `/** … */` 的说明写了「不重载窗口」，
	//     导致「不得出现『重载窗口』文案」这条断言挂掉（代码里其实已经没有该文案）。
	// 前者比后者更常见，而两者都比「误吃代码导致断言乱报」可接受得多，故共用实现保持不变。
	//
	// ★ 需要**负向**断言时：在**该套件内**用更严的局部版本（先剥块注释再剥行注释），
	// 不要改这个共用函数 —— 例如 `workspaceFolderWriters.test.ts` 里的 `stripAllComments`。
	// 局部版本的风险（可能吃代码）由该套件的断言自己承担，影响面被限制在套件内。
	return src.replace(/^[ \t]*\/\/.*$/gm, '');
}

function readSource(rel: string): string {
	const abs = path.join(process.cwd(), AGENT_STUDIO, rel);
	assert.ok(fs.existsSync(abs), `源码文件不存在（路径基准变了？）：${abs}`);
	return stripComments(fs.readFileSync(abs, 'utf8'));
}

/**
 * 更严的剥离：先剥块注释再剥行注释 —— **仅**用于负向断言（「不得出现 X」）。
 *
 * 共用的 `stripComments` 刻意只剥整行 `//`（见其「已知残留」），而源码的块注释说明里
 * 常常**正引用了旧写法** —— 本套件 ⑯ 就被自己写的「旧实现首行是 if (!node.filePath ||
 * !node.startLine)」骗过一次（负向断言假失败）。局部版本「可能吃代码」的风险由本套件自担。
 */
function stripAllComments(rel: string): string {
	const abs = path.join(process.cwd(), AGENT_STUDIO, rel);
	return fs.readFileSync(abs, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** 断言某文件里出现了某个调用 —— 即「这条路径确实接了该护栏」。 */
function assertWired(rel: string, needle: string, what: string): void {
	const src = readSource(rel);
	assert.ok(
		src.includes(needle),
		`[${what}] ${rel} 里应出现 \`${needle}\` —— 该路径可能漏接护栏（今天 6 处缺陷都是这个形态）`,
	);
}

suite('护栏接线不变量（源码级）', () => {

	// ── 元测试：确保断言本身不是「永远通过」的摆设 ──────────────────────
	test('★ 元测试：assertWired 对不存在的调用必须失败', () => {
		assert.throws(
			() => assertWired('browser/toolExecutionGuard.ts', 'THIS_IDENTIFIER_DOES_NOT_EXIST(', 'meta'),
			'断言本身写错会让整套不变量形同虚设',
		);
	});

	test('★ 元测试：整行 `//` 注释不算数（否则一句说明就能让断言通过/失败）', () => {
		// 取一段**只出现在整行 `//` 注释里**的文本，断言它在剥离后消失；
		// 同时断言代码本身没被误剥。
		const raw = readSource('browser/toolExecutionGuard.ts');
		assert.ok(!raw.includes('终端命令无 path 参数'), '整行 // 注释应已被剥离');
		// ⚠ 锚点必须是**仍在该文件里**的代码：`isProtectedPath` 已于 2026-09-13 搬到
		// `common/protectedPaths.ts` —— 元测试当时正是靠这条断言发现「锚点失效」的。
		assert.ok(raw.includes('function entryMatches('), '代码本身不得被误剥');
	});

	// ── ① 两个 shell 工具都必须走共享执行前护栏 ─────────────────────────
	test('★★ 两个 shell 工具都接 `shellPreflightRejection`（防「只给一条路径加护栏」）', () => {
		assertWired('browser/providers/tool/coreTools.ts', 'shellPreflightRejection(', 'terminal');
		assertWired('browser/providers/tool/compatibilityTools.ts', 'shellPreflightRejection(', 'execute_code');
	});

	// ── ② 两条写路径都必须过敏感路径硬拒 ────────────────────────────────
	test('★★ `file_write` 与 `patch` 都接 `sensitiveWriteRejection`（写凭据恒拦）', () => {
		assertWired('browser/providers/tool/coreTools.ts', 'sensitiveWriteRejection(', 'file_write');
		assertWired('browser/providers/tool/compatibilityTools.ts', 'sensitiveWriteRejection(', 'patch');
	});

	// ── ③ 读守卫与它的配置开关 ──────────────────────────────────────────
	test('★★ `file_read` 接读守卫，且配置开关真的被消费', () => {
		assertWired('browser/providers/tool/coreTools.ts', 'detectSensitivePath(', 'file_read 读守卫');
		// 该配置此前「已注册但从未被任何代码消费」，接线后才有意义
		assertWired('browser/providers/tool/coreTools.ts', 'SensitiveReadGuard', '读守卫配置接线');
	});

	// ── ④ 统一脱敏出口 + 各主动脱敏点 ───────────────────────────────────
	test('★★ 脱敏：统一出口 + `patch` 回显 + 命令输出管道都在位', () => {
		assertWired('browser/toolCallUtils.ts', 'redactSecrets(', '统一脱敏出口（所有工具结果）');
		assertWired('common/patchMatcher.ts', 'redactSecrets(', 'patch 回显（成功 + Closest match）');
		assertWired('browser/providers/tool/execOutputPipeline.ts', 'redactSecrets', '命令输出管道');
	});

	// ── ⑤ 搜索排除表必须由真源派生，且不得退回手抄 ──────────────────────
	test('★★ grep 排除表由 `sensitiveExcludeGlobs()` 派生', () => {
		assertWired('browser/providers/tool/searchHelpers.ts', 'sensitiveExcludeGlobs()', '搜索排除表派生');
	});

	test('★★ 反向：搜索层不得再手抄敏感文件名（必须走派生）', () => {
		const src = readSource('browser/providers/tool/searchHelpers.ts');
		for (const name of ['.npmrc', '.pypirc', '.git-credentials', '.env']) {
			const literal = `'**/${name}'`;
			assert.ok(
				!src.includes(literal),
				`searchHelpers.ts 里不应再出现手抄的 ${literal} —— 该表曾落后于 sensitivePaths 真源`
				+ `（file_read 拒绝读 .npmrc，search_code 却返回其内容），请改用 sensitiveExcludeGlobs()`,
			);
		}
	});

	// ── ⑥ 只读档位（plan/ask）的硬权限必须挂在所有执行路径 ──────────────
	test('★★ 硬权限挂在「工具列表 + 本地执行 + bridge 展开」三处', () => {
		assertWired('browser/agentToolAssembly.ts', 'applyHardPermission(', '工具列表过滤（模型看不到被禁工具）');
		// ⚠ 2026-09-19：锚点从 `isToolCallDeniedByHardPermission(` 改为
		// `isToolCallDeniedByTurnPolicy(` —— p0-1 重构把硬权限与范式策略合并为一个
		// 组合函数（common/toolPermission.ts:171 内部首行即调
		// `isToolCallDeniedByHardPermission`，硬权限护栏未被绕过）。
		// 「本地执行路径」这一断言意图不变：执行前必须过权限判定。
		assertWired('browser/agentTurnExecutor.ts', 'isToolCallDeniedByTurnPolicy(', '本地执行路径');
		// 上一条只证明 executor 调了组合函数；这里补一道**不可绕过**的守卫：
		// 组合函数体内必须真正调用硬权限判定，否则「合并」会变成「悄悄移除」。
		assertWired('common/toolPermission.ts', 'isToolCallDeniedByHardPermission(toolName, policy)', '组合函数内的硬权限真源');
		assertWired('browser/agentOSService.ts', 'isToolHardDenied(', 'bridge 工具展开路径');
	});

	// ── ⑦ MCP 工具的两道处置都在位 ──────────────────────────────────────
	test('★★ MCP 工具：不自动放行 + 审批卡片提示「不经沙箱」', () => {
		assertWired('common/toolApprovalPolicy.ts', 'MCP_TOOL_CATEGORY_PREFIX', 'MCP 写工具不自动放行');
		// ⚠ 2026-09-13：锚点从 `MCP_TOOL_CATEGORY_PREFIX` 改为 `isMcpSourcedTool` ——
		// 审批卡片那处内联的 `startsWith(MCP_TOOL_CATEGORY_PREFIX)` 已改用**单一真源**
		// （`isMcpSourcedTool`，三处消费同一函数）。元测试当场失败并暴露了锚点失效 ✓
		// —— 这正是它存在的意义：**锚点会随重构失效，而普通断言不会告诉你**。
		assertWired('browser/toolExecutionGuard.ts', 'isMcpSourcedTool(', 'MCP 审批卡片提示');
	});

	// ── ⑧ 源码写入护栏的「单一判定入口」不得被拆成两份 ──────────────────
	test('★★ 产物豁免走单一入口 `isAllowedArtifactTarget`（防两条路径放行面漂移）', () => {
		const src = readSource('browser/providers/tool/executeCodeGuards.ts');
		assert.ok(src.includes('function isAllowedArtifactTarget('), '应有单一判定入口');
		// 字面量路径与变量绑定两条路径都必须调用它（各 ≥1 次）
		const calls = src.match(/isAllowedArtifactTarget\(/g) ?? [];
		assert.ok(
			calls.length >= 3,
			`isAllowedArtifactTarget 至少应被调用 3 次（定义 1 + 两条路径各 1），实际 ${calls.length} 次`,
		);
	});

	// ── ⑩ 本项目配置的落点：`.vssaros`，不是 `.vscode` ────────────────────
	test('★★ 工具授权表写在 `.vssaros`，不得再写 `.vscode`（项目约定 + 防自授权）', () => {
		// 项目约定（用户 2026-09-13 明确）：本项目配置一律放 `.vssaros/`，不写 `.vscode/`。
		// 安全动机：`.vscode/settings.json` 在**工作区内、模型可写** —— 旧实现把授权表写在那里，
		// 于是「被约束者可以改写约束」（给自己加 terminal/file_write 授权、关掉读守卫）。
		assertWired('browser/agentOSService.ts', 'SarosPath.toolAllow', '授权表落点应为 .vssaros');
		const src = readSource('browser/agentOSService.ts');
		// 判据用「是否 **import** ConfigurationTarget」而不是「是否出现该字符串」——
		// 后者会被**块注释**里对该标识符的说明骗到（行注释已剥，块注释不剥，见 stripComments）。
		// 未 import 就不可能在代码里使用它，这是最精确且不受注释影响的代理判据。
		assert.ok(
			!/import\s*\{[^}]*\bConfigurationTarget\b[^}]*\}/.test(src),
			'agentOSService 不得再 import ConfigurationTarget —— 它在本文件的唯一用途是把本项目配置'
			+ '写进 <workspace>/.vscode/settings.json（工作区内、模型可写 ⇒ 被约束者可改写约束）；'
			+ '本项目数据一律放 ~/.vssaros/（见 sarosPaths 模块注释）',
		);
	});

	// ── ⑪ shell 命令里的路径也必须参与受保护判定 ────────────────────────
	test('★★ shell 命令里的路径必须参与受保护判定（否则「始终允许 terminal」可写 .git/hooks）', () => {
		// 判据真源在 `common/protectedPaths.commandTouchesProtectedPath`（纯函数、可单测）。
		// 这里只钉「接线」：`isProtected` 必须同时看**参数路径**与**命令路径** ——
		// 少了后半句，`echo x > .git/hooks/pre-commit` 在用户「始终允许 terminal」后
		// 就被静默放行（下次 commit 执行任意代码）。
		assertWired('browser/toolExecutionGuard.ts', 'commandTouchesProtectedPath(', 'shell 命令路径判定');
		assertWired('common/protectedPaths.ts', 'export function commandTouchesProtectedPath(', '判据真源');
	});

	// ── ⑲ 类别档位（Phase 1）必须接线且单一真源 ─────────────────────────
	test('★★ 类别档位：真源唯一 + 审批层真的查它（Phase 1「默认全问+类别自动批准」）', () => {
		// 类别模型的目标是把「哪些调用免审批」从**代码内定的多条分支**改为
		// **用户可控的类别档位**（对齐 Cline）。三处必须同时在位，缺一则档位形同虚设。
		assertWired('common/toolApprovalPolicy.ts', 'export function classifyToolCategory(', '类别真源');
		assertWired('browser/toolExecutionGuard.ts', 'classifyToolCategory(toolDef)', '审批层按类别判定');
		assertWired('browser/toolExecutionGuard.ts', 'this._autoApproveMode(', '档位查表（唯一读取入口）');
		assertWired('common/toolAllowStore.ts', 'export function autoApproveFor(', '配置读取入口');
	});

	// ── ⑱ 沙箱必须解析符号链接（词法边界可被 symlink 逃逸）─────────────────
	test('★★ 沙箱必须解析符号链接（否则工作区内 symlink 可指向 ~/.ssh 并免审批写入）', () => {
		// 词法边界（URI + isEqualOrParent）零文件系统访问 → 不解析 symlink；
		// 写黑名单 / 敏感路径 / 受保护路径三条也按词法路径查 → 全部落空。
		assertWired('browser/providers/tool/workspaceSecurity.ts', 'realPathBestEffort(', '沙箱的符号链接解析');
		assertWired('browser/providers/tool/workspaceSecurity.ts', 'realRootsBestEffort(', '允许根同步解析（防误拒）');
		// ★ 第二条出口（P2 结构自愈的 `return repaired`）也必须过同一套判定
		assertWired('browser/providers/tool/workspaceSecurity.ts', 'realPathAllowedWithinRoots(', '自愈出口的二次校验');
		assertWired('common/symlinkGuard.ts', 'export async function realPathBestEffort(', '解析真源');
	});

	// ── ⑰ 索引侧必须有显式的凭据名判定 ───────────────────────────────────
	test('★★ 代码库索引必须显式跳过凭据 / 密钥名（不得只靠点文件 + 扩展名巧合）', () => {
		// 索引里存的是**文件内容**且跨会话持久化，泄露面比一次 file_read 更大。
		// 此前扫描器**没有**任何敏感名判定 —— 靠「点开头跳过」+「扩展名白名单」
		// **恰好**挡住（一旦白名单加入 `.json`，`auth.json` 就进图）。
		assertWired('browser/codebaseGraphScanner.ts', 'isSensitiveName(', '索引侧的凭据名判定');
		assertWired('browser/providers/tool/sensitivePaths.ts', 'export function isSensitiveName(', '判定真源');
	});

	// ── ⑲ 工具结果里的图像必须剥离并改走 role:'user' ─────────────────────
	test('★★ 两条 agent loop 都必须：剥离图像 + 门控 supportsImages + 追加 user 消息', () => {
		// 全链路追踪结论（2026-09-13）：图像项若留在工具结果里，会被 `JSON.stringify`
		// 再按 10 万字符截断（base64 损坏），且 `messageFormatConverter` 的 `role:'tool'`
		// 分支只读字符串（三家 provider 皆然）→ **永远不会**以图像形式到达模型。
		// `mcpToolProvider` / `image_generate` 返回的 image 项同样如此（既存缺陷）。
		//
		// 两条 loop（agentTurnExecutor = Direct 模式；executionProvider = 槽位模式）
		// 必须同款处置 —— 只改一条就是本项目反复出现的「路径不对称」。
		for (const f of ['browser/agentTurnExecutor.ts', 'browser/providers/execution/executionProvider.ts']) {
			assertWired(f, 'splitToolResultImages(', `${f}: 图像剥离`);
			assertWired(f, 'resolveSupportsImages(', `${f}: 主模型图片能力门控（否则 400）`);
			assertWired(f, 'buildToolImageMessage(', `${f}: 用 user 消息承载图像`);
		}
		assertWired('common/toolResultImages.ts', 'export function buildToolImageMessage(', '判定/组装真源');
	});

	// ── ⑱ 读图片不得成为读守卫的绕过通道 ──────────────────────────────────
	test('★★ `vision_analyze` 读本地图片必须走与 `file_read` 同一套读护栏', () => {
		// 本工具把图片字节发给**外部模型 provider**，与 `file_read` 的出网面完全一致 ——
		// 若不跑「沙箱解析 / 设备伪文件系统 / 敏感路径读守卫」三件套，它就是一条
		// **绕过读守卫的通道**（image 后缀不在敏感名表里，但目录级敏感项如 `.ssh/`
		// `.aws/` `.config/gcloud/` 仍会被 `detectSensitivePath` 命中）。
		// 这正是今天最高频的缺陷形态：「另一条出口没挂检查」。
		assertWired('browser/providers/tool/builtinToolProvider.ts', 'loadLocalImage', '本地图片加载器接线');
		assertWired('browser/providers/tool/builtinToolProvider.ts', 'detectSensitivePath(resolved)', '敏感路径读守卫');
		assertWired('browser/providers/tool/builtinToolProvider.ts', 'detectDevicePath(resolved)', '设备伪文件系统');
		assertWired('browser/providers/tool/builtinToolProvider.ts',
			'_resolveAndCheckWorkspacePath(agentId, requestedPath, false)', '沙箱路径解析（与 file_read 同口径）');
	});

	// ── ⑰ 授权表的**读取**必须与**判定**同源（撤销入口曾读已迁走的键）──────
	test('★★ 授权表读取必须与判定同源（legacy 键只允许出现在迁移逻辑里）', () => {
		// 授权表已迁到 `~/.vssaros/tool-allow.json`；两个 legacy settings 键
		// 只剩「首次加载时迁移一次」的用途，**迁移之后恒为空**。
		//
		// 撤销命令（`agentStudio.tools.revokeAllow`）曾读这两个键 ⇒ 永远列出空列表、
		// 提示「当前没有任何持久化的工具授权」，而用户明明授权过 ——
		// 一个**静默失效**的撤销入口，偏偏它是用户唯一的自救手段。
		//
		// 现要求：legacy 键**只允许**出现在 `loadToolAllowFile` 的迁移逻辑里
		// （声明 1 处 + 读取 1 处 = 恰好 2 处；多一处都说明又有人拿它当数据源）。
		const src = readSource('browser/agentOSService.ts');
		for (const key of ['LEGACY_TOOL_ALLOW_USER_KEY', 'LEGACY_TOOL_ALLOW_WORKSPACE_KEY']) {
			const n = src.split(key).length - 1;
			assert.strictEqual(n, 2, `${key} 只应在「声明 + 迁移读取」各出现一次，实际 ${n} 次`);
		}
	});

	// ── ⑯ 显式拒绝必须优先于允许（deny-overrides-allow）──────────────────
	test('★★ 显式拒绝必须排在允许之前（否则用户的「始终拒绝」会被旧 blanket 允许压过）', () => {
		const src = readSource('browser/toolExecutionGuard.ts');
		const deny = src.indexOf('if (this._isDenied(toolCall.name, command))');
		const allow = src.indexOf('this._isAllowed(toolCall.name, command)) {');
		assert.ok(deny >= 0, '应存在 `_isDenied` 判定');
		assert.ok(allow >= 0, '应存在 `_isAllowed` 判定');
		assert.ok(deny < allow, `拒绝必须在前（deny@${deny} allow@${allow}）`);
	});

	// ── ⑮ 「必须用户裁决」判定必须单一真源（防七条通道再次各自手写）────────
	test('★★ 「必须用户裁决」判定是单一真源，且被所有非交互通道引用', () => {
		// 这三条判定（受保护路径 / 删除类命令 / 未经授权的 MCP）原先在**七条放行通道**里
		// 各写一遍 —— 实测已经漂移（`inherit` 对 MCP 有 `_isAllowed` 豁免，无 handler 那条漏了）。
		assertWired('browser/toolExecutionGuard.ts', 'private _requiresUserDecision(', '判定真源定义');
		const src = readSource('browser/toolExecutionGuard.ts');
		const uses = src.split('this._requiresUserDecision(').length - 1;
		assert.ok(uses >= 2, `inherit 与「无 handler 降级」都必须走单一真源，实际引用 ${uses} 次`);
	});

	// ── ⑭ 无审批 handler 时不得无条件放行（第七条通道）────────────────────
	test('★★ 无审批 handler 时不得无条件放行（受保护 / 删除类 / MCP 必须拒绝）', () => {
		// `if (!this._handler) { return true; }` 曾是无条件放行 —— 且**不留日志**。
		// 与 `inherit` 同构：没有 UI 可弹时，必须用户裁决的动作只能 deny。
		assertWired('browser/toolExecutionGuard.ts', 'no-handler-deny', '无 handler 的降级拒绝');
	});

	// ── ⑬ 后台 subagent 的 `inherit` 不得成为绕过全部审批的通道 ──────────
	test('★★ 后台 subagent（inherit）不得放行受保护路径 / 删除类命令 / 未授权 MCP 工具', () => {
		// `inherit` 曾是无条件 `return true`，且排在所有 isProtected / forcedAsk / MCP
		// 门控**之后** → 后台 subagent 绕过全部审批（含写 .git/hooks、rm -rf）。
		assertWired('browser/toolExecutionGuard.ts', 'if (isProtected || forcedAsk) {', 'inherit 的受保护/删除类拒绝');
		assertWired('browser/toolExecutionGuard.ts', 'isMcpSourcedTool(toolDef) && !this._isAllowed(', 'inherit 的 MCP 显式授权要求');
	});

	// ── ⑫ MCP 工具不得走 Safe 早返回（自报注解不可作为免审批依据）──────────
	test('★★ MCP 工具不得走 `Safe` 早返回（否则 server 自报 readOnlyHint 即可免审批）', () => {
		// MCP 工具的 securityLevel 来自 server 自报的 annotations（不可验证）→
		// 「免审批」的决定权会落到被审查方手里。
		assertWired('browser/toolExecutionGuard.ts', '!isMcpSourcedTool(toolDef)', 'Safe 早返回的 MCP 排除');
		assertWired('common/toolApprovalPolicy.ts', 'export function isMcpSourcedTool(', '判定真源');
	});

	// ── ⑨ 语句顺序不变量：受保护路径判定必须早于自动放行分支 ─────────────
	test('★★ 受保护路径判定必须**早于**自动放行分支（今天第 1 个缺陷的形态）', () => {
		// 2026-09-13 修的原始缺陷：`isProtectedPath` 只在 always-allow 检查之前求值，
		// 而 `isSandboxFileWriteAutoApproved` / 终端白名单 / execAutoReview 三个
		// 「自动放行」分支在它之前就已 `return true` → 文档承诺的 fail-closed
		// **只挡住了 always-allow，没挡住自动放行**。
		// 后果：`file_write` 写 `.git/hooks/pre-commit` 被静默放行（下次 commit 执行任意代码）。
		// 这里把「顺序」钉死：任何人把判定挪回自动放行之后，本用例当场失败。
		const src = readSource('browser/toolExecutionGuard.ts');
		const gate = src.indexOf('isProtectedPath(getToolCallPathArg(');
		const autoApprove = src.indexOf('isSandboxFileWriteAutoApproved(');
		assert.ok(gate >= 0, '应有 `isProtectedPath(getToolCallPathArg(...))` 判定');
		assert.ok(autoApprove >= 0, '应有自动放行分支');
		assert.ok(
			gate < autoApprove,
			'受保护路径判定必须在自动放行分支**之前**求值 —— 否则自动放行会先 return true，'
			+ '`isProtected` 永不生效，fail-closed 承诺落空',
		);
	});

	// ── ⑬ 图谱「本轮 project」不得依赖可变字段 `this._projectName` ──────────────
	//
	// 背景（2026-09-15，用户报「工作区是 sarosis 却按 S1Game 检索」的同一族缺陷）：
	// `CodebaseGraphService` 是**窗口内单例**，而一轮**全量索引要跑数分钟**。期间
	// bootstrap 的 `loadGraphMerge`（大图 10~40s，极易重叠）、工作区切换
	// （`_pruneForeignProjects`）或 viewer 的 `_autoDetectProjectName` 都可能改写
	// `this._projectName`。若索引体内读该字段，本轮的 post-pass / 文件哈希 / 落盘就会
	// 按**别的项目**过滤 ⇒ CALLS/克隆/Leiden 边被静默丢弃、`graph.db.zst` 内容错位
	// （`_saveGraph` 的 sanity check 只能事后告警，制品已被写坏）。
	//
	// 修法 = 两条一起才完整：
	//   A. 索引体内一律用本轮局部常量 `projectName`（含 `_saveGraph` / `_syncGraphToSqlite`）；
	//   B. helper 内部仍读该字段 ⇒ 外部改写必须走 `_setProjectNameUnlessIndexing()`（索引期间拒绝）。
	// 本用例把这两条钉死：谁把任一处改回直接读字段，当场失败。
	test('★★ 全量索引的 project 必须用本轮局部常量，且外部改写必须经守卫', () => {
		const rel = 'browser/codebaseGraphService.ts';
		const src = readSource(rel);

		// A. 索引体：局部常量 + 落盘/同步/activeProject 都用它
		assertWired(rel, "const projectName = config.projectName || config.subPath || this._basename(rootPath) || '_default';", '本轮 project 的局部常量');
		assertWired(rel, 'this._graph.setActiveProject(projectName);', '节点/边标记用本轮 project');
		assertWired(rel, 'this._saveGraph(rootPath, projectName)', '制品落盘用本轮 project');
		assertWired(rel, 'await this._syncGraphToSqlite(projectName);', 'SQLite 同步用本轮 project');
		assertWired(rel, '_recordHashAfterParse(projectName, relPath, filePath, result.status);', '文件哈希用本轮 project');
		assertWired(rel, 'this._recordFileHash(projectName, relPath, filePath);', '跳过类哈希用本轮 project');

		// A（负向）：落盘/同步不得退回可变字段
		assert.ok(
			!src.includes('this._saveGraph(rootPath, this._projectName)'),
			`[图谱 project 归属] ${rel} 的 _saveGraph 不得再传 this._projectName —— `
			+ '索引期间该字段可能被别的工作区的 merge 改写，制品会被写成别的项目的子图（甚至为空）',
		);
		assert.ok(
			!src.includes('await this._syncGraphToSqlite();'),
			`[图谱 project 归属] ${rel} 的 _syncGraphToSqlite() 不得省略 project 参数 —— `
			+ '缺省会读 this._projectName，同上有被改写风险',
		);
		assert.ok(
			!src.includes('_recordHashAfterParse(this._projectName'),
			`[图谱 project 归属] ${rel} 的哈希记录不得再读 this._projectName`,
		);

		// B. 外部改写路径必须走守卫（索引期间拒绝改写）
		assertWired(rel, 'private _setProjectNameUnlessIndexing(project: string): void {', '守卫定义');
		assertWired(rel, 'this._setProjectNameUnlessIndexing(detected);', '_autoDetectProjectName 接线');
		assertWired(rel, 'this._setProjectNameUnlessIndexing(this._resolveActiveProject(', '_loadGraphMergeImpl 接线');
		assertWired(rel, 'this._setProjectNameUnlessIndexing(activeProject);', '_pruneForeignProjects 接线');
		assert.ok(
			src.includes('if (this._isIndexing) {') && src.includes('_logService.debug'),
			`[图谱 project 归属] ${rel} 的守卫必须在索引进行中**拒绝**改写（否则 B 条形同虚设）`,
		);

		// B（负向）：三处外部改写不得绕过守卫直接赋值
		assert.ok(
			!src.includes('this._projectName = detected;'),
			`[图谱 project 归属] ${rel} 的 _autoDetectProjectName 不得直接赋值 this._projectName`,
		);
		assert.ok(
			!src.includes('this._projectName = this._resolveActiveProject('),
			`[图谱 project 归属] ${rel} 不得直接赋值 this._projectName（merge/prune 都要走守卫）`,
		);
	});

	// ── ⑭ 图谱候选检索的 project 过滤必须**下推到 SQL**（跨 IPC 四文件接线）────────
	//
	// 背景（2026-09-15 用户日志）：SQLite 文件是**跨工作区共享**的持久层
	// （`<userData>/codebase-graph/graph.db`），里面留着历史工作区的项目（S1Game 34 万 + UE5EA…）。
	// `searchNodes` 原先不带 project ⇒ 跨全库按 bm25 取前 N 条，**候选池被外来项目占满**
	// （实测 needle="test" 的 231 条全是 S1Game:148 + UE5EA:83，本项目命中根本没进池），
	// renderer 侧再按 project 收敛 ⇒ 结果恒为 0（「Find Symbol 搜不到任何东西」）。
	//
	// 这类改动**极易只改一半**（SQL 加了过滤但 IPC 没透传 / renderer 没传参 ⇒ 静默回到旧行为），
	// 且行为缺陷只在「SQLite 里有别的工作区数据」时才显形 ⇒ 必须用源码级断言把四段接线一起钉死。
	test('★★ 图谱候选检索的 project 过滤必须下推到 SQL（四段接线缺一不可）', () => {
		// ① SQL：FTS 路径（JOIN 别名 n）与 LIKE 路径（单表）各自带上 project 条件
		assertWired('node/codebaseGraphSqliteStore.ts', 'AND n.project = ?', 'FTS 路径的 project 过滤');
		assertWired('node/codebaseGraphSqliteStore.ts', 'AND project = ?', 'LIKE 路径的 project 过滤');
		// 注：只匹配到 project 参数为止（不带右括号）—— 后续再加参数（如 excludeTypes）时
		// 不会把这条断言打破（2026-09-15 加第 5 参时实测踩过）。
		assertWired('node/codebaseGraphSqliteStore.ts', 'async searchNodes(query: string, nodeType?: string, limit = 200, project?: string', 'store 侧签名');
		// ② IPC 契约：renderer 侧接口必须暴露第 4 参
		assertWired('common/codebaseGraphStoreChannel.ts', 'searchNodes(query: string, nodeType?: string, limit?: number, project?: string', 'IPC 契约签名');
		// ③ 主进程 channel：必须把第 4 参透传（漏了 ⇒ 过滤永远拿不到值）
		assertWired('electron-main/codebaseGraphStoreChannel.ts', "args![3] as string | undefined", '主进程透传第 4 参');
		// ④ renderer 调用点：必须传当前工作区的 project（同样只匹配到该参数为止）
		assertWired('browser/codebaseGraphService.ts', 'searchNodes(needle, nodeType, candidateCap, _wsProject', 'renderer 传 project');

		// 负向：不得退回「不带 project」的跨库候选检索（否则候选池又会被外来项目占满）
		const svc = readSource('browser/codebaseGraphService.ts');
		assert.ok(
			!svc.includes('searchNodes(needle, nodeType, candidateCap)'),
			'[图谱候选检索] 不得退回不带 project 的 searchNodes —— 跨库候选会被历史工作区的项目占满，收敛后恒为 0',
		);
	});

	// ── ⑮ 合并加载必须幂等 + bootstrap 必须防「同一 folder 并发重复加载」────────────
	//
	// 背景（2026-09-15 实测）：同一制品被合并两次（13:26:45 / 13:26:53 两行同样的
	// `merged ...sarosis...`），而旧实现无条件 `_nextNodeId++` 追加 ⇒ 节点翻倍。
	// 实测制品 `graph.db.zst`：358,887 节点 / 去重后 180,753 ⇒ **49.6% 冗余**。
	// 后果链：内存项目节点数翻倍 → `_ensureSqliteFreshness` 恒判「sqlite 落后」（36 万 vs 17.6 万）
	// → 每次查询都触发全量重同步 → 查询与写事务竞争（实测单次检索 2.3s 且候选残缺 231 条）。
	//
	// 两道防线缺一不可：① **源头**：bootstrap 登记「加载中」的 folder（否则 10~40s 的加载窗口内
	// 任何重入都会重复发起）；② **兜底**：合并本身幂等（同 project+qn 复用既有 id 并跳过）。
	test('★★ 图谱合并必须幂等，且 bootstrap 必须防重复加载（否则节点翻倍）', () => {
		const storeRel = 'browser/codebaseGraphStore.ts';
		assertWired(storeRel, 'async mergeFromJSONAsync(data: any, projectOverride?: string, onProgress?: (loaded: number, total: number) => void): Promise<IGraphMergeStats>', '合并返回统计（跳过数必须可见）');
		assertWired(storeRel, 'const existingId = qn ? this._nodesByQN.get(`${project}:${qn}`) : undefined;', '幂等闸门（同 qn 复用既有 id）');
		assertWired(storeRel, 'stats.nodesSkipped++;', '跳过计数');
		// 负向：不得再无条件追加节点（`const newId = this._nextNodeId++;` 必须出现在幂等闸门之后）
		const storeSrc = readSource(storeRel);
		const gate = storeSrc.indexOf('const existingId = qn ? this._nodesByQN.get(');
		const alloc = storeSrc.indexOf('const newId = this._nextNodeId++;', gate >= 0 ? gate : 0);
		assert.ok(gate >= 0 && alloc > gate, '幂等闸门必须早于 id 分配 —— 否则重复合并仍会翻倍');

		const bootRel = 'browser/codebaseGraphBootstrap.ts';
		assertWired(bootRel, 'private readonly _loadingFolders = new Set<string>();', '在途 folder 集合');
		assertWired(bootRel, '!this._loadingFolders.has(key)', 'toLoad 过滤在途 folder');
		assertWired(bootRel, 'this._loadingFolders.add(key);', '加载前登记');
		assertWired(bootRel, 'this._loadingFolders.delete(key);', '加载后清理（finally）');
	});

	// ── ⑯ 图谱节点跳转：必须统一走 resolveNodeLocation（2026-09-15）────────────
	//
	// 背景（用户报「双击 item 无法跳转打开对应的文件」）：
	// 此前 **7 处**跳转各自手写「project root + 相对路径」，每一处都带两个静默失败点：
	//  ① 只认 `getProjectRoots()[node.project]` **一项** —— 该映射的 value 来自
	//     `_rootProjectMap`（**小写 + 正斜杠**），project 名对不上就静默放弃；
	//  ② 把 `startLine` 当成可跳转前提，而图谱里**最常见的一类命中没有行号** ——
	//     `CodebaseGraphService.addEdge()` 为 CONTAINS 边实体化的 `label='file'` stub
	//     节点（只写 filePath/qualifiedName/name）。搜 `test` 命中的 `*.test.ts` 全是
	//     这类节点；Definition 列尾部那个多余的 `:` 就是 `${filePath}:${startLine ?? ''}`
	//     留下的痕迹 ⇒ 双击**恒静默返回**；
	//  ③ 附带：`joinPath` 是 posix 语义，filePath 含 `\` 时拼出「文件名里带 \」的坏 URI。
	// 现统一到 `ICodebaseGraphService.resolveNodeLocation()`（三级回退 + 行号缺省 + 未命中告警），
	// 本用例钉住「7 处都必须委派、不许再各自拼 root」。
	test('★★ 图谱节点跳转必须统一走 resolveNodeLocation（7 处不得再各自拼 root）', () => {
		const svcRel = 'browser/codebaseGraphService.ts';
		// 解析器本体：三级回退 + 行号缺省 + 未命中告警
		assertWired(svcRel, 'async resolveNodeLocation(', 'service 级解析器');
		assertWired(svcRel, 'const line = Math.max(1, node.startLine ?? 1);', '行号缺省落第 1 行');
		assertWired(svcRel, 'file not found: "${node.filePath}"', '未命中要告警（不再静默）');
		assertWired(svcRel, 'if (prefer) { push(URI.file(prefer.replace(/[\\\\/]+$/, \'\') + \'/\' + rel)); }', '① 该节点 project 直拼');
		assertWired(svcRel, 'for (const r of Object.values(roots)) { push(URI.file(r.replace(/[\\\\/]+$/, \'\') + \'/\' + rel)); }', '② 其余已注册 root 兜底');
		assertWired(svcRel, 'for (const u of this._resolveSearchFileCandidates(filePath)) { push(u); }', '③ 工作区各 folder（含绝对路径直解）');

		// 7 处跳转入口必须全部委派，且不得再手拼 root
		const jumpSites = [
			'browser/widgets/findSymbolModal.ts',
			'browser/widgets/classHierarchyModal.ts',
			'browser/widgets/openFileModal.ts',
			'browser/views/classHierarchyView.ts',
			'browser/views/referencesResultView.ts',
			'browser/codebaseGraphVaxSearch.contribution.ts',
			'browser/codebaseGraphLanguageFeatures.contribution.ts',
		];
		for (const rel of jumpSites) {
			assertWired(rel, 'resolveNodeLocation(', '必须委派给统一解析器');
			const code = stripAllComments(rel);
			assert.ok(
				!/roots\[[^\]]*\?\?\s*'_default'\]/.test(code),
				`[${rel}] 不得只解析单个 project root —— project 名对不上就静默失败，必须走 resolveNodeLocation`,
			);
			assert.ok(
				!code.includes('joinPath(URI.file(root)'),
				`[${rel}] 不得再手拼 joinPath(root, filePath) —— 必须走 resolveNodeLocation`,
			);
		}

		// 负向：跳转入口不得把 startLine / line 当作可跳转前提
		// （图谱 `label='file'` stub 节点没有行号，会让最常见的命中「双击无反应」）
		for (const rel of [
			'browser/widgets/findSymbolModal.ts',
			'browser/widgets/classHierarchyModal.ts',
			'browser/views/classHierarchyView.ts',
			'browser/views/referencesResultView.ts',
			'browser/widgets/implementationsModal.ts',
		]) {
			const code = stripAllComments(rel);
			assert.ok(
				!/!\s*(node|g|n)\.startLine\s*\)/.test(code),
				`[${rel}] 不得以 startLine 缺失作为提前返回条件 —— file 节点没有行号`,
			);
			assert.ok(
				!/!\s*(it|node)\.line\s*\)/.test(code),
				`[${rel}] 不得以 line 缺失作为提前返回条件 —— 会让无行号候选双击无反应`,
			);
		}
	});

	// ── ⑰ 「搜符号」必须排除 file 桩节点，且排除条件下推到 SQL ──────────────────
	//
	// 背景（2026-09-15 用户截图）：Find Symbol 搜 `test` 时 200 条候选里大半是
	// `label='file'` 的 CONTAINS 桩节点（`toolArgsJson.test.ts`、`kbBlocksCodec.test.ts` …）
	// —— 它们是 `addEdge()` 为让 CONTAINS 边不悬空而实体化的**文件名桩**，不是符号，
	// 却把真正的 `variable`/`function` 挤出 `LIMIT`（截图里可见的 6 条只有 2 条真符号）。
	//
	// 与 ⑭（project 过滤）**完全同一条教训**：过滤必须**下推到 SQL** —— 只在 renderer 后置
	// 过滤时，`LIMIT` 已经先把符号丢掉了。故同样按「四段接线」钉死；另外 renderer 必须保留
	// 一层后置兜底：IPC 是位置参数转发，「renderer 已更新、主进程未重启」时旧 main 会**静默
	// 忽略**第 5 参（只靠 SQL 会让用户以为修复无效）。
	test('★★ 「搜符号」必须排除 file 桩节点，且排除条件下推到 SQL（四段接线 + 兜底）', () => {
		// ⓪ 常量：黑名单而非白名单（索引器新增类型默认仍可见，白名单会静默藏掉新类型）
		assertWired('common/codebaseIndexDefaults.ts', "export const NON_SYMBOL_NODE_TYPES: readonly string[] = ['file', 'folder', 'project'];", '非符号类型常量');
		// ① SQL：FTS（JOIN 别名 n）与 LIKE（单表）两条路径各自带排除条件
		assertWired('node/codebaseGraphSqliteStore.ts', 'AND lower(n.type) NOT IN (', 'FTS 路径的排除条件');
		assertWired('node/codebaseGraphSqliteStore.ts', 'AND lower(type) NOT IN (', 'LIKE 路径的排除条件');
		// ★ 声明了过滤条件还必须**真的拼进 SQL**（半接线的经典形态：算了不用）
		assertWired('node/codebaseGraphSqliteStore.ts', '${typeFilter}${projFilterFts}${exFilterFts}', 'FTS SQL 拼上排除');
		assertWired('node/codebaseGraphSqliteStore.ts', '${typeFilter}${projFilterLike}${exFilterLike}', 'LIKE SQL 拼上排除');
		// ② IPC 契约：第 5 参
		assertWired('common/codebaseGraphStoreChannel.ts', 'excludeTypes?: readonly string[]', 'IPC 契约第 5 参');
		// ③ 主进程 channel：必须透传第 5 参（漏了 ⇒ SQL 层过滤永远拿不到值）
		assertWired('electron-main/codebaseGraphStoreChannel.ts', 'args![4] as readonly string[] | undefined', '主进程透传第 5 参');
		// ④ renderer：调用点透传 + 参数契约 + 后置兜底（主进程未重启）
		// 注：断言**不带右括号** —— 后续再加参数（如 nameOnly）时不会误报（本文件已踩过两次）
		assertWired('browser/codebaseGraphService.ts', 'searchNodes(needle, nodeType, candidateCap, _wsProject, params.excludeTypes', 'renderer 传 excludeTypes');
		assertWired('browser/codebaseGraphService.ts', 'non-symbol node(s) in renderer', 'renderer 后置兜底');
		// ⑤ 调用方：Find Symbol 必须真的传常量（否则四段接线等于没接上）
		assertWired('browser/widgets/findSymbolModal.ts', 'excludeTypes: NON_SYMBOL_NODE_TYPES,', 'Find Symbol 传常量');

		// 负向：不得退回「不带 excludeTypes」的候选检索（截图那个形态会立刻回归）
		const svc = readSource('browser/codebaseGraphService.ts');
		assert.ok(
			!svc.includes('searchNodes(needle, nodeType, candidateCap, _wsProject);'),
			'[图谱候选检索] 不得退回不带 excludeTypes 的 searchNodes —— 候选池会被文件名桩节点占满',
		);
	});

	// ── ⑱ 「搜符号」必须只匹配 name 列（QN 里的文件路径不得命中）────────────────
	//
	// 背景（2026-09-15 用户截图）：Find Symbol 搜 `test` 返回 `MockClassifyLLM`。
	// QN = `<相对文件路径>::<符号名>`，而 FTS 索引了 `name, qualified_name, file_path, body`
	// ⇒ `MATCH "test"` 命中了 `…/knowledge/classifyLLM.test.ts`。内存路径的 `namePattern`
	// 同样是 `name || qualifiedName` 的或匹配 ⇒ 两条路径都要收口。
	//
	// ★ 实现要点：`nameOnly` 时**跳过 FTS 直接走 `name LIKE`** —— FTS 是**词元**匹配，
	// 加 `name:` 列过滤后只命中词元恰为 `test` 的名字，`testHelper` 反而漏掉
	// （真实 SQL 用例 `nameOnly is a substring match` 钉住这一点，别"优化"成 FTS 列过滤）。
	test('★★ 「搜符号」必须只匹配 name 列（QN 里的文件路径不得命中）', () => {
		// ① SQL：nameOnly 跳过 FTS + LIKE 只匹配 name
		assertWired('node/codebaseGraphSqliteStore.ts', 'if (!nameOnly) {', 'nameOnly 时跳过 FTS');
		assertWired('node/codebaseGraphSqliteStore.ts', 'const likeWhere = nameOnly ? `name LIKE ?` : `(name LIKE ? OR qualified_name LIKE ?)`;', 'LIKE 只匹配 name');
		// ② IPC 契约 + ③ 主进程透传第 6 参
		assertWired('common/codebaseGraphStoreChannel.ts', 'nameOnly?: boolean', 'IPC 契约第 6 参');
		assertWired('electron-main/codebaseGraphStoreChannel.ts', 'args![5] as boolean | undefined', '主进程透传第 6 参');
		// ④ renderer：SQL 调用点透传 + 后置兜底（主进程未重启）
		assertWired('browser/codebaseGraphService.ts', 'params.excludeTypes, params.nameOnly)', 'renderer 传 nameOnly');
		assertWired('browser/codebaseGraphService.ts', 'matched only via QN/filePath for', 'renderer 后置兜底');
		// ④b 内存回退路径同口径
		assertWired('browser/codebaseGraphStore.ts', 'params.nameOnly', '内存 store 同口径');
		// ⑤ 调用方：Find Symbol 必须传
		assertWired('browser/widgets/findSymbolModal.ts', 'nameOnly: true,', 'Find Symbol 传 nameOnly');

		// 负向：内存 store 不得只剩「name || qualifiedName」的或匹配（QN 里的路径会重新命中）
		const storeSrc = stripAllComments('browser/codebaseGraphStore.ts');
		assert.ok(
			storeSrc.includes('? candidates.filter(n => regex.test(n.name))'),
			'[图谱符号名检索] 内存 store 必须保留 nameOnly 分支（只测 name）',
		);
	});

	// ── ⑲ 「配置已加载」不得用 `_workspaceFileConfig === null` 当哨兵 ──────────────
	//
	// 背景（2026-09-15 用户日志）：启动阶段 `_initWorkspaceFileConfig: starting` 连续出现 3 遍
	// （3 个 folder 各自 auto-index 读配置），每次都以
	// `sarosis-agents-client.code-workspace has no codebase-memory key` 结束。
	// 根因：`_doInitWorkspaceFileConfig` 在「文件里没有该 key」这条**正常路径**上什么都不赋值，
	// 而 `ensureConfigReady()` 却用 `_workspaceFileConfig === null` 判断「还没加载」——
	// 于是**每次调用都重跑整个加载**（列 root 的 89 个子项 + 读 4.4KB + JSONC 解析 +
	// 300 字符 preview 日志），且并发调用之间没有 in-flight 去重。
	test('★★ 「配置已加载」不得用 _workspaceFileConfig === null 当哨兵（会无限重载）', () => {
		const rel = 'browser/codebaseMemoryMcpService.ts';
		const src = stripAllComments(rel);

		// 正向：独立「已尝试加载」标记 + finally 置位 + 工作区变化时重置
		assertWired(rel, 'private _workspaceFileConfigLoaded = false;', '独立「已尝试加载」标记');
		assertWired(rel, 'if (this._workspaceFileConfigLoaded) { return; }', 'ensureConfigReady 用该标记判断');
		assertWired(rel, 'this._workspaceFileConfigLoaded = true;', '加载完成后置位');
		assertWired(rel, 'this._workspaceFileConfigLoaded = false;', '工作区变化时重置');
		assert.ok(
			src.includes('} finally {'),
			'[配置加载] 置位必须放 finally —— 异常路径不置位仍会无限重试',
		);

		// 负向：判据不得退回 null 哨兵（「没有 key」这条正常路径会让它恒为 null）
		assert.ok(
			!src.includes('if (this._workspaceFileConfig === null) {'),
			'[配置加载] 不得用 `_workspaceFileConfig === null` 判断「是否已加载」—— '
			+ '文件里没有 codebase-memory key 时它永远是 null，会让每次调用都重跑完整加载',
		);
	});

	// ── ⑳ PanelPart 内容高度必须钳到 ≥0（否则 -12 一路传下去）──────────────
	//
	// 背景（2026-09-15 用户日志）：切换右侧栏时打出
	// `[PanelPart] layout height<=0: height=0` → `[PaneCompositePart] … height=-12`
	// → `[CompositePart] … titleSize=-12, contentSize=0x2108`。
	// 根因：agents 布局建 panel 就是 `size: 0`（panel 折叠），grid 传 `height=0`，
	// 而 `layout()` 里 `0 - MARGIN_BOTTOM(10) - borderTotal(2)` = **-12** 未钳位就往下传。
	// 同时那批 `[Saros Debug]` 探针（`_inspectWidthChain`：7 次 getBoundingClientRect +
	// getComputedStyle = **强制同步重排**，再输出 20 行 JSON）**无条件挂在每次 layout 上**。
	test('★★ PanelPart 内容高度必须钳到 ≥0，且布局探针默认关闭', () => {
		// ⚠ 本文件在 agentStudio **之外** ⇒ 不能用 readSource/assertWired（它们以 AGENT_STUDIO 为基准）
		const abs = path.join(process.cwd(), 'src/vs/sessions/browser/parts/panelPart.ts');
		assert.ok(fs.existsSync(abs), `源码文件不存在（路径基准变了？）：${abs}`);
		const raw = fs.readFileSync(abs, 'utf8');
		const src = stripComments(raw);

		// 正向：钳位 + 探针开关
		assert.ok(
			src.includes('const contentHeight = Math.max(0, height - PanelPart.MARGIN_BOTTOM - borderTotal);'),
			'[PanelPart] 内容高度必须钳到 ≥0',
		);
		assert.ok(src.includes('const PANEL_LAYOUT_DEBUG = false;'), '[PanelPart] 布局探针必须默认关闭');
		assert.ok(src.includes('if (PANEL_LAYOUT_DEBUG) {'), '[PanelPart] 探针必须受开关控制');

		// 负向：先剥块注释（说明文字里引用了旧写法，否则假失败）
		const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
		assert.ok(
			!code.includes('height - PanelPart.MARGIN_BOTTOM - borderTotal,'),
			'[PanelPart] 不得把未钳位的高度传给 super.layout —— panel 折叠时 height=0 会算出 -12，'
			+ '一路传到 PaneCompositePart/CompositePart（titleSize=-12、contentSize=0x2108）',
		);
		assert.ok(
			!/^\t{2}setTimeout\(\(\) => this\._inspectWidthChain\(width\), 200\);/m.test(code),
			'[PanelPart] 尺寸链探针不得无条件执行 —— 它做 7 次 getBoundingClientRect + getComputedStyle'
			+ '（强制同步重排）并输出 20 行 JSON，必须受 PANEL_LAYOUT_DEBUG 控制',
		);
	});

	// ── ㉑ 索引完成回调必须按「刚索引的 root」刷新 watcher，且增量不刷新 ──────────
	//
	// 背景（2026-09-15 用户日志）：每轮**增量索引**完成后都紧跟
	// `[exclude] …` + `Starting graph watcher …` + `Watching …` 三条。
	// 根因：`onDidIndexComplete` 回调无条件 `_startWatching(this._primaryFolder())` ——
	//   ① 增量由 watcher 自己触发（watcher 必然已存在、排除集未变）⇒ 纯重复：重跑
	//      `_excludeResolver.resolve()`（读 .cbmignore + 工作区配置）+ 替换 root 条目 + 三条日志；
	//   ② `_primaryFolder()` 是 `folders[0]` ⇒ 多 folder 下**永远只刷新第一个 folder** 的 watcher，
	//      而真正可能改了排除集（索引会写 `.cbmignore`）的那个 folder 永不刷新。
	//      ★ 与 `_onWatcherChange`（用事件携带的 `e.rootPath`）/ `_resolveActiveProject`
	//      是同一条教训：**别用 folders[0] 代替事件所属 root**。
	test('★★ 索引完成回调必须按「刚索引的 root」刷新 watcher，且增量不刷新', () => {
		const bootRel = 'browser/codebaseGraphBootstrap.ts';
		assertWired(bootRel, "if (result.kind === 'incremental') { return; }", '增量不刷新 watcher');
		assertWired(bootRel, 'this._startWatching(result.rootPath || this._primaryFolder())', '按刚索引的 root 刷新');
		// 服务侧必须真的把 root/kind 填进结果（否则上面的判断恒为 undefined）
		assertWired('browser/codebaseGraphService.ts', 'rootPath?: string;', 'IIndexResult 带 rootPath');
		assertWired('browser/codebaseGraphService.ts', "kind: 'full',", '全量结果带 kind');
		assertWired('browser/codebaseGraphService.ts', "kind: 'incremental',", '增量结果带 kind');
		// ⚠ 断言**只用单行 needle**：本仓源码是 CRLF，多行 needle 里的 `\n` 永远匹配不上
		// （实测 `'rootPath,\n\t\t\t\tkind: …'` 假失败过一次）。

		// 负向：不得退回「无条件用 folders[0] 刷新」
		const bootSrc = stripAllComments(bootRel);
		assert.ok(
			!bootSrc.includes('void this._startWatching(this._primaryFolder());'),
			'[图谱 watcher] 不得无条件用 `_primaryFolder()`（folders[0]）刷新 watcher —— '
			+ '多 folder 下永远只刷新第一个 folder，且每轮增量都白跑一次',
		);
	});

	// ── ㉒ 无图也必须打开 UI：自动建图 + UI 内提示（不得再静默 return）──────────────
	//
	// 背景（2026-09-15 用户要求）：Find Symbol（Alt+Shift+S）/ Open File（Alt+Shift+O）以前
	// `run()` 首行就是 `if (!graphService.hasGraphData()) { logService.info(...); return; }`
	// —— 图谱没构建时**连模态都不弹**，用户只看到「按快捷键没反应」。现在要求：
	//   ① 无条件打开 UI；② 无图时自动触发建图；③ 在 UI 内显示提示（进度/结果/失败原因）。
	//
	// ⚠ 断言只用**单行 needle**（本仓源码 CRLF，多行 needle 里的 `\n` 匹配不上）。
	test('★★ 无图也必须打开 UI：自动建图 + UI 内提示（不得再静默 return）', () => {
		const autoRel = 'browser/widgets/codebaseGraphAutoBuild.ts';

		// ① 共用自动建图模块：就绪判定必须用**异步**版（内部 await whenGraphLoaded，
		//    否则启动期 loadGraphMerge 的 10~40s 里会假报「无数据」）
		assertWired(autoRel, 'export async function ensureGraphForUi(', '共用自动建图入口');
		assertWired(autoRel, 'ready = await graphService.hasGraphDataAsync();', '就绪判定用异步版（含 whenGraphLoaded）');
		assertWired(autoRel, 'if (graphService.isIndexing) {', '已在索引中则只显示进度、不重复发起');
		// ② 用户配置与 bootstrap 同口径（ensureConfigReady → getIndexConfig；projectName=basename）
		assertWired(autoRel, 'await cbmService.ensureConfigReady();', '读用户配置前先等配置就绪');
		assertWired(autoRel, 'userConfig = cbmService.getIndexConfig();', '读用户索引配置');
		assertWired(autoRel, "projectName: basename(rootPath) || '_default',", 'projectName 用 folder basename');
		// ③ 真的发起索引 + 把进度/结果写进 UI
		assertWired(autoRel, 'const result = await graphService.indexWorkspace(rootPath, config);', '自动触发建图');
		assertWired(autoRel, 'graphService.onDidIndexProgress(line => host.setNotice(', '索引进度实时进 UI');
		assertWired(autoRel, 'graphService.onDidIndexComplete(result => {', '索引完成回调进 UI');
		// ④ 失败必须**可读**（含索引锁被其他窗口占用 —— 不是故障，但必须说清）
		assertWired(autoRel, "'未打开工作区文件夹，无法构建代码图谱", '无工作区要说明');
		assertWired(autoRel, '另一个窗口正在构建该工作区的代码图谱', '索引锁被占用要说明');
		assertWired(autoRel, '/locked/i.test(msg)', '识别 Index already locked');

		// ⑤ 模态要能挂提示条（内容区顶部，搜索框之前）
		assertWired('browser/widgets/codebaseGraphModal.ts', 'setNotice(text: string, kind:', '通知条 API');
		assertWired('browser/widgets/codebaseGraphModal.ts', 'this._body.insertBefore(this._noticeEl, this._body.firstChild);', '提示条插在内容区顶部');

		// ⑥ 两个模态都必须接上自动建图，并在建好后刷新自己的列表
		assertWired('browser/widgets/findSymbolModal.ts', 'ensureGraphForUi(', 'Find Symbol 接自动建图');
		assertWired('browser/widgets/findSymbolModal.ts', 'refresh: () => this._scheduleSearch(),', 'Find Symbol 建好后重跑搜索');
		assertWired('browser/widgets/openFileModal.ts', 'ensureGraphForUi(', 'Open File 接自动建图');
		assertWired('browser/widgets/openFileModal.ts', 'refresh: () => { void this._loadFiles(); },', 'Open File 建好后重载列表');
		// ⑦ 空态必须能区分「没有匹配」与「图谱还没就绪」（此前是纯空白表格）
		assertWired('browser/widgets/findSymbolModal.ts', '没有匹配「', 'Find Symbol 空态提示');
		assertWired('browser/widgets/openFileModal.ts', '代码图谱尚无数据 —— 见上方提示', 'Open File 空态提示');

		// ⑧ 命令入口：无条件打开（保留原有实例化）
		assertWired('browser/codebaseGraphFindSymbol.contribution.ts', 'instantiationService.createInstance(FindSymbolModal).open(initialQuery);', 'Find Symbol 无条件打开');
		assertWired('browser/codebaseGraphVaxSearch.contribution.ts', 'await instantiationService.createInstance(OpenFileModal).open();', 'Open File 无条件打开');
		assertWired('browser/codebaseGraphClassHierarchy.contribution.ts', 'instantiationService.createInstance(ClassHierarchyModal).open(initialQuery);', 'Class Hierarchy 无条件打开');
		assertWired('browser/widgets/classHierarchyModal.ts', 'ensureGraphForUi(', 'Class Hierarchy 接自动建图');

		// ⑨ 三条 **QuickPick** 命令（无模态载体 ⇒ 用一条可更新的通知承载提示）
		//    + refresh 去重（`onDidIndexComplete` 与 `indexWorkspace` resolve 双触发 ⇒ 否则弹两个 picker）
		assertWired(autoRel, 'export function makeNotificationHost(', '通知宿主（非模态入口用）');
		assertWired(autoRel, 'handle.updateMessage(text', '通知可更新（不刷屏）');
		assertWired(autoRel, 'let refreshed = false;', 'refresh 去重');
		const vaxRel = 'browser/codebaseGraphVaxSearch.contribution.ts';
		assertWired(vaxRel, 'makeNotificationHost(accessor.get(INotificationService)', 'QuickPick 命令用通知承载提示');
		for (const cmd of ['sarosis.findGraphReferences', 'sarosis.gotoGraphImplementation', 'sarosis.listGraphMethods']) {
			assertWired(vaxRel, `executeCommand('${cmd}')`, `建好后重跑 ${cmd}`);
		}
		// ⑨b 通知被用户关闭 ⇒ 释放监听。否则「按了几次快捷键都没图」会累积 store
		//     （每次一套 index 监听）+ `_waitWhileBusy` 的 500ms 轮询循环；而且用户已明确关掉，
		//     建图完成后却仍会突然重跑命令（弹一个他没再要的 picker）。
		assertWired(autoRel, 'handle.onDidClose(', '通知关闭即释放监听');
		assertWired(autoRel, 'setTimeout(() => disposables?.dispose(), 0);', '延后 dispose（不在 Emitter 回调里同步改监听列表）');
		assertWired(vaxRel, '}, store),', '三个 QuickPick 入口都把 store 交给通知宿主');

		// ⑨c **空制品**的判据必须是「解析成功但 0 节点」这个**事实**，不能只看字节数。
		//    用户场景：PJDB\S1Game 留下一份 **10KB** 空图（能解压、零节点），旧判据（只比字节数）
		//    把它归进「≥1KB ⇒ 巨图损坏 ⇒ 跳过自动索引」⇒ 该 folder 既没有图、也永远不会重建 ✗。
		assertWired('browser/codebaseGraphService.ts', 'isLastMergeEmpty(rootPath: string): boolean;', 'service 暴露「空制品」事实');
		assertWired('browser/codebaseGraphService.ts', 'this._emptyArtifactRoots.add(rootPath);', '空合并写入标记');
		assertWired('browser/codebaseGraphService.ts', 'treating as NOT loaded (empty / garbage artifact)', '空合并不再 return true');
		assertWired('browser/codebaseGraphBootstrap.ts', 'const parsedButEmpty = this._graphService.isLastMergeEmpty(', 'bootstrap 用事实而非字节数');
		assertWired('browser/codebaseGraphBootstrap.ts', '&& !parsedButEmpty) {', '空制品不得被「跳过自动索引」拦下');

		// ⑩ 「加载/构建中」也要显示 codebase 状态并提示等待（2026-09-15 用户要求）
		//    ★ 加载状态此前**完全没暴露**：`_graphLoadingCount` 是私有、加载也不发
		//    `onDidIndexProgress`（只写日志）⇒ UI 拿不到任何进展，大图那几十秒提示条会停在
		//    第一句上，用户以为卡死。
		const svcRel = 'browser/codebaseGraphService.ts';
		assertWired(svcRel, 'readonly isGraphLoading: boolean;', '接口暴露加载状态');
		assertWired(svcRel, 'readonly onDidGraphLoadProgress: Event<string>;', '接口暴露加载进展事件');
		assertWired(svcRel, 'get isGraphLoading(): boolean { return this._graphLoadingCount > 0; }', '加载状态取自 _graphLoadingCount');
		assertWired(svcRel, 'this._onDidGraphLoadProgress.fire(', '加载阶段真的发进展');
		// UI 侧：订阅加载进展 + 等待循环 + 「请稍候」文案
		assertWired(autoRel, 'graphService.onDidGraphLoadProgress(line => {', 'UI **无条件**订阅加载进展');
		assertWired(autoRel, 'line.startsWith(GRAPH_LOAD_DONE_PREFIX)', 'UI 识别加载终态（清提示 + 刷新）');
		assertWired(svcRel, 'export const GRAPH_LOAD_DONE_PREFIX', '加载终态前缀常量（两端同一来源）');
		// SQLite 按需载入（13~32s 的那条重活）此前**完全沉默** ⇒ 必须有进展 + 终态
		assertWired(svcRel, '正在从 SQLite 载入图谱（', 'SQLite 载入要有进展上报');
		assertWired(svcRel, '`${GRAPH_LOAD_DONE_PREFIX}（${loadedNodes} 节点 / ${loadedEdges} 边', 'SQLite 载入要发终态行');
		// 持久层的阶段内百分比必须**真的接到** UI 事件（「送了没接」是半接线的经典形态）
		assertWired(svcRel, 'line => this._onDidGraphLoadProgress.fire(`${label}：${line}`)', '持久层进度接到 UI 事件');
		assert.ok(
			!stripAllComments(svcRel).includes('persistence.loadMerge(this._graph.store, p, projectOverride)'),
			'[图谱加载] 不得退回 3 参 loadMerge —— 会丢掉持久层的阶段内百分比（大图几十秒无进展）',
		);
		assertWired(autoRel, 'await _waitWhileBusy(graphService, host, disposables);', '进入等待循环');
		assertWired(autoRel, 'await graphService.whenGraphLoaded(BUSY_TICK_MS);', '加载用 whenGraphLoaded 轮询');
		assertWired(autoRel, 'setTimeout(resolve, BUSY_TICK_MS)', '补 sleep 防空转烧 CPU');
		assertWired(autoRel, '请稍候', '文案提示用户等待');
		// ★ 不变量：「加载/构建中」的等待分支必须**早于**自动建图 —— 加载期间 `hasGraphData()` 必为
		//   false，顺序反了就会在加载中再发起一次全量索引（与加载抢 store、双倍开销）。
		const autoSrc = stripAllComments(autoRel);
		const iWait = autoSrc.indexOf('if (graphService.isGraphLoading || graphService.isIndexing) {');
		const iBuild = autoSrc.indexOf('await graphService.indexWorkspace(rootPath, config)');
		assert.ok(
			iWait >= 0 && iBuild > iWait,
			'[自动建图] 「加载/构建中」的等待分支必须排在自动建图之前 —— 否则加载期间会再触发一次全量索引',
		);

		// 负向：不得退回「以 hasGraphData() 为前提的静默 return」
		// （负向断言必须先剥注释 —— 说明里正引用了旧写法，见 ⑯ 的假失败教训）
		for (const rel of [
			'browser/codebaseGraphFindSymbol.contribution.ts',
			'browser/codebaseGraphClassHierarchy.contribution.ts',
		]) {
			assert.ok(
				!stripAllComments(rel).includes('hasGraphData'),
				`[${rel}] 不得再以 hasGraphData() 为提前返回条件 —— 无图时必须照常打开 UI 并自动建图`,
			);
		}
		// 四个入口的旧「无图静默 return」日志分支必须全部消失
		// （Open File / Find Symbol / Class Hierarchy 三个模态 + vaxSearch 里三条 QuickPick）
		for (const rel of [
			'browser/codebaseGraphFindSymbol.contribution.ts',
			'browser/codebaseGraphVaxSearch.contribution.ts',
			'browser/codebaseGraphClassHierarchy.contribution.ts',
		]) {
			const code = stripAllComments(rel);
			assert.ok(
				!code.includes('requested but graph has no data'),
				`[${rel}] 不得退回「无图静默 return」的旧日志分支 —— 用户只会看到快捷键没反应`,
			);
			assert.ok(
				!code.includes('ABORT: graph has no data'),
				`[${rel}] 不得退回「无图静默 return」的旧日志分支（ABORT 形态）`,
			);
		}
	});

	// ── 会话锁：fail-open → fail-visible（P0-3，2026-09-15）─────────────────────
	//
	// 原实现：加锁抛错时 `warn('…(fail-open)')` + `return { acquired: true };`
	// —— 即「加锁失败就当作拿到了锁，且不告诉任何人」⇒ 用户以为会话受互斥保护，
	// 实际两个窗口可能同时写同一份对话历史（表现为「消息莫名少了 / 被回退」，无从归因）。

	test('★★★ 会话锁失败必须**可见**：不得再静默放行', () => {
		assertWired('browser/agentChatService.ts', 'degraded: true', '会话锁 fail-visible');
		assertWired('browser/agentChatService.ts', 'fail-visible', '日志须标明 fail-visible（便于事后取证）');
		// ⚠ 不能断言「全文不得出现 `return { acquired: true };`」—— **成功路径**上那正是正确写法
		//（`await writeLock()` 之后）。要钉的是「**加锁失败**的那条 return 不再静默」：
		// 以日志行为锚点，检查紧随其后的返回是否带 degraded。
		const src = readSource('browser/agentChatService.ts');
		const marker = src.indexOf('fail-visible');
		assert.ok(marker > 0, '应能找到 fail-visible 日志行');
		const afterLog = src.slice(marker, marker + 400);
		assert.ok(afterLog.includes('degraded: true'), '失败分支必须返回 degraded: true');
		assert.ok(
			!afterLog.includes('return { acquired: true };'),
			'失败分支不得再静默放行（必须带 degraded，由上层提示用户）',
		);
		// 同一把锁的另一半：**心跳**失败曾静默 `catch(() => {})` —— 连续 2min 不刷新，
		// 别的窗口即可接管，而本窗口仍在编辑 ⇒ 双方都以为持有锁。必须留可见痕迹。
		assertWired('browser/agentChatService.ts', 'session lock heartbeat failed', '锁心跳失败必须可见');
	});

	test('★★★ 上层必须消费 degraded 并**通知用户**（否则等于没改）', () => {
		assertWired('browser/nativeChatEditorPane.ts', 'res.degraded', 'pane 消费 degraded');
		assertWired('browser/nativeChatEditorPane.ts', '未能加锁', '必须给出用户可见的警告文案');
		// 接口必须声明该字段（否则 TS 层读不到语义；此文件在 agentStudio 之外，直接读）。
		const iface = fs.readFileSync(path.join(process.cwd(), 'src/vs/sessions/common/agentStudioService.ts'), 'utf8');
		assert.ok(iface.includes('degraded?: boolean'), '接口必须声明 degraded?: boolean');
	});

	// ── ㉓ Inno 排除清单必须与 strip 删除清单同步（防「staging 有、EXE 没有」漂移）──────
	//
	// 背景（2026-09-16 CI 日志分析）：tree-sitter 缺失**不在构建过程**，而在
	// `build/win32/code.iss` 的 `[Files] Excludes` —— 它把
	// `resources\app\node_modules\@vscode\tree-sitter-wasm`（含 `\**`）**显式排除**，
	// 于是 Inno 根本不把它打进 EXE；而前面四道保障（install-deps §5.4 / strip-before-pack /
	// verify-staging / generate-exe）**全部只检查暂存目录** ⇒ 一律 [OK]，
	// 真机却 `.../@vscode/tree-sitter-wasm/wasm/tree-sitter.js  ERR_FILE_NOT_FOUND`。
	// 该排除自 2026-06-05（`51a552dcdc7`）起一直在 main ⇒ 那之后**每个 EXE 都缺**，
	// 于是 08-11「fix: CI 保障语法高亮 wasm 进包」与 09-15 的两道新校验**注定无效**（校验盲区）。
	//
	// 成因：`.iss` 的 Excludes 是 `strip-before-pack.mjs` 删除清单的**手抄镜像**，两边各写一遍
	// ⇒ 漂移（tree-sitter-wasm 只在 .iss 里被排除，strip 侧反而在**保障**它）。本用例把两者钉死。
	test('★★ Inno 排除清单必须与 strip 删除清单同步（防「staging 有、EXE 没有」漂移）', () => {
		const issSrc = fs.readFileSync(path.join(process.cwd(), 'build/win32/code.iss'), 'utf8');
		const stripSrc = fs.readFileSync(path.join(process.cwd(), 'build/saros/strip-before-pack.mjs'), 'utf8');

		// strip 真正删除的 node_modules 包（包名取 removeDir 第一个参数，写法与 .iss 同形）
		const stripDeleted = new Set<string>();
		for (const m of stripSrc.matchAll(/removeDir\('([^']+)',\s*'resources\/app\/node_modules\//g)) {
			stripDeleted.add(m[1]);
		}
		assert.ok(
			stripDeleted.size >= 5,
			`[strip] 只解析到 ${stripDeleted.size} 个被删包 —— strip 写法变了，先修本测试的正则（否则本用例恒真）`,
		);

		// .iss Excludes 里被排除的 node_modules 包（去 `\**` 后缀、去重）；
		// 上游自带排除（@github / @microsoft / node-pty / ms-vscode.*）与本仓瘦身清单无关 ⇒ 不参与比对
		const issExcluded: string[] = [];
		for (const m of issSrc.matchAll(/\\resources\\app\\node_modules\\([^,;"]+)/g)) {
			const pkg = m[1].replace(/\\/g, '/').replace(/\/\*\*$/, '');
			if (/^(@github|@microsoft|node-pty|ms-vscode\.)/.test(pkg)) { continue; }
			if (!issExcluded.includes(pkg)) { issExcluded.push(pkg); }
		}
		assert.ok(issExcluded.length > 0, '[code.iss] 未解析到任何 node_modules 排除项 —— 解析失效，先修本测试');

		// ① 硬断言：运行时按**字符串路径**加载的包绝不能被排除
		//    （`codebaseGraphParserPool._initPool` → `<appRoot>/node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter.js`）
		assert.ok(
			!issExcluded.includes('@vscode/tree-sitter-wasm'),
			'[code.iss] 不得排除 @vscode/tree-sitter-wasm —— staging 会有（四道校验全 [OK]）但 EXE 里没有，'
			+ '真机必然 ERR_FILE_NOT_FOUND（2026-09-16 事故根因）',
		);

		// ② 漂移不变式：.iss 排除的包必须是 strip 也删除的（两条清单必须同源）。
		//    例外：这两个是**有意**排除、且 strip 侧保留（缺失只降级遥测/策略，不崩）—— 属已知冗余，
		//    登记在此以免被误判成新漂移；若日后启用遥测/策略功能再重新评估。
		const INTENTIONAL_ISS_ONLY = ['@vscode/deviceid', '@vscode/policy-watcher'];
		for (const pkg of issExcluded) {
			if (INTENTIONAL_ISS_ONLY.includes(pkg)) { continue; }
			assert.ok(
				stripDeleted.has(pkg),
				`[code.iss] 排除了 "${pkg}"，但 strip-before-pack.mjs 不删除它 —— 两条清单已漂移：`
				+ `staging 会保留该包而 EXE 缺它（正是 tree-sitter 缺包的成因）。`
				+ `要么从 .iss 的 Excludes 里删掉它，要么在 strip 里一并删除。strip 已删清单：${[...stripDeleted].join(', ')}`,
			);
		}
		// ③ 登记表不得腐烂：写进 INTENTIONAL_ISS_ONLY 的包必须真的还在 .iss 里被排除
		for (const pkg of INTENTIONAL_ISS_ONLY) {
			assert.ok(issExcluded.includes(pkg), `[code.iss] 已不再排除 "${pkg}"，请把它从 INTENTIONAL_ISS_ONLY 里删掉`);
		}
	});

	// ── ㉔ SQLite 按需载入：keyset 分页 + 时间切片（防主线程长冻结）──────────────────
	//
	// 背景（2026-09-16 日志 + 代码核实）：`_loadGraphFromSqlite()` 修掉 `push(...nodes)` 栈溢出后
	// **仍会卡** —— ① `getAllNodes(p)`/`getAllEdges(p)` 一次全量跨 IPC（主进程 stringify + renderer
	// **同步** parse，实测 13~32s）；② 两段**无 yield** 的长循环（upsert 34~78 万次，insertEdge
	// 通常 2~4 倍节点数）。★ 注意那 13~32s 是**抛错之前**的耗时 ⇒ 修栈溢出 ≠ 不卡。
	// 现改为 keyset 分页（O(n)；`LIMIT/OFFSET` 是 O(offset) 累计）+ 与 `common/asyncSlice` 同口径切片。
	test('★★ SQLite 按需载入：keyset 分页 + 时间切片（防主线程长冻结）', () => {
		const svcRel2 = 'browser/codebaseGraphService.ts';
		assertWired(svcRel2, 'const SQLITE_LOAD_PAGE_SIZE = 5000;', '分页大小常量');
		assertWired(svcRel2, 'getAllNodes(p, SQLITE_LOAD_PAGE_SIZE, undefined, cursor)', '节点走 keyset 分页');
		assertWired(svcRel2, 'getAllEdges(p, SQLITE_LOAD_PAGE_SIZE, undefined, cursor)', '边走 keyset 分页');
		assertWired(svcRel2, 'sliceBudgetExceeded(sliceStart)', '按时间预算判定是否让出');
		assertWired(svcRel2, 'await yieldToEventLoop();', '超预算即让出主线程');
		// 四段接线：IPC 契约 → 主进程透传 → SQL keyset → 边带回游标
		assertWired('common/codebaseGraphStoreChannel.ts', 'getAllNodes(project?: string, limit?: number, offset?: number, afterId?: number): Promise<GraphNode[]>;', 'IPC 契约第 4 参（节点）');
		assertWired('common/codebaseGraphStoreChannel.ts', 'getAllEdges(project?: string, limit?: number, offset?: number, afterId?: number): Promise<GraphEdge[]>;', 'IPC 契约第 4 参（边）');
		assertWired('electron-main/codebaseGraphStoreChannel.ts', "case 'getAllNodes': return s.getAllNodes(args![0] as string | undefined, args![1] as number | undefined, args![2] as number | undefined, args![3] as number | undefined)", '主进程透传 afterId');
		assertWired('node/codebaseGraphSqliteStore.ts', "where.push('id > ?');", 'SQL keyset（节点）');
		assertWired('node/codebaseGraphSqliteStore.ts', 'AND e.id > ?', 'SQL keyset（边）');
		assertWired('node/codebaseGraphSqliteStore.ts', 'id: String(r.id),', '边带回行 id 作游标');

		// 负向：不得退回「一次全量拉取 + 无切片长循环」
		const svcCode = stripAllComments(svcRel2);
		assert.ok(
			!svcCode.includes('await this._sqliteBackend.getAllNodes(p);')
			&& !svcCode.includes('await this._sqliteBackend.getAllEdges(p);'),
			'[SQLite 载入] 不得退回一次性全量拉取 —— 几十万对象跨 IPC 会在 renderer 同步 parse 卡住十几秒',
		);
		assert.ok(
			!svcCode.includes('allNodes.push(...nodes)'),
			'[SQLite 载入] 不得退回 `push(...nodes)` —— 数十万实参会抛 Maximum call stack size exceeded',
		);
	});
});
