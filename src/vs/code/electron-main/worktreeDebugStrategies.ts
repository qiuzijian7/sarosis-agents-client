/*---------------------------------------------------------------------------------------------
 *  Worktree Debug Strategies
 *
 *  Dispatch "debug" of a worktree by project type. Different project types have
 *  different build + launch requirements:
 *
 *    - vscode-fork : transpile-client + launch the dev electron binary (dev mode)
 *    - web         : npm run dev (vite/next/webpack dev server)
 *    - node        : npm run start / npm run dev / node <entry>
 *    - python      : python main.py / manage.py runserver
 *
 *  Priority (per user decision):
 *    1. .vscode/launch.json explicit config (type → strategy, preLaunchTask → build)
 *    2. marker-based auto-detection
 *    3. fallback → open the worktree directory (no launch)
 *
 *  This module runs in the Electron main process, so it uses node fs + child_process
 *  directly (not IFileService / IProcessService which are renderer-side abstractions).
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from 'child_process';
import { existsSync, readFileSync, readdirSync, symlinkSync } from 'fs';
import { shell } from 'electron';
import { dirname, join } from '../../base/common/path.js';
import { toErrorMessage } from '../../base/common/errorMessage.js';

export interface IWorktreeDebugResult {
	success: boolean;
	stderr: string;
	/** The strategy id that was dispatched ('open-folder' for fallback). */
	strategy?: string;
}

interface IWorktreeDebugStrategy {
	id: string;
	label: string;
	/** Marker-file detection for this project type. */
	detect(worktreePath: string): boolean;
	/** Build/compile step. Returns success (no-op is success). */
	build(worktreePath: string, overrideCommand?: string): Promise<IWorktreeDebugResult>;
	/** Launch the project (detached, "run and see the effect"). */
	launch(worktreePath: string, exePath: string): Promise<IWorktreeDebugResult>;
	/** 生成在终端里执行的编译命令（无需编译则返回 undefined）。 */
	buildCommand?(worktreePath: string, overrideCommand?: string): string | undefined;
	/** 生成在终端里执行的启动命令（无法启动则返回 undefined）。 */
	launchCommand?(worktreePath: string, exePath: string): string | undefined;
}

