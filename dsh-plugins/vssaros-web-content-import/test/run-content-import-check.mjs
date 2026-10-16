// @vssaros/dsh-web-content-import — 进程内断言（**不进包**：package.json 的 files 不含 test/）。
// 跑法（仓库根）：node dsh-plugins/vssaros-web-content-import/test/run-content-import-check.mjs
//
// 覆盖：平台路由（与 IDE 真源对账的口径）/ 落盘形状 / 提取与质量判定 / 命令拼装 / 子进程封装 /
//       vault 解析与落盘 / 锁 / 审批闸 / 工具注册与执行（html 输入路径）。
// ⚠ 不跑真 yt-dlp / ffmpeg / whisper（没有二进制 ⇒ 那些是**命令拼装**的断言，真机归探针）。

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeForUrl, genericRoute, KNOWN_BACKEND_KINDS, WEB_PLATFORM_ROUTES } from '../lib/core/routes.js';
import {
	composeArticleMarkdown, composeVideoMarkdown, findMarkdownImageUrls, formatDuration, guessMediaExt,
	htmlToPlainText, parseMetaTags, parseSubtitlesToText, parseYtDlpPrint, planImagePath,
	rewriteMarkdownImageUrls, slugifyTitle,
} from '../lib/core/record.js';
import { classifyExtractQuality, extractArticle, extractImages } from '../lib/core/extract.js';
import { ytDlpAudioArgs, ytDlpMetaArgs, ytDlpSubtitleArgs } from '../lib/core/video.js';
import { buildFfmpegAudioArgs, buildWhisperArgs, parseWhisperStdout } from '../lib/core/asr.js';
import { runCommand } from '../lib/core/run.js';
import { acquireFileLock, lockFileFor } from '../lib/lock.js';
import { dataRootOf, kbRootOf, pickVaultDir, writeRawMarkdown } from '../lib/store.js';
import * as plugin from '../lib/index.js';

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = '') {
	if (ok) { pass++; } else { fail++; failures.push({ name, detail }); }
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  — ${detail}`}`);
}

// ─── 平台路由（与 IDE 真源对账的口径）────────────────────────────────────────
check('路由表 13 条且 generic 在最后', WEB_PLATFORM_ROUTES.length === 13 && WEB_PLATFORM_ROUTES.at(-1).id === 'generic', `length=${WEB_PLATFORM_ROUTES.length}`);
check('generic 是全能匹配（兜底）', genericRoute().hostPatterns[0].test('anything.example.com'), '');
check('每条 backend.kind 都在封闭集合里', WEB_PLATFORM_ROUTES.every(r => r.backends.every(b => KNOWN_BACKEND_KINDS.includes(b.kind))), '');
check('KNOWN_BACKEND_KINDS 与 IDE 真源同值', JSON.stringify(KNOWN_BACKEND_KINDS) === JSON.stringify(['web-extract', 'browser', 'video-analyze', 'ytdlp', 'vision-analyze']), '');
const routeCases = [
	['https://www.xiaohongshu.com/explore/abc', 'xiaohongshu', 'browser'],
	['https://xhslink.com/a/bc', 'xiaohongshu', 'browser'],
	['https://www.douyin.com/video/123', 'douyin', 'video-analyze'],
	['https://www.bilibili.com/video/BV1xx', 'bilibili', 'video-analyze'],
	['https://www.youtube.com/watch?v=abc', 'youtube', 'video-analyze'],
	['https://youtu.be/abc', 'youtube', 'video-analyze'],
	['https://mp.weixin.qq.com/s/abc', 'weixin', 'web-extract'],
	['https://zhuanlan.zhihu.com/p/123', 'zhihu', 'web-extract'],
	['https://www.zhihu.com/question/123', 'zhihu', 'web-extract'],
	['https://weibo.com/123/abc', 'weibo', 'video-analyze'],
	['https://juejin.cn/post/123', 'juejin', 'web-extract'],
	['https://blog.csdn.net/u/a/123', 'csdn', 'web-extract'],
	['https://example.com/whatever', 'generic', 'web-extract'],
	['not-a-url', 'generic', 'web-extract'],
];
for (const [url, id, backend] of routeCases) {
	const r = routeForUrl(url);
	check(`routeForUrl ${url} → ${id} / 首选 ${backend}`, r.id === id && r.backends[0].kind === backend, `got ${r.id}/${r.backends[0].kind}`);
}
check('小红书 needsLogin、公众号不需要', routeForUrl('https://www.xiaohongshu.com/x').needsLogin === true && routeForUrl('https://mp.weixin.qq.com/s/x').needsLogin === false, '');

