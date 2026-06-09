/*---------------------------------------------------------------------------------------------
 *  Agent Model Resolver
 *
 *  Provides dynamic model resolution with three-level fallback:
 *  1. Explicit model parameter (highest priority)
 *  2. Agent-configured model[] (from Agent or Preset)
 *  3. Parent/default model (lowest priority)
 *
 *  Also includes cost-tier validation to prevent sub-agents from using
 *  more expensive models than their parent.
 *
 *  Ported from VS Code's RunSubagentTool.resolveSubagentModel pattern.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IAgentModelResolver = createDecorator<IAgentModelResolver>('agentModelResolver');

/**
 * Model information for display and cost-tier comparison.
 */
export interface IAgentModelInfo {
	/** Unique model identifier */
	readonly id: string;
	/** Human-readable model name */
	readonly name: string;
	/** Cost multiplier relative to the base model (1.0 = same tier) */
	readonly costMultiplier: number;
	/** Provider (e.g. 'copilot', 'anthropic', 'openai') */
	readonly provider: string;
}

/**
 * Result of model resolution.
 */
export interface IResolvedModel {
	/** The resolved model identifier, or undefined if no model available */
	readonly modelId: string | undefined;
	/** Human-readable name of the resolved model */
	readonly modelName: string | undefined;
	/** Whether an explicit model was requested and successfully resolved */
	readonly explicitResolved: boolean;
	/** The source of the resolution: 'explicit' | 'agent-config' | 'fallback' */
	readonly source: 'explicit' | 'agent-config' | 'fallback';
}

/**
 * Cost-tier check result.
 */
export interface ICostTierCheck {
	/** Whether the requested model exceeds the parent's cost tier */
	readonly exceeds: boolean;
	/** Human-readable reason if exceeds */
	readonly reason?: string;
}

export interface IAgentModelResolver {
	readonly _serviceBrand: undefined;

	/**
	 * Resolve the model for an agent with three-level fallback:
	 * 1. Explicit model parameter (highest priority)
	 * 2. Agent-configured model[] (try each in order until found)
	 * 3. Parent/default model (lowest priority)
	 *
	 * @param agentModels - Model qualified names from the agent config (Agent.model or Preset.model)
	 * @param parentModelId - The parent agent's model identifier
	 * @param explicitModel - Optional explicit model qualified name (e.g. "GPT-5 (copilot)")
	 * @returns Resolved model information
	 */
	resolveModel(
		agentModels: readonly string[] | undefined,
		parentModelId: string | undefined,
		explicitModel?: string,
	): IResolvedModel;

	/**
	 * Check if a model exceeds the parent's cost tier.
	 * @param modelId - The requested model
	 * @param parentModelId - The parent's model
	 * @returns Cost tier check result
	 */
	checkCostTier(modelId: string, parentModelId: string | undefined): ICostTierCheck;

	/**
	 * Get model info by identifier.
	 * @param modelId - The model identifier
	 */
	getModelInfo(modelId: string): IAgentModelInfo | undefined;

	/**
	 * Get all available models.
	 */
	getAvailableModels(): IAgentModelInfo[];
}

// ─── Built-in model registry ──────────────────────────────────────────────────

const MODEL_REGISTRY: IAgentModelInfo[] = [
	{ id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', costMultiplier: 1.0, provider: 'anthropic' },
	{ id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', costMultiplier: 0.8, provider: 'anthropic' },
	{ id: 'gpt-4o', name: 'GPT-4o', costMultiplier: 1.0, provider: 'openai' },
	{ id: 'gpt-4o-mini', name: 'GPT-4o Mini', costMultiplier: 0.3, provider: 'openai' },
	{ id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', costMultiplier: 0.2, provider: 'google' },
];

const MAX_COST_MULTIPLIER_RATIO = 1.5; // Sub-agent can use at most 1.5x parent's cost tier

export class AgentModelResolver implements IAgentModelResolver {
	declare readonly _serviceBrand: undefined;

	private readonly _modelById = new Map<string, IAgentModelInfo>();
	private readonly _modelByName = new Map<string, IAgentModelInfo>();

	constructor() {
		for (const model of MODEL_REGISTRY) {
			this._modelById.set(model.id, model);
			this._modelByName.set(model.name.toLowerCase(), model);
		}
	}

	resolveModel(
		agentModels: readonly string[] | undefined,
		parentModelId: string | undefined,
		explicitModel?: string,
	): IResolvedModel {
		let modelId = parentModelId;
		let explicitResolved = false;

		// Level 1: Explicit model parameter
		if (explicitModel) {
			const found = this._lookupByQualifiedName(explicitModel);
			if (found) {
				return { modelId: found.id, modelName: found.name, explicitResolved: true, source: 'explicit' };
			}
			// Explicit model not found — fall through to agent config
		}

		// Level 2: Agent-configured model[]
		if (agentModels && agentModels.length > 0 && !explicitResolved) {
			for (const qualifiedName of agentModels) {
				const found = this._lookupByQualifiedName(qualifiedName);
				if (found) {
					return { modelId: found.id, modelName: found.name, explicitResolved: false, source: 'agent-config' };
				}
			}
		}

		// Level 3: Parent/default model
		const parentInfo = modelId ? this._modelById.get(modelId) : undefined;
		return {
			modelId,
			modelName: parentInfo?.name,
			explicitResolved: false,
			source: 'fallback',
		};
	}

	checkCostTier(modelId: string, parentModelId: string | undefined): ICostTierCheck {
		if (!parentModelId) {
			return { exceeds: false };
		}

		const requestedInfo = this._modelById.get(modelId);
		const parentInfo = this._modelById.get(parentModelId);

		if (!requestedInfo || !parentInfo) {
			return { exceeds: false }; // Can't compare unknown models
		}

		const ratio = requestedInfo.costMultiplier / parentInfo.costMultiplier;
		if (ratio > MAX_COST_MULTIPLIER_RATIO) {
			return {
				exceeds: true,
				reason: `Model '${requestedInfo.name}' costs ${ratio.toFixed(1)}x more than parent model '${parentInfo.name}' (max allowed: ${MAX_COST_MULTIPLIER_RATIO}x)`,
			};
		}

		return { exceeds: false };
	}

	getModelInfo(modelId: string): IAgentModelInfo | undefined {
		return this._modelById.get(modelId);
	}

	getAvailableModels(): IAgentModelInfo[] {
		return [...MODEL_REGISTRY];
	}

	/**
	 * Look up a model by qualified name (e.g. "Claude Sonnet 4 (anthropic)")
	 * or by plain model ID.
	 */
	private _lookupByQualifiedName(qualifiedName: string): IAgentModelInfo | undefined {
		// Try exact ID match first
		const byId = this._modelById.get(qualifiedName);
		if (byId) { return byId; }

		// Try stripping the provider suffix: "Model Name (provider)"
		const match = qualifiedName.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
		if (match) {
			const modelName = match[1].trim().toLowerCase();
			const byName = this._modelByName.get(modelName);
			if (byName) { return byName; }
		}

		// Try name match
		const byName = this._modelByName.get(qualifiedName.toLowerCase());
		if (byName) { return byName; }

		return undefined;
	}
}
