/*---------------------------------------------------------------------------------------------
 *  Repo Overview Provider
 *
 *  Provides structured codebase context for AI decomposition.
 *  Inspired by OpenCode's repo_overview tool.
 *
 *  Capabilities:
 *  1. Ecosystem detection (Node.js/Python/Go/Rust/Ruby/Java/PHP)
 *  2. Package manager identification
 *  3. Entry point discovery
 *  4. Directory structure traversal
 *  5. Git information
 *
 *  The output is injected into the AI decomposition prompt so that
 *  task decomposition is aware of the actual project structure.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';


// ─── Types ────────────────────────────────────────────────────────────────

export interface RepoOverview {
	/** Project root path */
	readonly rootPath: string;
	/** Detected ecosystems (e.g., ["Node.js", "Python"]) */
	readonly ecosystems: string[];
	/** Package manager (e.g., "npm", "pnpm", "yarn", "bun", "pip", "cargo") */
	readonly packageManager: string;
	/** Dependency files found (e.g., ["package.json", "requirements.txt"]) */
	readonly dependencyFiles: string[];
	/** Likely entry points */
	readonly entryPoints: string[];
	/** Top-level directory structure (depth-limited) */
	readonly structure: DirectoryNode;
	/** Git branch info (if available) */
	readonly gitBranch?: string;
	/** Git HEAD commit (if available) */
	readonly gitHead?: string;
	/** Formatted summary for AI consumption */
	readonly summary: string;
}

export interface DirectoryNode {
	readonly name: string;
	readonly type: 'file' | 'directory';
	readonly children?: DirectoryNode[];
}

// ─── Ecosystem Detection ──────────────────────────────────────────────────

interface EcosystemDetector {
	readonly name: string;
	readonly markerFiles: string[];
	readonly packageManagers: Array<{ files: string[]; name: string }>;
	readonly entryPointFiles: string[];
}

const ECOSYSTEMS: EcosystemDetector[] = [
	{
		name: 'Node.js',
		markerFiles: ['package.json'],
		packageManagers: [
			{ files: ['bun.lockb', 'bun.lock'], name: 'bun' },
			{ files: ['pnpm-lock.yaml'], name: 'pnpm' },
			{ files: ['yarn.lock'], name: 'yarn' },
			{ files: ['package-lock.json'], name: 'npm' },
		],
		entryPointFiles: ['index.ts', 'index.js', 'index.mjs', 'main.ts', 'main.js', 'src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.js'],
	},
	{
		name: 'Python',
		markerFiles: ['requirements.txt', 'setup.py', 'pyproject.toml', 'Pipfile', 'poetry.lock'],
		packageManagers: [
			{ files: ['poetry.lock'], name: 'poetry' },
			{ files: ['Pipfile'], name: 'pipenv' },
			{ files: ['uv.lock'], name: 'uv' },
			{ files: ['requirements.txt'], name: 'pip' },
		],
		entryPointFiles: ['main.py', 'app.py', 'manage.py', 'src/__main__.py', 'src/main.py'],
	},
	{
		name: 'Go',
		markerFiles: ['go.mod', 'go.sum'],
		packageManagers: [
			{ files: ['go.mod'], name: 'go modules' },
		],
		entryPointFiles: ['main.go', 'cmd/main.go'],
	},
	{
		name: 'Rust',
		markerFiles: ['Cargo.toml', 'Cargo.lock'],
		packageManagers: [
			{ files: ['Cargo.toml'], name: 'cargo' },
		],
		entryPointFiles: ['src/main.rs', 'src/lib.rs'],
	},
	{
		name: 'Ruby',
		markerFiles: ['Gemfile', 'Gemfile.lock'],
		packageManagers: [
			{ files: ['Gemfile'], name: 'bundler' },
		],
		entryPointFiles: ['main.rb', 'app.rb', 'config.ru'],
	},
	{
		name: 'Java',
		markerFiles: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
		packageManagers: [
			{ files: ['pom.xml'], name: 'maven' },
			{ files: ['build.gradle', 'build.gradle.kts'], name: 'gradle' },
		],
		entryPointFiles: ['src/main/java/Main.java', 'src/main/java/Application.java'],
	},
	{
		name: 'PHP',
		markerFiles: ['composer.json', 'composer.lock'],
		packageManagers: [
			{ files: ['composer.json'], name: 'composer' },
		],
		entryPointFiles: ['index.php', 'public/index.php'],
	},
];