/** 给 renderer 的"在终端中调试"流程使用的行动计划（编译 + 启动命令）。 */
export interface IWorktreeDebugPlan {
	success: boolean;
	/** Strategy id ('open-folder' for fallback). */
	strategy?: string;
	label?: string;
	/** 在终端中执行的编译命令；undefined = 无需编译。 */
	buildCommand?: string;
	/** 在终端中执行的启动命令；undefined = 无法自动启动。 */
	launchCommand?: string;
	/** 启动命令所需环境变量（如 vscode-fork 需 VSCODE_DEV=1 进入 dev 模式，否则加载生产版 html）。 */
	env?: Record<string, string>;
	stderr?: string;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function fileExists(p: string): boolean {
	return existsSync(p);
}

function readJson<T = any>(p: string): T | undefined {
	try {
		return JSON.parse(readFileSync(p, 'utf8')) as T;
	} catch {
		return undefined;
	}
}

/** Run a shell command and resolve on close (with a hard timeout). */
function runCommand(command: string, cwd: string, timeoutMs = 180000): Promise<IWorktreeDebugResult> {
	return new Promise((resolve) => {
		const child = spawn(command, [], {
			cwd,
			shell: true,
			windowsHide: true,
		});
		let stderr = '';
		let settled = false;
		const timeoutHandle = setTimeout(() => {
			if (!settled) {
				settled = true;
				try { child.kill('SIGKILL'); } catch { /* ignore */ }
				resolve({ success: false, stderr: stderr + `\n[timeout: command killed after ${Math.round(timeoutMs / 1000)}s]` });
			}
		}, timeoutMs);
		child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
		child.stdout?.on('data', () => { /* swallow */ });
		child.on('error', (err) => {
			if (!settled) {
				settled = true;
				clearTimeout(timeoutHandle);
				resolve({ success: false, stderr: err.message });
			}
		});
		child.on('close', (code) => {
			if (!settled) {
				settled = true;
				clearTimeout(timeoutHandle);
				resolve({ success: code === 0, stderr });
			}
		});
	});
}

/**
 * Spawn a detached, long-running process (dev server / app) via a shell command.
 * Uses shell:true so `npm`/`python` resolve correctly on Windows (npm → npm.cmd).
 */
function spawnDetached(command: string, cwd: string, env: NodeJS.ProcessEnv): void {
	const child: ChildProcess = spawn(command, [], {
		cwd,
		env,
		shell: true,
		detached: true,
		stdio: 'ignore',
		windowsHide: true,
	});
	child.unref();
}

// ─── vscode-fork strategy ────────────────────────────────────────────────────

/**
 * Reuse the main repo's built-in extension `out/` outputs via junction.
 *
 * A worktree is an independent git checkout: its `extensions/<name>/src` is
 * present, but the compiled `out/` (gitignored build artifact) is missing.
 * Without it, the ext host fails to activate built-in extensions (git-base,
 * agent-studio, agentmemory-*, etc.), breaking Git / Agent Studio / memory.
 * Recompiling every extension (gulp compile) is heavy, so instead junction the
 * main repo's already-compiled `out/` directories — instant and read-only.
 *
 * If a worktree branch changed an extension's source, its `out/` would be stale;
 * that edge case requires recompiling the specific extension (documented, not
 * automated here).
 */
function junctionExtensionOuts(worktreePath: string, repoRoot: string): void {
	const mainExtDir = join(repoRoot, 'extensions');
	const wtExtDir = join(worktreePath, 'extensions');
	if (!existsSync(mainExtDir) || !existsSync(wtExtDir)) {
		return;
	}
	let names: string[];
	try {
		names = readdirSync(mainExtDir);
	} catch {
		return;
	}
	// Some extensions output to `out/` (most), others to `dist/` (e.g.
	// codebuddy-provider whose package.json main is `./dist/extension.cjs.js`).
	const BUILD_DIRS = ['out', 'dist'];
	for (const name of names) {
		const wtExt = join(wtExtDir, name);
		if (!existsSync(wtExt)) {
			continue;
		}
		for (const dir of BUILD_DIRS) {
			const mainBuild = join(mainExtDir, name, dir);
			const wtBuild = join(wtExt, dir);
			// Only junction if: main has the compiled dir + worktree's is missing.
			if (!existsSync(mainBuild) || existsSync(wtBuild)) {
				continue;
			}
			try {
				symlinkSync(mainBuild, wtBuild, 'junction');
			} catch {
				// ignore individual junction failures
			}
		}
	}
}

/**
 * 解析 vscode-fork 策略实际使用的 electron 二进制。
 *
 * 必须优先用 dev 二进制（<repoRoot>/.build/electron/<productName>.exe），而不是
 * process.execPath。原因：
 *  - 生产安装版的 process.execPath 是生产 exe（安装目录下的同名 exe），
 *    自带 resources/app（生产 bundle），Electron 会忽略目录参数、加载生产 bundle，
 *    不加载 worktree 的 out/；且 VSCODE_DEV=1 让生产 exe 进入 dev 模式后
 *    路径错乱 → 启动即崩溃（无窗口，连 userData 日志都没写）。
 *  - dev 二进制没有 resources/app（只有 default_app.asar），Electron 会把
 *    目录参数（worktreePath）当作 app 路径，加载 worktree/out/ 的源码
 *    （与 scripts/code.bat 把 repo 根目录作为 app 参数同理）。
 *
 * exe 文件名不写死：从 product.json 的 nameShort 动态读取（如 "VsSaros" → "VsSaros.exe"）。
 */
function resolveVscodeForkExePath(worktreePath: string, exePath: string): string {
	const repoRoot = dirname(dirname(worktreePath));
	const product = readJson<{ nameShort?: string }>(join(repoRoot, 'product.json'));
	if (product?.nameShort) {
		const devExe = join(repoRoot, '.build', 'electron', `${product.nameShort}.exe`);
		if (fileExists(devExe)) { return devExe; }
	}
	return exePath;
}

/**
 * vscode-fork 启动必须注入的 dev 环境变量。
 *
 * 缺 VSCODE_DEV=1 时 `environmentMainService.isBuilt=true`，主进程会加载生产版
 * sessions.html（引用不存在的 sessions.desktop.main.css 且无 dev import map），
 * 叠加 transpile 产物里保留的裸 CSS import，连环报错：CSS 被当模块加载、以及
 * "Failed to fetch dynamically imported module: .../sessions.desktop.main.js"。
 * 与 scripts/code.bat 的环境变量对齐。
 */
const VSCODE_FORK_DEV_ENV: Record<string, string> = {
	NODE_ENV: 'development',
	VSCODE_DEV: '1',
	VSCODE_CLI: '1',
	ELECTRON_ENABLE_LOGGING: '1',
	ELECTRON_ENABLE_STACK_DUMPING: '1',
};

const vscodeForkStrategy: IWorktreeDebugStrategy = {
	id: 'vscode-fork',
	label: 'VS Code fork (vssaros)',
	detect(worktreePath) {
		return fileExists(join(worktreePath, 'product.json')) && fileExists(join(worktreePath, 'src', 'vs', 'code'));
	},
	async build(worktreePath, overrideCommand) {
		const repoRoot = dirname(dirname(worktreePath));

		// 1. Idempotent node_modules junction (reuse main repo's, saves GBs)
		const wtNodeModules = join(worktreePath, 'node_modules');
		const mainNodeModules = join(repoRoot, 'node_modules');
		if (!existsSync(wtNodeModules) && existsSync(mainNodeModules)) {
			try { symlinkSync(mainNodeModules, wtNodeModules, 'junction'); } catch { /* non-fatal */ }
		}

		// 2. Compile the worktree's core out/
		const command = overrideCommand ?? 'npm run transpile-client';
		const compile = await runCommand(command, worktreePath);
		if (!compile.success) {
			return compile;
		}

		// 3. Junction the main repo's built-in extension out/ (avoids ext-host activation failures)
		junctionExtensionOuts(worktreePath, repoRoot);

		return { success: true, stderr: '' };
	},
	buildCommand(worktreePath, overrideCommand) {
		return overrideCommand ?? 'npm run transpile-client';
	},
	launchCommand(worktreePath, exePath) {
		return `"${resolveVscodeForkExePath(worktreePath, exePath)}" "${worktreePath}" --skip-sessions-welcome`;
	},
	async launch(worktreePath, exePath) {
		try {
			const command = `"${resolveVscodeForkExePath(worktreePath, exePath)}" "${worktreePath}" --skip-sessions-welcome`;
			spawnDetached(command, dirname(dirname(worktreePath)), {
				...process.env,
				...VSCODE_FORK_DEV_ENV,
			});
			return { success: true, stderr: '' };
		} catch (e) {
			return { success: false, stderr: `failed to launch worktree instance: ${toErrorMessage(e)}` };
		}
	},
};

// ─── web strategy ────────────────────────────────────────────────────────────

const WEB_CONFIG_FILES = [
	'vite.config.js', 'vite.config.ts', 'vite.config.mjs',
	'next.config.js', 'next.config.mjs', 'next.config.ts',
	'webpack.config.js', 'webpack.config.cjs',
	'nuxt.config.ts', 'nuxt.config.js',
	'angular.json',
];

const webStrategy: IWorktreeDebugStrategy = {
	id: 'web',
	label: 'Web frontend (vite/next/webpack)',
	detect(worktreePath) {
		if (!fileExists(join(worktreePath, 'package.json')) || fileExists(join(worktreePath, 'product.json'))) {
			return false;
		}
		return WEB_CONFIG_FILES.some(f => fileExists(join(worktreePath, f)));
	},
	async build(worktreePath, overrideCommand) {
		if (overrideCommand) {
			return runCommand(overrideCommand, worktreePath);
		}
		// dev server 实时编译，无强制 build；有 build script 则跑
		const pkg = readJson<{ scripts?: Record<string, string> }>(join(worktreePath, 'package.json'));
		if (pkg?.scripts?.build) {
			return runCommand('npm run build', worktreePath);
		}
		return { success: true, stderr: '' };
	},
	buildCommand(worktreePath, overrideCommand) {
		if (overrideCommand) { return overrideCommand; }
		const pkg = readJson<{ scripts?: Record<string, string> }>(join(worktreePath, 'package.json'));
		if (pkg?.scripts?.build) { return 'npm run build'; }
		return undefined;
	},
	launchCommand(worktreePath) {
		const pkg = readJson<{ scripts?: Record<string, string> }>(join(worktreePath, 'package.json'));
		const devScript = pkg?.scripts?.dev ? 'dev'
			: pkg?.scripts?.start ? 'start'
				: pkg?.scripts?.serve ? 'serve'
					: undefined;
		return devScript ? `npm run ${devScript}` : undefined;
	},
	async launch(worktreePath) {
		const pkg = readJson<{ scripts?: Record<string, string> }>(join(worktreePath, 'package.json'));
		const devScript = pkg?.scripts?.dev ? 'dev'
			: pkg?.scripts?.start ? 'start'
				: pkg?.scripts?.serve ? 'serve'
					: undefined;
		if (!devScript) {
			return { success: false, stderr: '未在 package.json 找到 dev/start/serve 启动脚本' };
		}
		try {
			spawnDetached(`npm run ${devScript}`, worktreePath, { ...process.env });
			return { success: true, stderr: '' };
		} catch (e) {
			return { success: false, stderr: `failed to launch dev server: ${toErrorMessage(e)}` };
		}
	},
};

// ─── node strategy ───────────────────────────────────────────────────────────

const nodeStrategy: IWorktreeDebugStrategy = {
	id: 'node',
	label: 'Node.js',
	detect(worktreePath) {
		return fileExists(join(worktreePath, 'package.json')) && !fileExists(join(worktreePath, 'product.json'));
	},
	async build(worktreePath, overrideCommand) {
		if (overrideCommand) {
			return runCommand(overrideCommand, worktreePath);
		}
		const pkg = readJson<{ scripts?: Record<string, string> }>(join(worktreePath, 'package.json'));
		if (pkg?.scripts?.build) {
			return runCommand('npm run build', worktreePath);
		}
		return { success: true, stderr: '' };
	},
	buildCommand(worktreePath, overrideCommand) {
		if (overrideCommand) { return overrideCommand; }
		const pkg = readJson<{ scripts?: Record<string, string> }>(join(worktreePath, 'package.json'));
		if (pkg?.scripts?.build) { return 'npm run build'; }
		return undefined;
	},
	launchCommand(worktreePath) {
		const pkg = readJson<{ scripts?: Record<string, string> }>(join(worktreePath, 'package.json'));
		if (pkg?.scripts?.start) { return 'npm run start'; }
		if (pkg?.scripts?.dev) { return 'npm run dev'; }
		if (pkg?.scripts?.serve) { return 'npm run serve'; }
		if (fileExists(join(worktreePath, 'src', 'index.js'))) { return 'node src/index.js'; }
		if (fileExists(join(worktreePath, 'index.js'))) { return 'node index.js'; }
		return undefined;
	},
	async launch(worktreePath) {
		const pkg = readJson<{ scripts?: Record<string, string> }>(join(worktreePath, 'package.json'));
		let command: string | undefined;
		if (pkg?.scripts?.start) { command = 'npm run start'; }
		else if (pkg?.scripts?.dev) { command = 'npm run dev'; }
		else if (pkg?.scripts?.serve) { command = 'npm run serve'; }
		else if (fileExists(join(worktreePath, 'src', 'index.js'))) { command = 'node src/index.js'; }
		else if (fileExists(join(worktreePath, 'index.js'))) { command = 'node index.js'; }

		if (!command) {
			return { success: false, stderr: '未找到可启动的 node 入口（无 start/dev/serve 脚本，也无 index.js）' };
		}
		try {
			spawnDetached(command, worktreePath, { ...process.env });
			return { success: true, stderr: '' };
		} catch (e) {
			return { success: false, stderr: `failed to launch node app: ${toErrorMessage(e)}` };
		}
	},
};

// ─── python strategy ─────────────────────────────────────────────────────────

const pythonStrategy: IWorktreeDebugStrategy = {
	id: 'python',
	label: 'Python',
	detect(worktreePath) {
		return fileExists(join(worktreePath, 'pyproject.toml'))
			|| fileExists(join(worktreePath, 'requirements.txt'))
			|| fileExists(join(worktreePath, 'setup.py'))
			|| fileExists(join(worktreePath, 'Pipfile'));
	},
	async build(worktreePath, overrideCommand) {
		if (overrideCommand) {
			return runCommand(overrideCommand, worktreePath);
		}
		// 解释型语言，无强制编译；有 requirements.txt 则 pip install
		if (fileExists(join(worktreePath, 'requirements.txt'))) {
			return runCommand('pip install -r requirements.txt', worktreePath, 300000);
		}
		return { success: true, stderr: '' };
	},
	buildCommand(worktreePath, overrideCommand) {
		if (overrideCommand) { return overrideCommand; }
		if (fileExists(join(worktreePath, 'requirements.txt'))) { return 'pip install -r requirements.txt'; }
		return undefined;
	},
	launchCommand(worktreePath) {
		if (fileExists(join(worktreePath, 'main.py'))) { return 'python main.py'; }
		if (fileExists(join(worktreePath, 'manage.py'))) { return 'python manage.py runserver'; }
		if (fileExists(join(worktreePath, 'app.py'))) { return 'python app.py'; }
		if (fileExists(join(worktreePath, 'pyproject.toml'))) { return 'python -m uvicorn main:app --reload'; }
		return 'python main.py';
	},
	async launch(worktreePath) {
		let command: string;
		if (fileExists(join(worktreePath, 'main.py'))) { command = 'python main.py'; }
		else if (fileExists(join(worktreePath, 'manage.py'))) { command = 'python manage.py runserver'; }
		else if (fileExists(join(worktreePath, 'app.py'))) { command = 'python app.py'; }
		else if (fileExists(join(worktreePath, 'pyproject.toml'))) { command = 'python -m uvicorn main:app --reload'; }
		else { command = 'python main.py'; }
		try {
			spawnDetached(command, worktreePath, { ...process.env });
			return { success: true, stderr: '' };
		} catch (e) {
			return { success: false, stderr: `failed to launch python app: ${toErrorMessage(e)}` };
		}
	},
};

// ─── strategy registry (priority order) ──────────────────────────────────────

const STRATEGIES: IWorktreeDebugStrategy[] = [
	vscodeForkStrategy,
	pythonStrategy,
	webStrategy,
	nodeStrategy,
];

// ─── explicit .vscode/launch.json resolution ─────────────────────────────────

interface ILaunchConfig {
	type?: string;
	preLaunchTask?: string;
}

/** Map a launch.json `type` to a strategy id. */
function mapLaunchTypeToStrategy(type: string | undefined): string | null {
	switch (type) {
		case 'extensionHost':
		case 'vscode-extension':
			return 'vscode-fork';
		case 'node':
		case 'pwa-node':
			return 'node';
		case 'python':
		case 'debugpy':
			return 'python';
		case 'chrome':
		case 'pwa-chrome':
		case 'msedge':
		case 'pwa-msedge':
			return 'web';
		default:
			return null;
	}
}

/**
 * Read .vscode/launch.json (explicit config, highest priority). Returns the
 * strategy id implied by `type`, and the build command implied by `preLaunchTask`
 * (looked up in .vscode/tasks.json).
 */
function resolveExplicitLaunchConfig(worktreePath: string): { strategyId: string; buildCommand?: string } | null {
	const launchJson = join(worktreePath, '.vscode', 'launch.json');
	if (!fileExists(launchJson)) {
		return null;
	}
	const cfg = readJson<{ configurations?: ILaunchConfig[] }>(launchJson);
	const first = cfg?.configurations?.[0];
	if (!first) {
		return null;
	}
	const strategyId = mapLaunchTypeToStrategy(first.type);
	if (!strategyId) {
		return null;
	}

	let buildCommand: string | undefined;
	if (first.preLaunchTask) {
		const tasksJson = join(worktreePath, '.vscode', 'tasks.json');
		const tasks = readJson<{ tasks?: { label?: string; command?: string }[] }>(tasksJson);
		const task = tasks?.tasks?.find(t => t.label === first.preLaunchTask);
		buildCommand = task?.command;
	}
	return { strategyId, buildCommand };
}

// ─── dispatcher ──────────────────────────────────────────────────────────────

/**
 * Entry point for `vscode:launchWorktreeDebug`. Resolves the project type via
 * (1) explicit launch.json, (2) marker auto-detection, (3) folder-open fallback,
 * then runs build → launch.
 */
export async function dispatchWorktreeDebug(worktreePath: string, exePath: string): Promise<IWorktreeDebugResult> {
	if (!fileExists(worktreePath)) {
		return { success: false, stderr: `worktree path not found: ${worktreePath}` };
	}

	// 1. Explicit .vscode/launch.json (highest priority)
	const explicit = resolveExplicitLaunchConfig(worktreePath);
	let strategy: IWorktreeDebugStrategy | undefined;
	let buildCommand: string | undefined;
	if (explicit) {
		strategy = STRATEGIES.find(s => s.id === explicit.strategyId);
		buildCommand = explicit.buildCommand;
	}

	// 2. Marker auto-detection
	if (!strategy) {
		strategy = STRATEGIES.find(s => s.detect(worktreePath));
	}

	// 3. Fallback: open the worktree directory
	if (!strategy) {
		try {
			await shell.openPath(worktreePath);
			return { success: true, stderr: '', strategy: 'open-folder' };
		} catch (e) {
			return { success: false, stderr: `无法识别项目类型且打开目录失败: ${toErrorMessage(e)}` };
		}
	}

	// Build (explicit preLaunchTask overrides the strategy's default build)
	const buildResult = await strategy.build(worktreePath, buildCommand);
	if (!buildResult.success) {
		return { success: false, stderr: `[${strategy.label}] 构建失败:\n${buildResult.stderr}`, strategy: strategy.id };
	}

	// Launch
	const launchResult = await strategy.launch(worktreePath, exePath);
	return { ...launchResult, strategy: strategy.id };
}

/**
 * Resolve a "debug in terminal" plan for a worktree: detect the project type and
 * produce the build + launch commands, WITHOUT executing them (the renderer runs
 * them in the integrated terminal so the user sees the compile output live).
 *
 * For `vscode-fork`, also performs the prep steps (node_modules junction +
 * extension-out junction) that must happen before `transpile-client`.
 */
export async function resolveWorktreeDebugPlan(worktreePath: string, exePath: string): Promise<IWorktreeDebugPlan> {
	if (!fileExists(worktreePath)) {
		return { success: false, stderr: `worktree path not found: ${worktreePath}` };
	}

	// 1. Explicit .vscode/launch.json (highest priority)
	const explicit = resolveExplicitLaunchConfig(worktreePath);
	let strategy: IWorktreeDebugStrategy | undefined;
	let buildCommand: string | undefined;
	if (explicit) {
		strategy = STRATEGIES.find(s => s.id === explicit.strategyId);
		buildCommand = explicit.buildCommand;
	}

	// 2. Marker auto-detection
	if (!strategy) {
		strategy = STRATEGIES.find(s => s.detect(worktreePath));
	}

	// 3. Fallback: no recognizable project type
	if (!strategy) {
		return { success: false, strategy: 'open-folder', stderr: '无法识别项目类型（无 .vscode/launch.json 也无项目标记文件）' };
	}

	// vscode-fork prep：junction node_modules + 内置扩展 out/（只读复用主仓库编译产物）
	if (strategy.id === 'vscode-fork') {
		const repoRoot = dirname(dirname(worktreePath));
		const wtNodeModules = join(worktreePath, 'node_modules');
		const mainNodeModules = join(repoRoot, 'node_modules');
		if (!existsSync(wtNodeModules) && existsSync(mainNodeModules)) {
			try { symlinkSync(mainNodeModules, wtNodeModules, 'junction'); } catch { /* non-fatal */ }
		}
		junctionExtensionOuts(worktreePath, repoRoot);
	}

	return {
		success: true,
		strategy: strategy.id,
		label: strategy.label,
		buildCommand: strategy.buildCommand?.(worktreePath, buildCommand) ?? undefined,
		launchCommand: strategy.launchCommand?.(worktreePath, exePath) ?? undefined,
		env: strategy.id === 'vscode-fork' ? VSCODE_FORK_DEV_ENV : undefined,
	};
}