// ─── 落盘形状（record.js）────────────────────────────────────────────────────
check('slugifyTitle 折叠非法字符与空白', slugifyTitle('Hello World: 你好?', 'https://x.com/a') === 'Hello-World-你好', slugifyTitle('Hello World: 你好?', 'https://x.com/a'));
check('slugifyTitle 无标题用 URL 末段', slugifyTitle('', 'https://x.com/a/my-post.html') === 'my-post.html', slugifyTitle('', 'https://x.com/a/my-post.html'));
check('slugifyTitle 超长截断且去尾连字符', slugifyTitle('a-'.repeat(50), 'https://x.com', 10) === 'a-a-a-a-a', slugifyTitle('a-'.repeat(50), 'https://x.com', 10));
check('parseYtDlpPrint 解析 ||| 分隔且 YYYYMMDD 格式化', (() => {
	const m = parseYtDlpPrint('标题|||123|||https://img|||UP主|||20261015|||简介', { platformName: 'B站' });
	return m.title === '标题' && m.durationSec === 123 && m.author === 'UP主' && m.date === '2026-10-15' && m.siteName === 'B站';
})(), '');
check('parseSubtitlesToText 去时间轴/序号/相邻重复', (() => {
	const t = parseSubtitlesToText('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n你好\n\n00:00:02.000 --> 00:00:03.000\n你好\n\n00:00:03.000 --> 00:00:04.000\n世界');
	return t === '你好\n世界';
})(), '');
check('composeArticleMarkdown 形状（标题 + 元信息行 + 原文行 + 摘要 + 正文 + 标签）', (() => {
	const md = composeArticleMarkdown({ url: 'https://x.com/a', platformName: '网页', meta: { title: 'T', author: 'A', date: '2026-10-15', description: 'D', tags: ['x', 'y'] }, body: '正文' });
	return md.startsWith('# T\n') && md.includes('> 作者：A · 发布：2026-10-15') && md.includes('> 平台：网页 · 原文：https://x.com/a') && md.includes('**摘要**：D') && md.includes('正文') && md.includes('标签：x / y');
})(), '');
check('composeVideoMarkdown 形状（时长行 + 未下载提示）', (() => {
	// ⚠ 真源口径：`平台：` 那行以 meta.siteName 为**条件**（显示的是 platformName）—— 不传 siteName 就没有那行 ✓
	const md = composeVideoMarkdown({ url: 'https://b.com/v/1', platformName: 'B站', meta: { title: 'V', author: 'U', siteName: 'B站', durationSec: 65 }, downloaded: false });
	return md.includes('> 作者：U · 平台：B站 · 时长：1:05') && md.includes('未能直接下载视频文件');
})(), '');
check('planImagePath 相对路径形如 assets/<slug>/<序号>-<名>.<ext>', planImagePath('s', 2, 'https://x.com/a/b.png').rel === 'assets/s/2-b.png', planImagePath('s', 2, 'https://x.com/a/b.png').rel);
check('guessMediaExt 从 URL 与 mime 推断', guessMediaExt('https://x.com/a.jpg') === 'jpg' && guessMediaExt('https://x.com/a', 'image/png') === 'png' && guessMediaExt('https://x.com/a.html') === 'bin', '');
check('formatDuration 与 htmlToPlainText', formatDuration(65) === '1:05' && formatDuration(3661) === '1:01:01' && htmlToPlainText('<p>a</p><script>var x=1</script><p>b</p>') === 'a\n\nb', '');
check('findMarkdownImageUrls + rewriteMarkdownImageUrls', (() => {
	const urls = findMarkdownImageUrls('![a](https://x.com/1.png) 与 ![b](https://x.com/2.png)');
	const out = rewriteMarkdownImageUrls('![a](https://x.com/1.png)', new Map([['https://x.com/1.png', 'assets/s/1-1.png']]));
	return urls.length === 2 && out === '![a](assets/s/1-1.png)';
})(), '');

