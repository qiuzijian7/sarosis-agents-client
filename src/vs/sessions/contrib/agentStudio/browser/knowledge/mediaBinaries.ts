/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 媒体二进制解析（ffmpeg / ffprobe / yt-dlp）—— 2026-09-24。
 *
 * ## 为什么需要
 *
 * 抽帧（`extract_video_frames`）与视频理解（`video_analyze`）都靠这两个外部 exe，
 * 而此前它们**只用裸命令名**（`buildCommand('ffmpeg', …)`）⇒ 完全依赖用户 PATH。
 * 实测：绝大多数机器上 PATH 里没有 ffmpeg/yt-dlp（本机即如此），于是工具只能返回
 * 「请先安装 ffmpeg」的指引 —— 能力等于不存在。
 *
 * 产品侧其实早就有「随包携带 ffmpeg」的机制（`build/saros/fetch-ffmpeg.mjs` 下载 →
 * `strip-before-pack.mjs` 的 `ensureOptionalBin` 落到 `<install>/resources/saros/bin/`），
 * 但它此前只被 vox 口播视频用（`electron-main/voxLaunchChannel.ts` 的 `findBuiltinBin`）。
 * 本模块把那条**既有**解析链搬到工具层（渲染进程），让抽帧/视频理解零安装可用。
 *
 * ## 解析优先级（与 voxLaunchChannel 的语义对齐，避免两处口径漂移）
 *
 * ① 显式覆盖：环境变量 `FFMPEG_PATH` / `FFPROBE_PATH` / `YTDLP_PATH`
 *    （vox 还支持 settings 覆盖；工具侧走环境变量，避免为此新增配置项与 UI）；
 * ② 随包内置：`<resourcesPath>/saros/bin/<exe>`（安装包形态）；
 * ③ dev 仓库：从 appRoot 向上找 `build/saros/bin/<exe>`（dev 下 appRoot = `<repo>/out`）；
 * ④ 兜底：裸命令名 ⇒ 交给 PATH（保持旧行为，用户自己装了也能用）。
 *
 * ⚠ **不做**「存在性探测 = 可用性判定」：内置路径存在但不可执行（杀软拦截/半截下载）时，
 *   调用方的 `probeBinary` 会真实执行一次 `<exe> -version` 并以退出码判定 ⇒ 由那里兜住。
 *   本模块只负责「**指到哪里**」，可用性判定留给调用方（单一判据，不重复）。
 *
 * ## 平台
 *
 * 内置二进制目前只随 **Windows** 包提供（`fetch-ffmpeg.mjs` 取的是 win64 构建）。
 * 非 win32 平台候选为空 ⇒ 自动落到 ①/④（PATH），行为与改动前一致。
 */

import * as path from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import type { ILogService } from '../../../../../platform/log/common/log.js';

export type MediaBinaryName = 'ffmpeg' | 'ffprobe' | 'yt-dlp' | 'whisper-cli';

/** 三个二进制的解析结果来源。`override` = 环境变量，`bundled` = 随包/仓库内置，`path` = 交给 PATH。 */
export type MediaBinarySource = 'override' | 'bundled' | 'path';

export interface IResolvedMediaBinary {
	readonly name: MediaBinaryName;
	/**
	 * 可直接拼进命令串的可执行名：命中覆盖/内置时是**绝对路径**，否则是裸命令名。
	 * 调用方必须用 `buildCommand()` 拼（它会给每项加引号 —— 绝对路径含空格时必需）。
	 */
	readonly command: string;
	readonly source: MediaBinarySource;
	/** 命中的绝对路径（`source === 'path'` 时缺省）。 */
	readonly path?: string;
}

/** 环境变量名（一个二进制可能有多个别名，按顺序取第一个非空）。 */
const OVERRIDE_ENV_KEYS: Readonly<Record<MediaBinaryName, readonly string[]>> = {
	ffmpeg: ['FFMPEG_PATH'],
	ffprobe: ['FFPROBE_PATH'],
	'yt-dlp': ['YTDLP_PATH', 'YT_DLP_PATH'],
	// 2026-09-25：本地 ASR（whisper.cpp，随包于 build/saros/bin，由 fetch-whisper.mjs 获取）
	'whisper-cli': ['WHISPER_PATH'],
};

/** 内置二进制的相对目录（打包后位于 `<resourcesPath>/saros/bin/`）。 */
const BUNDLED_REL_DIR = ['saros', 'bin'];
/** dev 模式下仓库内的相对目录（`<repo>/build/saros/bin/`）。 */
const REPO_REL_DIR = ['build', 'saros', 'bin'];
/** whisper 模型的目录（与 bin 平级：`resources/saros/models/` 与 `build/saros/models/`）。 */
const BUNDLED_MODEL_REL_DIR = ['saros', 'models'];
const REPO_MODEL_REL_DIR = ['build', 'saros', 'models'];
/** 随包模型的文件名（与 fetch-whisper.mjs 的默认 --model 一致；换档位用 WHISPER_MODEL_PATH 覆盖）。 */
const WHISPER_MODEL_FILE = 'ggml-base.bin';

