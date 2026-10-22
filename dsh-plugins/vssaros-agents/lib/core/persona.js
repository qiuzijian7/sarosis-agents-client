// @vssaros/dsh-agents — 会话内「人格热切换」的核心（纯逻辑，无 dsh 依赖，可单测）。
//
// **为什么长这样**（dsh 自带规范 + 运行期不变量，依据见 poc/dsh-p0/README.md 4.38）：
//   * 人格属于**提示词内容**，会话内可变；preset 身份（工具/模型/skills）首回合后锁定，两者分开。
//   * `system-prompt/assemble` 是"最强机制"，dsh 规范明令禁止用它加/删文本 → 我们只注册**普通 section**。
//   * 模型看到的一切必须能从会话日志重建（规范 Principle 1）→ 切换事实用 `agent.inject()` 投递，
//     落成 dsh **已登记**的事件 `agent/inbox/spliced`；**不新增事件类型**（插件加了会让会话打不开）。
//   * 每会话状态进 `sessionProjections` 单元（纯 `apply`，日志派生），不订阅 `session/event` 重扫。
//   * 注入消息只能用 **user 角色**：`role:'developer'` 会被 dsh-llm 的 `withoutDeveloperMessages()`
//     静默剔除（那是 loop 自己的"工具增删"专用通道），`role:'system'` 对应的 `system/message` 事件
//     又必须在打开的 step 内（dsh-session 不变量），插件写不进去。

/** 注入消息的 `source.kind`：投影靠它认出"这条 splice 是一次人格切换"。 */
export const PERSONA_SWITCH_SOURCE_KIND = 'vssaros/persona';

/** 投影单元 key。同 key + 同 `stateVersion` 的多次 `register()` 是 ref-count 共享，不会建重复单元。 */
export const PERSONA_PROJECTION_KEY = 'vssaros-persona';

/** 投影状态版本：字段或折叠语义一变就 +1（旧检查点会被 dsh 丢弃）。 */
export const PERSONA_STATE_VERSION = 1;

/** 空状态（还没切换过任何人格）。 */
export function emptyPersonaState() {
	return { personaId: null, name: null, text: null, atSeq: -1 };
}

/** 切换指令消息的正文（模型可见）。人格**全文**走 section，这里只负责"告知"。 */
export function personaSwitchText(name) {
	return `【人格切换】从现在起按「${name}」人格工作；工具与模型保持不变。`;
}

/** "恢复本 Agent 自带人设"的指令正文（清除会话内人格）。 */
export function personaClearText() {
	return '【人格切换】恢复为当前 Agent 自带的人设；工具与模型保持不变。';
}

/**
 * 从一条会话事件里读出人格切换（不是切换事件就返回 undefined）。
 *
 * 只认 `agent/inbox/spliced`（dsh 的 durable inbox）——`agent.inject/steer/followup` 都经它落盘，
 * 所以"谁在什么时候切成谁"天然可重放；重放时本函数的返回值与首次运行完全一致。
 * @param event dsh 会话事件
 * @returns `{ personaId, name, text }` 或 undefined
 */
export function personaSwitchOf(event) {
	if (event?.type !== 'agent/inbox/spliced') {
		return undefined;
	}
	const inserted = Array.isArray(event.data?.inserted) ? event.data.inserted : [];
	for (const message of inserted) {
		const source = message?.source;
		if (source?.kind !== PERSONA_SWITCH_SOURCE_KIND) {
			continue;
		}
		// 清除（切回 preset 自带人设）：只带标记，不带全文。
		if (source.cleared === true) {
			return { personaId: null, name: null, text: null, cleared: true };
		}
		if (typeof source.text === 'string' && source.text) {
			return { personaId: source.personaId ?? null, name: source.name ?? null, text: source.text };
		}
	}
	return undefined;
}

