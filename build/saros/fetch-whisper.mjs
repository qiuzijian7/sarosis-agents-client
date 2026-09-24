#!/usr/bin/env node
/**
 * fetch-whisper.mjs — 下载 whisper.cpp（本地 ASR）到 build/saros/bin/，模型到 build/saros/models/
 *
 * 用途（2026-09-25，方案②：用户拍板走本地 ASR 而非云端音频模型）：
 * `video_analyze` 目前的口播内容只能走 yt-dlp 字幕轨，而小红书/抖音教程**没有字幕轨**
 * （口播在画面里）⇒ 模型只能看帧 ⇒ 「口播内容不可知」。whisper.cpp 补上最后一环：
 *   yt-dlp 下载视频 → ffmpeg 提音轨（16kHz mono wav）→ whisper-cli 转写 ⇒ 本地、离线、
 *   不依赖任何外部模型的口播文本。
 *
 * 与 fetch-ffmpeg.mjs 同模式：唯一临时文件名 / 写流 close 后再解压 / 下载体积合理性检查 /
 * 失败清理 + 手动方案指引。**刻意独立成脚本**：whisper 带 ~75–466MB 模型文件，生命周期与
 * ffmpeg 不同；也不进 fetch-ffmpeg 的默认路径，避免给 CI 静默加大约 150MB 下载。
 *
 * ⚠ 打包接线（strip-before-pack 的 ensureOptionalBin + mediaBinaries.ts 解析）**暂未做**：
 *   是否把模型打进安装包是体积决策（base ≈142MB），等 ASR 管线落地时一起定。
 *
 * 用法：
 *   node build/saros/fetch-whisper.mjs                     # 二进制 + 默认模型(base)
 *   node build/saros/fetch-whisper.mjs --model tiny        # 指定模型（tiny/base/small/...）
 *   node build/saros/fetch-whisper.mjs --check-only        # 仅检查是否就位
 *   node build/saros/fetch-whisper.mjs --skip-model        # 只取二进制
 *   node build/saros/fetch-whisper.mjs --skip-selftest     # 跳过安装后的转写自检
 *   node build/saros/fetch-whisper.mjs --whisper-url <zip> # 自定义二进制源
 *   node build/saros/fetch-whisper.mjs --model-url <bin>   # 自定义模型源
 *
 * 下载源（Windows x64）：
 *   二进制（zip 内含 whisper-cli.exe + whisper.dll/ggml*.dll，DLL 必须与 exe 同目录）：
 *     https://github.com/ggerganov/whisper.cpp/releases/latest/download/whisper-bin-x64.zip
 *   模型（ggml；HuggingFace，国内自动回落 hf-mirror.com）：
 *     https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<model>.bin
 *
 * 仅支持 Windows x64 预编译包；macOS/Linux 请用 brew install whisper-cpp 或源码构建，
 * 然后把可执行文件放进 build/saros/bin/（解析侧按同名查找）。
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync, statSync, createWriteStream, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = .../build/saros
const BIN_DIR = join(__dirname, 'bin');
const MODEL_DIR = join(__dirname, 'models');

const args = process.argv.slice(2);
function optValue(name) {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}
const CUSTOM_WHISPER_URL = optValue('--whisper-url');
const CUSTOM_MODEL_URL = optValue('--model-url');
const MODEL_NAME = optValue('--model') ?? 'base';
const CHECK_ONLY = args.includes('--check-only');
const SKIP_MODEL = args.includes('--skip-model');
const SKIP_SELFTEST = args.includes('--skip-selftest');

// ⚠ 不能用 releases/latest/download：whisper.cpp 从 v1.9.3 起 release **不再挂任何资产**
// （实测 2026-09-25：latest=v1.9.4 assets=0 ⇒ 404）。钉在最后一个带 Windows 预编译包的
// 稳定版 v1.9.2（b51xx 是 CI 预发布，不追）。升级时改这里并重跑本脚本验证。
// 另：仓库已从 ggerganov/whisper.cpp 迁至 ggml-org/whisper.cpp（旧地址会 301，写新地址省去一跳）。
const DEFAULT_WHISPER_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip';
const WHISPER_ZIP_URL = CUSTOM_WHISPER_URL || DEFAULT_WHISPER_URL;
// HuggingFace 在国内常被墙/极慢 ⇒ 主源失败后自动回落 hf-mirror.com（同一文件，社区镜像）。
const MODEL_URLS = CUSTOM_MODEL_URL
	? [CUSTOM_MODEL_URL]
	: [
		`https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL_NAME}.bin`,
		`https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL_NAME}.bin`,
	];

const WHISPER = join(BIN_DIR, 'whisper-cli.exe');
const MODEL = join(MODEL_DIR, `ggml-${MODEL_NAME}.bin`);

/** 各模型档位的大小下限（用于"下载被拦截/截断"判定）。tiny ≈75MB，base ≈142MB，small ≈466MB。 */
const MODEL_MIN_BYTES = 30 * 1024 * 1024;

