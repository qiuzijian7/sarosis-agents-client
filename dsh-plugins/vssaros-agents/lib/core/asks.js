/**
 * 群聊选择卡（2026-11-07，纯逻辑）：成员要用户拍板时调 `group_ask`，群聊输入框上方出一张可点选的卡。
 *
 * 为什么不用官方 `ask_user_question`：它把成员的回合一直挂着等人，卡片又只在成员自己的会话里，群里看不到（真机：番茄钟团队
 * Coder，11-07 16:26 永久卡住）。这里学 DS Bot 的 `ask_user`（`ds-bot/src/host/tools.js:656-711`）：**记下问题、立刻结束回合**，
 * 答案来了再叫回成员 ⇒ 不占着成员、别的消息不用排队。比 DS Bot 多的两点：
 *  · 群里也能用（DS Bot 群里只能写文字，见 `goals.js:416-421`）；
 *  · 一次可问多题（它一次一题，群里拍板经常是几个问题一起问），可标「推荐」⇒ 卡上能一键「全部按推荐」。
 */

export const ROOM_ASK_TOOL = 'group_ask';

export const ASK_LIMITS = Object.freeze({
	questions: 6, optionsMin: 2, optionsMax: 6,
	question: 200, header: 20, detail: 300, label: 60, description: 160, custom: 500,
});

export const ASK_TOOL_DESCRIPTION = '在群聊输入框上方弹一张选择卡，让用户点选（方案取舍、范围、风格这类只有用户能定的事）。'
	+ '**调用后你这一轮立刻结束**，用户答了系统会叫你回来，答案带在那条消息里；所以要说的背景写在同一次回复的正文里，别再等。'
	+ '一次把要问的都问完（最多 6 题，每题 2–6 个选项），每题把你推荐的选项标 recommended（卡上有「全部按推荐」）。'
	+ '用户也可能跳过，或直接在群里打字回答。能自己查清的事先查清，不要问用户。';

export const ASK_TOOL_PARAMETERS = Object.freeze({
	type: 'object',
	required: ['questions'],
	properties: {
		questions: {
			type: 'array',
			description: `要问的问题（1–${ASK_LIMITS.questions} 题）`,
			items: {
				type: 'object',
				required: ['question', 'options'],
				properties: {
					question: { type: 'string', description: '一句话的问题' },
					header: { type: 'string', description: '很短的标题（如「交付形态」），可省略' },
					detail: { type: 'string', description: '一行补充说明，可省略' },
					options: {
						type: 'array',
						description: `${ASK_LIMITS.optionsMin}–${ASK_LIMITS.optionsMax} 个选项`,
						items: {
							type: 'object',
							required: ['label'],
							properties: {
								label: { type: 'string', description: '选项文字（短）' },
								description: { type: 'string', description: '这个选项意味着什么，可省略' },
								recommended: { type: 'boolean', description: '你推荐这一项' },
							},
						},
					},
					multiSelect: { type: 'boolean', description: '可以多选（默认单选）' },
					allowCustom: { type: 'boolean', description: '允许用户自己填（默认允许）' },
				},
			},
		},
	},
});

const clip = (value, max) => String(value ?? '').trim().slice(0, max);

/**
 * 校验并收敛模型给的问题。宽容：选项可以直接是字符串、`{ question, options }` 当成一题；重复选项去重。
 * @returns `{ questions }` 或 `{ error }`（error 回给模型，让它改了再调）
 */
