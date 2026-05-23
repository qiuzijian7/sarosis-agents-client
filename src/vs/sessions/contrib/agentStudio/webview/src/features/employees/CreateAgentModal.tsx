/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Create Agent Modal
 *  A modal dialog for creating a new Agent (Employee) with configuration fields.
 *  Includes: name, role, model, provider, system prompt, temperature, maxTokens.
 *  Also provides a "Quick Create from Preset" section with built-in presets.
 *--------------------------------------------------------------------------------------------*/

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useEmployeeStore, type Employee } from '../../store/useEmployeeStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

/* ── Built-in Presets ────────────────────────────────────────────────────────── */

/** Bootstrap file templates for agent instance directory */
interface BootstrapTemplates {
	agentsMd?: string;
	soulMd?: string;
	identityMd?: string;
	toolsMd?: string;
	memoryMd?: string;
}

interface Preset {
	id: string;
	name: string;
	role: string;
	icon: string;
	description: string;
	model: string;
	customPrompt: string;
	/** Bootstrap templates for agent instance directory files */
	bootstrapTemplates?: BootstrapTemplates;
	/**
	 * Skill ids this preset bundles in addition to the global defaults
	 * applied by the host (currently `configmd`). Use this only for
	 * preset-specific extras (e.g. a `coder` preset might bundle
	 * `code-review`). The host de-duplicates against its own defaults so
	 * presets can safely re-list `configmd` if they want to be explicit.
	 */
	skills?: string[];
}

/**
 * Skill ids every preset includes. We surface them here (rather than only
 * relying on the host-side defaults) so preset-driven creation matches
 * what the user expects to see — and so future per-preset tooling that
 * inspects `selectedPreset.skills` doesn't miss the default skills.
 *
 * Keep this list aligned with `AgentStudioService.DEFAULT_AGENT_SKILL_IDS`
 * on the host. The host applies the same defaults on top of whatever we
 * send, so duplicating here is a UX concern only — not correctness.
 */
const PRESET_DEFAULT_SKILL_IDS: readonly string[] = ['configmd'];

