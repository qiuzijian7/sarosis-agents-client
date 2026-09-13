/*---------------------------------------------------------------------------------------------
 *  固定槽位 — 可编辑的固定记忆槽，始终注入上下文。
 *  参考 agentmemory src/functions/slots.ts
 *
 *  槽位列表：
 *    persona           — Agent 人格描述
 *    user_preferences  — 用户偏好
 *    project_context   — 项目上下文
 *    tool_guidelines   — 工具使用准则
 *    guidance          — 通用指导
 *    pending_items     — 待办事项
 *    session_patterns  — 会话模式
 *    self_notes        — 自我备注
 *--------------------------------------------------------------------------------------------*/

export type SlotName =
	| 'persona'
	| 'user_preferences'
	| 'project_context'
	| 'tool_guidelines'
	| 'guidance'
	| 'pending_items'
	| 'session_patterns'
	| 'self_notes';

export interface MemorySlot {
	label: SlotName;
	content: string;
	sizeLimit: number;
	description: string;
	pinned: boolean;   // Q3: pinned slot 优先注入，不受 budget 限制
	readonly: boolean;
	createdAt: string;
	updatedAt: string;
}

const SLOT_DEFINITIONS: Array<{ label: SlotName; sizeLimit: number; description: string; pinned: boolean; readonly: boolean }> = [
	{ label: 'persona', sizeLimit: 500, description: 'Agent 人格描述', pinned: true, readonly: false },
	{ label: 'user_preferences', sizeLimit: 1000, description: '用户偏好', pinned: true, readonly: false },
	{ label: 'project_context', sizeLimit: 2000, description: '项目上下文', pinned: true, readonly: false },
	{ label: 'tool_guidelines', sizeLimit: 500, description: '工具使用准则', pinned: true, readonly: false },
	{ label: 'guidance', sizeLimit: 500, description: '通用指导', pinned: true, readonly: false },
	{ label: 'pending_items', sizeLimit: 1000, description: '待办事项', pinned: false, readonly: false },
	{ label: 'session_patterns', sizeLimit: 500, description: '会话模式', pinned: false, readonly: false },
	{ label: 'self_notes', sizeLimit: 500, description: '自我备注', pinned: false, readonly: false },
];

export class SlotRegistry {
	private _slots = new Map<string, Map<SlotName, MemorySlot>>();

	/** Ensure slots exist for an agent (lazy init) */
	private _ensure(agentId: string): Map<SlotName, MemorySlot> {
		let slots = this._slots.get(agentId);
		if (!slots) {
			slots = new Map();
			const now = new Date().toISOString();
			for (const def of SLOT_DEFINITIONS) {
				slots.set(def.label, { ...def, content: '', createdAt: now, updatedAt: now });
			}
			this._slots.set(agentId, slots);
		}
		return slots;
	}

	/** Get a slot's content */
	get(agentId: string, label: SlotName): string {
		const slots = this._ensure(agentId);
		return slots.get(label)?.content ?? '';
	}

	/** Set a slot's content (with size limit enforcement) */
	set(agentId: string, label: SlotName, content: string): void {
		const slots = this._ensure(agentId);
		const slot = slots.get(label);
		if (slot && !slot.readonly) {
			slot.content = content.slice(0, slot.sizeLimit);
			slot.updatedAt = new Date().toISOString();
		}
	}

	/** Append to a slot's content */
	append(agentId: string, label: SlotName, text: string): void {
		const current = this.get(agentId, label);
		const separator = current ? '\n' : '';
		this.set(agentId, label, current + separator + text);
	}

	/** Get all pinned slots (always injected into context) */
	getPinned(agentId: string): MemorySlot[] {
		const slots = this._ensure(agentId);
		return Array.from(slots.values()).filter(s => s.pinned && s.content.length > 0);
	}

	/** Q3: Pin/unpin a slot at runtime */
	pin(agentId: string, label: SlotName, pinned: boolean = true): void {
		const slots = this._ensure(agentId);
		const slot = slots.get(label);
		if (slot) { slot.pinned = pinned; slot.updatedAt = new Date().toISOString(); }
	}

	/** List all slots for an agent */
	list(agentId: string): MemorySlot[] {
		return Array.from(this._ensure(agentId).values());
	}

	/** Q3: Build context with pinned slots first */
	buildContext(agentId: string): string {
		const all = this.list(agentId).filter(s => s.content.length > 0);
		const pinned = all.filter(s => s.pinned);
		const unpinned = all.filter(s => !s.pinned);
		const parts: string[] = [];
		for (const s of [...pinned, ...unpinned]) {
			parts.push(`## ${s.description} (${s.label})\n${s.content}`);
		}
		return parts.join('\n\n');
	}

	/** Get all slots */
	getAll(agentId: string): MemorySlot[] {
		const slots = this._ensure(agentId);
		return Array.from(slots.values());
	}

	/** Build a system prompt from pinned slots */
	buildSystemPrompt(agentId: string): string {
		const pinned = this.getPinned(agentId);
		if (pinned.length === 0) return '';
		const parts: string[] = ['## Pinned Memory Slots'];
		for (const slot of pinned) {
			parts.push(`### ${slot.description} (${slot.label})`);
			parts.push(slot.content);
		}
		return parts.join('\n');
	}

	/** Serialize all slots for persistence */
	serialize(agentId: string): string {
		const slots = this._slots.get(agentId);
		if (!slots) return '{}';
		const obj: Record<string, { content: string; updatedAt: string }> = {};
		for (const [label, slot] of slots) {
			if (slot.content) {
				obj[label] = { content: slot.content, updatedAt: slot.updatedAt };
			}
		}
		return JSON.stringify(obj);
	}

	/** Deserialize slots from persisted data */
	deserialize(agentId: string, json: string): void {
		try {
			const data = JSON.parse(json);
			const slots = this._ensure(agentId);
			for (const [label, val] of Object.entries(data)) {
				const slot = slots.get(label as SlotName);
				if (slot && typeof val === 'object' && val !== null) {
					const v = val as { content: string; updatedAt: string };
					slot.content = v.content.slice(0, slot.sizeLimit);
					slot.updatedAt = v.updatedAt;
				}
			}
		} catch { /* ignore malformed */ }
	}

	clear(agentId: string): void {
		this._slots.delete(agentId);
	}

	clearAll(): void {
		this._slots.clear();
	}
}
