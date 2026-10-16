// @vssaros/dsh-web-content-import — core（纯逻辑）：yt-dlp 命令拼装与输出解析。
//
// ⚠ 命令口径与 IDE 侧 `browser/knowledge/kbVideoFetch.ts` **逐字对齐**：
//   · `--print` 而非 `--dump-json`（dump-json 含 formats 数组可达数百 KB ⇒ 单次缓冲的命令通道会截断）；
//   · 字段顺序 = `record.js` 的 `YTDLP_PRINT_FIELDS`，分隔符 `|||`（TAB 经 shell 易被吃掉）；
//   · 字幕是**文件**、不走 stdout（大字幕会被截断）⇒ `-o` 落盘后由调用方读回；
//   · 「该视频没有字幕」时 yt-dlp 可能以非 0 退出 ⇒ 以「目录里是否真有字幕文件」判定成功（调用方的事）。
//
// ⚠ 本文件用 **spawn 数组传参**（不走 shell）⇒ URL 不需要 `sanitizeForShell` 那套净化 ✓
//   （那是真源走 shell 字符串拼接时的护栏；数组传参不经 shell，参数逐字到达 ✓）。

import { YTDLP_PRINT_FIELDS, YTDLP_SEP } from './record.js';

/** 元信息命令（一行输出；真源超时 45s）。 */
export function ytDlpMetaArgs(url) {
	const tpl = YTDLP_PRINT_FIELDS.map(f => `%(${f})s`).join(YTDLP_SEP);
	return ['--no-playlist', '--no-warnings', '--skip-download', '--print', tpl, url];
}

/** 字幕命令（落盘，不下载本体；真源超时 60s）。 */
export function ytDlpSubtitleArgs(url, outTpl) {
	return ['--no-playlist', '--no-warnings', '--skip-download', '--write-subs', '--write-auto-subs',
		'--sub-langs', 'zh.*,en.*', '--sub-format', 'vtt/srt/best', '-o', outTpl, url];
}

/**
 * 音频下载命令（ASR 前置：只要音轨）。
 * ⚠ 格式选择器：`ba/b`（bestaudio，否则 best）—— **不要**用 `-f b`（只认 combined 单文件音画），
 *   B站/YouTube 只给**音画分离的 DASH 流** ⇒ 那会报 "Requested format is not available"
 *   （2026-09-25 真源侧修过同一坑：下载本体用 `bv*+ba/b` 合并优先 ✓）。
 */
export function ytDlpAudioArgs(url, outTpl) {
	return ['--no-playlist', '--no-warnings', '-f', 'ba/b', '-o', outTpl, url];
}
