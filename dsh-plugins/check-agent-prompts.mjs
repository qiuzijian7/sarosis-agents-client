/*
 * 守卫：**内置 agent 提示词的结构一致性**（2026-10-27 第二版）。
 *
 * ⚠ 第一版读的是 `resources/.agents/agents/<id>/.agent.md` —— **那是产物**：
 *   Host 启动时由 `buildAgentMd()` 从 `common/builtinAgents.ts` 重新生成，
 *   改 md 不会生效（本轮真的踩到了：改完 md 以为重构完成，其实真源一字未动）。
 *   ⇒ 现在只认**真源** `builtinAgents.ts` 的 `systemPrompt` 与 `suggestions`。
 *
 * 检查项（每个条目）：
 *   ① 有 systemPrompt，且含三段约束（中英文等价都算）
 *   ② suggestions 恰好 3 条、不含半角逗号（parseFrontmatter 会把列表拼成逗号串再 split）
 *   ③ 提示词里没有重复的二级标题（重复 = 拼接事故）
 *   ④ 提示词里没有未替换的占位符（TODO / XXX / {{...}}）
 *   ⑤ 内部 agent（task-reviewer / re-reviewer）豁免 ①②：它们不面向用户、不挂欢迎卡
 *
 * ⚠ 工具名维度**不在这里查**：本脚本只能看到 `tools-snapshot.json`（插件工具），
 *   看不到官方 44 个核心工具（read/write/pwsh/glob/grep/skill…）⇒ 会大面积误报。
 *   那个维度由 `check-agent-tools.mjs` 负责（它有「官方 + 插件」全名单）。
 *
 * 跑法：node dsh-plugins/check-agent-prompts.mjs
 */
import { readFileSync } from 'node:fs';

const REPO = 'g:/SarosWorkspace/sarosis-agents-client';
const TS = REPO + '/src/vs/sessions/contrib/agentStudio/common/builtinAgents.ts';
/** 全局前缀（硬规则 / 输出纪律）所在文件 —— 它对**所有** agent 生效，所以必须单独守。 */
const CHAT = REPO + '/src/vs/sessions/contrib/agentStudio/common/chatModeConfig.ts';

