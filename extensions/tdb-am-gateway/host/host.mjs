// @ts-check
/*---------------------------------------------------------------------------------------------
 *  TDB-AM Gateway 独立子进程入口（host.mjs）
 *
 *  本文件由 saros Electron 主进程通过 child_process.fork/spawn 启动。
 *  与 saros renderer 进程隔离，可自由使用 fs/path/http 等 Node 原生模块。
 *
 *  通信方式：
 *    - 配置：通过 process.env 传入（TDAI_* / TDBAM_* 系列变量）
 *    - 健康：通过 stdout 输出结构化 JSON 行 {kind:"ready"|"error"|"log", ...}
 *    - 终止：父进程发送 SIGTERM/SIGINT，本进程做 graceful shutdown
 *
 *  与 renderer 的数据通道：
 *    - vendor TdaiGateway 监听 127.0.0.1:<TDAI_GATEWAY_PORT>（默认 8420）
 *    - renderer 端各扩展通过 fetch HTTP 访问，无需 IPC
 *--------------------------------------------------------------------------------------------*/

import { fileURLToPath, pathToFileURL } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as http from 'node:http';

/** 本文件所在目录，用于解析 vendor 路径。 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 把日志写到 stdout（父进程会监听） + stderr（便于 PowerShell 直接调试）。 */
function emit(kind, payload) {
	const line = JSON.stringify({ kind, ts: Date.now(), ...payload });
	try { process.stdout.write(line + '\n'); } catch { /* ignore */ }
	if (kind === 'error') {
		try { process.stderr.write(line + '\n'); } catch { /* ignore */ }
	}
}

function log(msg) {
	emit('log', { msg });
}

/**
 * 定位 vendor TdaiGateway 编译产物。
 *
 * 候选路径（按可信度排序）：
 *   1. 与本 host 文件同级的 ../out/vendor/tdbam/src/gateway/server.js（独立编译产物，开发时常用）
 *   2. 父进程通过 env TDBAM_GATEWAY_VENDOR_PATH 显式指定
 */
function resolveVendorEntry() {
	const candidates = [];

	// 候选 1：env 显式指定
	const envPath = process.env.TDBAM_GATEWAY_VENDOR_PATH;
	if (envPath && envPath.trim()) {
		candidates.push(envPath.trim());
	}

	// 候选 2：相对本文件 ../out/vendor/tdbam/src/gateway/server.js
	candidates.push(path.resolve(__dirname, '..', 'out', 'vendor', 'tdbam', 'src', 'gateway', 'server.js'));

	// 候选 3：相对本文件 ../../out/vendor/tdbam/src/gateway/server.js（host 嵌得更深时的兜底）
	candidates.push(path.resolve(__dirname, '..', '..', 'out', 'vendor', 'tdbam', 'src', 'gateway', 'server.js'));

	for (const c of candidates) {
		const exists = fs.existsSync(c);
		log(`vendor 候选: ${c} ${exists ? '✅' : '❌'}`);
		if (exists) {
			return c;
		}
	}

	throw new Error(
		`找不到 vendor server.js。请先在 extensions/tdb-am-gateway 运行 'npm run compile:vendor'。`
		+ `已尝试: ${candidates.join(' | ')}`
	);
}

