/**
 * 商城专用 agent（★ 2026-10-26 用户需求：
 * 「商城工作台中… 新建会话时，使用专门的商城 agent」）。
 *
 * ## 为什么要落成 `.agent.md`，而不是直接 `ctx.agentPresets.register()`
 * `vssaros-agents` 是 preset 的**唯一注册者**：它启动时扫 `<数据根>/agents/<id>/.agent.md`
 * 逐个 `ctx.agentPresets.register()`（见 `vssaros-agents/lib/index.js` 头注释 L4）。
 * 两条路对比：
 *
 * | 做法 | 问题 |
 * |---|---|
 * | 本插件直接 register | 要 import `@vssaros/dsh-agents/lib/core/agents.js` 的
 *   `toPresetDefinition`（它依赖 `presetBase.generated.js` 的共享基座）⇒ **跨插件深层依赖**，
 *   换装法（pnpm 软链 vs 目录拷贝）路径就变了 ✗ |
 * | **写 `.agent.md`** | `vssaros-agents` 启动时自然扫到 ⇒ 与"用户自己建 bot"完全同构 ✓ |
 *
 * ⇒ 选后者。代价是**首次创建后要重启一次 Host** 才会被扫描到（如实告知用户）。
 *
 * ## 为什么**不写 `tools` 白名单**
 * `agents.js` 的 `allowlistDenyOf` 会**把不在白名单里的工具全 deny**
 * （本项目踩过：`saroasis-studio` 会话里只剩 `skill` + `subagent`，因为 `tools` 里
 * 写的是 VS Code 口径的名字，没映射上 ⇒ agent 直接变哑巴 ✗）。
 * ⇒ 省略 `tools` = 用全套工具（含商城的 `market_inspect_github` / `market_publish`），
 *   **靠人设约束范围**而不是靠白名单。宁可工具多，不能一个都没有。
 */

import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';

/** agent id（同时是目录名）。⚠ 必须 `[a-z][a-z0-9-]*`，它会进 preset id。 */
export const MARKET_AGENT_ID = 'marketplace-bot';

/**
 * 对应的 preset id。
 * 规则见 `vssaros-agents/lib/core/agents.js`：`presetIdOf = 'vssaros-' + slugify(id)`
 * ⇒ `marketplace-bot` → `vssaros-marketplace-bot`（**不要**自己再加一层 `vssaros-`，
 *   那会变成 `vssaros-vssaros-*`，永远 `agent-preset/not-found`）。
 */
export const MARKET_PRESET = 'vssaros-marketplace-bot';

/** 人设正文（`.agent.md` 的 body）。写得具体些，否则和通用 agent 没区别。 */
const PERSONA = [
	'你是「VsSaros 商城助手」，常驻在商城工作台右侧的对话里，帮用户**查找**和**发布**商城资源。',
	'',
	'## 你能做什么',
	'- **查找**：帮用户在商城里找 Agent / Skill / MCP / 工作流 / 工作台 / 插件。优先用商城的搜索能力（`market_inspect_github` 之外，页面左侧就是商城，可以引导用户点具体页签）。',
	'- **发布 GitHub 项目**（核心能力，两步）：',
	'  1. `market_inspect_github`：传 `owner/repo` 或完整 URL，读回名称 / 描述 / 版本 / 类型 / **推荐的发布源**。',
	'  2. `market_publish`：填 `source` / `kind` / `slug` / `version` 发布。',
	'',
	'## 发布时的硬规矩',
	'- **先 inspect，再 publish**。不要跳过第一步直接猜版本号或 slug。',
	'- **monorepo 必须用 npm 子包**：如果 inspect 返回的 `recommendWhy` 说根目录不可安装',
	'  （`private: true` / 有 workspaces），就必须用 `via: "npm"` + `npmName`（取',
	'  `recommendedDistribution.name`）。用 `github-source` 发布这种仓库会「发布成功但用户装不上」。',
	'- **不要自己编版本号**。inspect 给了 `version` 就用它；没给就问用户。',
	'- `description` 可以留空，商城会自动补一行「运行前依赖」；',
	'  但如果这个工具/插件依赖外部 CLI 或浏览器扩展，**请主动在描述里写清**。',
	'- 发布是**写操作**，会真的在商城建商品。执行前把 `slug` / `version` / `发布源` 讲给用户听。',
	'',
	'## 风格',
	'- 说人话，先说结论再说细节；列商品时说清楚它是什么、能干什么。',
	'- 不确定就明说「不确定」，不要编造商城里的商品。',
	'- 商城页面的路径是 `/x/marketplace/`，需要用户去看时给出这个地址。',
].join('\n');

