/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Employee Store (Zustand)
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';
import { sendRequest, postMessage } from '../bridge/messageClient';

export interface Employee {
	id: string;
	name: string;
	role: string;
	email?: string;
	avatar?: string;
	avatarStyle?: string;
	avatarSeed?: string;
	presetId?: string;
	model?: string;
	provider?: string;
	customPrompt?: string;
	skills?: { id: string; name: string; enabled: boolean }[];
	status: 'idle' | 'working' | 'thinking' | 'error' | 'offline';
	teamId?: string;
	workspaceId?: string;
	position?: { x: number; y: number };
	tokenUsage?: number | { input: number; output: number; total: number };
	isPM?: boolean;
	sortOrder?: number;
	subagentOf?: string | null;
	category?: string;
	temperature?: number;
	maxTokens?: number;
	/** Path to the agent instance directory under .sarosisworkspace/agents/{slug}/ */
	agentDir?: string;
	/**
	 * Bootstrap templates from a preset, used when creating the agent instance directory.
	 * Transient — only used during creation, not persisted.
	 */
	bootstrapTemplates?: {
		agentsMd?: string;
		soulMd?: string;
		identityMd?: string;
		toolsMd?: string;
		memoryMd?: string;
	};
}

/** Portable export format for an agent instance */
export interface AgentExportData {
	readonly version: 1;
	readonly exportedAt: string;
	readonly employee: Partial<Employee>;
	readonly agentConfig: Record<string, unknown>;
	readonly files: {
		readonly agentsMd?: string;
		readonly soulMd?: string;
		readonly identityMd?: string;
		readonly toolsMd?: string;
		readonly memoryMd?: string;
	};
}

interface EmployeeState {
	employees: Employee[];
	selectedEmployeeId: string | null;
	searchQuery: string;
	isLoading: boolean;

	// Actions
	loadEmployees: (workspaceId?: string) => Promise<void>;
	selectEmployee: (id: string | null, _skipBroadcast?: boolean) => void;
	setSearchQuery: (query: string) => void;
	createEmployee: (data: Partial<Employee>) => Promise<Employee>;
	updateEmployee: (id: string, data: Partial<Employee>) => Promise<void>;
	deleteEmployee: (id: string) => Promise<void>;
	exportEmployee: (id: string) => Promise<AgentExportData>;
	importEmployee: (data: AgentExportData, workspaceId?: string) => Promise<Employee>;

	// Computed
	filteredEmployees: () => Employee[];
}

export const useEmployeeStore = create<EmployeeState>((set, get) => ({
	employees: [],
	selectedEmployeeId: null,
	searchQuery: '',
	isLoading: false,

	loadEmployees: async (workspaceId?: string) => {
		set({ isLoading: true });
		try {
			const employees = await sendRequest<{ workspaceId?: string }, Employee[]>(
				'employees.list',
				{ workspaceId }
			);
			set({ employees, isLoading: false });
		} catch (err) {
			console.error('[EmployeeStore] Failed to load employees:', err);
			set({ isLoading: false });
		}
	},

	selectEmployee: (id, _skipBroadcast = false) => {
		set({ selectedEmployeeId: id });
		if (!_skipBroadcast) {
			postMessage('employees.selected', { employeeId: id });
		}
	},
	setSearchQuery: (query) => set({ searchQuery: query }),

	createEmployee: async (data) => {
		const employee = await sendRequest<Partial<Employee>, Employee>('employees.create', data);
		set(state => ({ employees: [...state.employees, employee] }));
		return employee;
	},

	updateEmployee: async (id, data) => {
		await sendRequest('employees.update', { id, data });
		set(state => ({
			employees: state.employees.map(e => e.id === id ? { ...e, ...data } : e),
		}));
	},

	deleteEmployee: async (id) => {
		await sendRequest('employees.delete', { id });
		set(state => ({
			employees: state.employees.filter(e => e.id !== id),
			selectedEmployeeId: state.selectedEmployeeId === id ? null : state.selectedEmployeeId,
		}));
	},

	exportEmployee: async (id) => {
		const exportData = await sendRequest<{ id: string }, AgentExportData>('employees.export', { id });
		return exportData;
	},

	importEmployee: async (data, workspaceId) => {
		const employee = await sendRequest<{ exportData: AgentExportData; workspaceId?: string }, Employee>(
			'employees.import',
			{ exportData: data, workspaceId },
		);
		set(state => ({ employees: [...state.employees, employee] }));
		return employee;
	},

	filteredEmployees: () => {
		const { employees, searchQuery } = get();
		if (!searchQuery) { return employees; }
		const q = searchQuery.toLowerCase();
		return employees.filter(e =>
			e.name.toLowerCase().includes(q) ||
			e.role.toLowerCase().includes(q)
		);
	},
}));
