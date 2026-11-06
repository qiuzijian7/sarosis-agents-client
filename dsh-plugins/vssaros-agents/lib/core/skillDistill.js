// @vssaros/dsh-agents — 团队步骤技能的模型提炼（纯函数，2026-11-06，superagent v2 第 7 节「沉淀技能」的核心承诺）
//
// 以前：superagent 交来执行证据，这里按模板把报告原样拼成 SKILL.md —— 等于没提炼（报告是一次性的，不是经验）。
// 现在分三步：
//   ① 提炼：把证据交给模型（一次性调用，见 lib/stepDistill.js），要它写出「什么时候用 / 怎么做 / 踩过的坑 / 怎么验证」，
//      并自报风险；同一 bot 已有的技能一并给它看，它判断是不是同一项技能（sameAs）。
//   ② 相似去重发版本：和该 bot 已有的技能（已生效 + 草稿）比，模型说是同一项或文字足够相近 ⇒ 不新建，
//      给那项技能出新版本草稿（version + 1，人批准后替换生效版，旧版留作 SKILL.v<N>.md）。
//   ③ 风险分级：模型自报的等级与规则判定取较高的那个（low / medium / high），连同理由写进 frontmatter，
//      人在面板上据此决定批不批。所有草稿都要人批准，风险只决定提醒的轻重。
// 模型不可用或答得不对时，退回模板草稿，并在 frontmatter 里写明 `distilled: template`，不会装作提炼过。

export const RISK_LEVELS = /** @type {const} */ (['low', 'medium', 'high']);
/** 文字相似到这个程度就算同一项技能（描述 + 标题的覆盖率，见 `similarityOf`）。 */
export const SIMILAR_AT = 0.6;
const STEPS_MAX = 8, LIST_ITEM_CHARS = 300;

