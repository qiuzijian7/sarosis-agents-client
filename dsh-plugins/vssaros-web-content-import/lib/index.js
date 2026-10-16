// @vssaros/dsh-web-content-import — 多平台内容导入：一个 `content_import` 工具，把一个 URL
// （平台文章 / 视频）抓回内容，可选写进知识库（`<vault>/库/raw/<slug>.md`）。
//
// 设计（方案稿 `doc/dsh-content-import-plan.md`，2026-10-15 用户拍板：插件名 web-content-import /
// 默认 read / 登录墙进本期 / 带 ASR）：
//   · 平台路由：`lib/core/routes.js`（JS 派生副本，真源在 IDE 侧 `common/webPlatformRoutes.ts`，守卫对账）；
//   · 抓取通道：静态文章走 HTTP + reader 提取（`lib/core/extract.js`）；视频走 yt-dlp 元信息 + 字幕轨，
//     无字幕轨 ⇒ 本地 whisper ASR（`lib/core/video.js` + `asr.js`，二进制随包自带）；
//   · 登录墙：本插件**不自己驱动浏览器** —— 拿到占位页 ⇒ 返回 `blocked` + 指引，模型用 `browser` 工具
//     抓整页 HTML 后以 `html` 参数喂回本工具（抓取归 browser、提取与写库归本插件 ✓ 职责不混 ✓）；
//   · 落盘契约与 IDE 侧 `kbUrlScraper` / `web-content-import` 技能**逐字对齐**（素材无 frontmatter、
//     图片相对路径、原子写 + 跨进程锁、视频默认不下载本体 ✓）；
//   · 审批闸：**只有 `mode:"write"` 才问用户**（read 是纯读，不拦 ✓）。
//
// 不导出 `inject`：本模块没有**必需**依赖（`ctx.tools` 都可缺）⇒ 任何 profile 都能激活 ✓。

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { routeForUrl } from './core/routes.js';
import { classifyExtractQuality, extractArticle } from './core/extract.js';
import {
	composeArticleMarkdown, composeVideoMarkdown, findMarkdownImageUrls, parseSubtitlesToText,
	parseYtDlpPrint, planImagePath, rewriteMarkdownImageUrls, slugifyTitle,
} from './core/record.js';
import { ytDlpAudioArgs, ytDlpMetaArgs, ytDlpSubtitleArgs } from './core/video.js';
import { buildFfmpegAudioArgs, buildWhisperArgs, parseWhisperStdout } from './core/asr.js';
import { runCommand } from './core/run.js';
import { toLosslessJsonValue } from './core/lossless.js';
import { acquireFileLock, lockFileFor } from './lock.js';
import { kbRootOf, pickVaultDir, writeRawMarkdown } from './store.js';

export const name = 'vssaros-web-content-import';

const TOOL_NAME = 'content_import';
/** 抓页面正文的大小上限（借 OpenBiliClaw 的预算口径：256KB → 我们给 512KB，文章可能长）。 */
const FETCH_MAX_BYTES = 512 * 1024;
/** 抓页面正文的超时。 */
const FETCH_TIMEOUT_MS = 15000;
/** 返回给模型的正文/字幕上限（更长就只给摘要 + 落盘路径）。 */
const DEFAULT_MAX_CHARS = 20000;
/** 图片本地化上限（防一页几百张图把库里塞爆）。 */
const MAX_LOCAL_IMAGES = 20;
/** 桌面 UA（文本抓取用；不代表我们在反检测 —— 那是 browser 通道的事）。 */
const FETCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 解析随包/环境二进制：`config.binDir` → `VSSAROS_BIN_DIR` → 裸名（PATH 兜底）。 */
function resolveBinary(config, name) {
	const dirs = [config?.binDir, process.env.VSSAROS_BIN_DIR].filter(v => typeof v === 'string' && v.trim());
	for (const dir of dirs) {
		for (const file of [join(dir.trim(), `${name}.exe`), join(dir.trim(), name)]) {
			if (existsSync(file)) { return file; }
		}
	}
	return name;
}

