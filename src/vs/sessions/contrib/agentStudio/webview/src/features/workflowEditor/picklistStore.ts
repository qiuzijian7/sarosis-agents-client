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

interface PicklistState {
	skills: SkillItem[];
	skillsLoaded: boolean;
	/** Fetch skills from the host once (idempotent). */
	loadSkills: () => Promise<void>;
}

export const usePicklistStore = create<PicklistState>((set, get) => ({
	skills: [],
	skillsLoaded: false,
	loadSkills: async () => {
		if (get().skillsLoaded) { return; }
		try {
			const skills = await sendRequest<unknown, SkillItem[]>('skills.list', {});
			set({ skills: skills ?? [], skillsLoaded: true });
		} catch {
			// Silent: the dropdown just shows the raw value when the host is
			// unreachable.
			set({ skillsLoaded: true });
		}
	},
}));