// ─── 提取与质量判定（extract.js；与 webPageQuality.ts 同口径的关键样本）─────────
const LONG_TEXT = '这是一段足够长的正文。'.repeat(30);
check('质量判定：正常长文 ⇒ ok', classifyExtractQuality(LONG_TEXT).verdict === 'ok', '');
check('质量判定：短文（<200）无特征 ⇒ thin', classifyExtractQuality('很短').verdict === 'thin', '');
check('质量判定：强特征（你访问的页面不见了）⇒ blocked / unavailable', (() => {
	// ⚠ 特征扫描窗口 = 标题 + 正文前 300 字符（真源：拦截页都很短 ⇒ 只扫头部，防长文偶现误判）⇒ 样本要短。
	const q = classifyExtractQuality('小红书 - 你访问的页面不见了');
	return q.verdict === 'blocked' && q.kind === 'unavailable';
})(), '');
check('质量判定：弱特征只在短页生效（长文里出现 just a moment 不拦）', classifyExtractQuality(LONG_TEXT + ' just a moment').verdict === 'ok', '');
check('质量判定：短页 + 登录墙句式 ⇒ blocked / login-required', (() => {
	const q = classifyExtractQuality('请先登录后查看');
	return q.verdict === 'blocked' && q.kind === 'login-required';
})(), '');
check('质量判定：强拦截（checking your browser）⇒ blocked / interstitial', (() => {
	const q = classifyExtractQuality('Checking your browser before accessing the site');
	return q.verdict === 'blocked' && q.kind === 'interstitial';
})(), '');
check('extractArticle：容器优先（<article> 的内容）', (() => {
	const html = `<html><head><title>T</title></head><body><nav>导航</nav><article><p>${LONG_TEXT}</p></article></body></html>`;
	const r = extractArticle(html, 'https://x.com/a');
	return r.container === 'container#0' && r.body.includes('这是一段足够长的正文') && r.quality.verdict === 'ok';
})(), '');
check('extractImages：data: 跳过、// 补协议、相对路径补全、去重', (() => {
	const imgs = extractImages('<img src="data:image/png;base64,x"><img src="//cdn.x.com/a.png"><img src="/b.jpg" alt="B"><img src="//cdn.x.com/a.png">', 'https://x.com/p/1');
	return imgs.length === 2 && imgs[0].url === 'https://cdn.x.com/a.png' && imgs[1].url === 'https://x.com/b.jpg' && imgs[1].alt === 'B';
})(), '');
check('parseMetaTags：og 优先 + article 字段', (() => {
	const m = parseMetaTags('<meta property="og:title" content="T"><meta name="author" content="A"><meta property="article:published_time" content="2026-10-15">');
	return m.title === 'T' && m.author === 'A' && m.date === '2026-10-15';
})(), '');

