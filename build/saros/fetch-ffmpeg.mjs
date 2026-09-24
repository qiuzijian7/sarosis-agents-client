#!/usr/bin/env node
/**
 * fetch-ffmpeg.mjs — 下载 ffmpeg / ffprobe / yt-dlp 静态二进制到 build/saros/bin/
 *
 * 用途：让 vssaros.exe「默认自带媒体工具链」——打包时 strip-before-pack.mjs 的
 * ensureOptionalBin 会把这里的三个 exe 落到 <install>/resources/saros/bin/，于是：
 *   · vox 口播视频节点（assemble 合成 + zoompan 动效）零用户操作可用；
 *   · 抽帧工具 `extract_video_frames` / 视频理解工具 `video_analyze` 开箱可用
 *     （此前这两个工具依赖用户本机 PATH 里有 ffmpeg/yt-dlp，绝大多数机器上都没有
 *      ⇒ 工具只能返回「请先安装」的指引，能力等于不存在）。
 *
 * ★ 2026-09-24：本脚本从「只取 ffmpeg」扩展为「取全套媒体二进制」。
 *   文件名保持 fetch-ffmpeg.mjs 不变（CI / 文档 / strip-before-pack 的提示文案都引用它），
 *   语义按「媒体二进制获取器」理解。
 *
 * 用法：
 *   node build/saros/fetch-ffmpeg.mjs                    # ffmpeg+ffprobe+yt-dlp 全取
 *   node build/saros/fetch-ffmpeg.mjs --check-only       # 仅检查三者是否已就位
 *   node build/saros/fetch-ffmpeg.mjs --skip-ytdlp       # 只要 ffmpeg/ffprobe
 *   node build/saros/fetch-ffmpeg.mjs --url <zip>        # ffmpeg 自定义下载源（zip）
 *   node build/saros/fetch-ffmpeg.mjs --ytdlp-url <exe>  # yt-dlp 自定义下载源（单 exe）
 *
 * 下载源（Windows x64）：
 *   ffmpeg/ffprobe（zip 内含两个 exe）：
 *     1. BtbN/FFmpeg-Builds (GPL，含 libx264，~180MB)
 *        https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip
 *     2. gyan.dev essentials (LGPL，~85MB，无 libx264)
 *        https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip
 *   yt-dlp（单文件 exe，~17MB，官方独立构建，自带 Python 运行时）：
 *     https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe
 *
 * 解压依赖 PowerShell Expand-Archive（Windows 自带）。
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWriteStream } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = .../build/saros
const BIN_DIR = join(__dirname, 'bin');

const args = process.argv.slice(2);
const urlArg = args.indexOf('--url');
const CUSTOM_URL = urlArg >= 0 ? args[urlArg + 1] : undefined;
const ytdlpUrlArg = args.indexOf('--ytdlp-url');
const CUSTOM_YTDLP_URL = ytdlpUrlArg >= 0 ? args[ytdlpUrlArg + 1] : undefined;
const CHECK_ONLY = args.includes('--check-only');
const SKIP_YTDLP = args.includes('--skip-ytdlp');

const DEFAULT_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip';
const DEFAULT_YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
// 切勿命名为 URL：模块级 const URL 会遮蔽全局 URL 构造器，
// 令下方重定向处理里的 `new URL(loc, url)` 抛 "TypeError: URL is not a constructor"
// （2026-09-06 CI 事故，ffmpeg 下载静默失败）。
const FFMPEG_ZIP_URL = CUSTOM_URL || DEFAULT_URL;
const YTDLP_EXE_URL = CUSTOM_YTDLP_URL || DEFAULT_YTDLP_URL;

const FFMPEG = join(BIN_DIR, 'ffmpeg.exe');
const FFPROBE = join(BIN_DIR, 'ffprobe.exe');
const YTDLP = join(BIN_DIR, 'yt-dlp.exe');

const FETCH_HINT = '获取: node build/saros/fetch-ffmpeg.mjs';

function log(msg) { console.log(msg); }

function isFfmpegReady() {
	return existsSync(FFMPEG) && existsSync(FFPROBE);
}

function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 刚 cpSync 落盘的 ~80MB exe 立即执行常被系统占用/杀软扫描挡住（Windows 上报
// "The process cannot access the file"），并非二进制损坏 —— 2026-09-07 CI 因此把
// 已正确安装的 ffmpeg 判为"下载损坏"并 exit 1。故失败要重试。
function verifyBinary(p, versionFlag = '-version', attempts = 3) {
	if (!existsSync(p)) { return false; }
	for (let i = 1; i <= attempts; i++) {
		try {
			execSync(`"${p}" ${versionFlag}`, { stdio: 'ignore', timeout: 15000 });
			return true;
		} catch (e) {
			if (i === attempts) {
				log(`   ⚠️ ${p} ${versionFlag} 校验失败（第 ${i}/${attempts} 次）: ${e.message.split('\n')[0]}`);
				return false;
			}
			sleepSync(1500);
		}
	}
	return false;
}

function download(url, dest) {
	return new Promise((resolvePromise, reject) => {
		const mod = url.startsWith('https:') ? httpsRequest : httpRequest;
		const req = mod(url, { headers: { 'User-Agent': 'VsSaros/1.0' } }, (res) => {
			const code = res.statusCode ?? 0;
			if (code === 301 || code === 302 || code === 303 || code === 307 || code === 308) {
				res.resume();
				const loc = res.headers.location;
				if (loc) {
					log(`   跟随重定向 → ${loc}`);
					download(new URL(loc, url).toString(), dest).then(resolvePromise, reject);
				} else {
					reject(new Error('重定向缺少 Location'));
				}
				return;
			}
			if (code < 200 || code >= 300) {
				res.resume();
				reject(new Error(`HTTP ${code}`));
				return;
			}
			const total = Number(res.headers['content-length'] ?? -1);
			let downloaded = 0;
			const file = createWriteStream(dest);
			res.on('data', (chunk) => {
				downloaded += chunk.length;
				if (total > 0 && downloaded % (20 * 1024 * 1024) < chunk.length) {
					const pct = ((downloaded / total) * 100).toFixed(1);
					process.stdout.write(`\r   进度: ${(downloaded / 1024 / 1024).toFixed(0)}/${(total / 1024 / 1024).toFixed(0)}MB (${pct}%)`);
				}
			});
			res.on('error', reject);
			file.on('error', reject);
			// 必须等【写流 close】而非 res 'end'：响应结束时数据仍在内核/流缓冲里，
			// 文件句柄未释放，紧接着的 Expand-Archive 会报
			// "The process cannot access the file ... because it is being used by another process"
			// （2026-09-07 CI 事故：163MB 下完立刻解压失败，ffmpeg 静默缺失）。
			file.on('close', () => {
				process.stdout.write('\n');
				resolvePromise();
			});
			res.pipe(file);
		});
		req.on('error', reject);
		req.end();
	});
}

function findBinaries(dir) {
	// 递归找 ffmpeg.exe / ffprobe.exe（BtbN 解压后是 ffmpeg-master-*/bin/*.exe）
	const out = execSync(
		`powershell -NoProfile -Command "Get-ChildItem -Path '${dir.replace(/'/g, "''")}' -Recurse -Filter '*.exe' | Where-Object { $_.Name -in @('ffmpeg.exe','ffprobe.exe') } | ForEach-Object { $_.FullName }"`,
		{ encoding: 'utf8' },
	).trim();
	return out.split('\n').filter(Boolean).map(s => s.trim());
}

/** 取 ffmpeg + ffprobe（zip 分发，一次下载两个 exe）。返回是否成功。 */
async function fetchFfmpeg() {
	if (isFfmpegReady() && verifyBinary(FFMPEG) && verifyBinary(FFPROBE)) {
		log(`✅ ffmpeg 已存在且可用，跳过下载（${FFMPEG}）`);
		log('   如需强制重新下载：先删除 build/saros/bin/ffmpeg.exe 与 ffprobe.exe');
		return true;
	}

	mkdirSync(BIN_DIR, { recursive: true });

	// 下载 zip 到临时目录。
	// 临时文件名必须按进程唯一：CI 复用同一工作区，上次被强杀的构建可能仍持有
	// _ffmpeg_tmp.zip 的句柄，固定名会报 "because it is being used by another process"，
	// 导致 ffmpeg 静默缺失（安装包丢掉配音/视频能力）。
	const tmpTag = `${process.pid}_${Date.now()}`;
	const zipPath = join(BIN_DIR, `_ffmpeg_tmp_${tmpTag}.zip`);
	const extractDir = join(BIN_DIR, `_ffmpeg_extract_${tmpTag}`);

	log(`⬇️  下载 ffmpeg: ${FFMPEG_ZIP_URL}`);
	log(`   目标: ${BIN_DIR}`);

	try {
		await download(FFMPEG_ZIP_URL, zipPath);
		const zipSize = statSync(zipPath).size;
		if (zipSize < 10 * 1024 * 1024) {
			throw new Error(`下载的 zip 过小（${(zipSize / 1024 / 1024).toFixed(1)}MB），疑似被拦截或截断`);
		}
		log(`✅ 下载完成（${(zipSize / 1024 / 1024).toFixed(1)}MB），解压中...`);

		rmSync(extractDir, { recursive: true, force: true });
		mkdirSync(extractDir, { recursive: true });
		// -ErrorAction Stop：Expand-Archive 的错误默认非终止，powershell 仍退出 0，
		// 会让解压失败伪装成「解压后未找到 ffmpeg.exe」，掩盖真实原因。
		execSync(
			`powershell -NoProfile -Command "$ErrorActionPreference='Stop'; Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
			{ stdio: 'inherit' },
		);

		const bins = findBinaries(extractDir);
		const ffmpegSrc = bins.find(p => p.toLowerCase().endsWith('ffmpeg.exe'));
		const ffprobeSrc = bins.find(p => p.toLowerCase().endsWith('ffprobe.exe'));

		if (!ffmpegSrc || !ffprobeSrc) {
			throw new Error(`解压后未找到 ffmpeg.exe/ffprobe.exe。找到的二进制: ${bins.join(', ') || '(无)'}`);
		}

		cpSync(ffmpegSrc, FFMPEG);
		cpSync(ffprobeSrc, FFPROBE);

		// 清理临时文件
		rmSync(zipPath, { force: true });
		rmSync(extractDir, { recursive: true, force: true });

		if (verifyBinary(FFMPEG) && verifyBinary(FFPROBE)) {
			log(`✅ ffmpeg 已安装到 ${FFMPEG} (${(statSync(FFMPEG).size / 1024 / 1024).toFixed(1)}MB)`);
			log(`✅ ffprobe 已安装到 ${FFPROBE} (${(statSync(FFPROBE).size / 1024 / 1024).toFixed(1)}MB)`);
			return true;
		}
		throw new Error('复制后 ffmpeg 无法执行（-version 校验失败），可能下载损坏');
	} catch (err) {
		// 失败路径同样要清理本进程的临时文件，避免残留污染下一次复用同一工作区的构建。
		rmSync(zipPath, { force: true });
		rmSync(extractDir, { recursive: true, force: true });
		log(`❌ ffmpeg 下载/解压失败: ${err.message}`);
		log('');
		log('手动方案：');
		log('  1. 从 https://www.gyan.dev/ffmpeg/builds/ 下载 ffmpeg-release-essentials.zip');
		log('  2. 解压后把 bin/ffmpeg.exe 和 bin/ffprobe.exe 放到:');
		log(`     ${BIN_DIR}`);
		log('  3. 或用 --url 指定镜像: node build/saros/fetch-ffmpeg.mjs --url <你的zip>');
		return false;
	}
}

/**
 * 取 yt-dlp（**单文件 exe** —— 官方 standalone 构建自带 Python 运行时，
 * 因此不需要用户装 Python，也不依赖 PATH）。
 *
 * 为什么必须随包：远端视频（抖音/小红书/B站/YouTube…）的**下载与字幕**全靠它；
 * 用户机器上几乎不会自带 ⇒ 抽帧/视频理解对链接类输入等于不可用。
 */
async function fetchYtDlp() {
	if (existsSync(YTDLP) && verifyBinary(YTDLP, '--version')) {
		log(`✅ yt-dlp 已存在且可用，跳过下载（${YTDLP}）`);
		log('   如需强制重新下载：先删除 build/saros/bin/yt-dlp.exe');
		return true;
	}

	mkdirSync(BIN_DIR, { recursive: true });
	const tmpPath = join(BIN_DIR, `_ytdlp_tmp_${process.pid}_${Date.now()}.exe`);
	log(`⬇️  下载 yt-dlp: ${YTDLP_EXE_URL}`);

	try {
		await download(YTDLP_EXE_URL, tmpPath);
		const size = statSync(tmpPath).size;
		// yt-dlp.exe 约 17MB；过小基本是 GitHub 的 HTML 错误页或重定向截断
		if (size < 5 * 1024 * 1024) {
			throw new Error(`下载的 yt-dlp 过小（${(size / 1024 / 1024).toFixed(1)}MB），疑似被拦截或截断`);
		}
		cpSync(tmpPath, YTDLP);
		rmSync(tmpPath, { force: true });
		if (verifyBinary(YTDLP, '--version')) {
			log(`✅ yt-dlp 已安装到 ${YTDLP} (${(size / 1024 / 1024).toFixed(1)}MB)`);
			return true;
		}
		// 校验失败 ⇒ 清掉这个「存在但不可执行」的文件：留着会让 strip-before-pack
		// 认为构件齐全而打进安装包（用户侧表现为「工具说缺 yt-dlp」但文件明明在）。
		rmSync(YTDLP, { force: true });
		throw new Error('复制后 yt-dlp 无法执行（--version 校验失败），可能下载损坏');
	} catch (err) {
		rmSync(tmpPath, { force: true });
		log(`❌ yt-dlp 下载失败: ${err.message}`);
		log('');
		log('手动方案：');
		log('  1. 从 https://github.com/yt-dlp/yt-dlp/releases/latest 下载 yt-dlp.exe');
		log(`  2. 放到: ${BIN_DIR}`);
		log('  3. 或指定镜像: node build/saros/fetch-ffmpeg.mjs --ytdlp-url <exe 直链>');
		log('  4. 只想跳过它（不再需要远端视频下载）: node build/saros/fetch-ffmpeg.mjs --skip-ytdlp');
		return false;
	}
}

// ─── 主流程 ────────────────────────────────────────────────────────────────

if (CHECK_ONLY) {
	const ffOk = isFfmpegReady();
	const ytOk = existsSync(YTDLP);
	if (ffOk) {
		log(`✅ ffmpeg 已就位: ${FFMPEG} (${(statSync(FFMPEG).size / 1024 / 1024).toFixed(1)}MB)`);
		log(`✅ ffprobe 已就位: ${FFPROBE}`);
	} else {
		log('❌ ffmpeg/ffprobe 未就位');
	}
	if (SKIP_YTDLP) {
		log('⏭️  yt-dlp 检查已跳过（--skip-ytdlp）');
	} else if (ytOk) {
		log(`✅ yt-dlp 已就位: ${YTDLP} (${(statSync(YTDLP).size / 1024 / 1024).toFixed(1)}MB)`);
	} else {
		log('❌ yt-dlp 未就位（远端视频下载/字幕不可用）');
	}
	if (!ffOk || (!ytOk && !SKIP_YTDLP)) {
		log(`\n运行补齐: ${FETCH_HINT}`);
		process.exit(1);
	}
	process.exit(0);
}

const ffOk = await fetchFfmpeg();
const ytOk = SKIP_YTDLP ? true : await fetchYtDlp();

if (!ffOk) {
	log('');
	log('💥 ffmpeg 缺失：不要带病出包（抽帧/vox 视频都会降级为「请先安装」提示）。');
	process.exit(1);
}
if (!ytOk) {
	log('');
	log('💥 yt-dlp 缺失：安装包将无法下载远端视频（抽帧/视频理解对链接类输入不可用）。');
	log('   若本次确实不需要该能力，可显式跳过：node build/saros/fetch-ffmpeg.mjs --skip-ytdlp');
	process.exit(1);
}

log('');
log('下一步：重新打包（strip-before-pack.mjs 会把三个 exe 落到 resources/saros/bin/，');
log('        运行时由 mediaBinaries.ts 优先解析内置路径，无需用户装任何东西）。');
process.exit(0);