/** 生成 `.agent.md` 全文。 */
export function marketAgentMarkdown(now = new Date()) {
	const stamp = now.toISOString();
	return [
		'---',
		'name: 商城助手',
		'description: "VsSaros 商城助手：帮你查找商城资源（Agent / Skill / MCP / 工作流 / 工作台 / 插件），并把 GitHub 项目发布上架（自动识别 monorepo 并选对发布源）。"',
		`id: ${MARKET_AGENT_ID}`,
		'role: 商城资源查找与发布专家',
		'category: Marketplace',
		// ⚠ **必须 `custom`**（★ 2026-10-26 真机定位到的根因）：
		//   IDE 侧 `filterUserFacingAgents` 的规则是
		//   `source !== 'builtin' || USER_FACING_BUILTIN_AGENT_IDS.has(id)`
		//   白名单只有 saros-claw / knowledge-base-expert / tob / mediaclawer
		//   ⇒ 写 `builtin` 会被 **IDE 的下拉框静默过滤掉**（dsh 的 /x/agents 反而能看到，两边规则不同）✗
		'source: custom',
		'version: 1.0.0',
		`storeId: ${MARKET_AGENT_ID}`,
		`createdAt: "${stamp}"`,
		`updatedAt: "${stamp}"`,
		'---',
		'',
		PERSONA,
		'',
	].join('\n');
}

async function exists(file) {
	try { await access(file); return true; } catch { return false; }
}

/**
 * 确保 `<数据根>/agents/marketplace-bot/.agent.md` 存在。
 *
 * ⚠ **只在不存在时创建**：用户可能改过这个 bot（改名、改人设、加技能），
 *   插件每次启动都覆写会把他的改动冲掉 ✗
 *
 * @param {{ dataRoot?: string }} [opts] `dataRoot` 缺省用 `~/.vssaros`
 * @returns {Promise<{ ok: boolean, created: boolean, file: string, preset: string, error?: string }>}
 */
export async function ensureMarketAgent(opts = {}) {
	const dataRoot = String(opts.dataRoot ?? '').trim()
		|| String(process.env.VSSAROS_DATA_ROOT ?? '').trim()
		|| join(String(process.env.USERPROFILE ?? process.env.HOME ?? '.'), '.vssaros');
	const dir = join(dataRoot, 'agents', MARKET_AGENT_ID);
	const file = join(dir, '.agent.md');
	try {
		if (await exists(file)) {
			// ★ 迁移（★ 2026-10-26 真机定位到的根因）：早期版本写的是 `source: builtin`
			//   ⇒ 被 IDE 的 `filterUserFacingAgents` **静默过滤掉**，下拉框里根本看不到。
			//   只改这一行，**不动用户改过的其它内容**（人设 / 名字 / 技能）。
			try {
				const text = await readFile(file, 'utf8');
				if (/^source:\s*builtin\s*$/m.test(text)) {
					const patched = text.replace(/^source:\s*builtin\s*$/m, 'source: custom');
					await writeFile(file, patched, 'utf8');
					return { ok: true, created: false, migrated: 'builtin→custom', file, preset: MARKET_PRESET };
				}
			} catch { /* 迁移失败不影响流程（下次还会再试） */ }
			return { ok: true, created: false, file, preset: MARKET_PRESET };
		}
		await mkdir(dir, { recursive: true });
		await writeFile(file, marketAgentMarkdown(), 'utf8');
		return { ok: true, created: true, file, preset: MARKET_PRESET };
	} catch (e) {
		return { ok: false, created: false, file, preset: MARKET_PRESET, error: String(e?.message ?? e) };
	}
}
