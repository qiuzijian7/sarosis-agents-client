/*
 * 离线 smoke：验证「技能自动加载」的注入逻辑（不需要 dsh 运行时）。
 *
 * 覆盖：
 *   ① 首轮注入：消息里出现 <skill_content name="x">，正文来自 ctx.skills.get
 *   ② 幂等：已有 <skill_content name="x"> ⇒ 不再注入（含"模型自己用 skill 工具加载过"的情形）
 *   ③ 技能不存在 ⇒ 不注入、不抛错、只告警一次
 *   ④ 未配置（skillAutoload 空 / 缺省）⇒ 完全不注册监听（零开销）
 *   ⑤ 每次注入的 message: role=user（dsh 规范：developer 会被剔除、system 写不进）
 *
 * 跑法：node dsh-plugins/vssaros-skills/scripts/smoke-skill-autoload.mjs
 */
import assert from 'node:assert';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(join(HERE, '..', 'lib', 'index.js')).href);
const { installSkillAutoload } = mod;

let pass = 0;
const ck = (name, cond, extra = '') => {
	if (cond) { pass++; console.log(`  ✓ ${name}`); } else { console.log(`  ✗ ${name} ${extra}`); process.exitCode = 1; }
};

/** 假 ctx：记录注册的监听器，模拟 effect（返回 disposer）。 */
function fakeCtx({ skills, logger } = {}) {
	const listeners = [];
	// ⚠ 判据必须是"有没有传 skills"（传空对象 = **有注册表但查不到**），而不是"里面有没有条目"
	//   否则"技能不存在"的用例会走进"ctx.skills 不可用"分支（本轮踩到 ✓）
	return {
		skills: skills !== undefined ? { get: async (name) => skills[name] } : undefined,
		logger: logger ?? { info() {}, warn() {} },
		on(name, fn) { listeners.push({ name, fn }); return { dispose() {} }; },
		effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
		// ★ 2026-10-20：生产代码改用 `ctx.inject(['agents'], scope => …)` 把 pre-step 挂到
		//   **agent 作用域**（真根因见 index.js 里的注释）。smoke 里假设该服务**已就绪** ⇒
		//   同步回调、把同一个假 ctx 当 scope 传回去（监听仍进 `_listeners`，`step()` 照常找得到 ✓）。
		inject(_deps, cb) { return cb(this); },
		_listeners: listeners,
	};
}

/** 假 createUserMessage：与 dsh 的形状一致（role=user + content 块数组 + source）。 */
const fakeCreate = (input) => ({ role: 'user', ...input, id: 'fake' });

/** 跑一次 pre-step：返回最终 decision。 */
async function step(ctx, { messages = [], agent = { session: { header: { cwd: '/repo' } } } } = {}) {
	const listener = ctx._listeners.find(l => l.name === 'agent/pre-step');
	assert.ok(listener, '应注册 agent/pre-step 监听');
	const next = async () => ({ kind: 'continue', messages });
	return listener.fn({ agent, messages, signal: undefined }, next);
}

const textOf = (msg) => (Array.isArray(msg.content) ? msg.content.map(p => p.text ?? '').join('\n') : String(msg.content ?? ''));

// ── ① 首轮注入 ──────────────────────────────────────────────────────────
{
	const ctx = fakeCtx({ skills: { 'help-me-understand': { name: 'help-me-understand', content: '# 讲懂流程\n七步法…' } } });
	installSkillAutoload(ctx, { skillAutoload: ['help-me-understand'] }, { createUserMessage: fakeCreate, appendLog: () => Promise.resolve() });
	const out = await step(ctx, { messages: [{ role: 'user', content: [{ type: 'text', text: '帮我讲懂 GC' }] }] });
	const added = out.messages[out.messages.length - 1];
	ck('① 首轮注入一条新消息', out.messages.length === 2);
	ck('① 注入消息 role=user', added.role === 'user');
	ck('① 含 <skill_content name="help-me-understand">', textOf(added).includes('<skill_content name="help-me-understand">'));
	ck('① 正文被带上', textOf(added).includes('七步法'));
	ck('① source.kind 正确', added.source?.kind === 'vssaros/skill-autoload');
	ck('① 提示不要重复加载', textOf(added).includes('不要再用'));
}

