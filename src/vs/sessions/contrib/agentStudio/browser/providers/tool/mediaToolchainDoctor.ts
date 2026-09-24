/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 媒体工具链**自检**（ffmpeg / ffprobe / yt-dlp）—— 2026-09-24。
 *
 * ## 解决什么
 *
 * 用户视角的真实困惑：「我明明没装 ffmpeg，工具却说随包自带 —— 到底装上没有？装在哪？
 * 为什么 `where ffmpeg` 找不到？」（这是 2026-09-24 用户实际提出的问题）。
 * 本模块把「解析到哪 + 能不能跑 + 版本」一次性摊开成**一份人可读报告**，
 * 挂在命令面板上（`agentStudio.mediaToolchain.check`）⇒ 从"猜"变成"自查"。
 *
 * ## 为什么与工具里的探测同源
 *
 * 复用 `probeMediaBinaryDetailed`（同一个命令拼装、同一份探活缓存），**只在显示层加东西**：
 * 若自检自己 spawn 一遍，就会出现「自检说 OK、工具说缺失」这类无法解释的不一致
 * （缓存键、引号规则、超时三处都得对齐才不出错 —— 干脆不复制）。
 *
 * ## 报告里的三类信息（都是用户真正需要的）
 *
 * · **解析结果**：内置（`<install>/resources/saros/bin`）/ dev 仓库 / 环境变量覆盖 / PATH；
 * · **可执行性**：真实跑一次 `-version`（不是"文件存在"就算数）；
 * · **修复路径**：缺失时给出**按本机情况**可执行的下一步（源码运行 ⇒ fetch 脚本；
 *   想自装 ⇒ 包管理器命令；已装但找不到 ⇒ 设 `*_PATH`）。
 */

import {
	resolveToolchain, probeMediaBinaryDetailed, type IMediaProbeContext, type ProbeStatus,
} from './videoMediaPipeline.js';
import type { IResolvedMediaBinary, MediaBinaryName } from '../../knowledge/mediaBinaries.js';

/** 单个二进制的自检结果。 */
export interface IMediaBinaryStatus {
	readonly name: MediaBinaryName;
	/** 解析出的可执行名（命中内置/覆盖时为绝对路径）。 */
	readonly command: string;
	readonly source: IResolvedMediaBinary['source'];
	readonly path?: string;
	/** 真实执行 `-version` 的结论。 */
	readonly verdict: ProbeStatus;
	/** 版本首行（`verdict === 'ok'` 时通常有值）。 */
	readonly version?: string;
}

/** `-version` 输出取首行、截断（报告要短；ffmpeg 的 banner 很长）。 */
export function firstLineOf(stdout: string | undefined, maxLen = 120): string | undefined {
	const line = String(stdout ?? '').split(/\r?\n/).map(s => s.trim()).find(Boolean);
	if (!line) { return undefined; }
	return line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line;
}

/**
 * 采集三者状态。
 *
 * ⚠ 默认 **force=true**（绕开探活缓存）：自检的意义就是"现在到底行不行"，
 *   命中 5 分钟前的缓存会给用户"我明明刚装好却还说没装"的错觉。
 */
export async function collectMediaToolchainStatus(
	ctx: IMediaProbeContext, opts: { force?: boolean } = {},
): Promise<IMediaBinaryStatus[]> {
	const bins = await resolveToolchain(ctx);
	const force = opts.force !== false;
	const specs: ReadonlyArray<{ bin: IResolvedMediaBinary; flag: string }> = [
		{ bin: bins.ffmpeg, flag: '-version' },
		{ bin: bins.ffprobe, flag: '-version' },
		{ bin: bins.ytdlp, flag: '--version' },
	];
	return Promise.all(specs.map(async ({ bin, flag }) => {
		const detail = await probeMediaBinaryDetailed(ctx, bin, flag, { force });
		return {
			name: bin.name,
			command: bin.command,
			source: bin.source,
			path: bin.path,
			verdict: detail.status,
			version: firstLineOf(detail.stdout),
		};
	}));
}

