#!/usr/bin/env node
/*
 * MediaClawer 的**唯一执行入口**（2026-10-20）。
 *
 * 为什么要有这层封装（而不是让模型自己拼 MediaCrawler 的命令）：
 *   · MediaCrawler 的 CLI 是 typer 的 `--platform/--lt/--type/--keywords`，输出目录靠
 *     `SAVE_DATA_PATH` 环境变量，产物路径又随平台变化 —— 这些细节模型不可能记住，
 *     放手让它拼必然写错（还会因为报错重试把账号跑成风控）；
 *   · URL 清单的抽取口径与 `vssaros-web-content-import` 的 `urlFile` **必须是同一份实现**
 *     （字段名、去重键、图片过滤），否则"抓到的"和"能导的"对不上。
 *
 * 它只做两件事：**跑爬虫** + **产出干净 URL 清单**；导入交给 agent 的 `content_import(urlFile)`。
 * 这样脚本可离线单测（`--only-extract` / `--dry-run`），也不会把"往知识库写"藏进黑盒。
 *
 * 用法：
 *   node crawl-import.mjs --platform xhs --keywords "关键词1,关键词2" [--limit 20]
 *        [--crawler <MediaCrawler 目录>] [--out <输出目录>] [--login cookie|qrcode]
 *        [--type search|detail] [--dry-run] [--timeout-ms 900000]
 *   node crawl-import.mjs --only-extract <某个 .jsonl> [--out <目录>]   # 只抽 URL（离线）
 *
 * 输出（stdout 一行 JSON）：
 *   { ok:true, platform, keywords, crawlerDir, outDir, jsonl, count, urlsFile, sample:[…] }
 *   { ok:false, error, hint }
 * 退出码：0 成功；1 失败（失败一律给 `hint`：可照做的下一步，不是干巴巴的错误串）。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLATFORMS = ['xhs', 'dy', 'ks', 'bili', 'wb', 'tieba', 'zhihu'];

const argv = process.argv.slice(2);
const flag = (name) => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(name);

const say = (obj, code) => {
	process.stdout.write(JSON.stringify(obj) + '\n');
	process.exit(code);
};
const fail = (error, hint) => say({ ok: false, error, hint }, 1);

/** URL 抽取：与 `vssaros-web-content-import` **同一份实现**（禁止各写一套）。 */
async function extractor() {
	const mod = join(HERE, '..', '..', 'vssaros-web-content-import', 'lib', 'core', 'urlList.js');
	if (!existsSync(mod)) {
		return null;
	}
	return import(pathToFileURL(mod).href);
}

/** MediaCrawler 目录：--crawler > env > 常见位置。找不到就如实报（不猜、不下载）。 */
function resolveCrawlerDir() {
	const explicit = flag('--crawler') ?? process.env.MEDIACRAWLER_DIR;
	if (explicit) {
		return { dir: resolve(explicit), from: flag('--crawler') ? '--crawler' : 'MEDIACRAWLER_DIR' };
	}
	const candidates = [
		join(homedir(), 'MediaCrawler'),
		'G:/CustomWorkspaces/AIProjects/MediaCrawler',
		'D:/MediaCrawler',
	];
	for (const c of candidates) {
		if (existsSync(join(c, 'main.py'))) {
			return { dir: c, from: 'default' };
		}
	}
	return { dir: undefined, from: 'missing' };
}

/** 最近修改的 .jsonl（MediaCrawler 按平台写到 <out>/<platform>/）。 */
function newestJsonl(dir) {
	if (!existsSync(dir)) {
		return undefined;
	}
	let best;
	const walk = (d) => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, entry.name);
			if (entry.isDirectory()) {
				walk(p);
			} else if (entry.name.endsWith('.jsonl')) {
				const m = statSync(p).mtimeMs;
				if (!best || m > best.mtimeMs) {
					best = { path: p, mtimeMs: m };
				}
			}
		}
	};
	walk(dir);
	return best?.path;
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
const outDir = resolve(flag('--out') ?? join(tmpdir(), `vssaros-crawl-${stamp}`));

const onlyExtract = flag('--only-extract');
if (onlyExtract) {
	const file = resolve(onlyExtract);
	if (!existsSync(file)) {
		fail(`找不到 ${file}`, '检查路径；或用 --dry-run 先看会跑什么命令');
	}
	const mod = await extractor();
	if (!mod) {
		fail('找不到 vssaros-web-content-import 的 urlList.js', '请在开发仓里运行（它依赖同级的 vssaros-web-content-import 插件）');
	}
	mkdirSync(outDir, { recursive: true });
	const urls = mod.extractUrlsFromText(readFileSync(file, 'utf8'), file);
	if (!urls.length) {
		fail('这个 JSONL 里没抽到 URL', '确认它是 MediaCrawler 的产出行；字段名支持 note_url/aweme_url/content_url/video_url/url…');
	}
	const urlsFile = join(outDir, 'urls.txt');
	writeFileSync(urlsFile, urls.join('\n') + '\n', 'utf8');
	say({ ok: true, jsonl: file, outDir, count: urls.length, urlsFile, sample: urls.slice(0, 3) }, 0);
}