// ─── 命令拼装（video.js / asr.js）─────────────────────────────────────────────
check('ytDlpMetaArgs：--print + ||| 模板 + 不用 --dump-json', (() => {
	const a = ytDlpMetaArgs('https://b.com/v/1');
	return a.includes('--print') && a.some(s => s.includes('%(title)s|||%(duration)s')) && !a.includes('--dump-json');
})(), '');
check('ytDlpSubtitleArgs：--write-subs + --write-auto-subs + sub-langs + 落盘 -o', (() => {
	const a = ytDlpSubtitleArgs('https://b.com/v/1', '/tmp/sub.%(ext)s');
	return a.includes('--write-subs') && a.includes('--write-auto-subs') && a.includes('zh.*,en.*') && a.includes('/tmp/sub.%(ext)s');
})(), '');
check('ytDlpAudioArgs：音频用 ba/b（不是只认 combined 的 -f b）', (() => {
	const a = ytDlpAudioArgs('https://b.com/v/1', '/tmp/a.%(ext)s');
	const i = a.indexOf('-f');
	return a[i + 1] === 'ba/b';
})(), '');
check('buildFfmpegAudioArgs：16kHz mono pcm_s16le（whisper 只认这个）', (() => {
	const a = buildFfmpegAudioArgs('/v.mp4', '/a.wav');
	return a.includes('-ar') && a[a.indexOf('-ar') + 1] === '16000' && a.includes('-ac') && a.includes('pcm_s16le');
})(), '');
check('buildWhisperArgs：-l auto 必传（默认英文会把中文按英文硬猜）', (() => {
	const a = buildWhisperArgs('/m.bin', '/a.wav');
	return a.includes('-l') && a[a.indexOf('-l') + 1] === 'auto';
})(), '');
check('parseWhisperStdout：压成 [mm:ss]；无时间轴 ⇒ undefined', (() => {
	const ok = parseWhisperStdout('[00:01:23.450 --> 00:01:26.000]  你好\n[00:02:01.000 --> 00:02:03.000] 世界');
	const bad = parseWhisperStdout('whisper_init: done');
	// [00:01:23] = 1 分 23 秒 ⇒ [01:23]；[00:02:01] = 2 分 1 秒 ⇒ [02:01]（我之前把期望值算错了 ✗）
	return ok === '[01:23] 你好\n[02:01] 世界' && bad === undefined;
})(), parseWhisperStdout('[00:01:23.450 --> 00:01:26.000]  你好') ?? '(undefined)');

// ─── 子进程封装 ───────────────────────────────────────────────────────────────
{
	const r = await runCommand('definitely-not-a-real-command-' + Date.now(), [], { timeoutMs: 3000 });
	check('runCommand：不存在的命令 ⇒ spawnError（不抛、不崩、ok=false）', r.ok === false && typeof r.spawnError === 'string' && r.spawnError.length > 0, JSON.stringify(r).slice(0, 120));
	const ok = await runCommand(process.execPath, ['-e', 'console.log("hi")'], { timeoutMs: 5000 });
	check('runCommand：正常命令 ⇒ ok + stdout', ok.ok === true && ok.stdout.trim() === 'hi', JSON.stringify(ok).slice(0, 120));
}

