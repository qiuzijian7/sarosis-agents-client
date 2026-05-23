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

export type OrchestrationTaskAction = 'retry' | 'pause' | 'resume' | 'cancel' | 'approve' | 'reject' | 'comment' | 'block' | 'unblock';

export interface TaskComment {
	id: string;
	author: string;
	content: string;
	createdAt: string;
}

export type TaskReviewStatus = 'pending' | 'approved' | 'rejected';

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
	// ─── Human-in-the-Loop Fields ─────────────────────────────────────────
	/** Whether this task needs human review after completion */
	needsReview?: boolean;
	/** Review status (pending/approved/rejected) */
	reviewStatus?: TaskReviewStatus;
	/** Review comment from human */
	reviewComment?: string;
	/** Human who reviewed this task */
	reviewedBy?: string;
	/** Review timestamp */
	reviewedAt?: string;
	/** Comments on this task (human-agent collaboration) */
	comments?: TaskComment[];
	/** Whether this task is blocked by human */
	isBlocked?: boolean;
	/** Reason why this task is blocked */
	blockedReason?: string;
	/** Human who blocked this task */
	blockedBy?: string;
	/** Block timestamp */
	blockedAt?: string;
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
	// ─── Human-in-the-Loop Actions ─────────────────────────────────────
	approveTask: (planId: string, taskId: string, comment?: string) => Promise<void>;
	rejectTask: (planId: string, taskId: string, comment?: string) => Promise<void>;
	commentTask: (planId: string, taskId: string, comment: string) => Promise<void>;
	blockTask: (planId: string, taskId: string, reason?: string) => Promise<void>;
	unblockTask: (planId: string, taskId: string) => Promise<void>;
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

	// ─── Human-in-the-Loop Actions ─────────────────────────────────────
	approveTask: async (planId, taskId, comment) => {
		try {
			await sendRequest<
				{ planId: string; taskId: string; comment?: string },
				PlanTask
			>('orchestration.approveTask', { planId, taskId, comment });
		} catch (err) {
			console.error('[OrchestrationStore] approveTask failed:', err);
		}
	},

	rejectTask: async (planId, taskId, comment) => {
		try {
			await sendRequest<
				{ planId: string; taskId: string; comment?: string },
				PlanTask
			>('orchestration.rejectTask', { planId, taskId, comment });
		} catch (err) {
			console.error('[OrchestrationStore] rejectTask failed:', err);
		}
	},

	commentTask: async (planId, taskId, comment) => {
		try {
			await sendRequest<
				{ planId: string; taskId: string; comment: string },
				PlanTask
			>('orchestration.commentTask', { planId, taskId, comment });
		} catch (err) {
			console.error('[OrchestrationStore] commentTask failed:', err);
		}
	},

	blockTask: async (planId, taskId, reason) => {
		try {
			await sendRequest<
				{ planId: string; taskId: string; reason?: string },
				PlanTask
			>('orchestration.blockTask', { planId, taskId, reason });
		} catch (err) {
			console.error('[OrchestrationStore] blockTask failed:', err);
		}
	},

	unblockTask: async (planId, taskId) => {
		try {
			await sendRequest<
				{ planId: string; taskId: string },
				PlanTask
			>('orchestration.unblockTask', { planId, taskId });
		} catch (err) {
			console.error('[OrchestrationStore] unblockTask failed:', err);
		}
	},

	loadPlans: async (workspaceId) => {
		set({ isLoading: true });
		try {
			const plans = await sendRequest<
				{ workspaceId: string },
				OrchestrationPlan[]
			>('orchestration.listPlans', { workspaceId });
			set(state => {
				// Restore activePlan from the loaded plans if it's no longer valid,
				// or if there's no activePlan but there's a pending_approval plan.
				let newActivePlan = state.activePlan;
				if (newActivePlan) {
					// Sync activePlan with the latest data from the server
					const synced = plans.find(p => p.id === newActivePlan!.id);
					newActivePlan = synced || null;
				}
				if (!newActivePlan) {
					// Auto-activate the most relevant plan: prefer pending_approval,
					// then executing/approved, then the most recent one
					newActivePlan = plans.find(p => p.status === 'pending_approval')
						|| plans.find(p => p.status === 'executing' || p.status === 'approved')
						|| null;
				}
				return { plans, activePlan: newActivePlan, isLoading: false };
			});
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
