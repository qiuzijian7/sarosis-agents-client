/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 媒体工具链**探活结果缓存**（ffmpeg / ffprobe / yt-dlp）—— 2026-09-24。
 *
 * ## 为什么需要
 *
 * 每次调用 `extract_video_frames` / `video_analyze`，管线都会先做一次依赖探测：
 * `<exe> -version`。而这两个 exe 都不小 —— **ffmpeg.exe 156MB**、**yt-dlp.exe 17MB
 * （PyInstaller 单文件，启动要解包 Python 运行时）**。实测 `yt-dlp --version` 在 Windows
 * 上常在 **0.3–0.8s** 量级，ffmpeg 也要数百毫秒，**纯粹为了回答一个不会变的静态事实**。
 * 一次抽帧任务里可能多次调用这两个工具（先抽帧、再逐帧追问），代价被乘起来。
 *
 * 上游 Hermes-Agent 对同类探测有明确的缓存纪律（`tools/env_probe.py` 进程级缓存 +
 * 超时 fail-open；`browser_tool.py` 的 `_cached_agent_browser`、cua 的指纹缓存），
 * 本模块是那套纪律在我们这边的等价物：**结果按进程缓存 + TTL + 明确的失效出口**。
 *
 * ## 三条纪律（与上游一致的部分）
 *
 * 1. **只缓存确定结论**（`ok` / `missing`）。`no-channel`（非桌面版没有命令通道）**不缓存** ——
 *    它描述的是「本次环境能不能执行命令」，与二进制在不在是两回事，缓存它会让后续
 *    「通道恢复了」的场景继续拿到过期结论（fail-open 优先于省一次探测）。
 * 2. **TTL 到期自动重新探测**（默认 5 分钟）：用户按提示装好 ffmpeg 后，不必重启应用，
 *    最多等一个 TTL 就能自愈（对比「永久缓存」会让用户以为装错了）。
 * 3. **可强制刷新**（`force`）：诊断/自检入口（见 `mediaToolchainStatus.ts` 与
 *    「检查媒体工具链」命令）必须能绕开缓存，否则用户刚装完却still看到旧结论。
 *
 * ⚠ 缓存键 = `命令 + 参数`（小写归一）。同一台机器上 `ffmpeg`（裸名 → PATH）与
 *   `D:\tools\ffmpeg.exe`（绝对路径）是**两个不同的键** —— 这正是我们要的：环境变量
 *   覆盖指向新路径后，结论不会与旧路径混淆。
 */

/** 探活结论（不缓存 `no-channel`，见文件头）。 */
export type ProbeVerdict = 'ok' | 'missing';

/** `ok` 结论的缓存有效期：5 分钟（二进制不会自己消失，长缓存省重复 spawn）。 */
export const PROBE_CACHE_TTL_MS = 5 * 60_000;

/**
 * `missing` 结论的缓存有效期：**30 秒**（与 ok 刻意不对称 —— 2026-09-25 生产事故）。
 *
 * 不对称的理由：两种结论的可信度不同。
 *   · `ok` 是二进制**真的跑起来了** ⇒ 可信，值得长缓存；
 *   · `missing` 可能只是**执行抖动**（启动高峰期 spawn 慢/杀软占用/IPC 繁忙）——
 *     实测（日志 20260925T022608）：应用重启后 40 秒的一次抖动被判 missing，
 *     按旧 5 分钟 TTL 缓存 ⇒ 该会话内 ffmpeg 全程"不可用"（二进制其实完好）。
 *   过期成本对比：cached-ok 过期 = 多 spawn 一次；cached-missing 过期 = 工具拒绝服务
 *   并给出错误指引。前者是性能问题，后者是正确性问题 ⇒ missing 必须短命。
 *   真没装时的代价：每次工具调用多一次失败的 spawn（<1s），换来 30s 内自愈。
 */
export const PROBE_CACHE_TTL_MISSING_MS = 30_000;

interface ICacheEntry {
	readonly verdict: ProbeVerdict;
	/** 写入时刻（ms epoch）。 */
	readonly at: number;
}

/** 进程级缓存（模块单例）。 */
const cache = new Map<string, ICacheEntry>();

/**
 * 缓存键：`<命令小写>|<参数小写>`。
 *
 * 归一化到小写的原因：Windows 路径与命令名大小写不敏感，`FFMPEG.EXE` 与 `ffmpeg.exe`
 * 必须命中同一条；不同平台（Linux 大小写敏感）在这里**不会**误命中，因为命令名的
 * 大小写差异在实践中不存在（同一个解析结果会在同一进程内反复出现）。
 */
export function probeCacheKey(command: string, flag: string): string {
	return `${String(command ?? '').trim().toLowerCase()}|${String(flag ?? '').trim().toLowerCase()}`;
}

/**
 * 读缓存：命中且未过期 ⇒ 返回结论；否则 undefined（**不抛**）。
 * `ttlMs` 缺省时**按结论分档**（ok=5min / missing=30s，理由见 PROBE_CACHE_TTL_MISSING_MS）。
 */
export function readProbeCache(key: string, now: number, ttlMs?: number): ProbeVerdict | undefined {
	const hit = cache.get(key);
	if (!hit) { return undefined; }
	const ttl = ttlMs ?? (hit.verdict === 'ok' ? PROBE_CACHE_TTL_MS : PROBE_CACHE_TTL_MISSING_MS);
	if (!Number.isFinite(now) || now - hit.at >= ttl || now < hit.at) {
		// 过期（或时钟回拨 ⇒ 视为失效，避免"永远新鲜"的幽灵条目）
		cache.delete(key);
		return undefined;
	}
	return hit.verdict;
}

/** 写缓存（只接受确定结论）。 */
export function writeProbeCache(key: string, verdict: ProbeVerdict, now: number): void {
	cache.set(key, { verdict, at: now });
}

/** 清空缓存（单测隔离用；也是「重新检测」的实现基础：force 更精确，见 `probeMediaBinary`）。 */
export function clearProbeCache(): void {
	cache.clear();
}

/** 当前缓存条目数（诊断/单测用）。 */
export function probeCacheSize(): number {
	return cache.size;
}
