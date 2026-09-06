#!/usr/bin/env node
/**
 * fetch-ffmpeg.mjs — 下载 ffmpeg/ffprobe 静态二进制到 build/saros/bin/
 *
 * 用途：让 vssaros.exe「默认自带 ffmpeg」——打包时 strip-before-pack.mjs 的
 * ensureFile 会把这里的 ffmpeg.exe/ffprobe.exe 落到 resources/saros/bin/，
 * vox 口播视频节点（assemble 合成 + zoompan 动效）即可零用户操作直接使用。
 *
 * 用法：
 *   node build/saros/fetch-ffmpeg.mjs              # 默认 BtbN GitHub (含 libx264)
 *   node build/saros/fetch-ffmpeg.mjs --url <zip>  # 自定义下载源
 *   node build/saros/fetch-ffmpeg.mjs --check-only # 仅检查是否已就位
 *
 * 下载源（Windows x64，zip 内含 ffmpeg.exe + ffprobe.exe）：
 *   1. BtbN/FFmpeg-Builds (GPL，含 libx264，~180MB)
 *      https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip
 *   2. gyan.dev essentials (LGPL，~85MB，无 libx264)
 *      https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip
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
const ROOT = resolve(__dirname, '../..');

const args = process.argv.slice(2);
const urlArg = args.indexOf('--url');
const CUSTOM_URL = urlArg >= 0 ? args[urlArg + 1] : undefined;
const CHECK_ONLY = args.includes('--check-only');

const DEFAULT_URL = 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip';
// 切勿命名为 URL：模块级 const URL 会遮蔽全局 URL 构造器，
// 令下方重定向处理里的 `new URL(loc, url)` 抛 "TypeError: URL is not a constructor"
// （2026-09-06 CI 事故，ffmpeg 下载静默失败）。
const FFMPEG_ZIP_URL = CUSTOM_URL || DEFAULT_URL;

const FFMPEG = join(BIN_DIR, 'ffmpeg.exe');
const FFPROBE = join(BIN_DIR, 'ffprobe.exe');

function log(msg) { console.log(msg); }

function isReady() {
	return existsSync(FFMPEG) && existsSync(FFPROBE);
}

function verifyBinary(p) {
	if (!existsSync(p)) { return false; }
	try {
		execSync(`"${p}" -version`, { stdio: 'ignore', timeout: 15000 });
		return true;
	} catch {
		return false;
	}
}

if (CHECK_ONLY) {
	if (isReady()) {
		log(`✅ ffmpeg 已就位: ${FFMPEG} (${(statSync(FFMPEG).size / 1024 / 1024).toFixed(1)}MB)`);
		log(`✅ ffprobe 已就位: ${FFPROBE}`);
		process.exit(0);
	}
	log('❌ ffmpeg/ffprobe 未就位，运行: node build/saros/fetch-ffmpeg.mjs');
	process.exit(1);
}

if (isReady() && verifyBinary(FFMPEG) && verifyBinary(FFPROBE)) {
	log(`✅ ffmpeg 已存在且可用，跳过下载（${FFMPEG}）`);
	log('   如需强制重新下载：先删除 build/saros/bin/ffmpeg.exe 与 ffprobe.exe');
	process.exit(0);
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
			res.on('end', () => {
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

try {
	await download(FFMPEG_ZIP_URL, zipPath);
	log('✅ 下载完成，解压中...');

	rmSync(extractDir, { recursive: true, force: true });
	mkdirSync(extractDir, { recursive: true });
	execSync(
		`powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
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
		log('');
		log('下一步：重新打包（strip-before-pack.mjs 会自动落到 resources/saros/bin/）。');
		process.exit(0);
	} else {
		throw new Error('复制后 ffmpeg 无法执行（-version 校验失败），可能下载损坏');
	}
} catch (err) {
	// 失败路径同样要清理本进程的临时文件，避免残留污染下一次复用同一工作区的构建。
	rmSync(zipPath, { force: true });
	rmSync(extractDir, { recursive: true, force: true });
	log(`❌ 下载/解压失败: ${err.message}`);
	log('');
	log('手动方案：');
	log('  1. 从 https://www.gyan.dev/ffmpeg/builds/ 下载 ffmpeg-release-essentials.zip');
	log('  2. 解压后把 bin/ffmpeg.exe 和 bin/ffprobe.exe 放到:');
	log(`     ${BIN_DIR}`);
	log('  3. 或用 --url 指定镜像: node build/saros/fetch-ffmpeg.mjs --url <你的zip>');
	process.exit(1);
}
