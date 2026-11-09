/**
 * DS Bot 风格工具名 → 本项目 `browser(op)` 的入参归一（2026-11-09，§4 兼容层）。
 *
 * ★ 只在 `runOp` 入参层生效：模型侧**仍然只见一个 `browser` 工具**、工具 schema 不变、
 *   不向 ctx.tools.register 注册第二套工具（那样会与既有 browser 撞名）。
 *   用途是迁移 DS Bot 生态的技能 / 工作流 / 提示词时，那些 `browser_open` 之类的调用
 *   能被原样接住，而不必逐条改写。
 *
 * ★ 归一发生在**所有闸之前**：别名调用与原生 op 一样过 isActionOp / riskGate / 审批 /
 *   高危闸，不存在「换个名字绕过审批」的口子。
 */

/** 不映射的名字，附理由；守卫会逐项对账，防止有人悄悄加回第二套入口。 */
export const UNMAPPED_ALIASES = Object.freeze({
	browser_tabs: '右栏是单一共享视图，不建多标签',
	browser_upload: '本项目没有等价的文件上传 op',
	browser_exec: '刻意不引入脚本沙箱，用 evaluate（默认关 + 逐次审批 + 代码回显）替代',
	browser_select: '本项目没有等价的下拉选择 op',
});

const keep = (source, keys) => {
	const out = {};
	for (const key of keys) {
		if (source?.[key] !== undefined) out[key] = source[key];
	}
	return out;
};

export const ALIASES = Object.freeze({
	browser_open: (p) => ({ op: 'navigate', ...keep(p, ['url']) }),
	browser_snapshot: () => ({ op: 'snapshot', format: 'aria' }),
	browser_click: (p) => ({ op: 'click', ...keep(p, ['ref', 'confirm', 'label']) }),
	browser_type: (p) => ({ op: 'type', ...keep(p, ['ref', 'text']) }),
	browser_press: (p) => ({ op: 'pressKey', ...keep(p, ['key']) }),
	browser_back: () => ({ op: 'back' }),
	browser_screenshot: () => ({ op: 'screenshot' }),
	browser_handoff: (p) => ({ op: 'handoff', text: String(p?.note ?? p?.reason ?? '') }),
	browser_resume: () => ({ op: 'resume' }),
	browser_task: (p) => ({ op: 'task', ...keep(p, ['goal', 'maxSteps']) }),
	read_browser: () => ({ op: 'snapshot' }),
});

/** @returns `{ params, mapped, from }`；未命中时原样返回，行为逐字不变。 */
export function normalizeOpCall(params) {
	const from = typeof params?.op === 'string' ? params.op.trim() : '';
	const entry = Object.hasOwn(ALIASES, from) ? ALIASES[from] : undefined;
	if (!entry) return { params, mapped: false, from };
	const mappedParams = entry(params);
	if (params?.params !== undefined) mappedParams.params = params.params;
	return { params: mappedParams, mapped: true, from };
}