/** appRoot 向上回溯的最大层数（dev 下 appRoot=`<repo>/out`，1 层即到仓库根；留足余量）。 */
const MAX_UPWARD_LEVELS = 6;

export interface IMediaBinaryContext {
	readonly fileService: IFileService;
	/** `INativeEnvironmentService.appRoot`（dev = `<repo>/out`，打包 = `<install>/resources/app`）。 */
	readonly appRoot?: string;
	/** `process.resourcesPath`（打包 = `<install>/resources`）。 */
	readonly resourcesPath?: string;
	/** 环境变量表（默认 `process.env`）；注入以便单测。 */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** 平台（默认 `process.platform`）；注入以便单测。 */
	readonly platform?: string;
	readonly logService?: ILogService;
}

// ─── 纯函数（单测覆盖）──────────────────────────────────────────────────────

/** `yt-dlp` 在 win32 上带 `.exe`；其余平台不加后缀。 */
export function executableName(name: MediaBinaryName, platform: string): string {
	return platform === 'win32' ? `${name}.exe` : name;
}

/** 读显式覆盖（环境变量）；空串视为未设置。 */
export function mediaBinaryOverride(
	name: MediaBinaryName, env: Readonly<Record<string, string | undefined>> | undefined,
): string | undefined {
	if (!env) { return undefined; }
	for (const key of OVERRIDE_ENV_KEYS[name]) {
		const v = env[key]?.trim();
		if (v) { return v; }
	}
	return undefined;
}

/**
 * 随包/仓库内置的候选绝对路径（按可靠性排序，调用方取第一个存在的）。
 *
 * 候选：
 *  1. `<resourcesPath>/saros/bin/<exe>` —— 安装包（strip-before-pack 的落点）；
 *  2. `<appRoot>/../..{n}/build/saros/bin/<exe>` —— dev 仓库（向上逐层，n ≤ MAX_UPWARD_LEVELS）；
 *  3. `<resourcesPath>/app/build/saros/bin/<exe>` —— 少数布局下 appRoot 在 resources/app。
 */
export function bundledBinaryCandidates(
	name: MediaBinaryName, opts: { resourcesPath?: string; appRoot?: string; platform?: string },
): string[] {
	const platform = opts.platform ?? 'win32';
	return bundledFileCandidates(executableName(name, platform), BUNDLED_REL_DIR, REPO_REL_DIR, opts);
}

/**
 * 「随包文件」的候选绝对路径（二进制与 whisper 模型共用同一套定位规则：
 * 打包 = `<resourcesPath>/saros/<子目录>/`，dev = 从 appRoot 向上找 `build/saros/<子目录>/`）。
 */
function bundledFileCandidates(
	fileName: string, bundledRelDir: readonly string[], repoRelDir: readonly string[],
	opts: { resourcesPath?: string; appRoot?: string },
): string[] {
	const out: string[] = [];
	const push = (p: string): void => { if (!out.some(x => x.toLowerCase() === p.toLowerCase())) { out.push(p); } };

	if (opts.resourcesPath) {
		push(path.join(opts.resourcesPath, ...bundledRelDir, fileName));
		push(path.join(opts.resourcesPath, 'app', ...repoRelDir, fileName));
	}
	if (opts.appRoot) {
		let dir = opts.appRoot;
		for (let i = 0; i < MAX_UPWARD_LEVELS; i++) {
			push(path.join(dir, ...repoRelDir, fileName));
			const parent = path.dirname(dir);
			if (!parent || parent === dir) { break; }
			dir = parent;
		}
	}
	return out;
}

// ─── 解析 ────────────────────────────────────────────────────────────────────

/**
 * 该路径是否可直接作为命令使用（存在即可；可执行性由调用方的 probe 兜住）。
 *
 * ⚠ 优先 `stat`（能排除目录）；宿主只提供 `exists` 时退用它（单测的内存文件系统即如此，
 *   缺这一层退回会让解析静默失效 —— 候选判不出存在性就永远落不到内置路径）。
 */
async function pathUsable(fileService: IFileService, candidate: string): Promise<boolean> {
	const fs = fileService as Partial<IFileService> & { exists?: (r: URI) => Promise<boolean> };
	try {
		if (typeof fs.stat === 'function') {
			const stat = await fs.stat(URI.file(candidate));
			return !stat.isDirectory;
		}
		if (typeof fs.exists === 'function') {
			return await fs.exists(URI.file(candidate));
		}
	} catch {
		return false;
	}
	return false;
}

/**
 * 解析单个媒体二进制（见文件头优先级）。
 *
 * 任何一步失败都**不抛**：解析失败只会退化成「裸命令名交给 PATH」——
 * 与改动前的行为一致，不会因解析本身把工具打挂。
 */