/**
 * 在 PATH 上按裸名找可执行文件（返回**所在目录**）。
 *
 * 为什么需要它（2026-10-15）：Host 启动会把随包 bin 目录前置进 PATH（`dshHostSupervisor`），
 * 而 whisper **模型**不在 PATH 语义里 ⇒ 光靠"exe 能跑"模型照样找不到 ✗。这里顺着 PATH 上
 * 命中的 exe 回到它的目录，再看**同级** `models/ggml-base.bin`（随包布局就是 `saros/bin` +
 * `saros/models` 兄弟目录 ✓）。找不到 ⇒ `undefined`（调用方如实报"拿不到" ✓）。
 * ⚠ Windows 的 PATH 键大小写不固定 ⇒ 按现有键的原样大小写读（与 supervisor 侧同一坑 ✓）。
 */
// ⚠ 这两个解析器**导出给自检脚本**（`test/run-content-import-check.mjs` 直接断言解析链 ✓）——
// 插件内照旧私有调用；别处的"同款需求"请复用它们，不要再写一份 ✗。
export function findOnPath(name) {
	const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path');
	const raw = pathKey ? String(process.env[pathKey] ?? '') : '';
	if (!raw) { return undefined; }
	const sep = process.platform === 'win32' ? ';' : ':';
	for (const dir of raw.split(sep)) {
		const d = dir.trim();
		if (!d) { continue; }
		for (const file of [join(d, `${name}.exe`), join(d, name)]) {
			if (existsSync(file)) { return d; }
		}
	}
	return undefined;
}

/**
 * whisper 模型路径：`config.whisperModel` → `WHISPER_MODEL_PATH` → `<binDir>/../models/ggml-base.bin`
 * （binDir 取 `config.binDir` / `VSSAROS_BIN_DIR` / **PATH 上 whisper-cli 的所在目录**，2026-10-15 补）。
 */
export function resolveWhisperModel(config) {
	const direct = [config?.whisperModel, process.env.WHISPER_MODEL_PATH].find(v => typeof v === 'string' && v.trim());
	if (direct) { return direct.trim(); }
	const binDir = [config?.binDir, process.env.VSSAROS_BIN_DIR, findOnPath('whisper-cli')]
		.find(v => typeof v === 'string' && v.trim());
	if (binDir) {
		const candidate = join(binDir.trim(), '..', 'models', 'ggml-base.bin');
		if (existsSync(candidate)) { return candidate; }
	}
	return undefined;
}

/** HTTP 抓整页 HTML（桌面 UA + 超时 + 大小上限）。 */
async function fetchHtml(url) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			headers: { 'user-agent': FETCH_UA, 'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
			signal: controller.signal,
			redirect: 'follow',
		});
		if (!res.ok) { return { ok: false, reason: `HTTP ${res.status}` }; }
		const html = await res.text();
		return { ok: true, html: html.length > FETCH_MAX_BYTES ? html.slice(0, FETCH_MAX_BYTES) : html, finalUrl: res.url || url };
	} catch (e) {
		return { ok: false, reason: String(e?.name === 'AbortError' ? `抓取超时（${FETCH_TIMEOUT_MS}ms）` : (e?.message ?? e)) };
	} finally {
		clearTimeout(timer);
	}
}

/** 登录墙 / 拦截 / 不可用的**指引文案**（按成因给不同下一步 —— 混成一句会让模型在死路上重试 ✗）。 */
function blockedGuidance(quality, route) {
	const base = `这个页面抓到的是「${quality.reason}」，不是正文 —— 不要把它当内容，也不要对同一 URL 重试 HTTP 抓取。`;
	if (quality.kind === 'login-required') {
		return base + ' 这是登录墙：请用户在那个被驱动的浏览器窗口里登录一次（browser 工具的 op:"login" 有完整闭环），'
			+ '然后用 browser 抓整页 HTML，再以 html 参数喂回本工具（content_import({ url, html })）。'
			+ (route.risks.length ? ' 已知坑：' + route.risks.join('；') : '');
	}
	if (quality.kind === 'unavailable') {
		return base + ' 这个页面自己说它不可用（已删除 / 受限）—— 重试无解，换来源或如实告诉用户读不到。';
	}
	return base + ' 这是反爬拦截页：换 browser 通道（真实浏览器）抓 HTML 后喂回本工具，或换来源。'
		+ (route.risks.length ? ' 已知坑：' + route.risks.join('；') : '');
}