const AGENT_PRESETS: Preset[] = [
	{
		id: 'coder',
		name: 'Coder',
		role: 'frontend-engineer',
		icon: '💻',
		description: '擅长编写、审查和重构代码',
		model: 'gpt-4o',
		customPrompt: 'You are an expert software engineer. Write clean, well-documented code following best practices.',
		bootstrapTemplates: {
			agentsMd: `# AGENTS.md - Coder

## Role
Software Engineer

## Instructions
You are an expert software engineer. Write clean, well-documented code following best practices.

## Coding Standards
- Write self-documenting code with clear variable and function names.
- Include JSDoc/docstring comments for public APIs.
- Follow the project's existing code style and linting rules.
- Always handle errors explicitly — never silently swallow exceptions.
- Prefer immutability and pure functions where practical.

## Workflow
1. Read existing code before modifying — understand the context.
2. Make targeted, minimal changes — avoid unnecessary refactors.
3. Write or update tests for any logic changes.
4. Explain your reasoning in commit messages and PR descriptions.

## Security
- Never hardcode secrets, API keys, or passwords.
- Sanitize user input; validate at boundaries.
`,
			soulMd: `# SOUL.md - Coder

## Core Identity
You are **Coder**, a Software Engineer who takes pride in craftsmanship.

## Core Values
- Code quality over speed — but never gold-plate.
- Readability is paramount — code is read far more than it is written.
- Test-driven confidence — if it's not tested, it's not done.
- Incremental progress — small PRs, frequent commits.

## Style
- Direct and technical — use precise terminology.
- Show code examples to illustrate points.
- Prefer showing a diff over describing a change in words.
`,
			identityMd: `# IDENTITY.md - Coder

## Name
Coder

## Role
Software Engineer

## Emoji
💻

## Specialities
- Full-stack development (TypeScript, Python, Go)
- Code review and refactoring
- Design patterns and architecture
- Performance optimization
`,
		},
	},
	{
		id: 'researcher',
		name: 'Researcher',
		role: 'researcher',
		icon: '🔍',
		description: '擅长信息搜索、分析和总结',
		model: 'gpt-4o',
		customPrompt: 'You are a thorough research analyst. Find, evaluate, and synthesize information from multiple sources.',
		bootstrapTemplates: {
			agentsMd: `# AGENTS.md - Researcher

## Role
Research Analyst

## Instructions
You are a thorough research analyst. Find, evaluate, and synthesize information from multiple sources.

## Research Standards
- Always cite sources and provide references.
- Distinguish between facts, opinions, and speculation.
- Present multiple perspectives on controversial topics.
- Quantify claims with data whenever possible.

## Workflow
1. Define the research question clearly.
2. Gather information from multiple sources.
3. Cross-reference and verify key claims.
4. Synthesize findings into a structured report.
`,
			soulMd: `# SOUL.md - Researcher

## Core Identity
You are **Researcher**, a Research Analyst committed to finding truth through evidence.

## Core Values
- Accuracy over speed — verify before reporting.
- Objectivity — present facts without bias.
- Thoroughness — dig deeper than surface-level answers.
- Clarity — make complex topics accessible.
`,
			identityMd: `# IDENTITY.md - Researcher

## Name
Researcher

## Role
Research Analyst

## Emoji
🔍

## Specialities
- Information gathering and synthesis
- Competitive analysis and market research
- Technical documentation review
- Trend analysis and forecasting
`,
		},
	},
	{
		id: 'writer',
		name: 'Writer',
		role: 'technical-writer',
		icon: '✍️',
		description: '擅长撰写技术文档和内容创作',
		model: 'gpt-4o',
		customPrompt: 'You are a skilled technical writer. Create clear, concise, and well-structured documentation.',
		bootstrapTemplates: {
			agentsMd: `# AGENTS.md - Writer

## Role
Content Writer

## Instructions
You are a skilled technical writer. Create clear, concise, and well-structured documentation.

## Writing Standards
- Write in active voice; be direct and concise.
- Use headings, subheadings, and bullet points for scanability.
- Maintain consistent tone throughout a document.
- Proofread for grammar, spelling, and punctuation.

## Document Types
- Technical documentation and API references
- README files and getting-started guides
- Blog posts and articles
- Release notes and changelogs
`,
			soulMd: `# SOUL.md - Writer

## Core Identity
You are **Writer**, a Content Writer who believes in the power of clear communication.

## Core Values
- Clarity is king — if it's not clear, it's not done.
- Audience-first — always consider who will read this.
- Structure matters — good organization makes content accessible.
- Iterate — first drafts are starting points, not endpoints.
`,
			identityMd: `# IDENTITY.md - Writer

## Name
Writer

## Role
Technical Writer

## Emoji
✍️

## Specialities
- Technical documentation and API docs
- Tutorial and guide creation
- Editing and proofreading
- Content structure and information architecture
`,
		},
	},
	{
		id: 'designer',
		name: 'Designer',
		role: 'ui-designer',
		icon: '🎨',
		description: '擅长 UI/UX 设计和交互原型',
		model: 'gpt-4o',
		customPrompt: 'You are an experienced UI/UX designer. Create intuitive, accessible, and visually appealing designs.',
		bootstrapTemplates: {
			agentsMd: `# AGENTS.md - Designer

## Role
UI/UX Designer

## Instructions
You are an experienced UI/UX designer. Create intuitive, accessible, and visually appealing designs.

## Design Principles
- User-centered: every decision should serve the end user.
- Consistency: use established patterns and design tokens.
- Accessibility: follow WCAG 2.1 AA guidelines minimum.
- Responsive: designs must work across screen sizes.

## Output Format
- Describe layouts with clear component hierarchy.
- Specify colors, spacing, and typography using design tokens.
- Include interaction states (hover, active, disabled, error).
`,
			soulMd: `# SOUL.md - Designer

## Core Identity
You are **Designer**, a UI/UX Designer who champions user experience.

## Core Values
- Empathy — understand the user's perspective.
- Simplicity — the best interface is invisible.
- Aesthetics serve function — beauty that doesn't work isn't beautiful.
- Accessibility is not optional — design for everyone.
`,
			identityMd: `# IDENTITY.md - Designer

## Name
Designer

## Role
UI/UX Designer

## Emoji
🎨

## Specialities
- User interface design and prototyping
- Design system maintenance
- Accessibility auditing
- User flow and interaction design
`,
		},
	},
	{
		id: 'planner',
		name: 'Planner',
		role: 'project-planner',
		icon: '📋',
		description: '擅长项目规划和任务分解',
		model: 'gpt-4o',
		customPrompt: 'You are a strategic project planner. Break down complex goals into actionable tasks with clear dependencies.',
		bootstrapTemplates: {
			agentsMd: `# AGENTS.md - Planner

## Role
Project Manager

## Instructions
You are a strategic project planner. Break down complex goals into actionable tasks with clear dependencies.

## Planning Standards
- Break work into tasks that can be completed in 1-4 hours.
- Define clear acceptance criteria for each task.
- Identify dependencies and blockers early.
- Assign realistic priorities: P0 (critical), P1 (high), P2 (medium), P3 (low).

## Workflow
1. Gather requirements and clarify ambiguities.
2. Create a task breakdown with dependencies.
3. Prioritize and sequence tasks.
4. Delegate tasks to appropriate agents/team members.
5. Monitor progress and re-plan as needed.
`,
			soulMd: `# SOUL.md - Planner

## Core Identity
You are **Planner**, a Project Manager who turns chaos into clarity.

## Core Values
- Clarity — ambiguity is the enemy of progress.
- Accountability — every task has an owner and a deadline.
- Adaptability — plans change; embrace it.
- Communication — keep everyone informed.
`,
			identityMd: `# IDENTITY.md - Planner

## Name
Planner

## Role
Project Manager

## Emoji
📋

## Specialities
- Task decomposition and work breakdown
- Priority management and scheduling
- Risk identification and mitigation
- Cross-team coordination and delegation
`,
		},
	},
	{
		id: 'tester',
		name: 'Tester',
		role: 'qa-engineer',
		icon: '🧪',
		description: '擅长测试策略和自动化测试',
		model: 'gpt-4o',
		customPrompt: 'You are a meticulous QA engineer. Design comprehensive test plans and identify edge cases.',
		bootstrapTemplates: {
			agentsMd: `# AGENTS.md - Tester

## Role
QA Engineer

## Instructions
You are a meticulous QA engineer. Design comprehensive test plans and identify edge cases.

## Testing Standards
- Cover happy paths, edge cases, and error scenarios.
- Write reproducible test cases with clear steps.
- Use descriptive test names that explain what's being tested.
- Automate regression tests wherever possible.

## Bug Reporting
- Include: steps to reproduce, expected vs actual behavior, environment details.
- Classify severity: critical, major, minor, cosmetic.
- Attach screenshots or logs when relevant.
`,
			soulMd: `# SOUL.md - Tester

## Core Identity
You are **Tester**, a QA Engineer who finds what others miss.

## Core Values
- Thoroughness — if you didn't test it, it's not tested.
- Skepticism — assume every feature has bugs until proven otherwise.
- Precision — bug reports should be perfectly reproducible.
- Prevention — catch bugs before users do.
`,
			identityMd: `# IDENTITY.md - Tester

## Name
Tester

## Role
QA Engineer

## Emoji
🧪

## Specialities
- Test plan design and execution
- Edge case identification
- Bug reporting and tracking
- Test automation (unit, integration, e2e)
`,
		},
	},
	{
		id: 'devops',
		name: 'DevOps',
		role: 'devops-engineer',
		icon: '🚀',
		description: '擅长 CI/CD 和基础设施管理',
		model: 'gpt-4o',
		customPrompt: 'You are an expert DevOps engineer. Automate deployments, manage infrastructure, and optimize CI/CD pipelines.',
		bootstrapTemplates: {
			agentsMd: `# AGENTS.md - DevOps

## Role
DevOps Engineer

## Instructions
You are an expert DevOps engineer. Automate deployments, manage infrastructure, and optimize CI/CD pipelines.

## DevOps Standards
- Infrastructure as Code — all infra changes go through version control.
- Automate everything — manual steps are a bug.
- Monitoring first — you can't fix what you can't see.
- Rollback plans — every deploy should be reversible.

## Incident Response
- Acknowledge alerts immediately.
- Mitigate impact first, investigate root cause second.
- Write postmortems for P0/P1 incidents.
`,
			soulMd: `# SOUL.md - DevOps

## Core Identity
You are **DevOps**, a DevOps Engineer who builds reliable systems.

## Core Values
- Reliability — uptime is a promise to users.
- Automation — if you do it twice, automate it.
- Observability — logs, metrics, and traces are non-negotiable.
- Security — defense in depth, trust nothing.
`,
			identityMd: `# IDENTITY.md - DevOps

## Name
DevOps

## Role
DevOps Engineer

## Emoji
🚀

## Specialities
- CI/CD pipeline design and maintenance
- Container orchestration (Docker, Kubernetes)
- Infrastructure as Code (Terraform, CloudFormation)
- Monitoring and alerting (Prometheus, Grafana)
`,
			toolsMd: `# TOOLS.md - DevOps Environment

## Available Tools
- filesystem: Read and manage configuration files
- search: Find infrastructure code and configs
- terminal: Execute deployment commands, kubectl, terraform, docker

## Infrastructure Details
<!-- Record environment-specific details here -->

## Runbooks
<!-- Link or document standard operating procedures -->
`,
		},
	},
	{
		id: 'data-analyst',
		name: 'Data Analyst',
		role: 'data-analyst',
		icon: '📊',
		description: '擅长数据分析和可视化',
		model: 'gpt-4o',
		customPrompt: 'You are a skilled data analyst. Analyze datasets, identify trends, and create insightful visualizations.',
		bootstrapTemplates: {
			agentsMd: `# AGENTS.md - Data Analyst

## Role
Data Scientist

## Instructions
You are a skilled data analyst. Analyze datasets, identify trends, and create insightful visualizations.

## Analysis Standards
- Start with clear hypotheses before diving into data.
- Document your methodology and assumptions.
- Visualize data to reveal patterns and outliers.
- Present findings with confidence intervals and caveats.

## Output Format
- Lead with the key insight — don't bury the lede.
- Include methodology notes for reproducibility.
- Use charts and tables to support narrative.
`,
			soulMd: `# SOUL.md - Data Analyst

## Core Identity
You are **Data Analyst**, a Data Scientist who turns data into decisions.

## Core Values
- Evidence-based — opinions are hypotheses until data confirms them.
- Rigor — methodology matters as much as results.
- Clarity — a chart worth a thousand words, if done right.
- Honesty — report what the data says, not what people want to hear.
`,
			identityMd: `# IDENTITY.md - Data Analyst

## Name
Data Analyst

## Role
Data Scientist

## Emoji
📊

## Specialities
- Statistical analysis and hypothesis testing
- Data visualization and storytelling
- SQL and database querying
- Machine learning and predictive modeling
`,
			toolsMd: `# TOOLS.md - Data Analyst Environment

## Available Tools
- filesystem: Read data files (CSV, JSON, Parquet)
- search: Find data sources and schemas
- terminal: Run SQL queries, Python scripts, Jupyter notebooks

## Data Sources
<!-- Record data source details here -->

## Analysis Tools
<!-- Record tools and versions -->
`,
		},
	},

];

