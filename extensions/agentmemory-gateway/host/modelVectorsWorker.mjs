/*---------------------------------------------------------------------------------------------
 *  Model Vectors Worker — 真语义向量构建的 Worker 线程（P2-3，2026-09-19）。
 *
 *  背景：model 向量构建（`buildModelVectorsIfEnabled`）在网关**主线程**执行，~240s（10033 doc）
 *  ⇒ 阻塞 `/provider` 响应（renderer 5s 超时误判风险）。搬进 Worker ⇒ 主线程只处理 HTTP 请求。
 *
 *  设计：
 *    · Worker **独立打开 SQLite（readonly: true）** —— WAL 模式支持多连接读，只读安全。
 *    · Worker **常驻**（复用 xenova 模型加载 ~2s，避免每次构建都重启）。
 *    · 主线程**逐 agent 串行**发任务（`await` 完成再下一个），避免并发写 Worker。
 *    · 传回 `exportVectors()`（`[{id, vector: number[]}]`）⇒ structuredClone（自动序列化）。
 *    · 支持**增量**（只构建 `pendingIds` 里的 id）与**全量**（`pendingIds` 为空则全部）两种模式。
 *--------------------------------------------------------------------------------------------*/
import { parentPort, workerData } from 'node:worker_threads';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TAG = '[agentmemory-worker]';
const log = (msg) => parentPort.postMessage({ type: 'log', msg });
const warn = (msg) => parentPort.postMessage({ type: 'warn', msg });

// ─── 独立打开 SQLite（只读；WAL 模式支持多连接读）─────────────────────
let db = null;
try {
	const sqlite = await import('node:sqlite');
	db = new sqlite.DatabaseSync(workerData.dbPath, { readonly: true });
	db.exec('PRAGMA journal_mode = WAL');
	log(`SQLite opened (readonly): ${workerData.dbPath}`);
} catch (err) {
	warn(`SQLite open failed: ${err instanceof Error ? err.message : String(err)}`);
}

function listAll(scope) {
	if (!db) return {};
	const rows = db.prepare('SELECT key, value FROM kv_store WHERE scope = ?').all(scope);
	const result = {};
	for (const row of rows) result[row.key] = row.value;
	return result;
}

// ─── 加载 vectorIndex.js（复用多候选路径，与 host.mjs 的 resolveVectorModule 同策略）────
let VectorIndex = null;
let EmbedFn = null;
async function loadVectorModule() {
	if (VectorIndex && EmbedFn) return;
	const extRoot = workerData.extRoot;
	const candidates = [
		extRoot ? path.join(extRoot, 'out', 'vectorIndex.js') : null,
		path.join(__dirname, '..', '..', 'agentmemory-memory', 'out', 'vectorIndex.js'),
		path.join(__dirname, '..', '..', '..', 'extensions', 'agentmemory-memory', 'out', 'vectorIndex.js'),
	].filter(Boolean);
	for (const c of candidates) {
		if (!fs.existsSync(c)) continue;
		try {
			const mod = await import(pathToFileURL(c).href);
			VectorIndex = mod.VectorIndex || (mod.default && mod.default.VectorIndex) || mod.default;
			if (typeof mod.embed === 'function') { EmbedFn = mod.embed; }
			log(`VectorIndex loaded from ${c} (embed=${typeof EmbedFn === 'function' ? 'yes' : 'no'})`);
			return;
		} catch (err) {
			warn(`VectorIndex load failed (${c}): ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	warn('VectorIndex not found — model vectors unavailable');
}

// ─── 任务处理（type=build；逐 agent 串行，由主线程保证）────────────────
parentPort.on('message', async (msg) => {
	if (msg.type !== 'build') return;
	const { agentId, scope, pendingIds } = msg;
	try {
		await loadVectorModule();
		if (!VectorIndex || !EmbedFn) {
			parentPort.postMessage({ type: 'done', agentId, error: 'vector module unavailable' });
			return;
		}
		const all = listAll(scope);
		const items = [];
		for (const val of Object.values(all)) {
			try {
				const obj = JSON.parse(val);
				if (obj && obj.content && obj.isLatest !== false && obj.deleted !== true) {
					// 增量模式：只构建 pendingIds 里的 id；全量模式（pendingIds 为空/undefined）则全部
					if (!pendingIds || pendingIds.length === 0 || pendingIds.includes(obj.id || '')) {
						items.push({ id: obj.id || '', content: obj.content });
					}
				}
			} catch { /* skip malformed */ }
		}
		const vi = new VectorIndex();
		let ok = 0, failed = 0;
		for (let i = 0; i < items.length; i++) {
			try {
				const vec = await EmbedFn(items[i].content);
				if (vec && vec.length > 0) { vi.addModelVector(items[i].id, vec); ok++; }
				else { failed++; }
			} catch { failed++; }
			if ((i + 1) % 250 === 0) {
				parentPort.postMessage({ type: 'progress', agentId, built: i + 1, total: items.length });
			}
		}
		parentPort.postMessage({
			type: 'done', agentId,
			vectors: vi.exportVectors(),
			mode: 'model', built: ok, failed,
		});
	} catch (err) {
		parentPort.postMessage({ type: 'done', agentId, error: err instanceof Error ? err.message : String(err) });
	}
});

log('Worker ready');
