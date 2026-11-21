/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 官方组件安装器。版本由 winget / brew / apt / dnf / pacman 自己解析；
 * 这里只固定“包名”和“安装范围”，不保存 upstream 版本号。
 */
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { delimiter, join } from '../../../../base/common/path.js';
import { DshComponentSpec, DshOs, DshProviderSpec } from './dshComponentCatalog.js';

export interface IDshCommandResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export type DshCommandRunner = (
	file: string,
	args: readonly string[],
	options: { timeout: number; windowsHide: boolean; env: NodeJS.ProcessEnv },
) => Promise<IDshCommandResult>;

export interface IDshComponentProvider {
	readonly id: string;
	readonly label: string;
	requiresElevation(): boolean;
	available(): Promise<boolean>;
	install(spec: DshComponentSpec, specProvider: DshProviderSpec, signal: AbortSignal): Promise<void>;
}

function resolveExecutable(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
	const suffix = platform === 'win32' && !name.endsWith('.exe') ? '.exe' : '';
	const candidates: string[] = [];
	const pathDirs = String(env.PATH ?? '').split(delimiter).map(dir => dir.trim()).filter(Boolean);
	for (const dir of pathDirs) { candidates.push(join(dir, `${name}${suffix}`)); }
	if (platform === 'win32') {
		if (env.LOCALAPPDATA) { candidates.push(join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', `${name}${suffix}`)); }
		if (env.ProgramFiles) { candidates.push(join(env.ProgramFiles, 'WindowsApps', `${name}${suffix}`)); }
	} else if (platform === 'darwin') {
		candidates.push(`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/opt/local/bin/${name}`);
	} else {
		candidates.push(`/usr/bin/${name}`, `/bin/${name}`, `/usr/local/bin/${name}`);
	}
	return candidates.find(candidate => existsSync(candidate)) ?? name;
}

function defaultRunner(): DshCommandRunner {
	return (file, args, options) => new Promise((resolve, reject) => {
		execFile(file, [...args], { timeout: options.timeout, windowsHide: options.windowsHide, env: options.env }, (error, stdout, stderr) => {
			const code = (error as { code?: unknown } | null)?.code;
			if (error && typeof code === 'string') {
				reject(error);
				return;
			}
			resolve({ code: typeof code === 'number' ? code : 0, stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

const INSTALL_TIMEOUT_MS = 15 * 60_000;

abstract class CommandProvider implements IDshComponentProvider {
	abstract readonly id: string;
	abstract readonly label: string;
	protected readonly _run: DshCommandRunner;
	protected readonly _env: NodeJS.ProcessEnv;

	constructor(run: DshCommandRunner, env: NodeJS.ProcessEnv) {
		this._run = run;
		this._env = env;
	}

	requiresElevation(): boolean { return false; }

	async available(): Promise<boolean> {
		return true;
	}

	abstract install(spec: DshComponentSpec, specProvider: DshProviderSpec, signal: AbortSignal): Promise<void>;

	protected async _exec(file: string, args: readonly string[], env: NodeJS.ProcessEnv = this._env): Promise<IDshCommandResult> {
		const result = await this._run(file, args, { timeout: INSTALL_TIMEOUT_MS, windowsHide: true, env });
		if (result.code !== 0) {
			const detail = (result.stderr || result.stdout).trim().slice(0, 800);
			throw new Error(`${file} exited ${result.code}${detail ? `: ${detail}` : ''}`);
		}
		return result;
	}

	protected async _commandExists(file: string): Promise<boolean> {
		try {
			const result = await this._run(file, ['--version'], { timeout: 10_000, windowsHide: true, env: this._env });
			return result.code === 0;
		} catch {
			return false;
		}
	}
}

class WingetProvider extends CommandProvider {
	readonly id = 'winget';
	readonly label = 'Windows Package Manager (winget)';
	private readonly _exe: string;

	constructor(run: DshCommandRunner, env: NodeJS.ProcessEnv) {
		super(run, env);
		this._exe = resolveExecutable('winget', env, 'win32');
	}

	override async available(): Promise<boolean> {
		return this._commandExists(this._exe);
	}

	async install(_spec: DshComponentSpec, specProvider: DshProviderSpec, _signal: AbortSignal): Promise<void> {
		if (specProvider.type !== 'winget') { return; }
		for (const packageId of specProvider.packages) {
			const args = [
				'install', '--id', packageId, '-e',
				'--scope', specProvider.scope ?? 'user',
				'--accept-source-agreements', '--accept-package-agreements',
				'--disable-interactivity',
			];
			await this._exec(this._exe, args);
		}
	}
}

class BrewProvider extends CommandProvider {
	readonly id = 'brew';
	readonly label = 'Homebrew';
	private readonly _exe: string;

	constructor(run: DshCommandRunner, env: NodeJS.ProcessEnv) {
		super(run, env);
		this._exe = resolveExecutable('brew', env, 'darwin');
	}

	override async available(): Promise<boolean> {
		return this._commandExists(this._exe);
	}

	async install(_spec: DshComponentSpec, specProvider: DshProviderSpec, _signal: AbortSignal): Promise<void> {
		if (specProvider.type !== 'brew') { return; }
		for (const formula of specProvider.formulas) {
			await this._exec(this._exe, ['install', '--formula', formula]);
		}
	}
}

class LinuxPackageProvider extends CommandProvider {
	readonly id: string;
	readonly label: string;
	private readonly _manager: 'apt' | 'dnf' | 'pacman';
	private readonly _command: string;

	constructor(manager: 'apt' | 'dnf' | 'pacman', run: DshCommandRunner, env: NodeJS.ProcessEnv) {
		super(run, env);
		this._manager = manager;
		this._command = resolveExecutable(manager === 'apt' ? 'apt-get' : manager, env, 'linux');
		this.id = manager;
		this.label = manager === 'apt' ? 'APT' : manager === 'dnf' ? 'DNF' : 'Pacman';
	}

	override requiresElevation(): boolean { return true; }

	override async available(): Promise<boolean> {
		return this._commandExists(this._command);
	}

	async install(_spec: DshComponentSpec, specProvider: DshProviderSpec, _signal: AbortSignal): Promise<void> {
		if ((specProvider.type !== 'apt' && specProvider.type !== 'dnf' && specProvider.type !== 'pacman') || specProvider.type !== this._manager) {
			return;
		}
		// 不直接调 sudo：由 UI 明确确认后，通过 pkexec 弹出系统授权。
		const args = this._manager === 'apt'
			? ['env', 'DEBIAN_FRONTEND=noninteractive', this._command, 'install', '-y', ...specProvider.packages]
			: this._manager === 'dnf'
				? [this._command, 'install', '-y', ...specProvider.packages]
				: [this._command, '-S', '--noconfirm', ...specProvider.packages];
		await this._exec(resolveExecutable('pkexec', this._env, 'linux'), args);
	}
}

export class DshComponentProviderRegistry {
	private readonly _providers: readonly IDshComponentProvider[];

	constructor(options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; run?: DshCommandRunner } = {}) {
		const env = options.env ?? process.env;
		const run = options.run ?? defaultRunner();
		const platform = options.platform ?? process.platform;
		const os: DshOs | undefined = platform === 'win32' || platform === 'darwin' || platform === 'linux' ? platform : undefined;
		this._providers = os === 'win32'
			? [new WingetProvider(run, env)]
			: os === 'darwin'
				? [new BrewProvider(run, env)]
				: os === 'linux'
					? [
						new LinuxPackageProvider('apt', run, env),
						new LinuxPackageProvider('dnf', run, env),
						new LinuxPackageProvider('pacman', run, env),
					]
					: [];
	}

	list(): readonly IDshComponentProvider[] {
		return this._providers;
	}

	find(id: string): IDshComponentProvider | undefined {
		return this._providers.find(provider => provider.id === id);
	}
}
