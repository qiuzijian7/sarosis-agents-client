/*---------------------------------------------------------------------------------------------
 *  反思器 — 从最近观察中自动更新槽位和收集 TODO。
 *  参考 agentmemory src/functions/reflect.ts
 *
 *  规则：
 *    - 扫描最近的短期/长期记忆
 *    - 提取 TODO 项 → 追加到 pending_items 槽
 *    - 提取用户偏好 → 追加到 user_preferences 槽
 *    - 提取项目约定 → 追加到 project_context 槽
 *    - 提取工具使用模式 → 追加到 tool_guidelines 槽
 *    - Fire-and-forget，不阻塞主流程
 *--------------------------------------------------------------------------------------------*/

import type { SlotRegistry } from './slots.js';

interface InternalEntry {
	id: string;
	content: string;
	metadata?: Record<string, unknown>;
	timestamp?: number;
}

const TODO_RE = /(?:TODO|FIXME|HACK|XXX|待办|需要|应该|TODO:)\s*([^\n.]{5,80})/gi;
const PREFERENCE_RE = /(?:prefer|like|want|不喜欢|偏好|习惯|总是|usually)\s+([^\n.]{5,80})/gi;
const CONVENTION_RE = /(?:convention|standard|rule|always use|never use|should use|约定|规范|必须|禁止)\s*:?\s*([^\n.]{5,80})/gi;
const TOOL_GUIDE_RE = /(?:use|using|with|via|通过)\s+(?:the\s+)?(\w+\s*(?:tool|command|script|extension|plugin))\s+(?:to|for|when)\s+([^\n.]{5,60})/gi;

export interface ReflectResult {
	todosAdded: number;
	preferencesAdded: number;
	conventionsAdded: number;
	toolGuidesAdded: number;
	totalScanned: number;
}

export class Reflector {
	/**
	 * Reflect on recent observations and update slots.
	 * Called after sweep or on session end.
	 */
	reflect(agentId: string, entries: InternalEntry[], slots: SlotRegistry): ReflectResult {
		const result: ReflectResult = {
			todosAdded: 0,
			preferencesAdded: 0,
			conventionsAdded: 0,
			toolGuidesAdded: 0,
			totalScanned: entries.length,
		};

		// Only reflect on recent entries (last 50)
		const recent = entries.slice(-50);

		const todos: string[] = [];
		const preferences: string[] = [];
		const conventions: string[] = [];
		const toolGuides: string[] = [];

		for (const entry of recent) {
			// Extract TODOs
			for (const match of entry.content.matchAll(TODO_RE)) {
				const todo = match[1].trim();
				if (todo.length > 5 && !todos.includes(todo)) {
					todos.push(todo);
				}
			}

			// Extract preferences
			for (const match of entry.content.matchAll(PREFERENCE_RE)) {
				const pref = match[1].trim();
				if (pref.length > 5 && !preferences.includes(pref)) {
					preferences.push(pref);
				}
			}

			// Extract conventions
			for (const match of entry.content.matchAll(CONVENTION_RE)) {
				const conv = match[1].trim();
				if (conv.length > 5 && !conventions.includes(conv)) {
					conventions.push(conv);
				}
			}

			// Extract tool guidelines
			for (const match of entry.content.matchAll(TOOL_GUIDE_RE)) {
				const guide = `${match[1].trim()} → ${match[2].trim()}`;
				if (!toolGuides.includes(guide)) {
					toolGuides.push(guide);
				}
			}
		}

		// Append to slots (cap at 10 items each to prevent overflow)
		if (todos.length > 0) {
			const todoText = todos.slice(0, 10).map(t => `- [ ] ${t}`).join('\n');
			slots.append(agentId, 'pending_items', todoText);
			result.todosAdded = todos.length;
		}

		if (preferences.length > 0) {
			const prefText = preferences.slice(0, 10).map(p => `- ${p}`).join('\n');
			slots.append(agentId, 'user_preferences', prefText);
			result.preferencesAdded = preferences.length;
		}

		if (conventions.length > 0) {
			const convText = conventions.slice(0, 10).map(c => `- ${c}`).join('\n');
			slots.append(agentId, 'project_context', convText);
			result.conventionsAdded = conventions.length;
		}

		if (toolGuides.length > 0) {
			const guideText = toolGuides.slice(0, 10).map(g => `- ${g}`).join('\n');
			slots.append(agentId, 'tool_guidelines', guideText);
			result.toolGuidesAdded = toolGuides.length;
		}

		return result;
	}
}
