/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 组件路径发现。只找现有文件，不下载、不安装、不修改系统。
 *
 * 路径来自：
 * - 应用配置的多个候选根；
 * - PATH；
 * - WinGet / Homebrew / 发行版包管理器的默认安装位置。
 *
 * 找到后执行组件自己的 `-version` / `--version`，版本只用于展示。
 */
import { execFile } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, delimiter, dirname, join } from '../../../../base/common/path.js';
import { DshBinarySpec, DshComponentSpec, DshOs, DshPathRoot, DshComponentSource } from './dshComponentCatalog.js';

export interface ILocatedComponent {
	readonly id: string;
	readonly binaries: Readonly<Record<string, string>>;
	readonly source: DshComponentSource;
	readonly version?: string;
	readonly path: string;
}

export interface IDshComponentLocatorOptions {
	readonly userDataPath: string;
	readonly platform?: NodeJS.Platform;
	readonly env?: NodeJS.ProcessEnv;
	readonly home?: string;
	readonly execFile?: (file: string, args: readonly string[], options: { timeout: number; windowsHide: boolean; env: NodeJS.ProcessEnv }) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface IDshPathRootLike {
	readonly path: string;
	readonly source?: DshComponentSource;
	readonly deep?: boolean;
}

export interface IDshLocatorFindOptions {
	/** 安装成功后强制重新扫描，忽略短缓存。 */
	readonly fresh?: boolean;
}

const PROBE_TIMEOUT_MS = 5000;
const DEEP_SEARCH_DEPTH = 5;

function normalizeOs(platform: NodeJS.Platform): DshOs | undefined {
	return platform === 'win32' || platform === 'darwin' || platform === 'linux' ? platform : undefined;
}

function expand(value: string, ctx: { env: NodeJS.ProcessEnv; home: string; userDataPath: string }): string {
	return value.replace(/\$\{([^}]+)\}/g, (_match, raw: string) => {
		const key = String(raw).trim();
		if (key.startsWith('env:')) {
			return ctx.env[key.slice(4)] ?? '';
		}
		switch (key) {
			case 'home': return ctx.home;
			case 'userData': return ctx.userDataPath;
			case 'localAppData': return ctx.env.LOCALAPPDATA ?? join(ctx.home, 'AppData', 'Local');
			case 'ProgramFiles': return ctx.env.ProgramFiles ?? 'C:\\Program Files';
			case 'xdgData': return ctx.env.XDG_DATA_HOME ?? join(ctx.home, '.local', 'share');
			default: return '';
		}
	});
}

function pathRootsFromPath(env: NodeJS.ProcessEnv): DshPathRoot[] {
	return String(env.PATH ?? '')
		.split(delimiter)
		.map(path => path.trim())
		.filter(Boolean)
		.map(path => ({ path, source: 'path' as const }));
}

function isFile(path: string): boolean {
	try { return statSync(path).isFile(); } catch { return false; }
}

function isDirectory(path: string): boolean {
	try { return statSync(path).isDirectory(); } catch { return false; }
}

function findDeep(root: string, fileName: string, depth: number): string | undefined {
	if (depth < 0) { return undefined; }
	let entries;
	try { entries = readdirSync(root, { withFileTypes: true }); } catch { return undefined; }
	for (const entry of entries) {
		const child = join(root, entry.name);
		if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) { return child; }
		if (entry.isDirectory()) {
			const found = findDeep(child, fileName, depth - 1);
			if (found) { return found; }
		}
	}
	return undefined;
}

function extractVersion(output: string): string | undefined {
	const text = output.trim();
	if (!text) { return undefined; }
	const line = text.split(/\r?\n/, 1)[0].trim();
	const match = /\d+(?:\.\d+){1,3}/.exec(line);
	return match?.[0] ?? line.slice(0, 120);
}

export class DshComponentLocator {
	private readonly _ctx: { env: NodeJS.ProcessEnv; home: string; userDataPath: string };
	private readonly _platform: NodeJS.Platform;
	private readonly _run: NonNullable<IDshComponentLocatorOptions['execFile']>;
	private readonly _cache = new Map<string, { at: number; value: ILocatedComponent | undefined }>();

