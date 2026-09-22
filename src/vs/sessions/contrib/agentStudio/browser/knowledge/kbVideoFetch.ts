/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 视频元信息抓取 —— **yt-dlp 扩展点**（2026-09-22）。
 *
 * 背景：`kbUrlScraper.ts` 头注释早就写明「真正抓取需接 yt-dlp / headless 扩展点」，本模块补上 yt-dlp 这一半。
 *
 * 设计取舍：
 *  1. **只抓元信息 + 封面，不下载视频本体**：视频动辄几十 MB～GB，落进知识库会拖慢索引与飞书同步
 *     （飞书同步也不处理视频）。需要本体时由用户自行 `yt-dlp <url>`，或在后续版本里接 terminal 长任务。
 *  2. **用 `--print` 而非 `--dump-json`**：主进程命令通道（`vscode:execCode`）是**单次缓冲**，
 *     而 dump-json 含 formats 数组可达数百 KB ⇒ 用 `--print` 模板只输出一行 TSV（字段顺序见
 *     `YTDLP_PRINT_FIELDS`），既省流量也避免输出被截断。
 *  3. 与 lark-cli 检测同一套原语（`execShortCommand`）⇒ 未安装/未登录等失败都只是「降级」，不抛异常。
 */

import type { IKbMetaTags } from '../views/knowledgeBase/kbUrlScraper.js';
import { YTDLP_PRINT_FIELDS, YTDLP_SEP, parseYtDlpPrint } from '../views/knowledgeBase/kbUrlScraper.js';
import { execShortCommand } from './feishuSyncCore.js';

/** yt-dlp 默认可执行名（从 PATH 查找；后续可像 lark-cli 一样做成配置项）。 */
export const DEFAULT_YTDLP = 'yt-dlp';

/** `--print` 模板：与 `YTDLP_PRINT_FIELDS` 顺序严格一致，用 `|||` 分隔（避免 shell 对 TAB 的处理差异）。 */
const PRINT_TEMPLATE = YTDLP_PRINT_FIELDS.map(f => `%(${f})s`).join(YTDLP_SEP);

/** 命令里拼接 URL 前的净化（走 shell ⇒ 去掉双引号与换行）。 */
function sanitizeForShell(s: string): string {
	return (s ?? '').replace(/["\r\n]/g, '').trim();
}

/** 探测 yt-dlp 是否可用（`--version`，短输出，8s 超时）。 */
export async function detectYtDlp(cliPath: string = DEFAULT_YTDLP): Promise<{ installed: boolean; version?: string }> {
	const exe = (cliPath ?? '').trim() || DEFAULT_YTDLP;
	const r = await execShortCommand(`${exe} --version`, 8000);
	if (!r || !r.ok) { return { installed: false }; }
	const v = (r.stdout || '').trim().split('\n')[0]?.trim();
	return { installed: true, version: v || undefined };
}

/**
 * 抓取视频**字幕**（`--write-subs --write-auto-subs`），供 agent 总结视频内容。
 *
 * ⚠ 字幕是**文件**、不能走 stdout（主进程命令通道单次缓冲，大字幕会被截断）⇒
 *    本函数只负责「跑命令并写到 `outDir`」，由调用方用 `IFileService` 读回后 `parseSubtitlesToText()` 清洗。
 * ⚠ yt-dlp 在「该视频没有字幕」时可能以非 0 退出 ⇒ 调用方应以「目录里是否真有字幕文件」判定成功，
 *    故这里把 ok=false 视为**降级信号**（reason 给日志）。
 */
export async function fetchVideoSubtitles(
	url: string,
	outDir: string,
	cliPath: string = DEFAULT_YTDLP,
): Promise<{ ok: boolean; outDir: string; reason?: string }> {
	const exe = (cliPath ?? '').trim() || DEFAULT_YTDLP;
	const target = sanitizeForShell(url);
	const dir = sanitizeForShell(outDir);
	if (!target || !dir) { return { ok: false, outDir: dir, reason: 'URL 或输出目录非法' }; }
	const r = await execShortCommand(
		`${exe} --no-playlist --no-warnings --skip-download --write-subs --write-auto-subs`
		+ ` --sub-langs "zh.*,en.*" --sub-format "vtt/srt/best" -o "${dir}/%(id)s.%(ext)s" "${target}"`, 60000);
	if (!r) { return { ok: false, outDir: dir, reason: '命令通道不可用（主进程桥缺失）' }; }
	if (!r.ok) {
		const detail = (r.stderr || r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean).slice(-2).join(' ');
		return { ok: false, outDir: dir, reason: detail.slice(0, 300) || 'yt-dlp 字幕抓取失败' };
	}
	return { ok: true, outDir: dir };
}

/**
 * 抓取视频元信息（标题 / 时长 / 封面 / 作者 / 发布日期 / 简介）。
 * @returns 成功 `{ ok: true, ...IKbMetaTags }`；失败 `{ ok: false, reason }`（调用方降级为「只记链接」）。
 */
export async function fetchVideoMeta(
	url: string,
	cliPath: string = DEFAULT_YTDLP,
): Promise<{ ok: true; meta: IKbMetaTags } | { ok: false; reason: string }> {
	const exe = (cliPath ?? '').trim() || DEFAULT_YTDLP;
	const target = sanitizeForShell(url);
	if (!target) { return { ok: false, reason: 'URL 为空或含非法字符' }; }
	const r = await execShortCommand(
		`${exe} --no-playlist --no-warnings --skip-download --print "${PRINT_TEMPLATE}" "${target}"`, 45000);
	if (!r) { return { ok: false, reason: '命令通道不可用（主进程桥缺失）' }; }
	if (!r.ok) {
		const detail = (r.stderr || r.stdout || 'yt-dlp 执行失败').split('\n').map(s => s.trim()).filter(Boolean).slice(-2).join(' ');
		return { ok: false, reason: detail.slice(0, 300) };
	}
	const line = (r.stdout || '').split('\n').find(l => l.trim().length > 0) ?? '';
	if (!line) { return { ok: false, reason: 'yt-dlp 无输出' }; }
	return { ok: true, meta: parseYtDlpPrint(line) };
}