// ─── store / lock（真文件，临时目录）──────────────────────────────────────────
const tmp = await mkdtemp(join(tmpdir(), 'vssaros-wci-test-'));
try {
	check('kbRootOf 缺省 = <数据根>/knowledge-base', kbRootOf({ dataRoot: tmp }) === join(tmp, 'knowledge-base'), kbRootOf({ dataRoot: tmp }));
	check('dataRootOf 显式优先', dataRootOf({ dataRoot: tmp }) === tmp, '');
	const badVault = await pickVaultDir(join(tmp, 'kb'), 'not a vault');
	check('pickVaultDir：不合法 vault 名 ⇒ error（不猜）', typeof badVault.error === 'string' && badVault.error.includes('不合法'), '');
	const noVault = await pickVaultDir(join(tmp, 'kb'), '');
	check('pickVaultDir：没有库 ⇒ error（如实说，不猜目录名）', typeof noVault.error === 'string', '');
	await mkdir(join(tmp, 'kb', '20261015120000-ab12'), { recursive: true });
	const picked = await pickVaultDir(join(tmp, 'kb'), '');
	check('pickVaultDir：缺省取第一个 vault', picked.id === '20261015120000-ab12' && picked.dir.endsWith('20261015120000-ab12'), '');
	const file = await writeRawMarkdown(picked.dir, 'demo', '# 标题\n\n正文\n');
	check('writeRawMarkdown：落到 库/raw/<slug>.md 且内容原子写完整', (await readFile(file, 'utf8')).includes('正文') && file.endsWith(join('库', 'raw', 'demo.md')), file);
	check('writeRawMarkdown：无临时文件残留', !(await readdir(join(picked.dir, '库', 'raw'))).some(n => n.includes('.vssaros-tmp')), '');
	// 锁：抢着 ⇒ 第二个等着超时（短 waitMs）⇒ 如实报"被占用"
	const lock = lockFileFor(join(picked.dir, '.demo'));
	const release = await acquireFileLock(lock, { label: '测试' });
	let blocked = '';
	try {
		await acquireFileLock(lock, { label: '测试', waitMs: 400, pollMs: 50 });
	} catch (e) { blocked = String(e?.message ?? e); }
	await release();
	check('锁：被持有时第二个抢锁者如实报"被占用"（且带持有者信息）', blocked.includes('被另一个写者占用') && blocked.includes('仍在运行'), blocked.slice(0, 120));
	check('锁：释放后锁文件清掉', !existsSync(lock), '');
} finally {
	await rm(tmp, { recursive: true, force: true }).catch(() => {});
}

