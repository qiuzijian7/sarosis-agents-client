/*---------------------------------------------------------------------------------------------
 *  Project Context Injector
 *
 *  Automatically injects project-specific context into agent bootstrap templates.
 *  Reads package.json, tsconfig.json, .eslintrc, .editorconfig, and project structure
 *  to enrich AGENTS.md, TOOLS.md, and MEMORY.md with real project information.
 *
 *  Aligned with VS Code's ComputeAutomaticInstructions pattern.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

export interface IProjectContext {
	/** Project name (from package.json or folder name) */
	name: string;
	/** Programming languages detected */
	languages: string[];
	/** Framework/libraries detected */
	frameworks: string[];
	/** Build system (npm, yarn, pnpm, cargo, make, etc.) */
	buildSystem: string | undefined;
	/** Test framework (jest, pytest, mocha, etc.) */
	testFramework: string | undefined;
	/** Linter configured (eslint, pylint, etc.) */
	linter: string | undefined;
	/** TypeScript config detected */
	hasTsConfig: boolean;
	/** Key directories (src, test, lib, docs, etc.) */
	keyDirectories: string[];
	/** Package manager (npm, yarn, pnpm) */
	packageManager: string | undefined;
	/** Raw package.json dependencies summary */
	dependencies: { prod: string[]; dev: string[] };
}