/** 按平台给出"自装"命令（缺失时的兜底建议）。 */
function installHintFor(name: MediaBinaryName, platform: string): string {
	if (platform === 'win32') {
		return name === 'yt-dlp'
			? 'winget install yt-dlp.yt-dlp'
			: 'winget install --id Gyan.FFmpeg';
	}
	if (platform === 'darwin') { return name === 'yt-dlp' ? 'brew install yt-dlp' : 'brew install ffmpeg'; }
	return name === 'yt-dlp' ? 'pipx install yt-dlp' : 'apt install ffmpeg';
}

/**
 * 解析来源 → 一行「在哪」（与状态图标一起读成一句话）。
 *
 * ⚠ 不要额外再拼一个来源标签：曾出现 `内置：内置 G:\…` 这种重复
 *   （来源与路径本来就是同一件事的两个侧面）。
 */
function whereLabel(status: IMediaBinaryStatus): string {
	switch (status.source) {
		case 'bundled': return `内置 ${status.path ?? status.command}`;
		case 'override': return `覆盖 ${status.path ?? status.command}`;
		default: return 'PATH（按命令名解析）';
	}
}

/**
 * 纯函数：把状态渲染成报告文本（可直接给通知/输出面板/日志）。
 *
 * 结构：首行结论 → 每个二进制一行（图标 + 名称 + 来源 + 版本）→ 修复建议（仅缺失时）。
 */
export function formatMediaToolchainReport(
	statuses: readonly IMediaBinaryStatus[], opts: { platform?: string } = {},
): string {
	const platform = opts.platform ?? 'win32';
	const missing = statuses.filter(s => s.verdict !== 'ok');
	const noChannel = statuses.some(s => s.verdict === 'no-channel');
	const lines: string[] = [];

	if (noChannel) {
		lines.push('媒体工具链自检：**当前环境没有命令执行通道**（非桌面版），无法探测。');
	} else if (missing.length === 0) {
		lines.push('媒体工具链自检：全部就绪 ✅');
	} else {
		lines.push(`媒体工具链自检：${missing.length} 项缺失 ❌（抽帧 / 视频理解会降级）`);
	}
	lines.push('');

	for (const s of statuses) {
		const icon = s.verdict === 'ok' ? '✅' : s.verdict === 'no-channel' ? '❔' : '❌';
		const detail = s.verdict === 'ok'
			? (s.version ? `  ${s.version}` : '')
			: s.verdict === 'no-channel' ? '  无法探测' : '  未找到';
		lines.push(`${icon} ${s.name.padEnd(8)} ${whereLabel(s)}${detail}`);
	}

	// 修复建议：只对真正缺失的项给（✅ 的项给建议是噪音）
	const broken = statuses.filter(s => s.verdict === 'missing');
	if (broken.length) {
		lines.push('');
		lines.push('修复（正常安装的 VsSaros 自带这些二进制，不需要手动装）：');
		lines.push('  1. 从源码运行 ⇒ 执行 `node build/saros/fetch-ffmpeg.mjs`（一次取齐 ffmpeg/ffprobe/yt-dlp）');
		for (const s of broken) {
			lines.push(`  2. 自装 ${s.name} ⇒ \`${installHintFor(s.name, platform)}\``);
			lines.push(`  3. 已装但找不到 ⇒ 设环境变量 \`${s.name === 'yt-dlp' ? 'YTDLP_PATH' : `${s.name.toUpperCase()}_PATH`}\` 指向可执行文件`);
		}
	}
	if (noChannel) {
		lines.push('');
		lines.push('（若你确实在用桌面版：说明主进程命令通道未就绪，请重启应用后重试。）');
	}
	return lines.join('\n');
}

/** 单行摘要（给日志用，避免把整份报告塞进日志）。 */
export function summarizeMediaToolchain(statuses: readonly IMediaBinaryStatus[]): string {
	return statuses.map(s => `${s.name}=${s.source}${s.path ? `(${s.path})` : ''}:${s.verdict}`).join(' · ');
}