/*---------------------------------------------------------------------------------------------
 *  存量数据清洗（Sanitize）
 *
 *  ─── 背景 ───────────────────────────────────────────────────────────────
 *  早期 chat 渲染链路在某些异步消息片段尚未到达时会用 String(undefined) 拼接
 *  历史，导致 vendor /capture 写入的 assistant_content 中夹杂连续的
 *  "undefined" 字面量串。客户端 chat 侧 + vendor 写入入口（memoryProvider.ts
 *  的 stripUndefinedLiterals）现已堵住所有新数据，但已经写到磁盘 jsonl 的
 *  16 条历史记录里仍有 7 条带脏数据，需要就地清洗。
 *
 *  ─── 数据布局 ──────────────────────────────────────────────────────────
 *  vendor TdaiGateway 把 L0 对话流水写到：
 *    <dataDir>/conversations/YYYY-MM-DD.jsonl
 *  每行一个 JSON 对象，关键字段：
 *    { sessionKey, sessionId, recordedAt, id, role, content, ... }
 *  我们对 `content`、`user_content`、`assistant_content` 字段做
 *  /(?:undefined)+/g → '' 的替换。
 *
 *  ─── 安全保证 ───────────────────────────────────────────────────────────
 *  - 写回采用 "临时文件 + rename" 原子模式，避免写到一半进程被杀导致数据损坏
 *  - JSON 解析失败的行原样保留（不丢失任何潜在合法数据）
 *  - 不修改 .backup / .metadata / records / scene_blocks 等其它子目录
 *  - 单文件无脏数据时跳过 IO，不触发不必要的写入
 *--------------------------------------------------------------------------------------------*/

const UNDEFINED_RUN_RE = /(?:undefined)+/g;
const SANITIZE_TARGET_FIELDS = ['content', 'user_content', 'assistant_content'];

/**
 * 对单行 jsonl 做 strip。返回 { changed, line }。
 * 解析失败时直接原样返回（changed=false），不丢数据。
 */
function sanitizeJsonlLine(line) {
	if (!line || line.length === 0) return { changed: false, line };
	if (!line.includes('undefined')) return { changed: false, line };
	let obj;
	try {
		obj = JSON.parse(line);
	} catch {
		return { changed: false, line };
	}
	if (!obj || typeof obj !== 'object') {
		return { changed: false, line };
	}
	let changed = false;
	for (const f of SANITIZE_TARGET_FIELDS) {
		const v = obj[f];
		if (typeof v === 'string' && v.includes('undefined')) {
			const cleaned = v.replace(UNDEFINED_RUN_RE, '');
			if (cleaned !== v) {
				obj[f] = cleaned;
				changed = true;
			}
		}
	}
	if (!changed) return { changed: false, line };
	return { changed: true, line: JSON.stringify(obj) };
}

/** 原子写回：tmp 文件 + rename。失败抛错。 */
function atomicWriteFile(targetPath, content) {
	const tmpPath = `${targetPath}.sanitize.tmp`;
	fs.writeFileSync(tmpPath, content, { encoding: 'utf8' });
	fs.renameSync(tmpPath, targetPath);
}

/**
 * 扫描 <dataDir>/conversations/*.jsonl，逐行清洗。
 *
 * @param {string} dataDir vendor 数据目录（TDAI_DATA_DIR）
 * @returns {{ scannedFiles: number, scannedLines: number, modifiedLines: number, modifiedFiles: string[], errors: string[] }}
 */
