// @vssaros/dsh-web-content-import — core（纯逻辑）：本地 ASR（whisper.cpp）命令拼装与输出解析。
//
// ⚠ 逐形派生自 IDE 侧 `browser/providers/tool/videoMediaPipeline.ts`（2026-09-25）：
//   · ffmpeg 提音轨：whisper.cpp 的 WAV 读取器只认 **16kHz mono 16bit** ⇒ 必须显式转；
//   · whisper-cli 的 `-l auto` **必传**（默认**英文** ⇒ 中文口播不传会被按英文音素硬猜 ⇒ 一堆无意义英文）；
//   · 解析不出时间轴 ⇒ 判失败（whisper 对静音/噪声会**幻觉文本**，把幻觉当内容是最坏的结果 ✗）。

/** ffmpeg 提音轨参数（与真源逐字同形）。 */
export function buildFfmpegAudioArgs(videoPath, wavPath) {
	return ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath,
		'-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath];
}

/** whisper-cli 转写参数（`-l auto` 必传，见真源注释）。 */
export function buildWhisperArgs(modelPath, wavPath) {
	return ['-m', modelPath, '-f', wavPath, '-l', 'auto'];
}

/**
 * 解析 whisper-cli 的 stdout 为带时间锚点的文本。
 * whisper-cli 默认输出 `[00:01:23.450 --> 00:01:26.000]  文本` 的行；进度/日志走 stderr。
 * 这里只保留每段的**开始时间**并压成 `[mm:ss] 文本`（与帧标注 `[帧 mm:ss]` 同款格式）。
 * 一行都解析不出来 ⇒ `undefined`（调用方按失败处理 ✓）。
 */
export function parseWhisperStdout(raw) {
	const src = String(raw ?? '').replace(/\r/g, '');
	const lines = [];
	for (const line of src.split('\n')) {
		const m = line.match(/^\s*\[(\d+):(\d{2}):(\d{2})\.\d+\s*-->\s*[\d:.]+\s*\]\s*(.*)$/);
		if (!m) { continue; }
		const text = m[4].trim();
		if (!text) { continue; }
		const mm = String(Number(m[1]) * 60 + Number(m[2])).padStart(2, '0');
		lines.push(`[${mm}:${m[3]}] ${text}`);
	}
	const out = lines.join('\n').trim();
	return out || undefined;
}