const FETCH_HINT = '获取: node build/saros/fetch-whisper.mjs';

function log(msg) { console.log(msg); }

function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * whisper-cli 没有可靠的 `--version`（--help 的退出码各版本不一致），
 * 所以校验标准是「能运行且输出长得像 whisper 用法说明」，容忍非零退出码。
 */
function verifyWhisper(attempts = 3) {
	if (!existsSync(WHISPER)) { return false; }
	for (let i = 1; i <= attempts; i++) {
		const r = spawnSync(`"${WHISPER}"`, ['--help'], { shell: true, encoding: 'utf8', timeout: 20000 });
		const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
		if (/whisper/i.test(out) && out.length > 100) { return true; }
		if (i === attempts) {
			log(`   ⚠️ whisper-cli --help 校验失败（第 ${i}/${attempts} 次）: ${(r.error?.message ?? out.slice(0, 120))}`);
			return false;
		}
		// 刚落盘的 exe 立即执行可能被系统/杀软占用（同 fetch-ffmpeg 的 2026-09-07 CI 教训）
		sleepSync(1500);
	}
	return false;
}

/**
 * ggml/gguf 模型文件头校验。
 * ⚠ whisper 的 ggml magic 是 uint32 字面量 0x67676d6c —— 落盘是**小端字节序**，
 *   前 4 字节读作 ASCII 是 "lmgg" 而**不是** "ggml"（本脚本初版就栽在这里：
 *   141MB 模型下载成功却被误判为错误页删掉）。GGUF 格式则是 ASCII "GGUF" 原序。
 */
function verifyModelFile(p) {
	if (!existsSync(p)) { return false; }
	if (statSync(p).size < MODEL_MIN_BYTES) { return false; }
	const head = readFileSync(p).subarray(0, 4).toString('ascii');
	return head === 'lmgg' || head === 'GGUF';
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
			// 必须等【写流 close】而非 res 'end'（fetch-ffmpeg 2026-09-07 CI 事故：数据仍在内核缓冲，
			// 紧接着解压会报 "being used by another process"）。
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

/** 递归列出目录下所有文件（whisper zip 结构不承诺层级，不赌它平铺）。 */
function listFilesRecursive(dir) {
	const out = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) { out.push(...listFilesRecursive(p)); } else { out.push(p); }
	}
	return out;
}

/**
 * 取 whisper-cli.exe + 全部 DLL（zip 分发）。
 * DLL 必须与 exe 同目录（whisper.dll / ggml*.dll 是运行时依赖，只拷 exe 会起不来）。
 */