function sanitizeConversations(dataDir) {
	const result = {
		scannedFiles: 0,
		scannedLines: 0,
		modifiedLines: 0,
		modifiedFiles: /** @type {string[]} */ ([]),
		errors: /** @type {string[]} */ ([]),
	};

	const convDir = path.join(dataDir, 'conversations');
	if (!fs.existsSync(convDir)) {
		return result;
	}

	let entries;
	try {
		entries = fs.readdirSync(convDir);
	} catch (err) {
		result.errors.push(`readdir ${convDir} failed: ${err && err.message ? err.message : String(err)}`);
		return result;
	}

	for (const name of entries) {
		if (!name.endsWith('.jsonl')) continue;
		const full = path.join(convDir, name);
		let stat;
		try { stat = fs.statSync(full); } catch { continue; }
		if (!stat.isFile()) continue;

		result.scannedFiles++;

		let raw;
		try {
			raw = fs.readFileSync(full, 'utf8');
		} catch (err) {
			result.errors.push(`read ${full} failed: ${err && err.message ? err.message : String(err)}`);
			continue;
		}

		// 文件级快速跳过：完全没有 undefined 子串就跳过 split / parse
		if (!raw.includes('undefined')) {
			result.scannedLines += raw.length === 0 ? 0 : raw.split('\n').length;
			continue;
		}

		// 保留行尾：split + 末尾空行检测，确保 join 后字节级等价
		const hasTrailingNewline = raw.endsWith('\n');
		const lines = raw.split('\n');
		// 当原文以 \n 结尾时，split 末尾会产生一个空字符串元素；处理时跳过它
		const tailEmpty = hasTrailingNewline && lines.length > 0 && lines[lines.length - 1] === '';
		const effectiveCount = tailEmpty ? lines.length - 1 : lines.length;

		let fileChanged = false;
		for (let i = 0; i < effectiveCount; i++) {
			result.scannedLines++;
			const { changed, line } = sanitizeJsonlLine(lines[i]);
			if (changed) {
				lines[i] = line;
				fileChanged = true;
				result.modifiedLines++;
			}
		}

		if (!fileChanged) continue;

		const nextRaw = lines.join('\n');
		try {
			atomicWriteFile(full, nextRaw);
			result.modifiedFiles.push(name);
		} catch (err) {
			result.errors.push(`write ${full} failed: ${err && err.message ? err.message : String(err)}`);
		}
	}

	return result;
}

/*---------------------------------------------------------------------------------------------
 *  Admin HTTP Server
 *
 *  独立于 vendor 监听端口，避免改动 vendor 编译产物。
 *
 *  端点：
 *    GET  /admin/health    — 探活，返回 dataDir / port
 *    POST /admin/sanitize  — 触发一次存量清洗，返回统计结果
 *
 *  默认端口 = vendor port + 100（vendor=8420 → admin=8520），可通过
 *  TDBAM_ADMIN_PORT 覆盖。
 *--------------------------------------------------------------------------------------------*/

/** @type {http.Server | undefined} */
let adminServer;

/**
 * @param {{ port: number, dataDir: string }} cfg
 * @returns {Promise<{ port: number }>}
 */
function startAdminServer(cfg) {
	return new Promise((resolve, reject) => {
		const desiredPort = Number(process.env.TDBAM_ADMIN_PORT) || (cfg.port + 100);

		const server = http.createServer((req, res) => {
			const send = (status, body) => {
				res.statusCode = status;
				res.setHeader('Content-Type', 'application/json; charset=utf-8');
				res.end(JSON.stringify(body));
			};

			try {
				const url = req.url || '/';

				if (req.method === 'GET' && (url === '/admin/health' || url === '/admin/health/')) {
					return send(200, { ok: true, dataDir: cfg.dataDir, vendorPort: cfg.port });
				}

				if (req.method === 'POST' && (url === '/admin/sanitize' || url === '/admin/sanitize/')) {
					const summary = sanitizeConversations(cfg.dataDir);
					log(`/admin/sanitize 完成: scannedFiles=${summary.scannedFiles} scannedLines=${summary.scannedLines} modifiedLines=${summary.modifiedLines} modifiedFiles=${summary.modifiedFiles.length} errors=${summary.errors.length}`);
					return send(200, summary);
				}

				return send(404, { error: 'not_found', method: req.method, url });
			} catch (err) {
				const msg = err && err.message ? err.message : String(err);
				return send(500, { error: 'internal', message: msg });
			}
		});

		server.once('error', (err) => {
			reject(err);
		});

		server.listen(desiredPort, '127.0.0.1', () => {
			adminServer = server;
			resolve({ port: desiredPort });
		});
	});
}

function stopAdminServer() {
	return new Promise((resolve) => {
		if (!adminServer) return resolve(undefined);
		try {
			adminServer.close(() => {
				adminServer = undefined;
				resolve(undefined);
			});
		} catch {
			adminServer = undefined;
			resolve(undefined);
		}
	});
}

/**
 * 注入 vendor 启动需要的环境变量。
 *
 * 大部分变量已经由父进程传过来；此处只做兜底默认值（防止漏传时 vendor 走了
 * 真实 OpenAI 域名等危险路径）。
 */