/** 视频流程：yt-dlp 元信息 → 字幕轨 → 无字幕轨 ⇒ 本地 ASR（best-effort，任何一步失败都如实记 notes）。 */
async function fetchVideoContent(url, route, config, notes) {
	const ytdlp = resolveBinary(config, 'yt-dlp');
	const metaRun = await runCommand(ytdlp, ytDlpMetaArgs(url), { timeoutMs: 45000 });
	if (!metaRun.ok) {
		const reason = metaRun.spawnError ? `yt-dlp 不可用（${metaRun.spawnError}）` : `yt-dlp 元信息失败（${(metaRun.stderr || metaRun.stdout || '').trim().split('\n').pop() ?? '未知'}）`;
		return { ok: false, reason };
	}
	const meta = parseYtDlpPrint(metaRun.stdout.trim().split('\n')[0] ?? '', { platformName: route.name });

	// 字幕轨（落盘后读回；没有字幕时 yt-dlp 可能非 0 退出 ⇒ 以"目录里是否真有字幕文件"判定 ✓）
	let subtitles;
	const tmp = await mkdtemp(join(tmpdir(), 'vssaros-wci-'));
	try {
		await runCommand(ytdlp, ytDlpSubtitleArgs(url, join(tmp, 'sub.%(ext)s')), { timeoutMs: 60000 });
		const files = (await readdir(tmp)).filter(n => /\.(srt|vtt)$/i.test(n));
		if (files.length) {
			// 优先人工字幕（文件名不带 .auto），其次自动字幕（与 IDE 侧同口径 ✓）
			const picked = files.find(n => !/\.auto\./i.test(n)) ?? files[0];
			const text = parseSubtitlesToText(await readFile(join(tmp, picked), 'utf8'));
			if (text) { subtitles = { kind: /\.auto\./i.test(picked) ? 'auto' : 'manual', text }; }
		}
	} catch (e) {
		notes.push(`字幕轨抓取失败：${e?.message ?? e}`);
	}

	if (!subtitles) {
		// 无字幕轨 ⇒ 本地 ASR（whisper）：下载音频 → ffmpeg 提 16k mono wav → whisper-cli 转写。
		const ffmpeg = resolveBinary(config, 'ffmpeg');
		const whisper = resolveBinary(config, 'whisper-cli');
		const model = resolveWhisperModel(config);
		if (!model) {
			notes.push('该视频没有字幕轨，且本地 ASR 不可用（找不到 whisper 模型：配 `WHISPER_MODEL_PATH` 指到 ggml-base.bin，或让 `VSSAROS_BIN_DIR` 指向含它的 bin 目录）⇒ 口播内容拿不到');
		} else {
			const audioTpl = join(tmp, 'audio.%(ext)s');
			const dl = await runCommand(ytdlp, ytDlpAudioArgs(url, audioTpl), { timeoutMs: 300000 });
			const audio = (await readdir(tmp).catch(() => [])).find(n => /^audio\./.test(n) && !/\.(srt|vtt)$/i.test(n));
			if (!dl.ok || !audio) {
				notes.push(`ASR 前置失败（下载音频${dl.timedOut ? '超时' : '失败'}）⇒ 口播内容拿不到`);
			} else {
				const wav = join(tmp, 'audio.wav');
				const ff = await runCommand(ffmpeg, buildFfmpegAudioArgs(join(tmp, audio), wav), { timeoutMs: 120000 });
				if (!ff.ok || !existsSync(wav)) {
					notes.push(`ASR 前置失败（ffmpeg 提音轨失败）⇒ 口播内容拿不到`);
				} else {
					const asr = await runCommand(whisper, buildWhisperArgs(model, wav), { timeoutMs: 600000 });
					const text = parseWhisperStdout(asr.stdout);
					if (text) {
						subtitles = { kind: 'asr', text };
						notes.push('口播文本来自本地 ASR（whisper，离线；可能有个别错字/简繁混排）');
					} else {
						notes.push(`本地 ASR 没转出文本（${asr.spawnError ? 'whisper-cli 不可用：' + asr.spawnError : '解析不到时间轴'}）⇒ 口播内容拿不到`);
					}
				}
			}
		}
	}
	// 临时目录（字幕 / 音频 / wav）用完即清 —— 不留在系统 temp 里 ✓
	await rm(tmp, { recursive: true, force: true }).catch(() => {});
	return { ok: true, meta, subtitles };
}