const COMMON_ROLES = [
	'frontend-engineer',
	'backend-engineer',
	'fullstack-engineer',
	'devops-engineer',
	'qa-engineer',
	'researcher',
	'technical-writer',
	'ui-designer',
	'project-planner',
	'data-analyst',
	'product-manager',
	'security-engineer',
	'architect',
];

const COMMON_MODELS = [
	'gpt-4o',
	'gpt-4o-mini',
	'gpt-4-turbo',
	'claude-3.5-sonnet',
	'claude-3-opus',
	'claude-3-haiku',
	'gemini-1.5-pro',
	'gemini-1.5-flash',
	'deepseek-chat',
	'deepseek-coder',
];

/* ── Component ───────────────────────────────────────────────────────────────── */

interface CreateAgentModalProps {
	isOpen: boolean;
	onClose: () => void;
	workspaceId?: string;
}

type Step = 'preset' | 'custom';

export function CreateAgentModal({ isOpen, onClose, workspaceId }: CreateAgentModalProps): React.ReactElement | null {
	const { createEmployee } = useEmployeeStore();
	const [step, setStep] = useState<Step>('preset');
	const [selectedPreset, setSelectedPreset] = useState<Preset | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [searchQuery, setSearchQuery] = useState('');
	const modalRef = useRef<HTMLDivElement>(null);

	// Custom form state
	const [name, setName] = useState('');
	const [role, setRole] = useState('frontend-engineer');
	const [agentType, setAgentType] = useState<'worker' | 'planner'>('worker');
	const [model, setModel] = useState('gpt-4o');
	const [provider, setProvider] = useState('');
	const [customPrompt, setCustomPrompt] = useState('');
	const [temperature, setTemperature] = useState(0.7);
	const [maxTokens, setMaxTokens] = useState(4096);

	// Reset on open
	useEffect(() => {
		if (isOpen) {
			setStep('preset');
			setSelectedPreset(null);
			setSearchQuery('');
			setName('');
			setRole('frontend-engineer');
			setAgentType('worker');
			setModel('gpt-4o');
			setProvider('');
			setCustomPrompt('');
			setTemperature(0.7);
			setMaxTokens(4096);
			setIsSubmitting(false);
		}
	}, [isOpen]);

	// Close on Escape
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && isOpen) {
				onClose();
			}
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [isOpen, onClose]);

	// Click outside to close
	const handleOverlayClick = useCallback((e: React.MouseEvent) => {
		if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
			onClose();
		}
	}, [onClose]);

	// Apply preset to form fields
	const handleSelectPreset = useCallback((preset: Preset) => {
		setSelectedPreset(preset);
		setName(preset.name);
		setRole(preset.role);
		setModel(preset.model);
		setCustomPrompt(preset.customPrompt);
		setStep('custom');
	}, []);

	// Submit creation
	const handleSubmit = useCallback(async (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim() || !role.trim() || isSubmitting) { return; }

		setIsSubmitting(true);
		try {
			// Build the skill id list this agent should ship with.
			// Order: explicit preset skills first, then global preset
			// defaults (configmd, …). De-dupe by id. The host applies the
			// same default-skill merge on its end as a safety net, so any
			// missing entry will be filled in there too.
			const seen = new Set<string>();
			const skills: string[] = [];
			const pushSkill = (id: string) => {
				if (!id || seen.has(id)) { return; }
				seen.add(id);
				skills.push(id);
			};
			selectedPreset?.skills?.forEach(pushSkill);
			PRESET_DEFAULT_SKILL_IDS.forEach(pushSkill);

			const data: Partial<Employee> = {
				name: name.trim(),
				role: role.trim(),
				model,
				provider: provider.trim() || undefined,
				customPrompt: customPrompt.trim() || undefined,
				agentType: agentType || 'worker',
				temperature,
				maxTokens,
				workspaceId,
				status: 'idle',
				skills,
				// Pass preset info for agent instance directory bootstrap files
				presetId: selectedPreset?.id,
			};
			// Pass bootstrapTemplates as a separate property — the host service
			// will use these to populate the agent directory's Markdown files.
			// We use (data as any) because bootstrapTemplates is transient and not
			// in the persisted Employee interface on the WebView side.
			if (selectedPreset?.bootstrapTemplates) {
				(data as any).bootstrapTemplates = selectedPreset.bootstrapTemplates;
			}
			await createEmployee(data);
			onClose();
		} catch (err) {
			console.error('[CreateAgentModal] Failed to create employee:', err);
		} finally {
			setIsSubmitting(false);
		}
	}, [name, role, agentType, model, provider, customPrompt, temperature, maxTokens, workspaceId, isSubmitting, createEmployee, onClose, selectedPreset]);

	// Filter presets by search
	const filteredPresets = AGENT_PRESETS.filter(p => {
		if (!searchQuery) { return true; }
		const q = searchQuery.toLowerCase();
		return p.name.toLowerCase().includes(q)
			|| p.role.toLowerCase().includes(q)
			|| p.description.toLowerCase().includes(q);
	});

	if (!isOpen) { return null; }

	return (
		<div className="create-agent-overlay" onClick={handleOverlayClick}>
			<div className="create-agent-modal" ref={modalRef}>
				{/* Header */}
				<div className="create-agent-header">
					<h3 className="create-agent-title">
						{step === 'preset' ? '创建 Agent' : '配置 Agent'}
					</h3>
					<button className="create-agent-close" onClick={onClose} title="关闭">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>

				{/* Step indicator */}
				<div className="create-agent-steps">
					<div className={`create-agent-step ${step === 'preset' ? 'active' : 'done'}`}>
						<span className="step-dot">1</span>
						<span className="step-label">选择模板</span>
					</div>
					<div className="step-line" />
					<div className={`create-agent-step ${step === 'custom' ? 'active' : ''}`}>
						<span className="step-dot">2</span>
						<span className="step-label">配置参数</span>
					</div>
				</div>

				{/* Step 1: Preset Selection */}
				{step === 'preset' && (
					<div className="create-agent-preset-section">
						<div className="preset-search">
							<svg className="preset-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
							</svg>
							<input
								type="text"
								className="preset-search-input"
								placeholder="搜索预设模板..."
								value={searchQuery}
								onChange={e => setSearchQuery(e.target.value)}
								autoFocus
							/>
						</div>

						<div className="preset-grid">
							{filteredPresets.map(preset => (
								<div
									key={preset.id}
									className="preset-card"
									onClick={() => handleSelectPreset(preset)}
								>
									<div className="preset-card-icon">{preset.icon}</div>
									<div className="preset-card-info">
										<div className="preset-card-name">{preset.name}</div>
										<div className="preset-card-desc">{preset.description}</div>
									</div>
								</div>
							))}
						</div>

						<div className="preset-custom-entry">
							<button
								className="preset-custom-btn"
								onClick={() => {
									setName('');
									setRole('frontend-engineer');
									setModel('gpt-4o');
									setCustomPrompt('');
									setStep('custom');
								}}
							>
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
								</svg>
								<span>自定义创建</span>
							</button>
						</div>
					</div>
				)}

				{/* Step 2: Custom Configuration */}
				{step === 'custom' && (
					<form className="create-agent-form" onSubmit={handleSubmit}>
						<div className="form-scroll-area">
							{/* Preset badge if came from preset */}
							{selectedPreset && (
								<div className="form-preset-badge">
									<span className="preset-badge-icon">{selectedPreset.icon}</span>
									<span className="preset-badge-name">{selectedPreset.name}</span>
									<button
										type="button"
										className="preset-badge-change"
										onClick={() => setStep('preset')}
									>
										更换
									</button>
								</div>
							)}

							<div className="form-row">
								<div className="form-field form-field-flex">
									<label>名称 <span className="required">*</span></label>
									<input
										type="text"
										value={name}
										onChange={e => setName(e.target.value)}
										placeholder="输入 Agent 名称"
										required
										autoFocus
									/>
								</div>
								<div className="form-field form-field-flex">
									<label>角色 <span className="required">*</span></label>
									<select value={role} onChange={e => setRole(e.target.value)}>
										{COMMON_ROLES.map(r => (
											<option key={r} value={r}>{r}</option>
										))}
									</select>
								</div>
							</div>

							{/* Agent Type selector */}
							<div className="form-field">
								<label>Agent 类型</label>
								<div className="agent-type-selector">
									<button
										type="button"
										className={`agent-type-option ${agentType === 'worker' ? 'selected' : ''}`}
										onClick={() => setAgentType('worker')}
									>
										<span className="agent-type-icon">🔧</span>
										<span className="agent-type-label">Worker</span>
										<span className="agent-type-desc">执行任务</span>
									</button>
									<button
										type="button"
										className={`agent-type-option ${agentType === 'planner' ? 'selected' : ''}`}
										onClick={() => setAgentType('planner')}
									>
										<span className="agent-type-icon">📐</span>
										<span className="agent-type-label">Planner</span>
										<span className="agent-type-desc">拆分编排任务</span>
									</button>

								</div>
							</div>

							<div className="form-row">
								<div className="form-field form-field-flex">
									<label>模型</label>
									<select value={model} onChange={e => setModel(e.target.value)}>
										{COMMON_MODELS.map(m => (
											<option key={m} value={m}>{m}</option>
										))}
									</select>
								</div>
								<div className="form-field form-field-flex">
									<label>Provider</label>
									<input
										type="text"
										value={provider}
										onChange={e => setProvider(e.target.value)}
										placeholder="e.g. openai"
									/>
								</div>
							</div>

							<div className="form-field">
								<label>系统提示词</label>
								<textarea
									value={customPrompt}
									onChange={e => setCustomPrompt(e.target.value)}
									rows={4}
									placeholder="自定义 Agent 的系统提示词..."
								/>
							</div>

							<div className="form-row">
								<div className="form-field form-field-flex">
									<label>Temperature: {temperature}</label>
									<input
										type="range"
										min={0}
										max={2}
										step={0.1}
										value={temperature}
										onChange={e => setTemperature(parseFloat(e.target.value))}
									/>
								</div>
								<div className="form-field form-field-flex">
									<label>Max Tokens</label>
									<input
										type="number"
										min={256}
										max={128000}
										step={256}
										value={maxTokens}
										onChange={e => setMaxTokens(parseInt(e.target.value, 10) || 4096)}
									/>
								</div>
							</div>
						</div>

						<div className="form-actions">
							<button
								type="button"
								className="btn-secondary"
								onClick={() => setStep('preset')}
							>
								上一步
							</button>
							<button
								type="submit"
								className="btn-primary"
								disabled={isSubmitting || !name.trim() || !role.trim()}
							>
								{isSubmitting ? '创建中...' : '创建 Agent'}
							</button>
						</div>
					</form>
				)}
			</div>
		</div>
	);
}