// ─── 插件装配：审批闸 + 工具注册 + 执行（html 输入路径）────────────────────────
{
	const defs = [];
	const preHandlers = [];
	const ctx = {
		effect(fn) { fn(); },
		on(event, handler) { preHandlers.push({ event, handler }); return () => { }; },
		inject(deps, cb) {
			if (deps.includes('tools')) {
				cb({ tools: { register: d => { defs.push(d); return () => { }; }, schemas: () => defs.map(d => ({ name: d.name })) } });
			}
		},
	};
	plugin.apply(ctx, { dataRoot: tmp });
	check('apply 注册了恰好一个工具 content_import', defs.length === 1 && defs[0].name === 'content_import', defs.map(d => d.name).join(','));
	check('工具定义满足 dsh 注册契约（parameters + output{schema,render}）', !!defs[0].parameters && typeof defs[0].output?.render === 'function', '');
	const pre = preHandlers.find(h => h.event === 'tools/pre-execute')?.handler;
	check('审批闸挂在 tools/pre-execute 上', typeof pre === 'function', '');
	check('审批闸：mode=write ⇒ ask（写库要用户确认）', (await pre({ name: 'content_import', arguments: { mode: 'write', url: 'https://x.com' } }, () => 'next')).kind === 'ask', '');
	check('审批闸：mode=read 与其它工具 ⇒ 放行（不拦只读）', (await pre({ name: 'content_import', arguments: { mode: 'read' } }, () => 'next')) === 'next' && (await pre({ name: 'other_tool', arguments: {} }, () => 'next')) === 'next', '');
	// html 输入路径（登录墙回路）：不联网，直接提取
	const html = `<html><head><title>测试标题</title><meta name="author" content="作者甲"></head><body><article><p>${LONG_TEXT}</p><img src="https://cdn.x.com/p.png"></article></body></html>`;
	const r1 = await defs[0].execute({ url: 'https://example.com/p/1', html, mode: 'read' });
	check('execute（html 输入）：提取出标题/作者/正文/图片，status=ok', r1.status === 'ok' && r1.title === '测试标题' && r1.author === '作者甲' && r1.bodyExcerpt.includes('这是一段足够长的正文') && r1.images.length === 1, JSON.stringify({ status: r1.status, title: r1.title, images: r1.images?.length }));
	check('execute（html 输入）：read 不落盘', r1.saved === undefined, '');
	let threw = '';
	try { await defs[0].execute({ mode: 'read' }); } catch (e) { threw = String(e?.message ?? e); }
	check('execute：url 为空 ⇒ 明确报错（不静默）', threw.includes('url 不能为空'), threw);
	const r2 = await defs[0].execute({ url: 'not-a-url', html, mode: 'read' });
	check('execute：畸形 URL ⇒ 落 generic 兜底（不抛错）', r2.platform === 'generic' && r2.status === 'ok', r2.platform);
	// ★ 2026-10-15：lossless JSON（dsh 校验器拒收含 undefined/非有限数的返回值 —— 真机现场）。
	//   判据 = JSON 往返**逐字相等**（丢一个键都过不了 ✓）。
	check('execute（html 输入）：返回值过 JSON 往返不变（lossless ✓ —— 否则 dsh 判 invalid output ✗）',
		JSON.stringify(r1) === JSON.stringify(JSON.parse(JSON.stringify(r1))), '');
	// 最坏形状：html 里什么 meta 都没有 ⇒ meta.* 全是 undefined ⇒ 归一后必须仍 lossless
	const bare = await defs[0].execute({ url: 'https://example.com/bare', html: '<html><body><article><p>只有正文没有 meta。</p></article></body></html>', mode: 'read' });
	check('execute（无 meta）：undefined 字段被丢键 ⇒ 往返仍逐字相等（真机出 bug 的那条路 ✓）',
		JSON.stringify(bare) === JSON.stringify(JSON.parse(JSON.stringify(bare))), JSON.stringify(Object.keys(bare)));
}
// ─── ASR 模型/二进制的解析链（2026-10-15：真机"找不到 whisper 模型"那条的回归）───────────────
{
	const { findOnPath, resolveWhisperModel } = await import('../lib/index.js');
	// 造一个"随包布局"：tmp/bin/whisper-cli.exe + tmp/models/ggml-base.bin
	const root = await mkdtemp(join(tmpdir(), 'wci-bin-'));
	const bin = join(root, 'bin');
	await mkdir(join(root, 'models'), { recursive: true });
	await mkdir(bin, { recursive: true });
	await writeFile(join(bin, 'whisper-cli.exe'), '');
	await writeFile(join(root, 'models', 'ggml-base.bin'), 'x');
	const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
	const savedPath = process.env[pathKey];
	const savedBinDir = process.env.VSSAROS_BIN_DIR;
	const savedModel = process.env.WHISPER_MODEL_PATH;
	try {
		delete process.env.VSSAROS_BIN_DIR;
		delete process.env.WHISPER_MODEL_PATH;
		// ① PATH 兜底：whisper-cli 在 PATH 上 ⇒ 顺着它找到同级 models/
		process.env[pathKey] = bin;
		check('findOnPath：PATH 上的裸命令能解析回它的目录（随包布局的关键一跳 ✓）', findOnPath('whisper-cli') === bin, String(findOnPath('whisper-cli')));
		check('resolveWhisperModel：只给 PATH ⇒ 顺着 whisper-cli 找到同级 models/ggml-base.bin',
			resolveWhisperModel({}) === join(bin, '..', 'models', 'ggml-base.bin'), String(resolveWhisperModel({})));
		// ② env 优先于 PATH（override 语义 ✓）
		process.env.VSSAROS_BIN_DIR = bin;
		check('resolveWhisperModel：VSSAROS_BIN_DIR 优先于 PATH（override 优先 ✓）', resolveWhisperModel({}) === join(bin, '..', 'models', 'ggml-base.bin'), '');
		// ③ 都没有 ⇒ undefined（如实报"拿不到" ✓，不猜）。PATH 指到一个**肯定没有** whisper-cli 的目录（确定性 ✓）
		delete process.env.VSSAROS_BIN_DIR;
		process.env[pathKey] = root;
		check('resolveWhisperModel：哪条路都不通 ⇒ undefined（不猜一个出来 ✗）', resolveWhisperModel({}) === undefined, String(resolveWhisperModel({})));
	} finally {
		if (savedPath === undefined) { delete process.env[pathKey]; } else { process.env[pathKey] = savedPath; }
		if (savedBinDir === undefined) { delete process.env.VSSAROS_BIN_DIR; } else { process.env.VSSAROS_BIN_DIR = savedBinDir; }
		if (savedModel === undefined) { delete process.env.WHISPER_MODEL_PATH; } else { process.env.WHISPER_MODEL_PATH = savedModel; }
		await rm(root, { recursive: true, force: true });
	}
}

