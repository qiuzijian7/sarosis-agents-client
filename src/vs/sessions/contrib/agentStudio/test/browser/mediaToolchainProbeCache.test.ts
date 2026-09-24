/*---------------------------------------------------------------------------------------------
 *  媒体二进制探活缓存 单元测试 —— 2026-09-24
 *
 *  背景：每次 `extract_video_frames` / `video_analyze` 调用都要先 spawn 一次
 *  `<exe> -version`（ffmpeg 156MB、yt-dlp 17MB PyInstaller）来回答"装没装"这个**静态**问题。
 *  上游 Hermes 对同类探测有进程级缓存纪律（tools/env_probe.py、browser_tool.py 的
 *  `_cached_agent_browser`），本模块是它在我们的等价物。
 *
 *  覆盖（都是"缓存出错会静默误导用户"的点）：
 *   ① 键归一化（大小写/空白）—— 否则同一条结论会因写法差异重复探测；
 *   ② TTL 到期必须失效 —— 否则用户装好二进制后永远看到旧结论；
 *   ③ 时钟回拨视为失效 —— 否则会出现"永远新鲜"的幽灵条目；
 *   ④ 清空接口（单测隔离与"重新检测"的基础）。
 *
 *  运行（仓库根目录）：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/mediaToolchainProbeCache.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';

import {
	probeCacheKey, readProbeCache, writeProbeCache, clearProbeCache, probeCacheSize, PROBE_CACHE_TTL_MS, PROBE_CACHE_TTL_MISSING_MS,
} from '../../browser/providers/tool/mediaToolchainProbeCache.js';

suite('媒体探活缓存 · 纯函数', () => {

	test('键归一化：大小写与首尾空白不影响命中（Windows 路径大小写不敏感）', () => {
		assert.strictEqual(
			probeCacheKey('D:\\Tools\\FFMPEG.EXE', '-VERSION'),
			probeCacheKey('d:/tools/ffmpeg.exe'.replace(/\//g, '\\'), '-version'),
		);
		assert.strictEqual(probeCacheKey('  ffmpeg  ', '  -version  '), 'ffmpeg|-version');
	});

	test('★ 写入后命中；TTL 到期后失效（用户装完二进制至多等一个 TTL 即自愈）', () => {
		clearProbeCache();
		const key = probeCacheKey('ffmpeg', '-version');
		writeProbeCache(key, 'ok', 1_000);

		assert.strictEqual(readProbeCache(key, 1_000), 'ok', '同一时刻应命中');
		assert.strictEqual(readProbeCache(key, 1_000 + PROBE_CACHE_TTL_MS - 1), 'ok', '未到期仍有效');
		assert.strictEqual(readProbeCache(key, 1_000 + PROBE_CACHE_TTL_MS), undefined, '到期即失效（>= TTL）');
		// 失效后条目应被清掉，避免无界增长
		assert.strictEqual(probeCacheSize(), 0, '过期条目必须被删除');
	});

	test('★ 时钟回拨（now < 写入时刻）视为失效 —— 不留"永远新鲜"的幽灵条目', () => {
		clearProbeCache();
		writeProbeCache('ffmpeg|-version', 'missing', 10_000);
		assert.strictEqual(readProbeCache('ffmpeg|-version', 9_000), undefined);
		assert.strictEqual(probeCacheSize(), 0);
	});

	test('只接受确定结论：missing 同样会被缓存（否则用户没装时会反复 spawn）', () => {
		clearProbeCache();
		writeProbeCache('yt-dlp|--version', 'missing', 0);
		assert.strictEqual(readProbeCache('yt-dlp|--version', 1), 'missing');
	});

	test('★★ 不对称 TTL：missing 30s 即过期，ok 仍是 5min（2026-09-25 启动抖动毒化事故）', () => {
		// 事故：应用重启高峰期一次 spawn 抖动被判 missing，5min TTL 让 ffmpeg 整场会话"不可用"。
		// missing 是"没跑成"（可能抖动），ok 是"真跑起来了"（可信）⇒ 两者 TTL 必须不同。
		clearProbeCache();
		writeProbeCache('a|-v', 'ok', 10_000);
		writeProbeCache('b|-v', 'missing', 10_000);
		const afterMissingTtl = 10_000 + PROBE_CACHE_TTL_MISSING_MS;
		assert.strictEqual(readProbeCache('b|-v', afterMissingTtl), undefined, 'missing 到期必须失效（30s 内自愈）');
		assert.strictEqual(readProbeCache('a|-v', afterMissingTtl), 'ok', 'ok 不受 missing 的短 TTL 影响');
		assert.strictEqual(readProbeCache('a|-v', 10_000 + PROBE_CACHE_TTL_MS), undefined, 'ok 到自己的 5min 才失效');
		// 显式传 ttlMs 时按调用方（测试/特殊路径的逃生舱）
		clearProbeCache();
		writeProbeCache('c|-v', 'missing', 0);
		assert.strictEqual(readProbeCache('c|-v', PROBE_CACHE_TTL_MS - 1, PROBE_CACHE_TTL_MS), 'missing', '显式 ttlMs 优先');
	});

	test('不同命令/参数是不同键（内置绝对路径 vs PATH 裸名不得互相污染）', () => {
		clearProbeCache();
		writeProbeCache(probeCacheKey('C:\\bin\\ffmpeg.exe', '-version'), 'ok', 0);
		assert.strictEqual(readProbeCache(probeCacheKey('ffmpeg', '-version'), 1), undefined,
			'绝对路径的结论不得被裸名读到 —— 环境变量覆盖指向新路径时必须重新探测');
	});

	test('clearProbeCache：清空全部条目（单测隔离 / "重新检测"的基础）', () => {
		clearProbeCache();
		writeProbeCache('a|-v', 'ok', 0);
		writeProbeCache('b|-v', 'missing', 0);
		assert.strictEqual(probeCacheSize(), 2);
		clearProbeCache();
		assert.strictEqual(probeCacheSize(), 0);
	});

	test('非法 now（NaN）⇒ 视为失效，而不是命中', () => {
		clearProbeCache();
		writeProbeCache('x|-v', 'ok', 0);
		assert.strictEqual(readProbeCache('x|-v', Number.NaN), undefined);
	});
});
