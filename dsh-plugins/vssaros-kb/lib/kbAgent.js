/**
 * 知识库专用 agent（★ 2026-10-31 用户需求：
 * 「dsh 侧知识库中，AI 助手应该显示 知识库 agent」）。
 *
 * ## 为什么必须落成 `.agent.md`，而不是直接 `ctx.agentPresets.register()`
 * `vssaros-agents` 是 preset 的**唯一注册者**：它启动时扫 `<数据根>/agents/<id>/.agent.md`
 * 逐个 register。本插件直接 register 要 import `toPresetDefinition`（依赖共享基座）⇒
 * 跨插件深层依赖、换装法路径就变 ✗（商城 `marketAgent.js` 已经踩过，照抄结论）。
 *
 * ## 为什么 id 用 `kb-expert` 而不是 `knowledge-base-expert`
 * `knowledge-base-expert` **是内置 agent 的 id**（`builtinAgents.ts` 的
 * `USER_FACING_BUILTIN_AGENT_IDS` 白名单里就有它）。若在数据根里写同名 agent，
 * 两套注册会发生同名冲突/遮蔽 ⇒ 用一个**独立的 id**，名字仍叫「知识库专家」✓
 *
 * ⇒ preset id = `vssaros-` + slugify(id) = **`vssaros-kb-expert`**
 *   （⚠ 规则在 `vssaros-agents/lib/core/agents.js` 的 `presetIdOf`，
 *    自己再加一层 `vssaros-vssaros-*` 会永远 `agent-preset/not-found`）
 *
 * ## 为什么**不写 `tools` 白名单**
 * `allowlistDenyOf` 会把不在白名单里的工具**全 deny**（本项目踩过：写错名字 ⇒
 * agent 直接变哑巴）⇒ 省略 `tools` = 全套工具，靠人设约束范围。宁可工具多，不能一个都没有。
 */
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';

/** agent id（同时是目录名）。⚠ 必须 `[a-z][a-z0-9-]*`，它会进 preset id。 */
export const KB_AGENT_ID = 'kb-expert';

/** 对应的 preset id（`presetIdOf(KB_AGENT_ID)`）。 */
export const KB_PRESET = 'vssaros-kb-expert';

/**
 * 客户端优先尝试的 preset id 顺序。
 *
 * ⚠ 第一项是**内置** `knowledge-base-expert`：它是官方"知识库专家"，
 *   若运行时花名册里有它，用它最省事（人设是官方的）。
 *   第二项是本插件落的 `vssaros-kb-expert`（保证一定有）。
 */
export const KB_PRESET_CANDIDATES = ['knowledge-base-expert', KB_PRESET];

const PERSONA = [
	'你是「知识库专家」，常驻在知识库工作台右侧的对话里。**左边就是知识库面板**，用户能直接点。',
	'',
	'你的职责是把用户的资料整理成**能被检索、能复用**的知识，而不是泛泛地聊天。',
	'',
	'## 四类任务',
	'',
	'### 一、找东西（先看库，再回答）',
	'- 用户问"我之前写过什么/那个方案在哪"，**先在知识库里搜**（全文/文件名两种口径都试），再基于真实命中回答。',
	'- 命中多条时给出：**标题 · 路径 · 一句话说明它讲什么**，让用户自己挑。',
	'- **搜不到就说搜不到**，不要凭印象编造笔记名或结论。',
	'',
	'### 二、读与总结',
	'- 长文先给**结论**（3–5 行），再给要点；不要从头复述。',
	'- 涉及代码/配置时保留原样，别改写；引用时带上路径。',
	'- 库里有多篇讲同一件事时，**指出冲突**（哪篇说 A、哪篇说 B），不要自己合并成一个说法。',
	'',
	'### 三、写与改（走工具，不要凭空生成）',
	'- 新建/改写笔记**必须落盘**（用知识库的写接口），不要只在对话里给一段文字。',
	'- 改之前先说清"改哪篇、改什么"；改完回报**路径 + 变更摘要**。',
	'- 素材区（`库/raw`）是**原始素材**，成稿在 `笔记/`；不要混着放。',
	'',
	'### 四、版本与安全',
	'- 库里开了本地 Git 版本管理（每次保存自动一个版本）⇒ 用户问"改坏了怎么办"时，引导他用版本面板**查看/恢复**，不要让他手抄备份。',
	'- **不要把私人内容往外发**：涉及发布/分享时，先提醒他检查隐私（本机路径、邮箱、手机号、内网地址）。',
	'',
	'## 说话方式',
	'- 结论先行；路径用 `库/方法/xxx.md` 这种可点的形式。',
	'- 不确定就说"不确定"，并说清**缺哪条信息**才能确定。',
	'- 需要用户点界面时，说清点哪里（左栏树 / 细条「版本」/ 设置）。',
	'',
	'## 你不做什么',
	'- 不替用户决定"这篇要不要删"；你负责摆清影响，决定权在他。',
	'- 不解释与知识库无关的通用技术问题（那些交给主对话的通用 agent）。',
].join('\n');

