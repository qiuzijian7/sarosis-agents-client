/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 官方组件目录：只声明“找哪些文件、去哪里找、用什么官方渠道装”。
 *
 * 这里刻意不保存应用维护的版本号：
 * - winget / brew / apt / dnf / pacman 自己解析稳定版；
 * - 应用只记录运行时探测到的版本，用于 UI 展示；
 * - Office Python 运行时随安装包分发；
 * - Whisper 模型直接使用 HuggingFace 官方文件 + 固定 SHA256。
 */
export type DshOs = 'win32' | 'darwin' | 'linux';
export type DshComponentId = 'media' | 'office' | 'whisper';
export type DshComponentSource = 'user' | 'managed' | 'bundled' | 'winget' | 'brew' | 'apt' | 'dnf' | 'pacman' | 'huggingface' | 'path' | 'unknown';

export interface DshBinarySpec {
	/** 候选文件名（Windows 带 `.exe`）。 */
	readonly file: string;
	/** 健康检查参数，例如 `-version` / `--version`。 */
	readonly probeArgs: readonly string[];
}

export interface DshPathRoot {
	readonly path: string;
	readonly source: DshComponentSource;
	/** WinGet Packages 这类目录需要有限深度递归查找。 */
	readonly deep?: boolean;
}

export type DshProviderSpec =
	| { readonly type: 'winget'; readonly packages: readonly string[]; readonly scope?: 'user' | 'machine' }
	| { readonly type: 'brew'; readonly formulas: readonly string[] }
	| { readonly type: 'apt' | 'dnf' | 'pacman'; readonly packages: readonly string[]; readonly requiresElevation: true };

export interface DshComponentSpec {
	readonly id: DshComponentId;
	readonly label: string;
	readonly binaries: Readonly<Record<DshOs, readonly DshBinarySpec[]>>;
	readonly pathRoots: Readonly<Record<DshOs, readonly DshPathRoot[]>>;
	readonly providers: Readonly<Record<DshOs, readonly DshProviderSpec[]>>;
}

const FFMPEG: DshBinarySpec = { file: 'ffmpeg', probeArgs: ['-version'] };
const FFPROBE: DshBinarySpec = { file: 'ffprobe', probeArgs: ['-version'] };
const YTDLP: DshBinarySpec = { file: 'yt-dlp', probeArgs: ['--version'] };
const WIN_FFMPEG: DshBinarySpec = { file: 'ffmpeg.exe', probeArgs: ['-version'] };
const WIN_FFPROBE: DshBinarySpec = { file: 'ffprobe.exe', probeArgs: ['-version'] };
const WIN_YTDLP: DshBinarySpec = { file: 'yt-dlp.exe', probeArgs: ['--version'] };

/**
 * 媒体组件是唯一由官方包管理器负责的组件。
 * Office Python 和 Whisper 模型仍由 DshComponentManager 的 managed manifest 负责。
 */
/**
 * Whisper 模型不维护“版本”，只固定官方模型文件的内容身份：
 * HuggingFace 官方地址 + 官方镜像 + SHA256 + 精确大小。
 * 这样不再依赖 VsSaros 组件服务器。
 */
export const WHISPER_MODEL_ENTRY = Object.freeze({
	id: 'whisper',
	version: 'base',
	fileName: 'ggml-base.bin',
	url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
	urls: ['https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin'],
	sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
	size: 147951465,
	format: 'file' as const,
});

export const MEDIA_COMPONENT: DshComponentSpec = {
	id: 'media',
	label: '媒体工具（ffmpeg / ffprobe / yt-dlp）',
	binaries: {
		win32: [WIN_FFMPEG, WIN_FFPROBE, WIN_YTDLP],
		darwin: [FFMPEG, FFPROBE, YTDLP],
		linux: [FFMPEG, FFPROBE, YTDLP],
	},
	pathRoots: {
		win32: [
			{ path: '${env:FFMPEG_PATH}', source: 'user' },
			{ path: '${env:FFPROBE_PATH}', source: 'user' },
			{ path: '${env:YTDLP_PATH}', source: 'user' },
			{ path: '${userData}/components/media/current', source: 'managed' },
			{ path: '${localAppData}/Microsoft/WinGet/Links', source: 'winget' },
			{ path: '${localAppData}/Microsoft/WinGet/Packages', source: 'winget', deep: true },
			{ path: '${ProgramFiles}/ffmpeg/bin', source: 'path' },
			{ path: '${ProgramFiles}/ffmpeg', source: 'path' },
		],
		darwin: [
			{ path: '${env:FFMPEG_PATH}', source: 'user' },
			{ path: '${env:FFPROBE_PATH}', source: 'user' },
			{ path: '${env:YTDLP_PATH}', source: 'user' },
			{ path: '${userData}/components/media/current', source: 'managed' },
			{ path: '/opt/homebrew/bin', source: 'brew' },
			{ path: '/usr/local/bin', source: 'brew' },
			{ path: '/opt/local/bin', source: 'path' },
			{ path: '${home}/.local/bin', source: 'path' },
		],
		linux: [
			{ path: '${env:FFMPEG_PATH}', source: 'user' },
			{ path: '${env:FFPROBE_PATH}', source: 'user' },
			{ path: '${env:YTDLP_PATH}', source: 'user' },
			{ path: '${userData}/components/media/current', source: 'managed' },
			{ path: '/usr/bin', source: 'path' },
			{ path: '/usr/local/bin', source: 'path' },
			{ path: '/snap/bin', source: 'path' },
			{ path: '${home}/.local/bin', source: 'path' },
		],
	},
	providers: {
		win32: [
			{ type: 'winget', packages: ['Gyan.FFmpeg', 'yt-dlp.yt-dlp'], scope: 'user' },
		],
		darwin: [
			{ type: 'brew', formulas: ['ffmpeg', 'yt-dlp'] },
		],
		linux: [
			{ type: 'apt', packages: ['ffmpeg', 'yt-dlp'], requiresElevation: true },
			{ type: 'dnf', packages: ['ffmpeg', 'yt-dlp'], requiresElevation: true },
			{ type: 'pacman', packages: ['ffmpeg', 'yt-dlp'], requiresElevation: true },
		],
	},
};


