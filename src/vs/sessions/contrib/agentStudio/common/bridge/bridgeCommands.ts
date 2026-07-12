/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── Slash 命令框架（对齐 cc-connect core/command.go CommandRegistry）──
// 纯逻辑：仅依赖 bridgeTypes，不引入平台/服务实现，便于单测。

import {
	BridgeButton,
	BridgeCard,
	BridgeCommandContext,
	BridgeCardElement,
	IBridgeCommand,
} from "./bridgeTypes.js";

function normalizeCommandName(name: string): string {
	return name.replace(/[_]/g, "-").toLowerCase();
}

export class BridgeCommandRegistry {
	private readonly _commands = new Map<string, IBridgeCommand>();

	register(cmd: IBridgeCommand): void {
		this._commands.set(normalizeCommandName(cmd.name), cmd);
	}

	/** 解析命令；hyphen ↔ underscore 归一化后再匹配。 */
	resolve(name: string): IBridgeCommand | undefined {
		const lower = name.toLowerCase().replace(/^\//, "");
		const norm = normalizeCommandName(lower);
		const direct = this._commands.get(lower);
		if (direct) {
			return direct;
		}
		for (const [key, cmd] of this._commands) {
			if (key === norm) {
				return cmd;
			}
		}
		return undefined;
	}

	/** 解析一整行用户输入：若以 "/" 开头且能解析到命令则返回。 */
	parse(raw: string): { cmd: IBridgeCommand; args: string[] } | undefined {
		const trimmed = raw.trim();
		if (!trimmed.startsWith("/")) {
			return undefined;
		}
		const spaceIdx = trimmed.search(/\s/);
		const name = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
		const cmd = this.resolve(name);
		if (!cmd) {
			return undefined;
		}
		const args = spaceIdx === -1 ? [] : trimmed.slice(spaceIdx + 1).trim().split(/\s+/).filter(Boolean);
		return { cmd, args };
	}

	list(): IBridgeCommand[] {
		return [...this._commands.values()].sort((a, b) => a.name.localeCompare(b.name));
	}
}

// ─── 命令构造助手 ───────────────────────────────────────────────

function card(elements: BridgeCardElement[], headerTitle?: string): BridgeCard {
	return {
		header: headerTitle ? { title: headerTitle } : undefined,
		elements,
	};
}

function buttonRow(label: string, value: string, type: "primary" | "default" | "danger" = "default"): BridgeButton[] {
	return [{ text: label, value, type }];
}

// ─── 内置命令 ───────────────────────────────────────────────────

export function createBuiltinCommands(): IBridgeCommand[] {
	return [
		{
			name: "help",
			description: "列出所有可用命令",
			run: (ctx: BridgeCommandContext) => {
				const body = builtinList
					.map(c => `• /${c.name}${c.usage ? " " + c.usage : ""} — ${c.description}`)
					.join("\n");
				ctx.reply("可用命令：\n" + body);
			},
		},
		{
			name: "new",
			description: "新建一个对话会话",
			run: async (ctx: BridgeCommandContext) => {
				const id = await ctx.engine.createSession(ctx.session.sessionKey, ctx.session.agentId, "Bridge 会话");
				ctx.engine.switchSession(ctx.session.sessionKey, id);
				ctx.reply(`已新建并切换到会话：${id}`);
			},
		},
		{
			name: "switch",
			description: "切换对话会话",
			usage: "<序号>",
			run: async (ctx: BridgeCommandContext) => {
				if (ctx.args.length < 1) {
					ctx.reply("用法：/switch <序号>（先用 /sessions 查看序号）");
					return;
				}
				const idx = parseInt(ctx.args[0], 10) - 1;
				const sessions = await ctx.engine.listSessions(ctx.session.agentId);
				if (idx < 0 || idx >= sessions.length) {
					ctx.reply(`序号越界，共 ${sessions.length} 个会话`);
					return;
				}
				ctx.engine.switchSession(ctx.session.sessionKey, sessions[idx].id);
				ctx.reply(`已切换到会话：${sessions[idx].name} (${sessions[idx].id})`);
			},
		},
		{
			name: "sessions",
			description: "列出当前 Agent 的会话",
			run: async (ctx: BridgeCommandContext) => {
				const sessions = await ctx.engine.listSessions(ctx.session.agentId);
				if (sessions.length === 0) {
					ctx.reply("暂无会话");
					return;
				}
				const body = sessions
					.map((s, i) => `${i + 1}. ${s.name} (${s.id}) — ${s.messageCount} 条消息`)
					.join("\n");
				ctx.reply("会话列表：\n" + body);
			},
		},
		{
			name: "agents",
			description: "列出可用 Agent",
			run: async (ctx: BridgeCommandContext) => {
				const agents = await ctx.engine.listAgents();
				const body = agents.map(a => `• ${a.id} — ${a.name} (默认模型: ${a.model})`).join("\n");
				ctx.reply("可用 Agent：\n" + body);
			},
		},
		{
			name: "agent",
			description: "切换本会话使用的 Agent",
			usage: "<agentId>",
			run: (ctx: BridgeCommandContext) => {
				if (ctx.args.length < 1) {
					ctx.reply("用法：/agent <agentId>（先用 /agents 查看）");
					return;
				}
				ctx.engine.setAgent(ctx.session.sessionKey, ctx.args[0]);
				ctx.reply(`已切换到 Agent：${ctx.args[0]}`);
			},
		},
		{
			name: "model",
			description: "查看或设置本会话模型覆盖",
			usage: "[modelName]",
			run: (ctx: BridgeCommandContext) => {
				if (ctx.args.length < 1) {
					ctx.reply(`当前模型覆盖：${ctx.session.modelOverride ?? "（跟随 Agent 默认）"}`);
					return;
				}
				ctx.engine.setModelOverride(ctx.session.sessionKey, ctx.args[0]);
				ctx.reply(`已设置模型覆盖：${ctx.args[0]}`);
			},
		},
		{
			name: "mode",
			description: "设置对话模式",
			usage: "[craft|ask|plan|workflow]",
			run: (ctx: BridgeCommandContext) => {
				const allowed = ["craft", "ask", "plan", "workflow"];
				if (ctx.args.length < 1) {
					ctx.reply(`当前模式：${ctx.session.chatMode ?? "craft"}`);
					return;
				}
				if (!allowed.includes(ctx.args[0])) {
					ctx.reply("可选模式：craft / ask / plan / workflow");
					return;
				}
				ctx.engine.setChatMode(ctx.session.sessionKey, ctx.args[0]);
				ctx.reply(`已切换到模式：${ctx.args[0]}`);
			},
		},
		{
			name: "stop",
			description: "中断当前流式响应",
			run: (ctx: BridgeCommandContext) => {
				ctx.engine.cancel(ctx.session.sessionKey);
				ctx.reply("已发送中断信号");
			},
		},
		{
			name: "clear",
			description: "清空当前会话历史",
			run: async (ctx: BridgeCommandContext) => {
				await ctx.engine.clearHistory(ctx.session.sessionKey);
				ctx.reply("已清空会话历史");
			},
		},
		{
			name: "relay",
			description: "把消息 relay 给另一个 Agent（bot↔bot）并把结果回传",
			usage: "<agentId>[>agentId2...] [message]",
			run: async (ctx: BridgeCommandContext) => {
				if (ctx.args.length < 1) {
					ctx.reply("用法：/relay <agentId>[>agentId2...] [message]");
					return;
				}
				const toSpec = ctx.args[0];
				const content = ctx.args.slice(1).join(" ");
				if (!content) {
					ctx.reply("请提供要 relay 的消息内容");
					return;
				}
				const ids = toSpec.split(">").map(s => s.trim()).filter(Boolean);
				if (ids.length === 0) {
					ctx.reply("用法：/relay <agentId>[>agentId2...] [message]");
					return;
				}
				if (ids.length === 1) {
					await ctx.engine.relayToAgent(ctx.session.sessionKey, ids[0], content);
				} else {
					await ctx.engine.relayChainToAgent(ctx.session.sessionKey, ids, content);
				}
			},
		},
		{
			name: "usage",
			description: "查看本会话 / Agent 的 token 用量统计",
			run: (ctx: BridgeCommandContext) => {
				const stats = ctx.engine.getUsageStats({ sessionKey: ctx.session.sessionKey });
				if (stats.length === 0) {
					ctx.reply("暂无用量数据");
					return;
				}
				const body = stats
					.map(s => {
						const credit = s.credit ? ` / 积分 ${s.credit}` : "";
						return `• ${s.agentId}: 输入 ${s.promptTokens} / 输出 ${s.completionTokens} / 缓存命中 ${s.cachedTokens} / 总 ${s.totalTokens} / 调用 ${s.calls} 次${credit}`;
					})
					.join("\n");
				ctx.reply("用量统计：\n" + body);
			},
		},
	];
}

// 供 /help 列出（与 createBuiltinCommands 保持一致顺序）
const builtinList: IBridgeCommand[] = createBuiltinCommands();

// 重新导出便于测试/扩展
export { card, buttonRow };
