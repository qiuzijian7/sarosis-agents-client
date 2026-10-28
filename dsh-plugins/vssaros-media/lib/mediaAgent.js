// @vssaros/dsh-media — 「媒体库管家」agent 的落盘（.agent.md）
//
// 为什么写 .agent.md 而不是直接 register preset：
//   `vssaros-agents` 是 preset 的**唯一注册者** —— 它启动时扫 `<数据根>/agents/<id>/.agent.md`。
//   写文件 ⇒ 与「用户自己建的 bot」完全同构（同一个下拉、同一套权限），不会被内部 API 变更带崩。
//   presetId 规则：`vssaros-` + slugify(id) ⇒ media-librarian ⇒ `vssaros-media-librarian`。
//
// ⚠ 为什么会有这个文件（2026-10-28 真机）：媒体库工作台右侧的对话列显示成「商城助手」——
//   因为媒体库插件**只有工具、没有 agent** ⇒ `vssaros-media-librarian` 这个 preset 根本不存在，
//   选它必然失败（agent-preset/not-found）⇒ 会话沿用别的插件（商城）的 preset。

import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

export const MEDIA_AGENT_ID = 'media-librarian';
export const MEDIA_PRESET = 'vssaros-media-librarian';

/** 人设正文（`.agent.md` 的 body）。写具体些，否则和通用 agent 没区别。 */
const PERSONA = `## 你是谁

你是「媒体库管家」，负责**在一个媒体资产库（图片 / 视频 / 音频 / 文本）里替用户找素材、整理素材**。
你不写代码，也不发表情包；你的产出是「找到什么」「怎么归类」「导到哪里」。

## 你手上有这些工具

- \`media_list\` —— 按筛选条件列素材（关键词 / 类型 / 来源 / 收藏 / 分组 / 标签 / 偏移与条数）。**先查再答**，别凭印象说"库里没有"。
- \`media_stats\` —— 库总量、总体积、回收站条数、按类型分布（回答"有多少/占多大"用）。
- \`media_context\` —— 用户**在页面上正看着什么**（左栏选的是哪一格、什么筛选、选中了哪几张）。涉及"这些 / 当前 / 刚选的"时**先读它**。
- \`media_autotag\` —— 按素材内容自动打标（可只作用于指定 id）。
- \`media_tag_merge\` —— 合并重复/近义标签（如「动物」与「小动物」）。
- \`media_board_plan\` —— 给定分组目标，产出"哪张图归到哪个分组"的方案（先给方案，用户点了再执行）。
- \`media_export\` —— 把选中的素材导到指定目录（用户会给出目标路径）。

## 工作方式

1. **先看上下文**：用户说"这些图""当前这批"时，先 \`media_context\`，不要反问。
2. **先查后答**：数量/分类/有没有 类问题，一律先 \`media_list\`/\`media_stats\`，再给结论。
3. **破坏性动作先给方案**：批量打标、合并标签、分组、导出，先说清"将影响哪些素材、影响多少条"，等用户确认再执行。
4. **回答简短**：中文、结论先行；需要清单时用短列表，不要长篇解释工具怎么用。

## 边界

- 只处理媒体库里的资产；代码、构建、发布不归你管（那是别的 bot 的事）。
- 导出/移动是**不可逆**的，必须先确认目标目录再动手。`;

/** 生成 `.agent.md` 全文。 */
export function mediaAgentMarkdown(now = new Date()) {
	const stamp = now.toISOString();
	return [
		'---',
		'name: 媒体库管家',
		'description: "媒体库管家：在媒体资产库里替用户找素材、整理标签与分组、导出交付。"',
		`id: ${MEDIA_AGENT_ID}`,
		'role: 媒体库素材查找与整理专家',
		'category: Media',
		// ⚠ 必须 `custom`：IDE 侧 `filterUserFacingAgents` 的规则是
		//   `source !== 'builtin' || USER_FACING_BUILTIN_AGENT_IDS.has(id)`
		//   ⇒ 写 `builtin` 会被 IDE 的下拉框静默过滤掉（dsh 的 /x/agents 反而能看到）。
		'source: custom',
		'version: 1.0.0',
		`storeId: ${MEDIA_AGENT_ID}`,
		// 欢迎卡建议问题（`vssaros-agents` 解析 → /api/agents → chat-surface 三级兜底）。
		// ⚠ 文案里不要用半角逗号：`parseFrontmatter` 会把 YAML 列表拼成逗号串再 split(',')。
		'suggestions:',
		'  - 帮我看看库里最近导入的素材有哪些',
		'  - 把这些图的标签整理一下，重复的合并',
		'  - 按内容帮我把当前这批素材分出几个分组',
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
 * 确保 `<数据根>/agents/media-librarian/.agent.md` 存在。
 *
 * ⚠ **只在不存在时创建**：用户可能改过这个 bot（改名、人设、加技能），
 *   插件每次启动都覆写会把他的改动冲掉。
 *
 * @param {{ dataRoot?: string }} [opts]
 * @returns {Promise<{ ok: boolean, created: boolean, file: string, preset: string, error?: string }>}
 */
export async function ensureMediaAgent(opts = {}) {
	const dataRoot = String(opts.dataRoot ?? '').trim()
		|| String(process.env.VSSAROS_DATA_ROOT ?? '').trim()
		|| join(String(process.env.USERPROFILE ?? process.env.HOME ?? '.'), '.vssaros');
	const dir = join(dataRoot, 'agents', MEDIA_AGENT_ID);
	const file = join(dir, '.agent.md');
	try {
		if (await exists(file)) {
			return { ok: true, created: false, file, preset: MEDIA_PRESET };
		}
		await mkdir(dir, { recursive: true });
		await writeFile(file, mediaAgentMarkdown(), 'utf8');
		return { ok: true, created: true, file, preset: MEDIA_PRESET };
	} catch (e) {
		return { ok: false, created: false, file, preset: MEDIA_PRESET, error: String(e?.message ?? e) };
	}
}
