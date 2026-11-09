// ACP 多轮适配器（P1）。
//
// 与 P0 单轮 NDJSON 的区别：一轮 CLI prompt 会跨多次 dsh `stream()` 调用。
//   #1 text/activity → 遇到 MCP tools/call → 发 tool-call 三连 chunk + finish(tool-calls) → return
//   #2 dsh loop 执行工具（含审批）→ 再调 stream() → 从 role:'tool' 消息回灌 MCP SSE → CLI 继续
//   #3 同一 live 的事件队列继续 drain，直到 done → finish(stop)
// 因此 events / pending / mcp / CLI session 都挂在 live 上，不能随单次 stream 销毁。
import { AcpEngine } from './acp.js';
import { APPROVE_TOOL, LoopbackMcp } from './mcp.js';
import { textOfContent } from './text.js';
import { acpPromptBlocks, imageRefsOf, withInstructions } from './images.js';

export const DEFAULT_CONTEXT_WINDOW = 200_000;

export function parseDecision(text) {
	try {
		const value = JSON.parse(String(text ?? ''));
		return value && value.decision === 'allow' ? 'allow' : 'deny';
	} catch {
		return 'deny'; // 自由文本 / 解析失败一律 deny（fail-closed）
	}
}

/** 只在决策明确为 allow 且 CLI 提供了 allow 类选项时才放行。 */
export function pickAllowOption(options, decision) {
	if (decision !== 'allow' || !Array.isArray(options)) return null;
	const found = options.find((option) =>
		/allow/i.test(String(option?.kind ?? '')) || /allow/i.test(String(option?.optionId ?? '')));
	return found?.optionId ?? null;
}

export function approveToolSchema() {
	return {
		name: APPROVE_TOOL,
		description: 'Answer a permission request from a local agent CLI. The tool result must be JSON {"decision":"allow"} or {"decision":"deny"}.',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', description: 'What the CLI wants to do' },
				options: { type: 'array', items: { type: 'object', additionalProperties: true } },
			},
			required: ['action'],
			additionalProperties: false,
		},
	};
}