export async function resolveMediaBinary(
	name: MediaBinaryName, ctx: IMediaBinaryContext,
): Promise<IResolvedMediaBinary> {
	const platform = ctx.platform ?? 'win32';
	// ⚠ 兜底必须用**不带后缀**的裸名：命令行 `ffmpeg` 在 Windows 上同样能命中 `ffmpeg.exe`
	//   （PATHEXT），而 `.exe` 后缀名在非 Windows 上是错的。这样也天然保持了改动前的行为
	//   （工具单测按 `"ffmpeg" "-version"` 断言命令串）。
	const bare: IResolvedMediaBinary = { name, command: name, source: 'path' };

	// ① 显式覆盖（环境变量）。允许「只是个命令名」的写法（如 FFMPEG_PATH=ffmpeg）。
	const override = mediaBinaryOverride(name, ctx.env);
	if (override) {
		if (!override.includes('/') && !override.includes('\\')) {
			return { name, command: override, source: 'override' };
		}
		if (await pathUsable(ctx.fileService, override)) {
			return { name, command: override, source: 'override', path: override };
		}
		ctx.logService?.warn(`[mediaBinaries] ${name}: ${OVERRIDE_ENV_KEYS[name][0]} 指向的路径不存在，已忽略：${override}`);
	}

	// ②③ 随包内置 / dev 仓库
	const candidates = bundledBinaryCandidates(name, {
		resourcesPath: ctx.resourcesPath,
		appRoot: ctx.appRoot,
		platform,
	});
	for (const candidate of candidates) {
		if (await pathUsable(ctx.fileService, candidate)) {
			return { name, command: candidate, source: 'bundled', path: candidate };
		}
	}

	// ④ 兜底 PATH（保持旧行为）
	return bare;
}

/** 批量解析（一次拿齐，供工具在探测/拼命令时复用，避免每步各解析一遍）。 */
export async function resolveMediaBinaries(
	names: readonly MediaBinaryName[], ctx: IMediaBinaryContext,
): Promise<Record<MediaBinaryName, IResolvedMediaBinary>> {
	const entries = await Promise.all(names.map(async n => [n, await resolveMediaBinary(n, ctx)] as const));
	return Object.fromEntries(entries) as Record<MediaBinaryName, IResolvedMediaBinary>;
}

/**
 * 运行时默认上下文（打包/dev 通用的 `resourcesPath` / `env` / `platform` 取值）。
 *
 * 渲染进程经 preload 暴露的 `globalThis.process` 读（与 `feishuSyncCore` 的
 * `syncScriptCandidates` 同一策略）；读不到时不传 ⇒ 候选集为空 ⇒ 退化为 PATH。
 */
export function defaultMediaBinaryRuntime(): Pick<IMediaBinaryContext, 'resourcesPath' | 'env' | 'platform'> {
	const proc = (globalThis as { process?: { resourcesPath?: string; env?: Record<string, string | undefined>; platform?: string } }).process;
	return {
		resourcesPath: proc?.resourcesPath,
		env: proc?.env,
		platform: proc?.platform,
	};
}

/** 诊断用：把解析结果渲染成 `ffmpeg=内置(...)` 这样的一行（工具回显与日志共用）。 */
export function describeResolvedBinary(b: IResolvedMediaBinary): string {
	const where = b.source === 'bundled' ? `内置 ${b.path}`
		: b.source === 'override' ? `覆盖 ${b.path ?? b.command}`
			: 'PATH';
	return `${b.name}=${where}`;
}

// ─── whisper 模型（数据文件，不是可执行文件 ⇒ 单独解析）─────────────────────

export interface IResolvedWhisperModel {
	readonly path: string;
	readonly source: MediaBinarySource;
}

/**
 * 解析 whisper 的 ggml 模型文件（2026-09-25，本地 ASR）。
 *
 * 与二进制的两点不同：
 *  ① 它在 `models/` 目录（与 `bin/` 平级），不在 bin 里；
 *  ② **没有 PATH 兜底** —— PATH 是找命令的，模型文件放 PATH 没有意义 ⇒ 找不到就是 undefined
 *     （调用方据此决定「ASR 不可用 ⇒ 退回仅帧分析」，best-effort 语义）。
 *
 * 换模型档位（tiny/small/...）用 `WHISPER_MODEL_PATH` 指向对应文件即可。
 */
export async function resolveWhisperModel(ctx: IMediaBinaryContext): Promise<IResolvedWhisperModel | undefined> {
	const override = ctx.env?.['WHISPER_MODEL_PATH']?.trim();
	if (override) {
		if (await pathUsable(ctx.fileService, override)) {
			return { path: override, source: 'override' };
		}
		ctx.logService?.warn(`[mediaBinaries] whisper 模型: WHISPER_MODEL_PATH 指向的路径不存在，已忽略：${override}`);
	}
	const candidates = bundledFileCandidates(WHISPER_MODEL_FILE, BUNDLED_MODEL_REL_DIR, REPO_MODEL_REL_DIR, ctx);
	for (const candidate of candidates) {
		if (await pathUsable(ctx.fileService, candidate)) {
			return { path: candidate, source: 'bundled' };
		}
	}
	return undefined;
}
