/*---------------------------------------------------------------------------------------------
 *  YAML Declarative SubAgent Configuration
 *
 *  Inspired by deer-flow's config.yaml → custom_agents section and
 *  config layering (built-in → custom → per-agent override).
 *
 *  Purpose:
 *  - Define sub-agents declaratively in a YAML file instead of requiring
 *    programmatic registration
 *  - Lower the barrier to creating custom sub-agents with specific tool lists,
 *    system prompts, and constraints
 *  - Support config layering: built-in defaults → YAML custom → runtime
 *    SubAgentOptions override
 *
 *  YAML Format (`.sarosis/subagents.yaml`):
 *  ```yaml
 *  # Global defaults for all sub-agents
 *  defaults:
 *    max_turns: 100
 *    timeout_seconds: 600
 *    model: null  # null = inherit from parent
 *
 *  # Custom sub-agent definitions
 *  custom_agents:
 *    code-reviewer:
 *      description: "Expert code reviewer — finds bugs, style issues, and architectural problems"
 *      type: general
 *      system_prompt: |
 *        You are an expert code reviewer. Your job is to thoroughly review code
 *        and identify bugs, security issues, performance problems, and style violations.
 *      tools:
 *        - file_read
 *        - search_files
 *        - grep
 *      disallowed_tools:
 *        - file_write
 *        - terminal_cmd
 *      skills:
 *        - code-review-checklist
 *        - security-patterns
 *      max_turns: 60
 *      timeout_seconds: 300
 *      model: "claude-sonnet-4-20250514"  # specific model override
 *
 *    test-runner:
 *      description: "Runs tests and reports failures"
 *      type: general
 *      tools:
 *        - terminal_cmd
 *        - file_read
 *        - grep
 *      max_turns: 40
 *
 *  # Per-agent overrides (by agent name in the workspace)
 *  agent_overrides:
 *    workflow-agent:
 *      max_turns: 150
 *      timeout_seconds: 900
 *  ```
 *
 *  Resolution order (aligned with deer-flow):
 *  1. Built-in defaults (hardcoded in SubagentYamlConfig.DEFAULTS)
 *  2. YAML `defaults` section
 *  3. YAML `custom_agents.<name>` definition
 *  4. YAML `agent_overrides.<agent_name>` section
 *  5. Runtime SubAgentOptions passed at dispatch time
 *--------------------------------------------------------------------------------------------*/

import type { SubAgentType } from './unifiedSubAgentDispatch.js';
import { type SubAgentOptions, SubAgentType as SAT } from './unifiedSubAgentDispatch.js';

// ─── YAML Schema Types ────────────────────────────────────────────────────

/** Default values applied to all sub-agents. */
export interface YamlSubagentDefaults {
	max_turns?: number;
	timeout_seconds?: number;
	model?: string | null;
	type?: 'explore' | 'general' | 'scout';
}

/** A single custom sub-agent definition. */
export interface YamlCustomSubagent {
	/** Human-readable description (shown to the lead agent when deciding which sub-agent to use). */
	description: string;
	/** Sub-agent type (determines permission profile). */
	type?: 'explore' | 'general' | 'scout';
	/** Custom system prompt (replaces the default per-type prompt). */
	system_prompt?: string;
	/** Allowed tool names (if not specified, inherits from parent). */
	tools?: string[];
	/** Disallowed tool names (blacklist — overrides tools whitelist). */
	disallowed_tools?: string[];
	/** Skill names to load for this sub-agent. */
	skills?: string[];
	/** Max turns/iterations. */
	max_turns?: number;
	/** Timeout in seconds. */
	timeout_seconds?: number;
	/** Specific model to use (null = inherit from parent). */
	model?: string | null;
}

/** Per-agent overrides keyed by agent name/ID. */
export interface YamlAgentOverride {
	max_turns?: number;
	timeout_seconds?: number;
	model?: string | null;
	skills?: string[];
}

/** Top-level YAML schema. */
export interface SubagentYamlSchema {
	defaults?: YamlSubagentDefaults;
	custom_agents?: Record<string, YamlCustomSubagent>;
	agent_overrides?: Record<string, YamlAgentOverride>;
}

// ─── Constants ────────────────────────────────────────────────────────────

/** Built-in defaults (applied before YAML). */
const BUILTIN_DEFAULTS: Required<Omit<YamlSubagentDefaults, 'model' | 'type'>> = {
	max_turns: 100,
	timeout_seconds: 600,
};