// Directories to skip during structure traversal
const SKIP_DIRS = new Set([
	'.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt',
	'vendor', '__pycache__', '.venv', 'venv', 'env', '.env',
	'target', '.cargo', '.rustup', 'coverage', '.coverage',
	'.idea', '.vscode', '.vs', 'bin', 'obj', 'Debug', 'Release',
	'.sarosisworkspace',
]);

// Files to skip
const SKIP_FILES = new Set([
	'.DS_Store', 'Thumbs.db', '.gitkeep',
]);

// Maximum total file/directory nodes across the entire tree
const MAX_TOTAL_NODES = 1000;
// Maximum children per directory (smart truncation below this limit)
const MAX_CHILDREN_PER_DIR = 50;

// ─── RepoOverviewProvider ─────────────────────────────────────────────────

export class RepoOverviewProvider {

	/** Running count of nodes across the entire tree to enforce MAX_TOTAL_NODES */
	private _nodeCount = 0;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
	) { }

	/**
	 * Generate a repo overview for the given workspace root.
	 * @param rootUri The workspace root URI
	 * @param maxDepth Maximum directory traversal depth (default: 3, max: 6)
	 */
	async getOverview(rootUri: URI, maxDepth: number = 3): Promise<RepoOverview> {
		maxDepth = Math.min(Math.max(maxDepth, 1), 6);
		const rootPath = rootUri.fsPath;

		// Reset node counter for this scan
		this._nodeCount = 0;

		this.logService.info(`[RepoOverview] Generating overview for ${rootPath}, maxDepth=${maxDepth}`);

		// Phase 1: Detect ecosystems
		const { ecosystems, packageManager, dependencyFiles } = await this._detectEcosystems(rootUri);

		// Phase 2: Discover entry points
		const entryPoints = await this._discoverEntryPoints(rootUri);

		// Phase 3: Scan directory structure
		const structure = await this._scanDirectoryStructure(rootUri, maxDepth);

		// Phase 4: Git info
		const gitBranch = await this._tryReadGitHead(rootUri);

		let overview: RepoOverview = {
			rootPath,
			ecosystems,
			packageManager,
			dependencyFiles,
			entryPoints,
			structure,
			gitBranch: gitBranch?.branch,
			gitHead: gitBranch?.commit,
			summary: '', // computed below
		};

		// Phase 5: Generate formatted summary
		overview = { ...overview, summary: this._formatSummary(overview) };

		this.logService.info(`[RepoOverview] Overview complete: ${ecosystems.length} ecosystems, ${entryPoints.length} entry points`);
		return overview;
	}

	/**
	 * Get a compact summary string suitable for injection into AI prompts.
	 */
	async getCompactSummary(rootUri: URI): Promise<string> {
		const overview = await this.getOverview(rootUri, 2);
		return overview.summary;
	}

	// ─── Private Methods ──────────────────────────────────────────────────

	private async _detectEcosystems(rootUri: URI): Promise<{
		ecosystems: string[];
		packageManager: string;
		dependencyFiles: string[];
	}> {
		const ecosystems: string[] = [];
		let packageManager = 'unknown';
		const dependencyFiles: string[] = [];

		for (const eco of ECOSYSTEMS) {
			let ecosystemDetected = false;

			for (const marker of eco.markerFiles) {
				try {
					const uri = URI.joinPath(rootUri, marker);
					const stat = await this.fileService.stat(uri);
					if (stat) {
						ecosystemDetected = true;
						dependencyFiles.push(marker);
					}
				} catch { /* file doesn't exist */ }
			}

			if (ecosystemDetected) {
				ecosystems.push(eco.name);

				// Detect package manager (first match wins)
				if (packageManager === 'unknown') {
					for (const pm of eco.packageManagers) {
						for (const pmFile of pm.files) {
							try {
								const uri = URI.joinPath(rootUri, pmFile);
								const stat = await this.fileService.stat(uri);
								if (stat) {
									packageManager = pm.name;
									break;
								}
							} catch { /* file doesn't exist */ }
						}
						if (packageManager !== 'unknown') { break; }
					}
				}
			}
		}

		return { ecosystems, packageManager, dependencyFiles };
	}

	private async _discoverEntryPoints(rootUri: URI): Promise<string[]> {
		const entryPoints: string[] = [];

		// Check common entry point files
		const commonEntries = [
			'index.ts', 'index.js', 'index.mjs',
			'main.ts', 'main.js', 'main.py', 'main.go', 'main.rs',
			'app.ts', 'app.js', 'app.py',
			'src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.js',
			'src/main.py', 'src/main.go',
		];

		for (const entry of commonEntries) {
			try {
				const uri = URI.joinPath(rootUri, entry);
				const stat = await this.fileService.stat(uri);
				if (stat) {
					entryPoints.push(entry);
				}
			} catch { /* file doesn't exist */ }
		}

		// Try to read package.json for entry points
		try {
			const pkgUri = URI.joinPath(rootUri, 'package.json');
			const content = await this.fileService.readFile(pkgUri);
			const pkg = JSON.parse(content.value.toString());

			if (pkg.main) { entryPoints.push(`main: ${pkg.main}`); }
			if (pkg.module) { entryPoints.push(`module: ${pkg.module}`); }
			if (pkg.types || pkg.typings) { entryPoints.push(`types: ${pkg.types || pkg.typings}`); }
			if (pkg.bin) {
				if (typeof pkg.bin === 'string') {
					entryPoints.push(`bin: ${pkg.bin}`);
				} else if (typeof pkg.bin === 'object') {
					for (const [name, path] of Object.entries(pkg.bin)) {
						entryPoints.push(`bin(${name}): ${path}`);
					}
				}
			}
			if (pkg.exports) {
				const exports = typeof pkg.exports === 'object' ? Object.keys(pkg.exports) : [pkg.exports];
				for (const exp of exports.slice(0, 5)) {
					entryPoints.push(`export: ${exp}`);
				}
			}
		} catch { /* not a Node.js project or no package.json */ }

		return entryPoints;
	}

	private async _scanDirectoryStructure(rootUri: URI, maxDepth: number): Promise<DirectoryNode> {
		return this._scanDir(rootUri, 0, maxDepth);
	}

	private async _scanDir(dirUri: URI, currentDepth: number, maxDepth: number): Promise<DirectoryNode> {
		const name = dirUri.path.split('/').pop() || dirUri.fsPath.split(/[\\/]/).pop() || '';

		if (currentDepth >= maxDepth || this._nodeCount >= MAX_TOTAL_NODES) {
			return { name, type: 'directory' };
		}

		// Count this directory node
		this._nodeCount++;

		const children: DirectoryNode[] = [];

		try {
			const stat = await this.fileService.resolve(dirUri);

			// Sort: directories first, then files, both alphabetically
			const sorted = (stat.children || []).sort((a, b) => {
				if (a.isDirectory !== b.isDirectory) { return a.isDirectory ? -1 : 1; }
				return a.name.localeCompare(b.name);
			});

			// Separate directories and files for smart truncation
			const dirEntries = sorted.filter(e => e.isDirectory);
			const fileEntries = sorted.filter(e => !e.isDirectory);

			// Smart truncation: reserve slots for directories (they are more
			// informative for AI), fill remaining slots with files.
			const maxDirs = Math.min(dirEntries.length, Math.ceil(MAX_CHILDREN_PER_DIR * 0.7));
			const maxFiles = Math.min(fileEntries.length, MAX_CHILDREN_PER_DIR - Math.min(dirEntries.length, maxDirs));
			const truncatedDirs = dirEntries.slice(0, maxDirs);
			const truncatedFiles = fileEntries.slice(0, maxFiles);

			const truncatedEntries = [...truncatedDirs, ...truncatedFiles];

			for (const entry of truncatedEntries) {
				// Global node budget check
				if (this._nodeCount >= MAX_TOTAL_NODES) { break; }

				// Skip noise directories and files
				if (entry.isDirectory && SKIP_DIRS.has(entry.name)) { continue; }
				if (!entry.isDirectory && SKIP_FILES.has(entry.name)) { continue; }
				// Skip hidden files/dirs (except .github which is often useful)
				if (entry.name.startsWith('.') && entry.name !== '.github') { continue; }

				const childUri = entry.resource;

				if (entry.isDirectory) {
					const childNode = await this._scanDir(childUri, currentDepth + 1, maxDepth);
					children.push(childNode);
				} else {
					this._nodeCount++;
					children.push({ name: entry.name, type: 'file' });
				}
			}

			// Append truncation indicator if entries were omitted
			const totalOmitted = (dirEntries.length - maxDirs) + (fileEntries.length - maxFiles);
			if (totalOmitted > 0) {
				children.push({ name: `... (${totalOmitted} more entries omitted)`, type: 'file' });
			}
		} catch { /* directory doesn't exist or not readable */ }

		return { name, type: 'directory', children };
	}

	private async _tryReadGitHead(rootUri: URI): Promise<{ branch: string; commit: string } | undefined> {
		try {
			// Read HEAD file
			const headUri = URI.joinPath(rootUri, '.git', 'HEAD');
			const content = await this.fileService.readFile(headUri);
			const head = content.value.toString().trim();

			// Parse branch name from "ref: refs/heads/branch-name"
			const branchMatch = head.match(/^ref: refs\/heads\/(.+)$/);
			if (branchMatch) {
				const branch = branchMatch[1];
				// Try to read the commit hash
				try {
					const refUri = URI.joinPath(rootUri, '.git', 'refs', 'heads', branch);
					const refContent = await this.fileService.readFile(refUri);
					const commit = refContent.value.toString().trim().substring(0, 7);
					return { branch, commit };
				} catch {
					return { branch, commit: 'unknown' };
				}
			}

			// Detached HEAD — head is just a commit hash
			if (/^[0-9a-f]{40}$/.test(head)) {
				return { branch: 'detached HEAD', commit: head.substring(0, 7) };
			}
		} catch { /* not a git repo */ }

		return undefined;
	}

	private _formatSummary(overview: RepoOverview): string {
		const lines: string[] = [];

		lines.push(`Project: ${overview.rootPath}`);

		if (overview.ecosystems.length > 0) {
			lines.push(`Ecosystems: ${overview.ecosystems.join(', ')}`);
		}

		if (overview.packageManager !== 'unknown') {
			lines.push(`Package manager: ${overview.packageManager}`);
		}

		if (overview.dependencyFiles.length > 0) {
			lines.push(`Dependency files: ${overview.dependencyFiles.join(', ')}`);
		}

		if (overview.entryPoints.length > 0) {
			lines.push('Likely entry points:');
			for (const ep of overview.entryPoints.slice(0, 10)) {
				lines.push(`  - ${ep}`);
			}
		}

		if (overview.gitBranch) {
			lines.push(`Git: branch=${overview.gitBranch}, HEAD=${overview.gitHead || 'unknown'}`);
		}

		lines.push('');
		lines.push('Directory structure:');
		lines.push(this._formatDirectoryTree(overview.structure, ''));

		return lines.join('\n');
	}

	private _formatDirectoryTree(node: DirectoryNode, indent: string): string {
		const lines: string[] = [];

		if (node.type === 'file') {
			lines.push(`${indent}${node.name}`);
		} else {
			lines.push(`${indent}${node.name}/`);
			if (node.children) {
				for (const child of node.children) {
					lines.push(this._formatDirectoryTree(child, indent + '  '));
				}
			}
		}

		return lines.join('\n');
	}
}