const clip = (text, max) => { const t = String(text ?? '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

/** 拉丁词 + 汉字二元组，中英文都能比。 */
export function wordsOf(text) {
	const lower = String(text ?? '').toLowerCase();
	const latin = lower.match(/[a-z0-9_-]{2,}/g) ?? [];
	const han = lower.match(/[\u3400-\u9fff]/g) ?? [];
	return [...new Set([...latin, ...han.slice(1).map((ch, i) => han[i] + ch)])];
}
/** 两段文字的相似度（0..1）：较短一方的词有多少出现在另一方。 */
export function similarityOf(a, b) {
	const left = wordsOf(a), right = wordsOf(b);
	if (!left.length || !right.length) { return 0; }
	const [small, big] = left.length <= right.length ? [left, new Set(right)] : [right, new Set(left)];
	return small.filter((word) => big.has(word)).length / small.length;
}

/** 给模型的系统提示与用户消息。`similar`：该 bot 已有的技能（名字、描述、版本）。 */
export function distillMessages(evidence, similar = []) {
	const system = [
		'你把一个团队步骤的执行证据提炼成一项可复用的技能，给同一个 bot 以后遇到同类任务时读。',
		'只写能迁移到下一次的经验：什么时候用、按什么步骤做、哪里容易出错、怎么确认做对了。不要复述这次的具体结果、文件名清单或聊天过程。',
		'如果下面列出的已有技能里有一项就是同一项技能（以后遇到同类任务应该读它），在 sameAs 里写它的名字；否则 sameAs 为 null。',
		'自评风险：low = 只读或只在工作目录内改文件；medium = 要跑命令、装依赖、访问网络；high = 会外发消息、发布/推送、删除数据或接触密钥凭据。',
		'只输出一个 JSON 对象，不要任何别的文字：',
		'{"title":"≤40字","description":"≤120字，一句话说清这项技能解决什么","when":"≤300字","steps":["≤8步，每步一句"],"pitfalls":["踩过的坑与规避"],"verify":["怎么确认做对了"],"risk":"low|medium|high","riskReasons":["理由"],"sameAs":null}',
	].join('\n');
	const user = JSON.stringify({
		bot: evidence.botName || evidence.botId,
		step: { title: evidence.stepTitle, spec: clip(evidence.spec, 1500), outcome: evidence.outcome, turns: evidence.turns, attempts: evidence.attempts },
		report: clip(evidence.report, 4000),
		failures: (evidence.failures ?? []).map((failure) => clip(failure, 500)),
		...(evidence.request ? { request: clip(evidence.request, 800) } : {}),
		existingSkills: similar.map((skill) => ({ name: skill.name, description: clip(skill.description, 200), version: skill.version })),
	});
	return { system, user };
}

const asList = (value) => (Array.isArray(value) ? value : value ? [value] : []).map((item) => clip(item, LIST_ITEM_CHARS)).filter(Boolean);

/**
 * 模型的回答 → 技能内容。接受裸 JSON 或 ```json 代码块。
 * @throws 没有 JSON、缺 description / steps、风险等级不认识
 */
export function parseDistilled(text) {
	const raw = String(text ?? '');
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)?.[1];
	const body = fenced ?? raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
	let value;
	try { value = JSON.parse(body); } catch { throw new Error('提炼结果不是 JSON'); }
	const description = clip(value?.description, 160);
	const steps = asList(value?.steps).slice(0, STEPS_MAX);
	if (!description || !steps.length) { throw new Error('提炼结果缺少 description 或 steps'); }
	const risk = String(value?.risk ?? 'low').toLowerCase();
	if (!RISK_LEVELS.includes(risk)) { throw new Error(`提炼结果的风险等级不认识：${risk}`); }
	const sameAs = typeof value?.sameAs === 'string' && value.sameAs.trim() ? value.sameAs.trim() : undefined;
	return { title: clip(value?.title, 60), description, when: clip(value?.when, 600), steps, pitfalls: asList(value?.pitfalls).slice(0, 8),
		verify: asList(value?.verify).slice(0, 6), risk, riskReasons: asList(value?.riskReasons).slice(0, 5), ...(sameAs ? { sameAs } : {}) };
}

// 中文词不能放进 \b…\b（汉字不是单词字符，\b 永远落不到它们两边），所以中英文分开写。
const HIGH = [
	[/\b(secret|token|password|passwd|credential|api[_-]?key)\b|私钥|密钥|口令|凭据/i, '涉及密钥或凭据'],
	[/\b(git\s+push|npm\s+publish|pnpm\s+publish|deploy)\b|发布到|推送到远端|上线到/i, '会发布或推送'],
	[/\brm\s+-rf\b|Remove-Item\b[^\n]*-Recurse|\bdel\s+\/s\b|\bdrop\s+table\b|删库|删除数据/i, '会删除数据'],
	[/\b(webhook|sendmail|smtp)\b|发消息|发通知|外发/i, '会外发消息'],
];
const MEDIUM = [
	[/\b(npx|npm|pnpm|yarn|pip|git|curl|wget|pwsh|bash|powershell)\b|cmd\.exe/i, '要跑命令'],
	[/\bhttps?:\/\//i, '要访问网络'],
	[/安装依赖|装依赖|\binstall\b/i, '要装依赖'],
];
/** 按内容判的风险等级与理由。 */
export function ruleRisk(text) {
	const value = String(text ?? '');
	const high = HIGH.filter(([re]) => re.test(value)).map(([, why]) => why);
	if (high.length) { return { level: 'high', reasons: high }; }
	const medium = MEDIUM.filter(([re]) => re.test(value)).map(([, why]) => why);
	return medium.length ? { level: 'medium', reasons: medium } : { level: 'low', reasons: [] };
}
/** 模型自报与规则判定取较高的等级；理由合并去重。 */
export function gradeRisk(distilled, text) {
	const rule = ruleRisk(text);
	const model = RISK_LEVELS.includes(distilled?.risk) ? distilled.risk : 'low';
	const level = RISK_LEVELS[Math.max(RISK_LEVELS.indexOf(model), RISK_LEVELS.indexOf(rule.level))];
	return { level, reasons: [...new Set([...(distilled?.riskReasons ?? []), ...rule.reasons])].slice(0, 6) };
}

/**
 * 已有技能里与这次是同一项的那个：模型点名的（名字要在列表里）优先，否则取文字最相近、且达到 `SIMILAR_AT` 的。
 * @param existing `[{ name, description, title? }]`，只含该 bot 的技能
 */
export function pickSimilar(candidate, existing, sameAs) {
	if (sameAs) {
		const named = existing.find((skill) => skill.name === sameAs);
		if (named) { return named; }
	}
	let best, score = 0;
	for (const skill of existing) {
		const s = similarityOf(`${candidate.title} ${candidate.description}`, `${skill.title ?? ''} ${skill.description}`);
		if (s > score) { best = skill; score = s; }
	}
	return score >= SIMILAR_AT ? best : undefined;
}

/** 模型不可用时的模板内容（和提炼结果同形，`distilled: false`）。 */
export function templateOf(evidence) {
	return {
		title: clip(evidence.stepTitle, 60),
		description: clip(`${evidence.botName || evidence.botId}做「${evidence.stepTitle}」这类步骤的经验`, 160),
		when: clip(evidence.spec || evidence.stepTitle, 600),
		steps: [clip(evidence.report, 1200) || '（步骤没有留下报告。）'],
		pitfalls: (evidence.failures ?? []).map((failure) => clip(failure, LIST_ITEM_CHARS)),
		verify: [], risk: 'low', riskReasons: [],
	};
}

const yamlText = (text) => `"${String(text ?? '').replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
/**
 * SKILL.md 全文（vssaros-skills 的布局：frontmatter 必需 name / description）。
 * @param input `{ name, version, evidence, content, risk: {level, reasons}, distilled: boolean, previous?: { version } }`
 */
export function renderSkill({ name, version, evidence, content, risk, distilled, previous }) {
	const lines = [
		'---',
		`name: ${name}`,
		`description: ${yamlText(content.description)}`,
		'category: team-step',
		'metadata:',
		`  owner: "bot:${evidence.botId}"`,
		`  origin: ${yamlText(`superagent ticket ${evidence.ticketId} step ${evidence.stepKey}`)}`,
		`  version: ${version}`,
		`  risk: ${risk.level}`,
		...(risk.reasons.length ? [`  riskReasons: ${yamlText(risk.reasons.join('；'))}`] : []),
		`  distilled: ${distilled ? 'model' : 'template'}`,
		'---',
		'',
		`# ${content.title || clip(evidence.stepTitle, 80)}`,
		'',
		`归属：${evidence.botName || evidence.botId}（bot:${evidence.botId}）。v${version}${previous ? `（替换 v${previous.version}）` : ''}，`
			+ `来自团队工单「${clip(evidence.ticketTitle, 80)}」的步骤 ${evidence.stepKey}（${evidence.outcome}，${evidence.turns} 回合，${evidence.attempts} 次尝试）。`,
		'',
		'## 什么时候用',
		'',
		content.when || clip(evidence.spec || evidence.stepTitle, 600),
		'',
		'## 做法',
		'',
		...content.steps.map((step, i) => `${i + 1}. ${step}`),
	];
	if (content.pitfalls.length) { lines.push('', '## 踩过的坑', '', ...content.pitfalls.map((item, i) => `${i + 1}. ${item}`)); }
	if (content.verify.length) { lines.push('', '## 怎么验证', '', ...content.verify.map((item) => `- ${item}`)); }
	lines.push('', `## 风险：${risk.level}`, '', risk.reasons.length ? risk.reasons.map((why) => `- ${why}`).join('\n') : '- 只读或只在工作目录内改文件');
	if (!distilled) { lines.push('', '> 模型没能提炼（见 superagent 面板的原因），这是由执行证据拼出的草稿；批准前请人工补全「什么时候用」和关键步骤。'); }
	lines.push('');
	return lines.join('\n');
}