export function createAcpAdapter({ engineTable = {}, deps = {} } = {}) {
	const engineFactory = deps.engineFactory ?? ((route, spec) => new AcpEngine(route, spec, deps));
	const mcpFactory = deps.mcpFactory ?? ((options) => new LoopbackMcp(options));
	const cwdFor = deps.cwdFor ?? (() => process.cwd());
	/** P2：由插件入口从 `attachments.readImage` 注入；缺失时 ACP 也不声明支持图片。 */
	const readImage = deps.readImage;
	const engines = new Map();
	const lives = new Map();

	const engineOf = (route) => {
		let engine = engines.get(route);
		if (!engine) {
			engine = engineFactory(route, engineTable[route]);
			engines.set(route, engine);
		}
		return engine;
	};

	async function ensureLive(sessionId, route, options) {
		const existing = lives.get(sessionId);
		if (existing) return existing;
		const engine = engineOf(route);
		await engine.ensure();
		/** 每次 stream 开头刷新：工具面按分层披露可能变化。 */
		let live;
		const mcp = mcpFactory({
			tools: () => live?.tools ?? [],
			onCall: ({ name, args, arguments: callArgs, callId }) => {
				if (!live) return;
				const dshCallId = `vsla-${callId}`;
				live.pending.set(dshCallId, { kind: 'mcp', mcpCallId: callId });
				live.events.push({ type: 'call', name, args: args ?? callArgs ?? {}, dshCallId });
			},
		});
		const endpoint = await mcp.start();
		const cliSessionId = await engine.openSession({
			cwd: cwdFor(options),
			mcp: { url: endpoint.url, token: endpoint.token },
		});
		live = {
			route, cliSessionId, engine, mcp,
			events: engine.events(cliSessionId),
			pending: new Map(),
			tools: [],
			handed: 0,
		};
		lives.set(sessionId, live);
		return live;
	}

	const toolSurface = (options) => {
		const provided = Array.isArray(options.tools) ? options.tools : [];
		const allowed = deps.allowedToolNames
			? provided.filter((tool) => deps.allowedToolNames.has(tool.name))
			: provided;
		return [...allowed, approveToolSchema()];
	};

	/** 一次 stream 内的块索引从 0 开始（runtime 的 assembler 按单次流组装）。 */
	function makeEmitter() {
		let index = 0;
		const open = new Map();
		return {
			nextIndex() { return index++; },
			async *text(type, text) {
				if (!text) return;
				let slot = open.get(type);
				if (!slot) {
					slot = { index: index++, parts: [] };
					open.set(type, slot);
					yield { type: 'block-start', index: slot.index, blockType: type };
				}
				slot.parts.push(text);
				yield { type: type === 'reasoning' ? 'reasoning-delta' : 'text-delta', index: slot.index, text };
			},
			async *closeAll() {
				for (const [type, slot] of open) {
					const text = slot.parts.join('');
					yield { type: 'block-end', index: slot.index, block: { type, text } };
				}
				open.clear();
			},
		};
	}

	async function* drain(live, signal) {
		const emit = makeEmitter();
		while (true) {
			const { done, value: event } = await live.events.wait(signal);
			if (done) {
				live.mcp.failAll(new Error('the turn was stopped'));
				live.engine.cancel(live.cliSessionId);
				for (const [, pending] of live.pending) {
					if (pending.kind === 'permission') live.engine.answerPermission(pending.permissionId, null);
				}
				live.pending.clear();
				yield* emit.closeAll();
				yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'the turn was stopped' } } };
				return;
			}
			switch (event.type) {
				case 'text':
					yield* emit.text('text', event.text);
					break;
				case 'thought':
				case 'activity':
					yield* emit.text('reasoning', `${event.text}\n`);
					break;
				case 'call':
				case 'permission': {
					yield* emit.closeAll();
					const at = emit.nextIndex();
					const id = event.dshCallId ?? `vsla-perm-${Math.random().toString(36).slice(2)}`;
					const name = event.type === 'permission' ? APPROVE_TOOL : event.name;
					const args = JSON.stringify(event.type === 'permission'
						? { action: event.action, options: event.options }
						: (event.args ?? {}));
					if (event.type === 'permission') {
						live.pending.set(id, { kind: 'permission', permissionId: event.id, options: event.options });
					}
					yield { type: 'block-start', index: at, blockType: 'tool-call' };
					yield { type: 'tool-call-delta', index: at, id, name, argumentsDelta: args };
					yield { type: 'block-end', index: at, block: { type: 'tool-call', id, name, arguments: args } };
					yield { type: 'finish', reason: { kind: 'tool-calls' } };
					return;
				}
				case 'done':
					yield* emit.closeAll();
					yield { type: 'finish', reason: { kind: 'stop' } };
					return;
				case 'error':
					yield* emit.closeAll();
					throw new Error(String(event.error ?? 'ACP 调用失败'));
				case 'usage':
					// ACP usage_update 结构随 CLI 而异；P1 不冒险伪造 TokenUsage，P2 再对齐。
					break;
				default:
					break;
			}
		}
	}

	return {
		lives,

		async listModels(route) {
			try { return (await engineOf(route).listModels({ cwd: cwdFor() })).map((model) => ({ ...model, provider: route })); }
			catch { return [{ provider: route, id: 'default', name: 'CLI default' }]; }
		},

		async *stream(options) {
			const route = options?.provider;
			const spec = engineTable[route];
			if (!spec || spec.kind !== 'acp') throw new Error(`不是 ACP 路由：${route}`);
			if (options.purpose === 'session-title' || options.purpose === 'compaction') {
				const text = options.purpose === 'session-title'
					? textOfContent(options.messages?.at(-1)?.content).replace(/\s+/g, ' ').trim().slice(0, 60) || 'New session'
					: '[Earlier conversation, condensed]';
				yield { type: 'block-start', index: 0, blockType: 'text' };
				yield { type: 'text-delta', index: 0, text };
				yield { type: 'block-end', index: 0, block: { type: 'text', text } };
				yield { type: 'finish', reason: { kind: 'stop' } };
				return;
			}

			const sessionId = String(options.sessionId ?? 'anonymous');
			const live = await ensureLive(sessionId, route, options);
			live.tools = toolSurface(options);

			const messages = Array.isArray(options.messages) ? options.messages : [];
			const delta = messages.slice(live.handed);
			live.handed = messages.length;
			let userText = '';
			let imageBlocks;
			for (const message of delta) {
				if (message?.role === 'tool' && live.pending.has(String(message.toolCallId))) {
					const pending = live.pending.get(String(message.toolCallId));
					live.pending.delete(String(message.toolCallId));
					const text = textOfContent(message.content) || (message.isError ? 'the call failed' : '');
					if (pending.kind === 'mcp') {
						live.mcp.settle(pending.mcpCallId, { text, isError: message.isError === true });
					} else {
						const optionId = pickAllowOption(pending.options, parseDecision(text));
						live.engine.answerPermission(pending.permissionId, optionId);
					}
				} else if (message?.role === 'user') {
					userText = textOfContent(message.content);
					// P2：有图片才走块数组；纯文本回合保持 P1 的字符串路径逐字不变。
					if (imageRefsOf(message.content).length) {
						imageBlocks = (await acpPromptBlocks({ content: message.content, readImage })).blocks;
					}
				}
			}

			if (userText || imageBlocks) {
				const system = messages.find((message) => message?.role === 'system');
				const instructions = system ? textOfContent(system.content).trim() : '';
				if (imageBlocks) {
					live.engine.prompt(live.cliSessionId, withInstructions(imageBlocks, instructions),
						{ signal: options.signal });
				} else {
					live.engine.prompt(live.cliSessionId,
						instructions ? `${instructions}\n\n${userText}` : userText,
						{ signal: options.signal });
				}
			}
			yield* drain(live, options.signal);
		},

		dispose() {
			for (const live of lives.values()) live.mcp.close();
			lives.clear();
			for (const engine of engines.values()) engine.dispose();
			engines.clear();
		},
	};
}