/** 生成 `.agent.md` 全文。 */
export function kbAgentMarkdown(now = new Date()) {
	const stamp = now.toISOString();
	return [
		'---',
		'name: 知识库专家',
		'description: "VsSaros 知识库专家：在库里检索/总结/整理笔记，改写必落盘，涉及发布时先做隐私检查。"',
		`id: ${KB_AGENT_ID}`,
		'role: 知识库检索与整理专家',
		'category: Knowledge',
		// ⚠ 必须 `custom`：IDE 侧 `filterUserFacingAgents` 的规则是
		//   `source !== 'builtin' || USER_FACING_BUILTIN_AGENT_IDS.has(id)`
		//   ⇒ 写 `builtin` 会被**静默过滤掉**（dsh 的 /x/agents 反而看得到，两边规则不同）
		'source: custom',
		'version: 1.0.0',
		`storeId: ${KB_AGENT_ID}`,
		// 欢迎卡建议问题由 agent 自己声明（三级兜底的第一级）
		// ⚠ 文案里不要用半角逗号 —— `parseFrontmatter` 会把列表拼成逗号串再 split(',')
		'suggestions:',
		'  - 帮我在库里找讲「差分图压缩」的那篇',
		'  - 把这篇笔记整理成一份可复用的检查清单',
		'  - 我上次改坏了某篇·怎么恢复',
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

/** 解析 dsh 数据根（与商城 `marketAgent.js` 同口径，避免两处漂移）。 */
function dataRootsOf(opts = {}) {
	const out = [];
	const add = (v) => {
		const s = String(v ?? '').trim();
		if (s && !out.includes(s)) { out.push(s); }
	};
	add(opts.dataRoot);
	add(process.env.VSSAROS_DATA_ROOT);
	const home = String(process.env.USERPROFILE ?? process.env.HOME ?? '.');
	// ⚠ 生产/开发两个根都写一份（扫描器只读自己的根；写多一份的代价远小于"猜错了没有 agent"）
	add(join(home, '.vssaros'));
	add(join(home, '.vssaros-dev'));
	return out;
}

/**
 * 确保 `<数据根>/agents/kb-expert/.agent.md` 存在。
 *
 * ⚠ **只在不存在时创建**：用户可能改过这个 bot（改名、改人设），每次启动覆写会冲掉他的改动。
 *
 * @param {{ dataRoot?: string }} [opts]
 * @returns {Promise<{ ok: boolean, created: string[], existed: string[], preset: string, errors: string[] }>}
 */
export async function ensureKbAgent(opts = {}) {
	const roots = dataRootsOf(opts);
	const created = [];
	const existed = [];
	const errors = [];
	const text = kbAgentMarkdown();

	for (const root of roots) {
		const dir = join(root, 'agents', KB_AGENT_ID);
		const file = join(dir, '.agent.md');
		try {
			if (await exists(file)) {
				// 迁移：早期若被写成 `source: builtin` ⇒ IDE 下拉会静默过滤（只改这一行，不动用户其它内容）
				try {
					const cur = await readFile(file, 'utf8');
					if (/^source:\s*builtin\s*$/m.test(cur)) {
						await writeFile(file, cur.replace(/^source:\s*builtin\s*$/m, 'source: custom'), 'utf8');
					}
				} catch { /* 迁移失败不影响 */ }
				existed.push(file);
				continue;
			}
			await mkdir(dir, { recursive: true });
			await writeFile(file, text, 'utf8');
			created.push(file);
		} catch (e) {
			errors.push(`${file}: ${String(e?.message ?? e)}`);
		}
	}

	return { ok: created.length > 0 || existed.length > 0, created, existed, preset: KB_PRESET, errors };
}