export function apply(ctx, config = {}) {
	// ★ 审批闸：只有 mode=write 才问（read 是纯读 ✓）。写库 = 跨会话持久 ⇒ 与 skill_manage / kb_organize 同一把闸。
	ctx.effect(() => ctx.on('tools/pre-execute', (exec, next) => {
		if (exec && exec.name === TOOL_NAME && exec.arguments?.mode === 'write') {
			return {
				kind: 'ask',
				reason: `content_import 会把 ${String(exec.arguments?.url ?? '(html 输入)')} 的内容写进知识库（库/raw/）`,
				displayReason: { en: 'Allow content_import to write this page into your knowledge base?', zh: '允许 content_import 把这篇内容写进知识库？' },
			};
		}
		return next();
	}));

	ctx.inject(['tools'], tools => {
		const definition = {
			name: TOOL_NAME,
			description: [
				'按 URL 读取平台文章 / 视频内容（小红书 / 抖音 / B站 / 知乎 / 公众号 / 掘金 / CSDN / YouTube / 微博 / 飞书 / 任意网页），可选写入知识库。',
				'静态文章走 HTTP + 正文提取；视频走 yt-dlp 元信息 + 字幕轨（无字幕轨自动本地 ASR 转写口播）；',
				'登录墙页面（小红书、知乎问答等）会如实返回 blocked：届时用 browser 工具抓到整页 HTML 后以 html 参数喂回本工具（不要再对同一 URL 重试）。',
				'默认 mode=read（只把内容读回来给你看）；mode=write 才会写进 <vault>/库/raw/<slug>.md（需要用户确认）。',
			].join(' '),
			parameters: {
				type: 'object',
				properties: {
					url: { type: 'string', description: '目标链接（文章 / 视频；短链会自动展开）' },
					html: { type: 'string', description: '已抓到的整页 HTML（登录墙路径：先用 browser 抓，再把 HTML 喂进来；此时 url 仍必填 —— 用来做平台识别与来源记录）' },
					mode: { type: 'string', enum: ['read', 'write'], description: 'read=只读回内容（默认）；write=同时写进知识库' },
					vault: { type: 'string', description: 'write 时的目标库 id（缺省取第一个库）' },
					slug: { type: 'string', description: 'write 时的文件名（缺省从标题派生，重名自动追加 -2/-3）' },
					images: { type: 'boolean', description: 'write 时是否把正文图片下载进 assets/（默认 true；下载失败会保留远程 URL 并说明）' },
					maxChars: { type: 'integer', description: `返回正文 / 字幕的字符上限（默认 ${DEFAULT_MAX_CHARS}；超出截断并标注）` },
				},
				required: [],
			},
			output: {
				schema: {
					type: 'object',
					properties: {
						status: { type: 'string' }, platform: { type: 'string' }, kind: { type: 'string' },
						title: { type: 'string' }, author: { type: 'string' }, date: { type: 'string' },
						bodyExcerpt: { type: 'string' }, bodyChars: { type: 'integer' }, truncated: { type: 'boolean' },
						notes: { type: 'array', items: { type: 'string' } },
						saved: { type: 'object' },
					},
					required: ['status'],
				},
				render: (_args, value) => {
					if (value.status === 'blocked') {
						return [{ type: 'text', text: `读不到内容（${value.notes?.[0] ?? 'blocked'}）` }];
					}
					const lines = [`${value.title ?? '(无标题)'}（${value.platformName ?? value.platform} · ${value.kind}）`];
					if (value.subtitles?.kind) { lines.push(`口播/字幕来源：${value.subtitles.kind}`); }
					if (value.saved?.path) { lines.push(`已写入知识库：${value.saved.path}`); }
					if (value.truncated) { lines.push(`正文共 ${value.bodyChars} 字符，已按上限截断（全文在库里）`); }
					if (value.notes?.length) { lines.push(`注意：${value.notes.join('；')}`); }
					return [{ type: 'text', text: lines.join('\n') }];
				},
			},
			isConcurrencySafe: () => true,
			execute: async (params) => {
				const url = typeof params?.url === 'string' ? params.url.trim() : '';
				const htmlInput = typeof params?.html === 'string' && params.html.trim() ? params.html : undefined;
				const mode = params?.mode === 'write' ? 'write' : 'read';
				const maxChars = Number.isInteger(params?.maxChars) && params.maxChars > 0 ? Math.min(params.maxChars, 200000) : DEFAULT_MAX_CHARS;
				if (!url) {
					throw new Error('url 不能为空（给整页 HTML 时也要带上原 URL —— 平台识别与来源记录都靠它）');
				}
				const route = routeForUrl(url);
				const notes = [];

				// ── 抓取：html 输入优先（登录墙回路）；否则按路由分派 ────────────────────────
				let meta = {};
				let body = '';
				let images = [];
				let subtitles;
				let finalUrl = url;
				if (htmlInput) {
					const extracted = extractArticle(htmlInput, url);
					meta = extracted.meta;
					body = extracted.body;
					images = extracted.images;
				} else if (route.type === 'video') {
					const video = await fetchVideoContent(url, route, config, notes);
					if (!video.ok) { return { status: 'blocked', platform: route.id, platformName: route.name, kind: route.type, url, notes: [...notes, video.reason] }; }
					meta = video.meta;
					subtitles = video.subtitles;
					body = subtitles?.text ?? '';
					if (!subtitles) { notes.push('该视频没有字幕轨，且本地 ASR 没转出文本 ⇒ 只有元信息（标题/简介），口播内容拿不到'); }
				} else {
					const fetched = await fetchHtml(url);
					if (!fetched.ok) { return { status: 'blocked', platform: route.id, platformName: route.name, kind: route.type, url, notes: [...notes, `页面抓取失败：${fetched.reason}`] }; }
					finalUrl = fetched.finalUrl;
					const extracted = extractArticle(fetched.html, finalUrl);
					meta = extracted.meta;
					body = extracted.body;
					images = extracted.images;
					const quality = extracted.quality;
					if (quality.verdict === 'blocked') {
						return { status: 'blocked', platform: route.id, platformName: route.name, kind: route.type, url, finalUrl, notes: [...notes, blockedGuidance(quality, route)] };
					}
					if (quality.verdict === 'thin') { notes.push(`正文偏短（${quality.length} 字符），可能不完整`); }
				}

				// ── 组装 ContentRecord ───────────────────────────────────────────────────
				const bodyChars = body.length;
				const record = {
					status: 'ok',
					platform: route.id,
					platformName: route.name,
					kind: route.type,
					url,
					finalUrl,
					title: meta.title,
					author: meta.author,
					siteName: meta.siteName,
					date: meta.date,
					description: meta.description,
					cover: meta.cover,
					tags: meta.tags,
					durationSec: meta.durationSec,
					videoUrl: meta.videoUrl,
					bodyExcerpt: body.length > maxChars ? body.slice(0, maxChars) : body,
					bodyChars,
					truncated: body.length > maxChars,
					images: images.slice(0, MAX_LOCAL_IMAGES),
					subtitles: subtitles ? { kind: subtitles.kind, chars: subtitles.text.length } : undefined,
					notes,
				};

				// ── 落盘（mode=write）─────────────────────────────────────────────────────
				if (mode === 'write') {
					const kbRoot = kbRootOf(config);
					const picked = await pickVaultDir(kbRoot, params?.vault);
					if (picked.error) { throw new Error(picked.error); }
					const slug = slugifyTitle(params?.slug || meta.title, url);
					// 图片本地化（默认开；失败保留远程 URL 并说明 ✓）
					let coverLocalPath;
					const imageMap = new Map();
					if (params?.images !== false) {
						const saveImage = async (imgUrl, index) => {
							const res = await fetch(imgUrl, { headers: { 'user-agent': FETCH_UA, 'referer': finalUrl }, signal: AbortSignal.timeout(15000) });
							if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
							const buf = Buffer.from(await res.arrayBuffer());
							const { rel } = planImagePath(slug, index, imgUrl, res.headers.get('content-type') ?? undefined);
							const dest = join(picked.dir, '库', 'raw', rel);
							await mkdir(dirname(dest), { recursive: true });
							await writeFile(dest, buf);
							return rel;
						};
						const targets = findMarkdownImageUrls(body).slice(0, MAX_LOCAL_IMAGES);
						for (let i = 0; i < targets.length; i++) {
							try {
								imageMap.set(targets[i], await saveImage(targets[i], i + 1));
							} catch (e) {
								notes.push(`图片下载失败（保留远程 URL）：${targets[i]} —— ${e?.message ?? e}`);
							}
						}
						if (meta.cover && imageMap.size < MAX_LOCAL_IMAGES) {
							try {
								coverLocalPath = await saveImage(meta.cover, 0);
							} catch (e) {
								notes.push(`封面下载失败（保留远程 URL）：${meta.cover} —— ${e?.message ?? e}`);
							}
						}
					}
					const markdown = route.type === 'video'
						? composeVideoMarkdown({ url: finalUrl, platformName: route.name, meta: { ...meta, siteName: meta.siteName ?? route.name }, downloaded: false })
						: composeArticleMarkdown({ url: finalUrl, platformName: route.name, meta, body: rewriteMarkdownImageUrls(body, imageMap), coverLocalPath });
					// ⚠ 锁文件的父目录可能还不存在（库里**第一次**导入时 `库/raw/` 还没建）⇒ 先建目录再抢锁 ✗
					//   （否则 `open(lock,'wx')` 报 ENOENT —— p3-93 抓到的真缺陷 ✓）。
					await mkdir(join(picked.dir, '库', 'raw'), { recursive: true });
					const release = await acquireFileLock(lockFileFor(join(picked.dir, '库', 'raw', '.content-import')), { label: '知识库素材' });
					try {
						const file = await writeRawMarkdown(picked.dir, slug, markdown);
						record.saved = { path: file, vault: picked.id, slug, imageCount: imageMap.size + (coverLocalPath ? 1 : 0) };
					} finally {
						await release();
					}
				}

				return record;
			},
		};
		// ★ 输出归一（2026-10-15）：dsh 校验器拒绝含 `undefined` / 非有限数的返回值
		//   （`tool "content_import" returned invalid output: value is not lossless JSON` —— 真机现场）。
		//   record 里 `meta.*` 与 `subtitles` 都可能是 `undefined` ⇒ 所有返回路径（ok / blocked / write）
		//   统一过这一道。**修值的形态，不改 schema**（缺的键本来就可选 ⇒ 丢键合法 ✓）。纯函数见 `core/lossless.js`。
		const rawExecute = definition.execute;
		definition.execute = async (params, exec) => toLosslessJsonValue(await rawExecute(params, exec));
		tools.tools.register(definition);
	});
}