const platform = flag('--platform');
if (!platform) {
	fail('缺少 --platform', `可选：${PLATFORMS.join(' / ')}`);
}
if (!PLATFORMS.includes(platform)) {
	fail(`不认识的平台：${platform}`, `可选：${PLATFORMS.join(' / ')}`);
}
const keywords = (flag('--keywords') ?? '').trim();
if (!keywords) {
	fail('缺少 --keywords', '给一个或多个关键词（逗号分隔）；不要自行扩大抓取范围');
}

const crawler = resolveCrawlerDir();
if (!crawler.dir) {
	fail('找不到 MediaCrawler 目录', '用法：--crawler <MediaCrawler 目录>，或设环境变量 MEDIACRAWLER_DIR');
}
if (!existsSync(join(crawler.dir, 'main.py'))) {
	fail(`${crawler.dir} 里没有 main.py`, '确认 --crawler 指向 MediaCrawler 仓根（含 main.py / cmd_arg/）');
}

const login = flag('--login') ?? 'cookie';
if (!['cookie', 'qrcode', 'phone'].includes(login)) {
	fail(`不认识的登录方式：${login}`, 'cookie（已登录过，推荐）/ qrcode（需要人扫码，非交互环境会卡住）');
}
const type = flag('--type') ?? 'search';
const timeoutMs = Number(flag('--timeout-ms') ?? 15 * 60 * 1000);

// ⚠ 命令里**不许**出现用户原文以外的任何东西；关键词用引号包住（含空格/中文都安全）
const args = ['run', 'python', 'main.py', '--platform', platform, '--lt', login, '--type', type, '--keywords', keywords];
// 只用于展示/日志：含空格、引号或**非 ASCII**（中文关键词）的实参一律加引号，
// 免得人照着抄时把 `职场,面试` 拆成两个参数（真实执行走 spawn 的 args，不经过这串）。
const quote = (a) => (/[\s"']|[^\x20-\x7E]/.test(a) ? `"${a}"` : a);
const printable = `cd "${crawler.dir}" ; $env:SAVE_DATA_PATH="${outDir}" ; uv ${args.map(quote).join(' ')}`;

if (has('--dry-run')) {
	say({ ok: true, dryRun: true, platform, keywords, crawlerDir: crawler.dir, crawlerFrom: crawler.from, outDir, command: printable }, 0);
}

mkdirSync(outDir, { recursive: true });
const run = spawnSync('uv', args, {
	cwd: crawler.dir,
	encoding: 'utf8',
	timeout: timeoutMs,
	// ★ 2026-10-21：缺 windowsHide ⇒ Windows 上会闪一叠黑框（点 agent 条目即弹 console 窗口那族问题）
	windowsHide: true,
	env: { ...process.env, SAVE_DATA_PATH: outDir, PYTHONIOENCODING: 'utf-8' },
	shell: process.platform === 'win32',
});
const tail = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim().split('\n').slice(-20).join('\n');

if (run.error) {
	const hint = /ENOENT/.test(String(run.error?.code ?? run.error?.message))
		? '这台机器没有 uv（或不在 PATH 里）：先装 uv，或改用 python main.py 手动跑一次'
		: '看 tail 里的最后 20 行输出';
	fail(`启动爬虫失败：${String(run.error?.message ?? run.error)}`, hint);
}
if (run.status !== 0) {
	const hint = /login|login state|登录|cookie|qrcode|扫码/i.test(tail)
		? '登录态失效/缺失：先在有人值守的终端跑一次（--login qrcode）完成扫码，再用 --login cookie 跑本命令'
		: (/ModuleNotFoundError|No module named|playwright/i.test(tail)
			? '依赖缺失：不要自动安装；把 tail 报给用户，让人决定是否 `uv sync`'
			: '抓取失败：把 tail 报给用户，不要反复重试（会触发风控）');
	fail(`爬虫退出码 ${run.status}`, hint);
}

const jsonl = newestJsonl(outDir);
if (!jsonl) {
	fail('爬虫跑完了但没找到 .jsonl 产物', `确认 SAVE_DATA_PATH 生效；目录是 ${outDir}（看 tail 里的输出路径）`);
}

const mod = await extractor();
const urls = mod ? mod.extractUrlsFromText(readFileSync(jsonl, 'utf8'), jsonl) : [];
if (!urls.length) {
	fail('产物里没抽到 URL', '可能是这次的搜索确实为空（换个关键词），或 MediaCrawler 改了输出字段名');
}
const urlsFile = join(outDir, 'urls.txt');
writeFileSync(urlsFile, urls.join('\n') + '\n', 'utf8');
say({ ok: true, platform, keywords, crawlerDir: crawler.dir, outDir, jsonl, count: urls.length, urlsFile, sample: urls.slice(0, 3) }, 0);
