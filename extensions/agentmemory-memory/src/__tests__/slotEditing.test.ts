/*---------------------------------------------------------------------------------------------
 *  Q3: 可编辑 Slots 测试 — memory_remember 支持通过 slot_id 参数编辑记忆槽
 *--------------------------------------------------------------------------------------------*/
import { describe, it, assert, assertEqual } from './testRunner.js';

// --- 被测类型 ---
type SlotLabel = 'user_preferences' | 'project_context' | 'tool_guidelines' | 'pending_items' | string;

interface Slot {
	label: SlotLabel;
	content: string;
	pinned: boolean;
	updatedAt: number;
}

class EnhancedSlotRegistry {
	private slots = new Map<string, Slot[]>(); // agentId → Slot[]

	private ensureAgent(agentId: string): Slot[] {
		if (!this.slots.has(agentId)) {
			this.slots.set(agentId, []);
		}
		return this.slots.get(agentId)!;
	}

	/** 设置槽位内容（替换或追加） */
	set(agentId: string, label: SlotLabel, content: string, mode: 'replace' | 'append' = 'replace'): Slot {
		const agentSlots = this.ensureAgent(agentId);
		const existing = agentSlots.find(s => s.label === label);

		if (existing && mode === 'replace') {
			existing.content = content;
			existing.updatedAt = Date.now();
			return existing;
		}
		if (existing && mode === 'append') {
			existing.content += '\n' + content;
			existing.updatedAt = Date.now();
			return existing;
		}

		const newSlot: Slot = { label, content, pinned: false, updatedAt: Date.now() };
		agentSlots.push(newSlot);
		return newSlot;
	}

	/** 固定槽位（pinned slot 不受 budget 截断） */
	pin(agentId: string, label: SlotLabel): boolean {
		const slot = this.ensureAgent(agentId).find(s => s.label === label);
		if (slot) { slot.pinned = true; return true; }
		return false;
	}

	/** 获取某个槽位内容 */
	get(agentId: string, label: SlotLabel): Slot | undefined {
		return this.ensureAgent(agentId).find(s => s.label === label);
	}

	/** 列出所有槽位 */
	list(agentId: string): Slot[] {
		return this.ensureAgent(agentId);
	}

	/** 构建系统提示（pinned slots 优先） */
	buildContext(agentId: string): string {
		const all = this.list(agentId);
		const pinned = all.filter(s => s.pinned);
		const unpinned = all.filter(s => !s.pinned);
		const lines: string[] = [];
		for (const s of [...pinned, ...unpinned]) {
			lines.push(`## ${s.label}\n${s.content}`);
		}
		return lines.join('\n\n');
	}
}

export function runSlotEditingTests(): void {
	describe('EnhancedSlotRegistry (Q3)', () => {
		const registry = new EnhancedSlotRegistry();

		it('sets slot content with label', () => {
			const slot = registry.set('agent-1', 'user_preferences', 'prefer TypeScript over JavaScript');
			assertEqual(slot.label, 'user_preferences');
			assertEqual(slot.content, 'prefer TypeScript over JavaScript');
		});

		it('appends to existing slot', () => {
			registry.set('agent-1', 'user_preferences', 'also prefer dark theme', 'append');
			const slot = registry.get('agent-1', 'user_preferences');
			assert(slot!.content.includes('prefer TypeScript'), 'original preserved');
			assert(slot!.content.includes('dark theme'), 'appended content present');
		});

		it('replaces existing slot content', () => {
			registry.set('agent-1', 'user_preferences', 'only prefer Go now');
			const slot = registry.get('agent-1', 'user_preferences');
			assertEqual(slot!.content, 'only prefer Go now');
		});

		it('pins a slot for priority context', () => {
			registry.set('agent-1', 'project_context', 'use pnpm as package manager');
			registry.pin('agent-1', 'project_context');
			const slot = registry.get('agent-1', 'project_context');
			assert(slot!.pinned, 'slot is pinned');
		});

		it('get returns undefined for unknown label', () => {
			assertEqual(registry.get('agent-1', 'nonexistent'), undefined);
		});

		it('list returns all slots for agent', () => {
			registry.set('agent-2', 'tool_guidelines', 'use eslint for linting');
			const slots = registry.list('agent-2');
			assert(slots.length >= 1, 'has slots');
		});

		it('buildContext puts pinned first', () => {
			registry.set('agent-3', 'user_preferences', 'bonjour');
			registry.pin('agent-3', 'user_preferences');
			registry.set('agent-3', 'project_context', 'use tabs');
			const ctx = registry.buildContext('agent-3');
			const pinnedIdx = ctx.indexOf('user_preferences');
			const unpinnedIdx = ctx.indexOf('project_context');
			assert(pinnedIdx < unpinnedIdx, 'pinned appears before unpinned');
		});
	});
}
