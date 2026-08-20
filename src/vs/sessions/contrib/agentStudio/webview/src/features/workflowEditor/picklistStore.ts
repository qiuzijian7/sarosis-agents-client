/*---------------------------------------------------------------------------------------------
 *  picklistStore — cached host picklists for workflow node forms (agents/skills).
 *
 *  The workflow editor's Agent / Skill nodes need dropdowns populated with every
 *  current agent item and skill. Agents already live in `useAgentStore`; skills
 *  are fetched once from the host via `skills.list` and cached module-wide so
 *  reopening the node editor doesn't refetch every time.
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';
import { sendRequest } from '../../bridge/messageClient';

export interface SkillItem {
	id: string;
	name: string;
	category?: string;
	activation?: string;
	description?: string;
}

export interface ToolItem {
	id: string;
	name: string;
	description?: string;
}

interface PicklistState {
	skills: SkillItem[];
	skillsLoaded: boolean;
	/** Fetch skills from the host once (idempotent). */
	loadSkills: () => Promise<void>;
	tools: ToolItem[];
	toolsLoaded: boolean;
	/** Fetch tool names from the host once (idempotent). */
	loadTools: () => Promise<void>;
}

export const usePicklistStore = create<PicklistState>((set, get) => ({
	skills: [],
	skillsLoaded: false,
	loadSkills: async () => {
		// ★ 有数据才算「已加载」：host 的 _handleSkillsList 有 3s 超时降级
		//   （skillRegistry 磁盘扫描 IO hang 时返回**部分**结果，可能为空数组）。
		//   若空结果也置 skillsLoaded=true，超时这一次的空列表会被永久缓存，
		//   后续扫描完成也永远拉不到 —— 允许空结果重试（effect 有
		//   skills.length===0 条件挡着，重试频率可控）。
		if (get().skillsLoaded && get().skills.length > 0) { return; }
		try {
			const skills = await sendRequest<unknown, SkillItem[]>('skills.list', {});
			set({ skills: skills ?? [], skillsLoaded: (skills ?? []).length > 0 });
		} catch {
			// Silent: the dropdown just shows the raw value when the host is
			// unreachable.
			set({ skillsLoaded: false });
		}
	},
	tools: [],
	toolsLoaded: false,
	loadTools: async () => {
		if (get().toolsLoaded) { return; }
		try {
			const tools = await sendRequest<unknown, ToolItem[]>('tools.list', {});
			set({ tools: tools ?? [], toolsLoaded: true });
		} catch {
			set({ toolsLoaded: true });
		}
	},
}));