// ─── lossless 归一的单元断言（纯函数 ✓）────────────────────────────────────────
{
	const { toLosslessJsonValue } = await import('../lib/core/lossless.js');
	const dirty = { a: undefined, b: NaN, c: -0, d: Infinity, e: [1, undefined, 3], f: { g: undefined, h: 'x' }, i: 10n };
	const clean = toLosslessJsonValue(dirty);
	check('lossless：undefined 丢键 / NaN·-0·∞ ⇒ null / bigint 丢键 / 数组洞 ⇒ null',
		!('a' in clean) && clean.b === null && clean.c === null && clean.d === null
		&& JSON.stringify(clean.e) === '[1,null,3]' && JSON.stringify(clean.f) === '{"h":"x"}' && !('i' in clean),
		JSON.stringify(clean));
	check('lossless：根值是 undefined ⇒ null（不是抛错 ✓）', toLosslessJsonValue(undefined) === null, '');
	const cyc = {}; cyc.self = cyc;
	check('lossless：循环引用 ⇒ 压成 null（如实降级，不栈溢出 ✗）', toLosslessJsonValue(cyc).self === null, '');
}

// ─── 与 IDE 真源对账（common/webPlatformRoutes.ts）────────────────────────────────────
// 为什么要有它：两侧隔离（插件间不能 import、src/vs 与 dsh-plugins 互相隔离）⇒ 路由表只能各自一份 ⇒
// 没有对账就会漂移（IDE 侧改了平台、插件不知道 ⇒ 同一链接两种走法 ✗）。
{
	const ts = readFileSync(join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'common', 'webPlatformRoutes.ts')), 'utf8');
	const tsRoutes = new Map();
	for (const m of ts.matchAll(/id: '([a-z-]+)', name: '[^']+', type: '([a-z]+)',[\s\S]*?backends: \[([\s\S]*?)\],[\s\S]*?needsLogin: (true|false)/g)) {
		tsRoutes.set(m[1], { type: m[2], firstKind: /kind: '([a-z-]+)'/.exec(m[3])?.[1], needsLogin: m[4] === 'true' });
	}
	check('对账：IDE 真源里抽到了 13 条路由（防空跑）', tsRoutes.size === 13, `抽到 ${tsRoutes.size} 条`);
	const pluginIds = WEB_PLATFORM_ROUTES.map(r => r.id).sort();
	const tsIds = [...tsRoutes.keys()].sort();
	check('对账：平台集合一致', JSON.stringify(pluginIds) === JSON.stringify(tsIds), `插件=${pluginIds.join(',')} 真源=${tsIds.join(',')}`);
	for (const r of WEB_PLATFORM_ROUTES) {
		const t = tsRoutes.get(r.id);
		check(`对账：${r.id} 的类型 / 首选通道 / needsLogin 与真源一致`,
			!!t && t.type === r.type && t.firstKind === r.backends[0].kind && t.needsLogin === r.needsLogin,
			`插件=${r.type}/${r.backends[0].kind}/${r.needsLogin} 真源=${t ? `${t.type}/${t.firstKind}/${t.needsLogin}` : '（缺）'}`);
	}
}

console.log(`\n${pass} passed / ${fail} failed`);
if (fail > 0) {
	console.log('失败明细：');
	for (const f of failures) { console.log(`  ✗ ${f.name}  — ${f.detail}`); }
	process.exit(1);
}