	constructor(options: IDshComponentLocatorOptions) {
		this._ctx = {
			env: options.env ?? process.env,
			home: options.home ?? homedir(),
			userDataPath: options.userDataPath,
		};
		this._platform = options.platform ?? process.platform;
		this._run = options.execFile ?? ((file, args, opts) => new Promise((resolve, reject) => {
			execFile(file, [...args], { timeout: opts.timeout, windowsHide: opts.windowsHide, env: opts.env }, (error, stdout, stderr) => {
				if (error && typeof (error as NodeJS.ErrnoException).code === 'string') {
					reject(error);
					return;
				}
				resolve({ code: typeof (error as { code?: unknown })?.code === 'number' ? (error as { code: number }).code : 0, stdout: String(stdout), stderr: String(stderr) });
			});
		}));
	}

	async find(spec: DshComponentSpec, extraRoots: readonly IDshPathRootLike[] = [], options: IDshLocatorFindOptions = {}): Promise<ILocatedComponent | undefined> {
		const cacheKey = `${spec.id}:${extraRoots.map(root => root.path).join('|')}`;
		const cached = this._cache.get(cacheKey);
		if (!options.fresh && cached && Date.now() - cached.at < 5000) { return cached.value; }
		const os = normalizeOs(this._platform);
		if (!os) { return undefined; }
		const roots: DshPathRoot[] = [
			...extraRoots.map(root => ({ path: root.path, source: root.source ?? 'user', deep: root.deep })),
			...spec.pathRoots[os],
			...pathRootsFromPath(this._ctx.env),
		];
		const binaries: Record<string, string> = {};
		let source: DshComponentSource = 'path';
		let version: string | undefined;

		for (const binary of spec.binaries[os]) {
			const found = await this._findBinary(binary, roots);
			if (!found) { return undefined; }
			binaries[binary.file] = found.path;
			if (!version && found.version) { version = found.version; }
			if (source === 'path' && found.source !== 'path') { source = found.source; }
		}

		const first = Object.values(binaries)[0];
		if (!first) {
			this._cache.set(cacheKey, { at: Date.now(), value: undefined });
			return undefined;
		}
		const located = { id: spec.id, binaries, source, ...(version ? { version } : {}), path: first };
		this._cache.set(cacheKey, { at: Date.now(), value: located });
		return located;
	}

	private async _findBinary(binary: DshBinarySpec, roots: readonly DshPathRoot[]): Promise<{ path: string; source: DshComponentSource; version?: string } | undefined> {
		const seen = new Set<string>();
		for (const root of roots) {
			const expanded = expand(root.path, this._ctx).trim();
			if (!expanded) { continue; }
			for (const candidate of this._candidatesForRoot(expanded, binary.file, root.deep)) {
				const key = this._platform === 'win32' ? candidate.toLowerCase() : candidate;
				if (seen.has(key) || !existsSync(candidate) || !isFile(candidate)) { continue; }
				seen.add(key);
				const probe = await this._probe(candidate, binary.probeArgs);
				if (probe !== undefined) {
					return { path: candidate, source: root.source, version: probe };
				}
			}
		}
		return undefined;
	}

	private _candidatesForRoot(root: string, file: string, deep?: boolean): string[] {
		if (isFile(root)) {
			const name = basename(root);
			if (name.toLowerCase() === file.toLowerCase()) { return [root]; }
			// FFMPEG_PATH 指向 ffmpeg.exe 时，推导同目录 ffprobe。
			if (file.toLowerCase().startsWith('ffprobe') && name.toLowerCase().startsWith('ffmpeg')) {
				const sibling = join(dirname(root), file);
				return existsSync(sibling) ? [sibling] : [];
			}
			return [];
		}
		if (!isDirectory(root)) { return []; }
		const direct = join(root, file);
		if (existsSync(direct)) { return [direct]; }
		if (!deep) { return []; }
		const found = findDeep(root, file, DEEP_SEARCH_DEPTH);
		return found ? [found] : [];
	}

	private async _probe(file: string, args: readonly string[]): Promise<string | undefined> {
		try {
			const result = await this._run(file, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true, env: this._ctx.env });
			if (result.code !== 0) { return undefined; }
			return extractVersion(`${result.stdout}\n${result.stderr}`);
		} catch {
			return undefined;
		}
	}
}
