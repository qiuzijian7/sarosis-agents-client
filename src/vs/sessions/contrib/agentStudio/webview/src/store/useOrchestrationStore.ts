/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Orchestration Store (Zustand)
 *  Manages task orchestration plans: create, approve/reject, task actions
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';
import { sendRequest } from '../bridge/messageClient';

// ─── Types ──────────────────────────────────────────────────────────────────

export type OrchestrationPlanStatus =
	| 'pending_approval'
	| 'approved'
	| 'executing'
	| 'completed'
	| 'rejected'
	| 'error';

export type PlanTaskStatus =
	| 'pending'
	| 'running'
	| 'paused'
	| 'done'
	| 'cancelled'
	| 'error';

export type OrchestrationTaskAction = 'retry' | 'pause' | 'resume' | 'cancel';

export interface PlanTask {
	id: string;
	title: string;
	description?: string;
	status: PlanTaskStatus;
	dependencies: string[];
	assigneeId?: string;
	assigneeName?: string;
	assigneeRole?: string;
	autoCreateAgent: boolean;
	priority: number;
	depth: number;
	retryCount: number;
	maxRetries: number;
	timeoutMs: number;
	result?: string;
	error?: string;
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
}

export interface OrchestrationPlan {
	id: string;
	goal: string;
	summary: string;
	status: OrchestrationPlanStatus;
	tasks: PlanTask[];
	workspaceId: string;
	/** The planner agent who created this plan */
	plannerId: string;
	/** The PM agent who dispatches tasks (only PM can approve) */
	pmId?: string;
	/** Max concurrent running tasks */
	maxConcurrency: number;
	createdAt: string;
	updatedAt: string;
	approvedAt?: string;
	completedAt?: string;
}

// ─── Store ──────────────────────────────────────────────────────────────────

interface OrchestrationState {
	/** All orchestration plans for the current workspace */
	plans: OrchestrationPlan[];
	/** The plan currently being previewed (pending approval) */
	activePlan: OrchestrationPlan | null;
	/** Whether the plan dialog is open */
	isPlanDialogOpen: boolean;
	/** Loading state */
	isLoading: boolean;
	/** Error message */
	error: string | null;

	// Actions
	createPlan: (goal: string, workspaceId: string, plannerId: string) => Promise<OrchestrationPlan | null>;
	approvePlan: (planId: string) => Promise<void>;
	rejectPlan: (planId: string) => Promise<void>;
	taskAction: (planId: string, taskId: string, action: OrchestrationTaskAction) => Promise<void>;
	loadPlans: (workspaceId: string) => Promise<void>;
	openPlanDialog: () => void;
	closePlanDialog: () => void;
	setActivePlan: (plan: OrchestrationPlan | null) => void;
	updatePlanFromEvent: (plan: OrchestrationPlan) => void;
	updateTaskFromEvent: (planId: string, task: PlanTask) => void;
}

export const useOrchestrationStore = create<OrchestrationState>((set, get) => ({
	plans: [],
	activePlan: null,
	isPlanDialogOpen: false,
	isLoading: false,
	error: null,

	createPlan: async (goal, workspaceId, plannerId) => {
		set({ isLoading: true, error: null });
		try {
			const plan = await sendRequest<
				{ goal: string; workspaceId: string; plannerId: string },
				OrchestrationPlan
			>('orchestration.plan', { goal, workspaceId, plannerId });

			set(state => ({
				plans: [...state.plans, plan],
				activePlan: plan,
				// Don't open dialog automatically - plan will be shown in chat message
				isPlanDialogOpen: false,
				isLoading: false,
			}));
			return plan;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			set({ isLoading: false, error: message });
			console.error('[OrchestrationStore] createPlan failed:', err);
			return null;
		}
	},

	approvePlan: async (planId) => {
		set({ isLoading: true, error: null });
		try {
			const updatedPlan = await sendRequest<
				{ planId: string },
				OrchestrationPlan
			>('orchestration.approve', { planId });

			set(state => ({
				plans: state.plans.map(p => p.id === planId ? updatedPlan : p),
				activePlan: state.activePlan?.id === planId ? updatedPlan : state.activePlan,
				isPlanDialogOpen: false,
				isLoading: false,
			}));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			set({ isLoading: false, error: message });
			console.error('[OrchestrationStore] approvePlan failed:', err);
		}
	},

	rejectPlan: async (planId) => {
		set({ isLoading: true, error: null });
		try {
			const updatedPlan = await sendRequest<
				{ planId: string },
				OrchestrationPlan
			>('orchestration.reject', { planId });

			set(state => ({
				plans: state.plans.map(p => p.id === planId ? updatedPlan : p),
				activePlan: null,
				isPlanDialogOpen: false,
				isLoading: false,
			}));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			set({ isLoading: false, error: message });
			console.error('[OrchestrationStore] rejectPlan failed:', err);
		}
	},

	taskAction: async (planId, taskId, action) => {
		try {
			await sendRequest<
				{ planId: string; taskId: string; action: string },
				PlanTask
			>('orchestration.taskAction', { planId, taskId, action });
		} catch (err) {
			console.error('[OrchestrationStore] taskAction failed:', err);
		}
	},

	loadPlans: async (workspaceId) => {
		set({ isLoading: true });
		try {
			const plans = await sendRequest<
				{ workspaceId: string },
				OrchestrationPlan[]
			>('orchestration.listPlans', { workspaceId });
			set({ plans, isLoading: false });
		} catch (err) {
			console.error('[OrchestrationStore] loadPlans failed:', err);
			set({ isLoading: false });
		}
	},

	openPlanDialog: () => set({ isPlanDialogOpen: true }),
	closePlanDialog: () => set({ isPlanDialogOpen: false, activePlan: null }),
	setActivePlan: (plan) => set({ activePlan: plan, isPlanDialogOpen: !!plan }),

	updatePlanFromEvent: (plan) => {
		set(state => {
			const exists = state.plans.some(p => p.id === plan.id);
			const plans = exists
				? state.plans.map(p => p.id === plan.id ? plan : p)
				: [...state.plans, plan];
			return {
				plans,
				activePlan: state.activePlan?.id === plan.id ? plan : state.activePlan,
			};
		});
	},

	updateTaskFromEvent: (planId, task) => {
		set(state => ({
			plans: state.plans.map(p => {
				if (p.id !== planId) { return p; }
				return {
					...p,
					tasks: p.tasks.map(t => t.id === task.id ? task : t),
				};
			}),
			activePlan: state.activePlan?.id === planId
				? {
					...state.activePlan,
					tasks: state.activePlan.tasks.map(t => t.id === task.id ? task : t),
				}
				: state.activePlan,
		}));
	},
}));