/** 三段约束的**中英文等价集合**（coder / tob 一直用英文小标题，不该为守卫改文风） */
const SECTIONS = [
	['什么时候停下来问', /(什么时候停下来问|Stop\s*&\s*ask|When to stop)/i],
	['完成前的自检', /(完成前的自检|Verify before done|Verification)/i],
	['输出约定', /(输出约定|Output format|^##\s*Output\b)/im],
];

/**
 * 内部 agent：不面向用户、不挂欢迎卡、由其他 agent 调起 ⇒ 不要求三段约束。
 * （它们也没有 `.agent.md` 产物，不是 Agent Studio 里能编辑的那种。）
 */
const INTERNAL = new Set(['task-reviewer', 're-reviewer']);

let pass = 0;
const failed = [];
const t = (name, ok, extra = '') => {
	if (ok) { pass += 1; return; }
	failed.push(name);
	console.log(`FAIL  ${name}${extra ? '  — ' + extra : ''}`);
};

const src = readFileSync(TS, 'utf8');
const marks = [...src.matchAll(/^\t\t\tid: '([^']+)',$/gm)];
t('找到内置 agent 条目（≥15）', marks.length >= 15, 'got=' + marks.length);

/**
 * 判定「提示词里点名的东西是不是工具」用的已知名单。
 *   插件工具来自 `tools-snapshot.json`（真源快照），核心工具写死在这里
 *   （它们不随插件走，所以快照里没有）。
 */
const KNOWN_TOOLS = new Set(['read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'skill', 'task', 'web_search', 'web_fetch']);
try {
	const snap = JSON.parse(readFileSync(REPO + '/dsh-plugins/tools-snapshot.json', 'utf8'));
	for (const list of Object.values(snap.plugins ?? {})) {
		for (const it of list ?? []) { if (it && typeof it.name === 'string') { KNOWN_TOOLS.add(it.name); } }
	}
} catch { /* 快照缺失 ⇒ 只按核心工具判，其余不误报 */ }

/**
 * 工具锚点的**技术债名单**：这些 agent 的提示词还没按五段模板重写，
 * 反引号锚点不足 3 个。名单只允许变短（每重写一个就删一行），
 * 留着是为了让债务可见，而不是让守卫放水。
 */
const ANCHOR_GAP = new Set([]);   // 2026-10-27：6 个 agent 全部补齐 ⇒ 债务清零

/**
 * 共享行为约束段（2026-10-27，P0）是否**存在且真的被装配**。
 * 抽出去之后，单看某个 agent 的 systemPrompt 已经没有那三段了 ⇒
 * 「有没有」必须由「常量存在 + 循环里追加」两件事共同保证，缺一就是静默丢失。
 */
const SHARED_OK = (() => {
	const BT = String.fromCharCode(96);
	const seg = src.split('const SHARED_AGENT_SECTIONS = ' + BT)[1] || '';
	const block = seg.split(BT + ';')[0];
	const hasAllHeads = ['什么时候停下来问', '完成前的自检', '输出约定'].every((h) => block.includes(h));
	const applied = /a\.systemPrompt = \(a\.systemPrompt \|\| ''\) \+ SHARED_AGENT_SECTIONS/.test(src);
	return block.length > 0 && hasAllHeads && applied;
})();
t('共享行为约束段存在且在装配时注入（P0）', SHARED_OK);

for (let k = 0; k < marks.length; k++) {
	const id = marks[k][1];
	const from = src.lastIndexOf('\t\t{', marks[k].index);
	const to = k + 1 < marks.length ? src.lastIndexOf('\t\t{', marks[k + 1].index) : src.length;
	const entry = src.slice(from, to);

	// ① systemPrompt
	const spMatch = /systemPrompt: `([\s\S]*?)`,\r?\n/.exec(entry);
	t(`${id}: 有 systemPrompt`, !!spMatch);
	const sp = spMatch ? spMatch[1] : '';

	if (!INTERNAL.has(id)) {
		/*
		 * 2026-10-27（P0）：三段约束抽成共享注入后，只有三种合法形态：
		 *   · 自带完整三段（英文系 agent 用 Stop & ask / Output format / Verify，语义等价）
		 *   · 完全不带（由 getBuiltinAgents() 追加 SHARED_AGENT_SECTIONS）
		 *   · 只带一部分 ⇒ 红（说明拼装时被削掉了）
		 */
		const hits = SECTIONS.filter(([, re]) => re.test(sp)).length;
		t(`${id}: 三段约束完整（自带或共享注入）`,
			hits === SECTIONS.length || (hits === 0 && SHARED_OK),
			'got=' + hits + '／3' + (hits === 0 && !SHARED_OK ? '（共享段缺失）' : ''));

		// ② suggestions
		const sugMatch = /suggestions: \[([^\]]*)\]/.exec(entry);
		const sug = sugMatch ? [...sugMatch[1].matchAll(/'([^']*)'/g)].map((m) => m[1]) : [];
		t(`${id}: suggestions 恰好 3 条`, sug.length === 3, 'got=' + sug.length);
		t(`${id}: suggestions 无半角逗号`, sug.every((s) => !s.includes(',')), sug.join(' | '));
	}

	// ③ 重复标题
	const heads = [...sp.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
	const dup = heads.filter((h, i) => heads.indexOf(h) !== i);
	t(`${id}: 提示词无重复二级标题`, dup.length === 0, dup.join(' / '));

	// ④ 占位符
	t(`${id}: 提示词无占位符`, !/\{\{[^}]+\}\}|\bTODO\b|\bXXX\b/.test(sp));

	// ⑤ 工具锚点（2026-10-27，P4）
	//    两个方向都要守：
	//      a) 提示词**点名**的工具必须在该 agent 的 tools 白名单里 —— 否则一调就被 allowlist 静默 deny
	//         （真机踩过：kb 提示词让人用 `content_import`，白名单里没有）
	//      b) 白名单里的工具，提示词至少点到 3 个 —— 否则就是"给了能力但没说怎么用"
	//    口径：只认**反引号包裹**的名字，避免英文散文里的 read / edit 造成假阳性。
	const toolsMatch = /tools: \[([^\]]*)\]/.exec(entry);
	const tools = toolsMatch ? [...toolsMatch[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
	const readable = sp.split('\\`').join('`');
	const anchored = tools.filter((x) => readable.includes('`' + x + '`'));
	const foreign = [...new Set([...readable.matchAll(/`([a-z][a-z0-9_]{2,})`/g)].map((m) => m[1]))]
		.filter((n) => KNOWN_TOOLS.has(n) && !tools.includes(n));
	t(`${id}: 点名的工具都在白名单里`, foreign.length === 0, foreign.join(','));
	if (!INTERNAL.has(id) && !ANCHOR_GAP.has(id)) {
		const need = Math.min(3, tools.length);
		t(`${id}: 工具锚点 ≥${need} 个`, anchored.length >= need, 'got=' + anchored.length + '（' + anchored.join(',') + '）');
	}

	// ⑥ 完成判据（2026-10-27，P4）：必须有可勾选的"什么算做完"
	//    没有判据的提示词，交付质量完全交给模型心情（真机表现：改完不跑、不重读）。
	//    口径：找「完成判据 / 完成标准 / 验收标准 / Done」小节，数它下面的 `- ` 条目。
	const critHead = /^##\s*(?:[一二三四五六七八九十]+、|\d+[.、]\s*)?(完成判据|完成标准|验收标准|Done criteria)/m.exec(readable);
	if (!INTERNAL.has(id) && !ANCHOR_GAP.has(id)) {
		let crit = 0;
		if (critHead) {
			const rest = readable.slice(critHead.index + critHead[0].length);
			const critBody = rest.split(/^##\s/m)[0] || '';
			crit = critBody.split(/\r?\n/).filter((l) => /^\s*-\s+\S/.test(l)).length;
		}
		t(`${id}: 有完成判据（≥2 条可勾选项）`, crit >= 2, 'got=' + crit);
	}

	// ⑦ 模糊词（2026-10-27，P4）：『尽量 / 适当 / 视情况』对模型没有约束力，必须换成可判定条件
	const VAGUE = ['尽量', '适当', '酌情', '视情况', '必要时', '等等', '之类', '差不多', '尽可能', 'as needed', 'if possible'];
	const vagueHits = VAGUE.filter((w) => readable.includes(w));
	t(`${id}: 提示词无模糊词`, vagueHits.length === 0, vagueHits.join(','));
}


// ── 全局前缀：硬规则 / 输出纪律（2026-10-27，L2）────────────────
// 依据：11 个开源 coding agent 源码研究（arXiv:2609.00006）——
//   anti-gold-plating 6/11、read-before-edit 有更严版本、9/11 有篇幅预算、两份禁用词表。
// 这三条**对所有 agent 生效**，所以不能只守在单个 agent 上。
{
	let chat = '';
	try { chat = readFileSync(CHAT, 'utf8'); } catch { /* 缺文件时下面会红 */ }

	const hard = (chat.split("const _HARD_RULES_SECTION = [")[1] || "").split("] as const;")[0];
	const out = (chat.split("const _OUTPUT_DISCIPLINE_SECTION = [")[1] || "").split("] as const;")[0];

	t('全局硬规则段存在', hard.length > 0);
	t('硬规则含 2 条 IMPORTANT（最小改动 / 先读后改）', (hard.match(/IMPORTANT:/g) || []).length >= 2, 'got=' + (hard.match(/IMPORTANT:/g) || []).length);
	t('硬规则含 NEVER（不谎报已完成）', hard.includes('NEVER:'));
	t('硬规则点名「不要扩大改动范围」', /不要扩大改动范围|不要顺手重构/.test(hard));
	t('硬规则点名「先读再改」', /没读过的文件不要改/.test(hard));

	t('输出纪律段存在', out.length > 0);
	t('输出纪律含篇幅预算（≤N 字）', /≤\s*\d+\s*字/.test(out));
	t('输出纪律含禁用表达表（≥6 个词）', (out.split('禁用表达')[1] || '').split(/[、，]/).filter((s) => s.trim().length >= 2).length >= 6);

	// 顺序：硬规则必须在主前缀**最前面**（大写标签越靠前越有效）
	const mainPrefix = (chat.split("export const GLOBAL_SYSTEM_PREFIX = [")[1] || "").split("].join")[0];
	const subPrefix = (chat.split("export const GLOBAL_SYSTEM_PREFIX_SUBAGENT = [")[1] || "").split("].join")[0];
	t('主前缀以硬规则开头', /^\s*\n?\s*\.\.\._HARD_RULES_SECTION/.test(mainPrefix));
	t('主前缀含输出纪律', mainPrefix.includes('_OUTPUT_DISCIPLINE_SECTION'));
	t('子代理前缀也含硬规则与输出纪律', subPrefix.includes('_HARD_RULES_SECTION') && subPrefix.includes('_OUTPUT_DISCIPLINE_SECTION'));
}

console.log('='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项（内置 agent 提示词结构 · 真源 builtinAgents.ts）`);
	process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过（真源 builtinAgents.ts：${marks.length} 个条目 × 三段/建议词/去重/占位符；内部 agent ${INTERNAL.size} 个豁免）`);