function applyEnvDefaults() {
	const port = process.env.TDAI_GATEWAY_PORT || '8420';
	const host = process.env.TDAI_GATEWAY_HOST || '127.0.0.1';
	const dataDir = process.env.TDAI_DATA_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.saros', '.tdai');
	const llmBase = process.env.TDAI_LLM_BASE_URL || 'http://127.0.0.1:8421/v1';
	const llmKey = process.env.TDAI_LLM_API_KEY || 'saros-knot-bridge-token';
	const llmModel = process.env.TDAI_LLM_MODEL || 'knot-default';

	process.env.TDAI_GATEWAY_PORT = port;
	process.env.TDAI_GATEWAY_HOST = host;
	process.env.TDAI_DATA_DIR = dataDir;
	process.env.TDAI_LLM_BASE_URL = llmBase;
	process.env.TDAI_LLM_API_KEY = llmKey;
	process.env.TDAI_LLM_MODEL = llmModel;
	process.env.TDAI_EMBEDDING_PROVIDER = process.env.TDAI_EMBEDDING_PROVIDER || 'none';
	process.env.TDAI_EMBEDDING_ENABLED = process.env.TDAI_EMBEDDING_ENABLED || 'false';
	process.env.TDAI_STORE_BACKEND = process.env.TDAI_STORE_BACKEND || 'sqlite';
	process.env.TDAI_RECALL_STRATEGY = process.env.TDAI_RECALL_STRATEGY || 'keyword';

	// llm-runner 适配变量（与 TDAI_* 并存）
	process.env.TDBAM_LLM_BASE_URL = process.env.TDBAM_LLM_BASE_URL || llmBase;
	process.env.TDBAM_LLM_API_KEY = process.env.TDBAM_LLM_API_KEY || llmKey;
	process.env.TDBAM_LLM_MODEL = process.env.TDBAM_LLM_MODEL || llmModel;

	// 确保数据目录存在
	try {
		fs.mkdirSync(dataDir, { recursive: true });
	} catch (err) {
		log(`mkdir dataDir 失败: ${err && err.message ? err.message : String(err)}`);
	}

	return { port: Number(port), host, dataDir };
}