export function normalizeAsk(args) {
	const raw = Array.isArray(args?.questions) ? args.questions : args?.question ? [args] : [];
	if (!raw.length) { return { error: '至少要有一个问题（questions）。' }; }
	if (raw.length > ASK_LIMITS.questions) { return { error: `一次最多问 ${ASK_LIMITS.questions} 个问题，挑最要紧的问。` }; }
	const questions = [];
	for (const [index, item] of raw.entries()) {
		const question = clip(item?.question, ASK_LIMITS.question);
		if (!question) { return { error: `第 ${index + 1} 题没有问题文字。` }; }
		const seen = new Set();
		const options = [];
		for (const option of Array.isArray(item?.options) ? item.options : []) {
			const label = clip(typeof option === 'string' ? option : option?.label, ASK_LIMITS.label);
			if (!label || seen.has(label)) { continue; }
			seen.add(label);
			const description = typeof option === 'object' ? clip(option?.description, ASK_LIMITS.description) : '';
			options.push({ label, ...(description ? { description } : {}), ...(option?.recommended === true ? { recommended: true } : {}) });
		}
		if (options.length < ASK_LIMITS.optionsMin) { return { error: `「${question}」至少要有 ${ASK_LIMITS.optionsMin} 个不同的选项。` }; }
		if (options.length > ASK_LIMITS.optionsMax) { return { error: `「${question}」最多 ${ASK_LIMITS.optionsMax} 个选项。` }; }
		const multiSelect = item?.multiSelect === true;
		// 单选题只认第一个「推荐」（否则「全部按推荐」不知道选哪个）
		if (!multiSelect) {
			let kept = false;
			for (const option of options) {
				if (option.recommended && kept) { delete option.recommended; }
				if (option.recommended) { kept = true; }
			}
		}
		const header = clip(item?.header, ASK_LIMITS.header);
		const detail = clip(item?.detail, ASK_LIMITS.detail);
		questions.push({ id: `q${index + 1}`, question, ...(header ? { header } : {}), ...(detail ? { detail } : {}),
			options, multiSelect, allowCustom: item?.allowCustom !== false });
	}
	return { questions };
}

/**
 * 校验用户的答案（前端已拦过，这里是接口的底线）：每题都要答；选项必须是卡上有的；单选只留一个，自填优先。
 * @returns `{ answers: [{ id, selected, custom? }] }` 或 `{ error }`
 */
export function normalizeAskAnswers(ask, answers) {
	const list = Array.isArray(answers) ? answers : [];
	const out = [];
	for (const question of ask?.questions ?? []) {
		const given = list.find(item => item?.id === question.id);
		const labels = new Set(question.options.map(option => option.label));
		const custom = question.allowCustom ? clip(given?.custom, ASK_LIMITS.custom) : '';
		let selected = (Array.isArray(given?.selected) ? given.selected : []).map(String).filter(label => labels.has(label));
		if (!question.multiSelect) { selected = custom ? [] : selected.slice(0, 1); }
		if (!selected.length && !custom) { return { error: `「${question.header || question.question}」还没选。` }; }
		out.push({ id: question.id, selected, ...(custom ? { custom } : {}) });
	}
	return { answers: out };
}

/** 答案写成人能读的几行（群聊记录、气泡、交给成员的那条消息共用）。 */
export function askAnswerText(ask, answers) {
	return (ask?.questions ?? []).map((question, index) => {
		const answer = (answers ?? []).find(item => item?.id === question.id);
		const picked = [...(answer?.selected ?? []), ...(answer?.custom ? [answer.custom] : [])].join('、') || '（没答）';
		return `${index + 1}. ${question.header || question.question}：${picked}`;
	}).join('\n');
}

/** 一句话说这张卡在问什么（群聊记录、结果正文用）。 */
export function askHeadline(ask) {
	return (ask?.questions ?? []).map(question => question.header || question.question).join(' / ');
}

/**
 * 人在群里直接打字时，哪些卡被这条消息顶替（对齐 DS Bot「任何用户消息都会顶替卡片」`turns.js:849-855`）。
 * 群里多一层：@ 了别人的话不是在答这张卡 ⇒ 只顶替被 @ 到的成员的卡；没 @ 人 / @所有人 ⇒ 全部顶替。
 * @returns `{ taken, kept }`；`routed` = 这条消息要不要改成交给提问的成员（没 @ 人才改，否则按 @ 走）
 */
export function supersedeAsks(asks, mention) {
	const list = Array.isArray(asks) ? asks : [];
	const named = mention && !mention.all && Array.isArray(mention.ids) && mention.ids.length > 0;
	const taken = named ? list.filter(ask => mention.ids.includes(ask.botId)) : list;
	return { taken, kept: list.filter(ask => !taken.includes(ask)),
		routed: taken.length > 0 && !named && !mention?.all };
}