/** Standard YAML file name. */
export const SUBAGENT_YAML_FILENAME = 'subagents.yaml';

// ─── Config Resolver ──────────────────────────────────────────────────────

/** Resolved sub-agent configuration after all layering is applied. */
export interface ResolvedSubagentConfig {
	name: string;
	description: string;
	type: SubAgentType;
	systemPrompt?: string;
	tools?: string[];
	disallowedTools?: string[];
	skills?: string[];
	maxTurns: number;
	timeoutMs: number;
	modelName?: string;
}

/**
 * Parse and resolve a YAML config into a map of ResolvedSubagentConfig,
 * applying the config layering rules.
 *
 * @param yamlData - Parsed YAML object.
 * @param agentName - Optional parent agent name for per-agent overrides.
 */
export function resolveSubagentConfigs(
	yamlData: SubagentYamlSchema,
	agentName?: string,
): Map<string, ResolvedSubagentConfig> {
	const configs = new Map<string, ResolvedSubagentConfig>();
	const defaults = yamlData.defaults ?? {};
	const customAgents = yamlData.custom_agents ?? {};
	const agentOverrides = yamlData.agent_overrides ?? {};

	// Merge global defaults
	const globalMaxTurns = defaults.max_turns ?? BUILTIN_DEFAULTS.max_turns;
	const globalTimeout = (defaults.timeout_seconds ?? BUILTIN_DEFAULTS.timeout_seconds) * 1000;

	for (const [name, custom] of Object.entries(customAgents)) {
		// Apply per-agent overrides if agent_name matches
		const override = agentName ? agentOverrides[agentName] : undefined;

		const type = mapSubagentType(custom.type ?? defaults.type ?? 'general');
		const maxTurns = override?.max_turns ?? custom.max_turns ?? globalMaxTurns;
		const timeoutMs = (override?.timeout_seconds ?? custom.timeout_seconds ?? globalTimeout / 1000) * 1000;
		const skills = override?.skills ?? custom.skills;
		const modelName = override?.model ?? custom.model ?? undefined;

		configs.set(name, {
			name,
			description: custom.description,
			type,
			systemPrompt: custom.system_prompt,
			tools: custom.tools,
			disallowedTools: custom.disallowed_tools,
			skills,
			maxTurns,
			timeoutMs,
			modelName: modelName ?? undefined,
		});
	}

	return configs;
}

/**
 * Convert a resolved config into SubAgentOptions suitable for UnifiedSubAgentDispatch.
 */
export function toSubAgentOptions(config: ResolvedSubagentConfig): SubAgentOptions {
	return {
		type: config.type,
		maxIterations: config.maxTurns,
		timeout: config.timeoutMs,
	};
}

// ─── YAML String Builder (for programmatic creation/default template) ────

/**
 * Generate a default subagents.yaml template string.
 */
export function generateDefaultYamlTemplate(): string {
	return `# ─── Sub-Agent Configuration ──────────────────────────────────────────────
# Place this file at: .sarosis/subagents.yaml
#
# Define custom sub-agents with specific tool sets, system prompts,
# and execution constraints. The lead agent will use these definitions
# when delegating tasks via delegate_task.

# Global defaults (applied to all custom sub-agents)
defaults:
  max_turns: 100
  timeout_seconds: 600
  # model: null  # null = inherit from parent agent

# Custom sub-agent definitions
custom_agents:
  # Example: a read-only code reviewer
  # code-reviewer:
  #   description: "Expert code reviewer — finds bugs, style issues, and architectural problems"
  #   type: general
  #   system_prompt: |
  #     You are an expert code reviewer. Thoroughly review code for bugs,
  #     security issues, performance problems, and style violations.
  #   tools:
  #     - file_read
  #     - search_files
  #     - grep
  #     - web_search
  #     - manage_todo
  #   disallowed_tools:
  #     - file_write
  #     - terminal_cmd
  #   max_turns: 60
  #   timeout_seconds: 300

# Per-agent overrides (keyed by agent name in the workspace)
agent_overrides: {}
`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function mapSubagentType(type: string): SubAgentType {
	switch (type) {
		case 'explore': return SAT.Explore;
		case 'scout': return SAT.Scout;
		case 'general':
		default: return SAT.General;
	}
}
