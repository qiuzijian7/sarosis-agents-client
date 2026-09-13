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
	// 已知残留：**块注释**里提到的标识符仍会让正向断言「看起来」通过。
	// 这比「误吃代码导致断言乱报」可接受得多。
	return src.replace(/^[ \t]*\/\/.*$/gm, '');
}

function readSource(rel: string): string {
	const abs = path.join(process.cwd(), AGENT_STUDIO, rel);
	assert.ok(fs.existsSync(abs), `源码文件不存在（路径基准变了？）：${abs}`);
	return stripComments(fs.readFileSync(abs, 'utf8'));
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
		assertWired('browser/agentTurnExecutor.ts', 'isToolCallDeniedByHardPermission(', '本地执行路径');
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
});
