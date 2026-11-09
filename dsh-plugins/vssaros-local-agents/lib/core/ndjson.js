// CLI 的 NDJSON / stream-json 事件 → dsh StreamChunk（P0）。
//
// 设计边界：P0 只搬运**文本与结束**，不搬工具调用、不做增量消息、不做 resume。
// 这样整条 seam 可以先被真实 runtime 验证，而三种 CLI 的方言差异被收在这一个纯函数里。
// 事件来源是 CLI 的 stdout，每行一个 JSON；解析失败的行静默跳过（CLI 常在首行打非 JSON 提示）。

/** 安全解析一行；非对象返回 undefined。 */
export function parseLine(line) {
	const text = typeof line === 'string' ? line.trim() : '';
	if (!text || text[0] !== '{') return undefined;
	try {
		const value = JSON.parse(text);
		return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function textFromParts(parts) {
	if (!Array.isArray(parts)) return '';
	return parts
		.filter((part) => part && part.type === 'text' && typeof part.text === 'string')
		.map((part) => part.text)
		.join('');
}

/**
 * 把一行 CLI 事件归一成 { type:'text'|'usage'|'done'|'error' }。
 * 认不出的事件返回 undefined（不猜语义）。
 */
export function normalizeEvent(line, kind) {
	const event = parseLine(line);
	if (!event) return undefined;

	if (kind === 'codex-json') {
		if (event.type === 'item.completed' && event.item?.type === 'agent_message'
			&& typeof event.item.text === 'string') {
			return { type: 'text', text: event.item.text };
		}
		if (event.type === 'turn.completed') return { type: 'done', usage: event.usage };
		if (event.type === 'turn.failed' || event.type === 'error') {
			return { type: 'error', text: String(event.error?.message ?? event.message ?? 'CLI 调用失败') };
		}
		return undefined;
	}

	if (kind === 'claude-stream-json') {
		if (event.type === 'assistant') {
			const text = textFromParts(event.message?.content);
			if (text) return { type: 'text', text };
		}
		if (event.type === 'result') return { type: 'done', usage: event.usage };
		if (event.type === 'error') {
			return { type: 'error', text: String(event.error?.message ?? event.message ?? 'CLI 调用失败') };
		}
		return undefined;
	}

	return undefined;
}

/**
 * 归一化事件 → dsh StreamChunk。形状由 dsh-llm 的 StreamChunk 契约钉住，
 * 见 dsh-plugins/test/llm-adapter-contract.test.mjs。
 *
 * 遇 error 事件抛错：runtime 的 adapterStream 会把它转成 error finish chunk，
 * 不会让回合挂住。
 */
export async function* toChunks(events) {
	let text = '';
	let started = false;
	let usage;
	// for await 同时接受数组与异步生成器：adapter 直接喂逐行归一后的流，保持流式输出。
	for await (const event of events) {
		if (!event) continue;
		if (event.type === 'error') throw new Error(event.text || 'CLI 调用失败');
		if (event.type === 'usage' || (event.type === 'done' && event.usage)) usage = event.usage;
		if (event.type !== 'text' || !event.text) continue;
		if (!started) {
			yield { type: 'block-start', index: 0, blockType: 'text' };
			started = true;
		}
		text += event.text;
		yield { type: 'text-delta', index: 0, text: event.text };
	}
	if (started) yield { type: 'block-end', index: 0, block: { type: 'text', text } };
	if (usage) yield { type: 'usage', usage };
	yield { type: 'finish', reason: { kind: 'stop' } };
}

/** 把一个可读流按行切分（异步生成器），供 adapter 消费子进程 stdout。 */
export async function* linesOf(readable) {
	if (!readable || typeof readable[Symbol.asyncIterator] !== 'function') return;
	let buffer = '';
	for await (const chunk of readable) {
		buffer += String(chunk);
		let at;
		while ((at = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, at);
			buffer = buffer.slice(at + 1);
			yield line;
		}
	}
	if (buffer.trim()) yield buffer;
}