// ── ② 幂等（模型自己加载过 / 本插件已注入过）────────────────────────────
{
	const ctx = fakeCtx({ skills: { 'help-me-understand': { name: 'help-me-understand', content: '正文' } } });
	installSkillAutoload(ctx, { skillAutoload: ['help-me-understand'] }, { createUserMessage: fakeCreate, appendLog: () => Promise.resolve() });
	const existing = { role: 'user', content: [{ type: 'text', text: '<skill_content name="help-me-understand">\n正文\n</skill_content>' }] };
	const out = await step(ctx, { messages: [existing] });
	ck('② 已有该技能正文 ⇒ 不重复注入', out.messages.length === 1);

	// 首次注入 → 第二轮不再注入（模拟同一会话连续两轮）
	const ctx2 = fakeCtx({ skills: { 'help-me-understand': { name: 'help-me-understand', content: '正文X' } } });
	installSkillAutoload(ctx2, { skillAutoload: ['help-me-understand'] }, { createUserMessage: fakeCreate, appendLog: () => Promise.resolve() });
	const r1 = await step(ctx2, { messages: [{ role: 'user', content: 'q1' }] });
	const r2 = await step(ctx2, { messages: r1.messages });
	ck('② 第二轮不再重复注入', r2.messages.length === r1.messages.length);
}

// ── ③ 技能不存在 ────────────────────────────────────────────────────────
{
	const warns = [];
	const ctx = fakeCtx({ skills: {}, logger: { info() {}, warn(m) { warns.push(m); } } });
	installSkillAutoload(ctx, { skillAutoload: ['no-such-skill'] }, { createUserMessage: fakeCreate, appendLog: () => Promise.resolve() });
	const out = await step(ctx, { messages: [{ role: 'user', content: 'q' }] });
	ck('③ 技能不存在 ⇒ 不注入', out.messages.length === 1);
	ck('③ 只告警一次（不刷屏）', warns.filter(w => w.includes('no-such-skill')).length === 1, JSON.stringify(warns));
}

// ── ④ 未配置 ⇒ 完全不注册 ───────────────────────────────────────────────
{
	const a = fakeCtx();
	// ⚠ 显式关掉「从自己 patch 兜底读」：本用例验证的是"配置空 ⇒ 完全不介入"，
	//   走真实兜底会读到包里的 skillAutoload 而意外注入（2026-10-20 加兜底后踩到）。
	installSkillAutoload(a, {}, { autoloadFallback: () => [] });
	ck('④ 缺省配置 ⇒ 不注册任何监听', a._listeners.length === 0);

	const b = fakeCtx();
	installSkillAutoload(b, { skillAutoload: [] }, { autoloadFallback: () => [] });
	ck('④ 空数组 ⇒ 不注册任何监听', b._listeners.length === 0);
}

// ── ⑤ reject 决策不被覆盖 ───────────────────────────────────────────────
{
	const ctx = fakeCtx({ skills: { 'help-me-understand': { name: 'help-me-understand', content: '正文' } } });
	installSkillAutoload(ctx, { skillAutoload: ['help-me-understand'] }, { createUserMessage: fakeCreate, appendLog: () => Promise.resolve() });
	const listener = ctx._listeners.find(l => l.name === 'agent/pre-step');
	const out = await listener.fn({ agent: {}, messages: [], signal: undefined }, async () => ({ kind: 'reject' }));
	ck('⑤ 上游 reject ⇒ 原样返回（不注入）', out.kind === 'reject');
}

// ⑥ 同一 agent 只注入一次（2026-10-20 真机：同一 session 连续 inject 了 4 次）
{
	const ctx = fakeCtx({ skills: { 'help-me-understand': { id: 'help-me-understand', content: 'BODY-ONCE', description: 'd' } } });
	installSkillAutoload(ctx, { skillAutoload: ['help-me-understand'] }, {
		createUserMessage: fakeCreate, appendLog: () => Promise.resolve(), skills: ctx.skills,
	});
	const agent = { session: { id: 'same-agent', header: { cwd: '/repo' } } };
	const first = await step(ctx, { messages: [], agent });
	const second = await step(ctx, { messages: [], agent });
	const third = await step(ctx, { messages: [], agent });
	const countOf = d => (Array.isArray(d?.messages) ? d.messages.length : 0);
	ck('⑥ 第一次 pre-step ⇒ 注入（+1 条消息）', countOf(first) === 1);
	ck('⑥ 同一 agent 第二次 ⇒ 不再注入', countOf(second) === 0);
	ck('⑥ 同一 agent 第三次 ⇒ 仍不注入', countOf(third) === 0);
}

console.log(`\n${process.exitCode ? '✗ 有失败' : `✓ 全部通过（${pass} 项）`}`);