async function fetchWhisperBinary() {
	if (verifyWhisper()) {
		log(`✅ whisper-cli 已存在且可用，跳过下载（${WHISPER}）`);
		log('   如需强制重新下载：先删除 build/saros/bin/whisper-cli.exe 及同目录 whisper/ggml DLL');
		return true;
	}
	if (process.platform !== 'win32') {
		log(`❌ 本脚本只支持 Windows x64 预编译包（当前 ${process.platform}/${process.arch}）。`);
		log('   macOS: brew install whisper-cpp；或从 https://github.com/ggerganov/whisper.cpp 源码构建，');
		log(`   把可执行文件放到 ${BIN_DIR}（解析侧按同名查找）。`);
		return false;
	}

	mkdirSync(BIN_DIR, { recursive: true });
	const tmpTag = `${process.pid}_${Date.now()}`;
	const zipPath = join(BIN_DIR, `_whisper_tmp_${tmpTag}.zip`);
	const extractDir = join(BIN_DIR, `_whisper_extract_${tmpTag}`);

	log(`⬇️  下载 whisper.cpp: ${WHISPER_ZIP_URL}`);
	log(`   目标: ${BIN_DIR}`);

	try {
		await download(WHISPER_ZIP_URL, zipPath);
		const zipSize = statSync(zipPath).size;
		if (zipSize < 1024 * 1024) {
			throw new Error(`下载的 zip 过小（${(zipSize / 1024 / 1024).toFixed(1)}MB），疑似被拦截或截断`);
		}
		log(`✅ 下载完成（${(zipSize / 1024 / 1024).toFixed(1)}MB），解压中...`);

		rmSync(extractDir, { recursive: true, force: true });
		mkdirSync(extractDir, { recursive: true });
		// -ErrorAction Stop：Expand-Archive 的错误默认非终止（fetch-ffmpeg 同款教训）。
		execSync(
			`powershell -NoProfile -Command "$ErrorActionPreference='Stop'; Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
			{ stdio: 'inherit' },
		);

		const files = listFilesRecursive(extractDir);
		// 旧版 zip 里的 CLI 叫 main.exe，v1.5+ 改名 whisper-cli.exe —— 统一落盘为 whisper-cli.exe。
		const cliSrc = files.find(p => /whisper-cli\.exe$/i.test(p)) ?? files.find(p => /(^|[\\/])main\.exe$/i.test(p));
		const dlls = files.filter(p => /\.dll$/i.test(p));
		if (!cliSrc) {
			throw new Error(`解压后未找到 whisper-cli.exe/main.exe。内容: ${files.map(f => f.slice(extractDir.length)).join(', ') || '(无)'}`);
		}
		if (dlls.length === 0) {
			throw new Error('解压后未找到任何 DLL（whisper.dll/ggml*.dll 是运行时依赖，缺了 exe 起不来）');
		}

		cpSync(cliSrc, WHISPER);
		for (const d of dlls) { cpSync(d, join(BIN_DIR, d.slice(d.lastIndexOf('\\') + 1).replace(/^.*\//, ''))); }

		rmSync(zipPath, { force: true });
		rmSync(extractDir, { recursive: true, force: true });

		if (verifyWhisper()) {
			log(`✅ whisper-cli 已安装到 ${WHISPER}（含 ${dlls.length} 个 DLL）`);
			return true;
		}
		rmSync(WHISPER, { force: true });
		throw new Error('复制后 whisper-cli 无法执行（--help 校验失败），可能下载损坏');
	} catch (err) {
		rmSync(zipPath, { force: true });
		rmSync(extractDir, { recursive: true, force: true });
		log(`❌ whisper.cpp 下载/解压失败: ${err.message}`);
		log('');
		log('手动方案：');
		log('  1. 从 https://github.com/ggerganov/whisper.cpp/releases/latest 下载 whisper-bin-x64.zip');
		log('  2. 解压，把 whisper-cli.exe 与全部 .dll 放到:');
		log(`     ${BIN_DIR}`);
		log('  3. 或用 --whisper-url 指定镜像: node build/saros/fetch-whisper.mjs --whisper-url <你的zip>');
		return false;
	}
}

/**
 * 取 ggml 模型（默认 base：中文口播的质量下限；tiny 的中文错字率高，只适合做冒烟）。
 * 主源 HuggingFace，失败自动回落 hf-mirror.com（国内可达性）。
 */
async function fetchModel() {
	if (verifyModelFile(MODEL)) {
		log(`✅ 模型已存在且头校验通过，跳过下载（${MODEL}）`);
		return true;
	}

	mkdirSync(MODEL_DIR, { recursive: true });
	const tmpPath = join(MODEL_DIR, `_model_tmp_${process.pid}_${Date.now()}.bin`);

	for (const url of MODEL_URLS) {
		log(`⬇️  下载模型 ggml-${MODEL_NAME}.bin: ${url}`);
		try {
			await download(url, tmpPath);
			const size = statSync(tmpPath).size;
			if (size < MODEL_MIN_BYTES) {
				throw new Error(`模型文件过小（${(size / 1024 / 1024).toFixed(1)}MB），疑似被拦截或截断`);
			}
			cpSync(tmpPath, MODEL);
			rmSync(tmpPath, { force: true });
			if (verifyModelFile(MODEL)) {
				log(`✅ 模型已安装到 ${MODEL} (${(size / 1024 / 1024).toFixed(1)}MB)`);
				return true;
			}
			rmSync(MODEL, { force: true });
			throw new Error('模型头校验失败（不是 ggml/GGUF 格式），可能下到错误页');
		} catch (err) {
			rmSync(tmpPath, { force: true });
			log(`   ⚠️ 该源失败: ${err.message}`);
		}
	}

	log(`❌ 模型下载失败（已试 ${MODEL_URLS.length} 个源）`);
	log('');
	log('手动方案：');
	log(`  1. 下载 ggml-${MODEL_NAME}.bin（https://huggingface.co/ggerganov/whisper.cpp/tree/main 或 hf-mirror.com 同名仓库）`);
	log(`  2. 放到: ${MODEL}`);
	log('  3. 或指定镜像: node build/saros/fetch-whisper.mjs --model-url <bin 直链>');
	return false;
}

/**
 * 端到端自检（best-effort）：Windows SAPI 合成一句英文 → 内置 ffmpeg 转 16kHz mono →
 * whisper-cli 转写 → 输出必须含 "hello"。
 * 之所以值得做：「exe 能跑」≠「能转写」（DLL/模型缺了也能过 --help）；这是唯一不依赖
 * 外网素材的全链路判据。失败只警告不阻断（SAPI 语音包可能缺失，属环境因素）。
 */
function selfTest() {
	const FFMPEG = join(BIN_DIR, 'ffmpeg.exe');
	if (!existsSync(FFMPEG)) {
		log('⚠️ 自检跳过：内置 ffmpeg 不在（先跑 node build/saros/fetch-ffmpeg.mjs）');
		return;
	}
	const tmpTag = `${process.pid}_${Date.now()}`;
	const rawWav = join(MODEL_DIR, `_selftest_raw_${tmpTag}.wav`);
	const wav = join(MODEL_DIR, `_selftest_${tmpTag}.wav`);
	try {
		execSync(
			`powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${rawWav}'); $s.Speak('Hello world. This is a whisper transcription test.'); $s.Dispose()"`,
			{ stdio: 'ignore', timeout: 30000 },
		);
		// whisper.cpp 的 WAV 读取器只认 16kHz mono 16bit —— SAPI 默认输出不是 ⇒ 必经 ffmpeg 转。
		execSync(`"${FFMPEG}" -y -i "${rawWav}" -ar 16000 -ac 1 -c:a pcm_s16le "${wav}"`, { stdio: 'ignore', timeout: 30000 });
		const r = spawnSync(`"${WHISPER}"`, ['-m', `"${MODEL}"`, '-f', `"${wav}"`, '-l', 'en', '--no-timestamps'], { shell: true, encoding: 'utf8', timeout: 120000 });
		const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
		if (/hello/i.test(out)) {
			log('✅ 自检通过：SAPI 合成 → ffmpeg 转码 → whisper 转写，输出含 "hello"');
		} else {
			log('⚠️ 自检未通过（不阻断安装）：转写输出不含 "hello"。输出末尾:');
			log(`   ${out.trim().slice(-300)}`);
		}
	} catch (err) {
		log(`⚠️ 自检执行失败（不阻断安装）: ${err.message.split('\n')[0]}`);
	} finally {
		rmSync(rawWav, { force: true });
		rmSync(wav, { force: true });
	}
}

// ─── 主流程 ────────────────────────────────────────────────────────────────

if (CHECK_ONLY) {
	const binOk = verifyWhisper();
	const modelOk = SKIP_MODEL ? true : verifyModelFile(MODEL);
	if (binOk) {
		log(`✅ whisper-cli 已就位: ${WHISPER}`);
	} else {
		log('❌ whisper-cli 未就位');
	}
	if (SKIP_MODEL) {
		log('⏭️  模型检查已跳过（--skip-model）');
	} else if (modelOk) {
		log(`✅ 模型已就位: ${MODEL} (${(statSync(MODEL).size / 1024 / 1024).toFixed(1)}MB)`);
	} else {
		log(`❌ 模型 ggml-${MODEL_NAME}.bin 未就位（口播转写不可用）`);
	}
	if (!binOk || !modelOk) {
		log(`\n运行补齐: ${FETCH_HINT}`);
		process.exit(1);
	}
	process.exit(0);
}

const binOk = await fetchWhisperBinary();
const modelOk = SKIP_MODEL ? true : await fetchModel();

if (!binOk) {
	log('');
	log('💥 whisper-cli 缺失：本地 ASR 不可用（video_analyze 对无字幕视频仍只能说「口播内容不可知」）。');
	process.exit(1);
}
if (!modelOk) {
	log('');
	log('💥 模型缺失：whisper 无模型可加载。若本次确实不需要 ASR，可显式跳过：--skip-model');
	process.exit(1);
}

if (!SKIP_SELFTEST) { selfTest(); }

log('');
log('打包接线已完成（2026-09-25）：strip-before-pack.mjs 会把 exe+DLL 落到 resources/saros/bin/、');
log('模型落到 resources/saros/models/（缺失仅警告不阻断出包，与 ffmpeg 同级）。');
log('下一步（ASR 管线落地时做）：');
log('  1. mediaBinaries.ts 解析 whisper-cli + 模型（沿用 build/saros 逐级向上 + resources/saros 规则）；');
log('  2. videoMediaPipeline 增加「无字幕轨 ⇒ ffmpeg 提音轨 ⇒ whisper 转写」一步。');
process.exit(0);