async function main() {
	log(`host.mjs 启动: pid=${process.pid} cwd=${process.cwd()}`);
	log(`Node 版本: ${process.version}`);

	const cfg = applyEnvDefaults();
	log(`配置: port=${cfg.port} host=${cfg.host} dataDir=${cfg.dataDir}`);

	let gateway;
	try {
		const vendorEntry = resolveVendorEntry();
		log(`vendor 实际加载: ${vendorEntry}`);

		const vendorUrl = pathToFileURL(vendorEntry).href;
		const mod = await import(vendorUrl);
		const TdaiGateway = mod.TdaiGateway;
		if (typeof TdaiGateway !== 'function') {
			throw new Error(`vendor module 未导出 TdaiGateway；exports=[${Object.keys(mod || {}).join(',') || '<empty>'}]`);
		}

		// ── 启动自愈（前置）：在 vendor 加载磁盘 jsonl 到内存之前清洗 ──
		// 关键时序：vendor TdaiGateway 在 start() 内部会把 conversations/*.jsonl
		// 全量加载到内存索引，之后磁盘改动它不会感知到（除非重启）。所以 sanitize
		// 必须放在 gateway.start() 之前，否则 vendor 内存中保留旧脏数据，面板
		// /list/conversations 就会一直回旧内容。
		try {
			const summary = sanitizeConversations(cfg.dataDir);
			if (summary.modifiedLines > 0) {
				log(`启动自愈：已清洗 ${summary.modifiedLines} 行 / ${summary.modifiedFiles.length} 个文件（scannedFiles=${summary.scannedFiles} scannedLines=${summary.scannedLines}）`);
			} else {
				log(`启动自愈：无需清洗（scannedFiles=${summary.scannedFiles} scannedLines=${summary.scannedLines}）`);
			}
			if (summary.errors.length > 0) {
				log(`启动自愈遇到 ${summary.errors.length} 个错误：${summary.errors.join(' | ')}`);
			}
		} catch (sanErr) {
			log(`启动自愈异常：${sanErr && sanErr.message ? sanErr.message : String(sanErr)}`);
		}

		gateway = new TdaiGateway({
			server: {
				port: cfg.port,
				host: cfg.host,
			},
			data: {
				baseDir: cfg.dataDir,
			},
			// llm/memory 字段由 vendor 内部根据 env 解析
		});

		await gateway.start();
		log(`TdaiGateway 已启动，端口=${cfg.port}`);

		// ── 启动 Admin HTTP Server（提供 /admin/sanitize 等运维端点） ──
		try {
			const { port: adminPort } = await startAdminServer({ port: cfg.port, dataDir: cfg.dataDir });
			log(`Admin 端点已启动，端口=${adminPort}（GET /admin/health, POST /admin/sanitize）`);
		} catch (adminErr) {
			const msg = adminErr && adminErr.message ? adminErr.message : String(adminErr);
			log(`Admin 端点启动失败（不影响主网关）：${msg}`);
		}

		// 主动 /health 自检
		try {
			const resp = await fetch(`http://${cfg.host}:${cfg.port}/health`);
			const body = resp.ok ? await resp.text() : `HTTP ${resp.status}`;
			log(`/health 自检: ${body.slice(0, 200)}`);
		} catch (healthErr) {
			log(`/health 自检异常: ${healthErr && healthErr.message ? healthErr.message : String(healthErr)}`);
		}

		emit('ready', { port: cfg.port, host: cfg.host, dataDir: cfg.dataDir });
	} catch (err) {
		const msg = err && err.message ? err.message : String(err);
		const stack = err && err.stack ? err.stack : '<no stack>';
		emit('error', { msg, stack });
		// 留 200ms 让 stdout flush 再退出
		setTimeout(() => process.exit(1), 200);
		return;
	}

	// ── 优雅关闭 ──
	let shuttingDown = false;
	const shutdown = async (signal) => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		log(`收到 ${signal}，开始关闭...`);
		try {
			await stopAdminServer();
			if (gateway && typeof gateway.stop === 'function') {
				await gateway.stop();
				log('TdaiGateway 已关闭');
			}
		} catch (err) {
			const msg = err && err.message ? err.message : String(err);
			log(`关闭 vendor 时异常: ${msg}`);
		} finally {
			setTimeout(() => process.exit(0), 100);
		}
	};

	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));

	// 注意：故意不监听 process.stdin 的 end/close。
	//
	// 实测某些子进程启动方式（如 PowerShell Start-Job + Node fork）会让 stdin
	// 在启动后被立刻关闭，从而误触发 shutdown。Electron 主进程通过 spawn 启动
	// 时虽然给了 stdio:'pipe'，但仍然存在历史/未来的不确定性，最稳妥的做法是
	// 只依赖显式的 SIGTERM/SIGINT 信号 —— 父进程退出时（包括异常退出）操作
	// 系统会自然回收子进程；正常退出时父进程会主动发 SIGTERM，行为完全可控。

	// 致命错误：避免 unhandled 直接退出
	process.on('uncaughtException', (err) => {
		emit('error', {
			msg: 'uncaughtException: ' + (err && err.message ? err.message : String(err)),
			stack: err && err.stack ? err.stack : '<no stack>',
		});
	});
	process.on('unhandledRejection', (reason) => {
		emit('error', { msg: 'unhandledRejection: ' + String(reason) });
	});
}

main().catch((err) => {
	const msg = err && err.message ? err.message : String(err);
	const stack = err && err.stack ? err.stack : '<no stack>';
	emit('error', { msg: 'main 抛出未捕获异常: ' + msg, stack });
	setTimeout(() => process.exit(1), 200);
});