/**
 * 构造"切换人格"的注入消息（user 角色）。
 *
 * 人格**全文**随消息落日志（`source.text`）：这样"某一步模型看到的 system prompt"可以从日志精确
 * 重建，之后 `.agent.md` 被改动也不会回头改写历史（dsh 对 preset 用 revision 解决同一问题，我们
 * 用"切换时快照"）。
 * @param target `{ id, name, persona }`（来自花名册扫描）
 * @param options.createUserMessage `@deepseek-ai/dsh-llm` 的工厂（拿不到就自组；消息对象运行期无校验）
 * @param options.uuid 自组消息时的 id 生成器
 * @returns 冻结前的消息对象
 */
export function personaSwitchMessage(target, options = {}) {
	const content = [{ type: 'text', text: options.clear ? personaClearText() : personaSwitchText(target.name) }];
	const source = options.clear
		// 清除：只带标记，不带 text（投影据此回到空状态 = 跟随 preset 自带人设）。
		? { kind: PERSONA_SWITCH_SOURCE_KIND, cleared: true }
		: {
			kind: PERSONA_SWITCH_SOURCE_KIND,
			personaId: target.id,
			name: target.name,
			text: target.persona,
		};
	if (typeof options.createUserMessage === 'function') {
		return options.createUserMessage({ content, source });
	}
	return { id: options.uuid(), role: 'user', content, source };
}

/**
 * `sessionProjections` 单元定义：fold `agent/inbox/spliced` → 当前生效人格。
 *
 * 忽略的事件**必须返回同一引用**（dsh 靠 `Object.is` 抑制下游发布），所以只在真命中时新建对象。
 * @returns dsh 的投影定义
 */
export function personaProjection() {
	return {
		key: PERSONA_PROJECTION_KEY,
		// 状态是纯 JSON。dsh 在读取持久化检查点时会 `stateSchema.parse(row.val)`；identity 即可。
		stateSchema: { parse: value => value },
		init: () => emptyPersonaState(),
		apply(state, event) {
			const hit = personaSwitchOf(event);
			if (!hit) {
				return state;
			}
			const atSeq = typeof event.seq === 'number' ? event.seq : -1;
			// 清除回到空状态（但 `atSeq` 记住"最后一次切换"的位置）；否则记下新人格。
			return hit.cleared === true
				? { ...emptyPersonaState(), atSeq }
				: { personaId: hit.personaId ?? null, name: hit.name ?? null, text: hit.text ?? null, atSeq };
		},
		stateVersion: PERSONA_STATE_VERSION,
		// ★ 2026-10-20：**带 wire 才会下发给页面**（dsh-session-projection 只把有 `wire` 的单元送进
		//   控制流 / 连接 baseline / `session/projections` RPC）。此前没有 ⇒ 页面
		//   `summary.projectionValues["vssaros-persona"]` 恒为 undefined ⇒ 人格 chip 只能靠本地缓存兜底 ✗。
		//   视图**不带 `text`**（人格全文可能很长，页面只需要 id + 名字）；状态本身不变 ⇒ stateVersion 不用改。
		//   ⚠ 同一 key 的多次 register 以**先注册**的定义为准（其余只计引用）——两处注册都调本函数，定义一致 ✓。
		wire: {
			viewSchema: { parse: value => value },
			view: state => ({ personaId: state.personaId ?? null, name: state.name ?? null, atSeq: state.atSeq ?? -1 }),
		},
	};
}

/**
 * 读某次提示词装配时该会话的生效人格。
 *
 * 供 section 的**函数形式** `text(context)` 调用：拿不到（服务未注入 / 会话没有 / 没切换过）就返回
 * undefined，调用方退回 preset 自带人设——**任何异常都不能让装配失败**（那会让整个会话打不开）。
 * @param projections `sessionProjections` 服务（可能尚未注入）
 * @param context 装配上下文（dsh 传 `{ agent, scope }`）
 * @returns 人格全文，或 undefined
 */
export function switchedPersonaText(projections, context) {
	try {
		const session = context?.agent?.session;
		if (!projections || !session) {
			return undefined;
		}
		const state = projections.stateOf(session, PERSONA_PROJECTION_KEY);
		return typeof state?.text === 'string' && state.text ? state.text : undefined;
	} catch {
		return undefined;
	}
}