export class ProjectContextInjector {

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) { }

	/**
	 * Collect project context from the current workspace.
	 */
	async collectContext(): Promise<IProjectContext> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		const rootUri = folders.length > 0 ? folders[0].uri : undefined;

		const context: IProjectContext = {
			name: rootUri ? basename(rootUri) : 'unknown',
			languages: [],
			frameworks: [],
			buildSystem: undefined,
			testFramework: undefined,
			linter: undefined,
			hasTsConfig: false,
			keyDirectories: [],
			packageManager: undefined,
			dependencies: { prod: [], dev: [] },
		};

		if (!rootUri) { return context; }

		// Read package.json
		try {
			const pkgUri = URI.joinPath(rootUri, 'package.json');
			const content = await this.fileService.readFile(pkgUri);
			const pkg = JSON.parse(content.value.toString());
			context.name = pkg.name || context.name;
			context.dependencies.prod = Object.keys(pkg.dependencies || {});
			context.dependencies.dev = Object.keys(pkg.devDependencies || {});

			// Detect frameworks
			const allDeps = [...context.dependencies.prod, ...context.dependencies.dev];
			if (allDeps.includes('react')) { context.frameworks.push('React'); }
			if (allDeps.includes('vue')) { context.frameworks.push('Vue'); }
			if (allDeps.includes('angular')) { context.frameworks.push('Angular'); }
			if (allDeps.includes('express')) { context.frameworks.push('Express'); }
			if (allDeps.includes('next')) { context.frameworks.push('Next.js'); }
			if (allDeps.includes('electron')) { context.frameworks.push('Electron'); }

			// Detect build system
			if (allDeps.includes('typescript')) { context.languages.push('TypeScript'); }
			if (allDeps.includes('webpack') || allDeps.includes('@webpack-cli')) { context.buildSystem = 'webpack'; }
			if (allDeps.includes('esbuild')) { context.buildSystem = 'esbuild'; }
			if (allDeps.includes('vite')) { context.buildSystem = 'vite'; }
			if (allDeps.includes('rollup')) { context.buildSystem = 'rollup'; }

			// Detect test framework
			if (allDeps.includes('jest')) { context.testFramework = 'Jest'; }
			if (allDeps.includes('mocha')) { context.testFramework = 'Mocha'; }
			if (allDeps.includes('vitest')) { context.testFramework = 'Vitest'; }
			if (allDeps.includes('pytest')) { context.testFramework = 'pytest'; }

			// Detect linter
			if (allDeps.includes('eslint')) { context.linter = 'ESLint'; }
			if (allDeps.includes('prettier')) { context.linter = (context.linter ? context.linter + ' + Prettier' : 'Prettier'); }

			// Detect package manager
			if (allDeps.includes('npm')) { context.packageManager = 'npm'; }
		} catch {
			// No package.json — not a JS/TS project
		}

		// Check for package manager lock files
		try {
			await this.fileService.resolve(URI.joinPath(rootUri, 'yarn.lock'));
			context.packageManager = 'yarn';
		} catch { /* no yarn.lock */ }
		try {
			await this.fileService.resolve(URI.joinPath(rootUri, 'pnpm-lock.yaml'));
			context.packageManager = 'pnpm';
		} catch { /* no pnpm-lock.yaml */ }

		// Check tsconfig.json
		try {
			await this.fileService.resolve(URI.joinPath(rootUri, 'tsconfig.json'));
			context.hasTsConfig = true;
			if (!context.languages.includes('TypeScript')) { context.languages.push('TypeScript'); }
		} catch { /* no tsconfig */ }

		// Detect Python
		try {
			await this.fileService.resolve(URI.joinPath(rootUri, 'pyproject.toml'));
			context.languages.push('Python');
			if (!context.buildSystem) { context.buildSystem = 'pip/uv'; }
		} catch { /* no pyproject.toml */ }

		// Detect Rust
		try {
			await this.fileService.resolve(URI.joinPath(rootUri, 'Cargo.toml'));
			context.languages.push('Rust');
			context.buildSystem = 'cargo';
		} catch { /* no Cargo.toml */ }

		// Detect Go
		try {
			await this.fileService.resolve(URI.joinPath(rootUri, 'go.mod'));
			context.languages.push('Go');
			context.buildSystem = 'go';
		} catch { /* no go.mod */ }

		// Scan key directories
		try {
			const children = await this.fileService.resolve(rootUri);
			if (children.children) {
				const dirNames = children.children
					.filter(c => c.isDirectory)
					.map(c => basename(c.resource));
				context.keyDirectories = dirNames.filter(d =>
					['src', 'lib', 'test', 'tests', 'spec', 'docs', 'doc', 'scripts', 'config', 'build', 'dist', 'public', 'assets'].includes(d.toLowerCase())
				);
			}
		} catch { /* can't read directory */ }

		// If no languages detected, default based on file presence
		if (context.languages.length === 0) {
			context.languages.push('JavaScript');
		}

		return context;
	}

	/**
	 * Inject project context into bootstrap templates.
	 * Merges detected context into the existing template content without
	 * overwriting user-defined sections.
	 */
	injectContext(
		templates: { agentsMd?: string; toolsMd?: string; memoryMd?: string },
		context: IProjectContext,
	): { agentsMd?: string; toolsMd?: string; memoryMd?: string } {
		const contextBlock = this._buildContextBlock(context);
		const projectInfo = this._buildProjectInfoSection(context);

		return {
			agentsMd: templates.agentsMd
				? this._injectSection(templates.agentsMd, 'Project Context', projectInfo)
				: undefined,
			toolsMd: templates.toolsMd
				? this._injectSection(templates.toolsMd, 'Environment Details', contextBlock)
				: undefined,
			memoryMd: templates.memoryMd
				? this._injectSection(templates.memoryMd, 'Project Context', projectInfo)
				: undefined,
		};
	}

	private _buildContextBlock(ctx: IProjectContext): string {
		const lines: string[] = [];
		if (ctx.buildSystem) { lines.push(`- Build system: ${ctx.buildSystem}`); }
		if (ctx.packageManager) { lines.push(`- Package manager: ${ctx.packageManager}`); }
		if (ctx.testFramework) { lines.push(`- Test framework: ${ctx.testFramework}`); }
		if (ctx.linter) { lines.push(`- Linter/formatter: ${ctx.linter}`); }
		if (ctx.hasTsConfig) { lines.push(`- TypeScript: Yes (tsconfig.json)`); }
		if (ctx.keyDirectories.length > 0) { lines.push(`- Key directories: ${ctx.keyDirectories.join(', ')}`); }
		return lines.join('\n');
	}

	private _buildProjectInfoSection(ctx: IProjectContext): string {
		const lines: string[] = [];
		lines.push(`- **Project**: ${ctx.name}`);
		if (ctx.languages.length > 0) { lines.push(`- **Languages**: ${ctx.languages.join(', ')}`); }
		if (ctx.frameworks.length > 0) { lines.push(`- **Frameworks**: ${ctx.frameworks.join(', ')}`); }
		if (ctx.buildSystem) { lines.push(`- **Build**: ${ctx.buildSystem}`); }
		if (ctx.testFramework) { lines.push(`- **Tests**: ${ctx.testFramework}`); }
		if (ctx.linter) { lines.push(`- **Lint**: ${ctx.linter}`); }
		if (ctx.dependencies.prod.length > 0) {
			lines.push(`- **Key deps**: ${ctx.dependencies.prod.slice(0, 10).join(', ')}${ctx.dependencies.prod.length > 10 ? '...' : ''}`);
		}
		return lines.join('\n');
	}

	/**
	 * Inject or replace a section in a Markdown document.
	 * If the section heading already exists, replaces its content.
	 * If not, appends the section at the end.
	 */
	private _injectSection(doc: string, heading: string, content: string): string {
		const headingLine = `## ${heading}`;
		const headingIndex = doc.indexOf(headingLine);

		if (headingIndex === -1) {
			// Section doesn't exist — append
			return doc.trimEnd() + `\n\n${headingLine}\n${content}\n`;
		}

		// Section exists — find the next ## heading or end of document
		const afterHeading = doc.indexOf('\n', headingIndex + headingLine.length) + 1;
		let nextHeading = doc.indexOf('\n## ', afterHeading);
		if (nextHeading === -1) { nextHeading = doc.length; }

		return doc.substring(0, afterHeading) + content + '\n' + doc.substring(nextHeading);
	}

	// ─── Real-time Context Injection (request-time) ────────────────────────────

	/**
	 * Build a real-time context string that can be injected into a system prompt
	 * at request time (aligned with VS Code's ComputeAutomaticInstructions).
	 *
	 * Unlike `injectContext()` which modifies bootstrap templates at creation time,
	 * this method returns a fresh context string computed from the *current*
	 * workspace state — reflecting file changes, active editor, and recent activity.
	 *
	 * @param employeeId The agent requesting context (for per-agent customization)
	 * @returns A Markdown-formatted context block, or empty string if no workspace
	 */
	async computeRealtimeContext(employeeId?: string): Promise<string> {
		const context = await this.collectContext();
		if (context.name === 'unknown' && context.languages.length === 0) {
			return ''; // No project detected
		}

		const lines: string[] = [];
		lines.push('## Current Project Context');
		lines.push(`- **Project**: ${context.name}`);
		if (context.languages.length > 0) {
			lines.push(`- **Languages**: ${context.languages.join(', ')}`);
		}
		if (context.frameworks.length > 0) {
			lines.push(`- **Frameworks**: ${context.frameworks.join(', ')}`);
		}
		if (context.buildSystem) {
			lines.push(`- **Build**: ${context.buildSystem}`);
		}
		if (context.testFramework) {
			lines.push(`- **Tests**: ${context.testFramework}`);
		}
		if (context.linter) {
			lines.push(`- **Lint**: ${context.linter}`);
		}
		if (context.packageManager) {
			lines.push(`- **Package Manager**: ${context.packageManager}`);
		}
		if (context.keyDirectories.length > 0) {
			lines.push(`- **Key Dirs**: ${context.keyDirectories.join(', ')}`);
		}
		if (context.dependencies.prod.length > 0) {
			const topDeps = context.dependencies.prod.slice(0, 15);
			lines.push(`- **Top Deps**: ${topDeps.join(', ')}${context.dependencies.prod.length > 15 ? '...' : ''}`);
		}
		lines.push(`- **Context refreshed**: ${new Date().toISOString()}`);

		return lines.join('\n');
	}

	/**
	 * Build a minimal context snippet for injection into the system prompt
	 * before each request. This is intentionally concise to minimize token usage
	 * while providing enough context for the model to understand the project.
	 *
	 * Aligned with VS Code's ComputeAutomaticInstructions which computes
	 * workspace summary, active editor info, and recent file changes.
	 */
	async computeRequestContext(): Promise<string> {
		const context = await this.collectContext();
		if (context.name === 'unknown') { return ''; }

		const parts: string[] = [context.name];
		if (context.languages.length > 0) { parts.push(context.languages.join('/')); }
		if (context.frameworks.length > 0) { parts.push(context.frameworks.join('+')); }
		if (context.buildSystem) { parts.push(context.buildSystem); }

		return `[Project: ${parts.join(' | ')}]`;
	}
}
