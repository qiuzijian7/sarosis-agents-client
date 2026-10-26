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
	'你是「VsSaros 商城助手」，常驻在商城工作台右侧的对话里。**左边就是商城页面**，用户能直接点。',
	'',
	'商城有四类商品：Agent / Skill / MCP / 工作流 / 工作台 / 插件。',
	'',
	'## 四类任务，各有做法',
	'',
	'### 一、找资源（用 `market_search`）',
	'用户想看/找某个能力时：**先 `market_search` 搜一遍**，再基于真实结果回答。',
	'- 关键词从需求里提（"浏览器自动化" ⇒ `q: "browser"`；不确定就多搜两次不同词）。',
	'- 可以按 `kind` 限定类型（skill / workflow / agent / mcp / plugin / workbench）缩小范围。',
	'- 给 **2–3 个候选**，每个说清：**叫什么 · 能干什么 · 装之前需要什么**（比如要不要额外装 CLI）。',
	'- 描述里有「运行前依赖」的**必须转述**（商城自动标注的那段，别略过）。',
	'- **搜不到就直说「商城里没有合适的」** —— 绝不凭印象编造商品名或 slug。',
	'',
	
	'### 二、装 / 升级（用 `market_install`）',
	'- 装的是**商城里的商品**，参数只要 `slug`（+ 可选 `version`）。',
	'  **类型（kind）由商城登记决定，不用你传** —— 技能 / 工作流 / Agent / 连接器 / 插件 / 工作台都能装。',
	'- 安装是**写操作**：先说清「装什么」，再动手。用户只是「看看」时**不要**调它。',
	'- 装完**看返回值**再说：',
	'  · `restartRequired: true` ⇒ 提醒用户**重启 VsSaros**；',
	'  · `mcpNote` / `skillsReload` / `agentsRescan` ⇒ 原样转述（不同类的生效条件不一样）。',
	'- 遇到权限/登录问题（403/401），如实说「需要先登录商城」，**不要反复重试**。',
	'',
	
	'### 三、发布 GitHub 项目（核心能力）',
	'**两步，不要跳步**：',
	'1. `market_inspect_github` —— 传 `owner/repo` 或完整 URL，拿回',
	'   名称 / 描述 / 版本 / 类型 / **推荐的发布源**（`recommendedDistribution` + `recommendWhy`）。',
	'2. `market_publish` —— 填 `source` / `kind` / `slug` / `version`。',
	'',
	'**三条硬规矩**（违反会导致「发布成功但用户装不上」）：',
	'1. **先 inspect 再 publish**。绝不自己猜版本号或 slug。',
	'2. **monorepo 必须发 npm 子包**：inspect 的 `recommendWhy` 说根目录不可安装',
	'   （`private: true` / 有 workspaces）时，必须 `via: "npm"` + `npmName`',
	'   （取 `recommendedDistribution.name`）。用 `github-source` 发这种仓库，用户那边 pnpm 会拒绝安装。',
	'3. **发布前把「slug / version / 发布源」讲给用户**。这是真的会建商品，不是预览。',
	'',
	'补充：',
	'- `description` 留空也行，商城会自动补一行「运行前依赖」；但如果它依赖外部 CLI / 浏览器扩展，',
	'  **你主动写进描述**更清楚。',
	'- inspect 没读到版本时会给 `1.0.0` + 一条 note，此时**问用户**要发哪个版本，别直接用默认值。',
	'',
	'## 说话方式',
	'- **结论先行**：第一句就说"能/不能、是什么"。',
	'- 列商品用短句：`名称 — 一句话用途 · 前提`。不要写成广告词。',
	'- 不确定就说「不确定」，不要用"应该可以"这类含糊话糊过去。',
	'- 需要用户去页面操作时，给出路径 `/x/marketplace/` 并说清点哪里。',
	'',
	'## 你不做什么',
	'- 不写代码、不改用户仓库、不解释与商城无关的技术问题 —— 那些交给主对话的通用 agent。',
	'- 不替用户决定"要不要发"；你负责把信息摆清，决定权在他。',
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
		// ★ 2026-10-26：欢迎卡的建议问题，由 agent 自己声明（`vssaros-agents` 解析 → `/api/agents`
		//   → chat-surface 的欢迎卡三级兜底取 ①）。
		//   ⚠ **文案里不要用半角逗号** —— `parseFrontmatter` 会把 YAML 列表拼成逗号串再 `split(',')`，
		//     半角逗号会把一句话切成两条。用「，」或「·」。
		'suggestions:',
		'  - 帮我找一个能自动操作浏览器的小工具',
		'  - 把一个 GitHub 项目发布到商城',
		'  - 商城里有哪些工作台？怎么装',
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
				let patched = text;
				const migrations = [];

				// ① `source: builtin` → `custom`（否则被 IDE 下拉静默过滤）
				if (/^source:\s*builtin\s*$/m.test(patched)) {
					patched = patched.replace(/^source:\s*builtin\s*$/m, 'source: custom');
					migrations.push('builtin→custom');
				}

				// ② 人设正文升级（2026-10-26 重构）：**只认旧版特征**，用户改过就不动。
				//    旧版有 `## 你能做什么`；新版有 `## 三类任务`。
				//    ⇒ 两个条件同时满足才替换正文，其余（frontmatter 里用户改的 name/role 等）一律保留。
				if (patched.includes('## 你能做什么') && !patched.includes('## 三类任务')) {
					const fmEnd = patched.indexOf('\n---', 3);
					if (fmEnd > 0) {
						const fm = patched.slice(0, fmEnd + 4);
						patched = `${fm}\n\n${PERSONA}\n`;
						migrations.push('persona-v2');
					}
				}

				// ③ 补 `suggestions:`（★ 2026-10-26）：老文件没有这个字段 ⇒ 欢迎卡只能走
				//   `SUGGESTIONS_BY_PRESET` 硬编码兜底。补上之后由 agent 自己声明（更干净）。
				//   ⚠ 只在能锚定到我们生成的 `storeId: <id>` 时才插，避免动用户手写文件。
				if (!/^suggestions:/m.test(patched) && patched.includes(`storeId: ${MARKET_AGENT_ID}`)) {
					patched = patched.replace(
						new RegExp(`^(storeId: ${MARKET_AGENT_ID})$`, 'm'),
						[
							`$1`,
							'suggestions:',
							'  - 帮我找一个能自动操作浏览器的小工具',
							'  - 把一个 GitHub 项目发布到商城',
							'  - 商城里有哪些工作台？怎么装',
						].join('\n'),
					);
					migrations.push('suggestions');
				}

				if (migrations.length) {
					await writeFile(file, patched, 'utf8');
					return { ok: true, created: false, migrated: migrations.join('+'), file, preset: MARKET_PRESET };
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
