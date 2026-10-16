// @vssaros/dsh-codebase — parser/worker：**worker_threads 里的 tree-sitter 宿主**（P0 自证的那一半）。
//
// 为什么非要起线程（而不是在 Host 主线程里 parse ✗）：
//   · 真源 `codebaseGraphParserPool` 就是池化解析（worker 数 = 硬件并发 − 1）✓ ⇒ 语义上与它同形；
//   · 更重要的是**失败隔离**：wasm 实例崩了/grammar ABI 不匹配，只该让一次解析失败，
//     不该把整个 Host 进程（页面、桥、别的工具）一起带走 ✗。
//
// 线程模型（刻意最简，够 P0 用 ✓）：
//   · 一个 worker 一份运行时实例 + 一份"语言 → Language 对象"缓存（`Language.load` 是**最贵**的一步 ✓）；
//   · **串行**处理请求（`parentPort` 上按需排队由 pool 侧保证 ✓）⇒ 这里不做并发控制；
//   · 一次解析结束就 `tree.delete()`（wasm 堆里的树不会自己回收 ✗）。
//
// ⚠ 加载运行时的两条纪律（都来自 P0 实测，见 resolve.js 文件头）：
//   ① 用 `createRequire` + `require(runtimePath)` —— **不用** `import()`（它是 UMD，import 会走 ESM 分支 ✗）；
//   ② 只找到 `tree-sitter.js` 且它落在 `"type":"module"` 作用域时，require 会**静默**当成 ESM 求值
//      ⇒ 报一句 `Unable to determine script URL` ✗ ⇒ 这里把它**翻译成人话**（带修法）✓。

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

import { factsFromTree } from './facts.js';
import { extractFromTree } from './extract.js';

const require = createRequire(import.meta.url);

const { wasmDir, runtime = 'tree-sitter.cjs' } = workerData ?? {};
const runtimePath = join(String(wasmDir), String(runtime));

let TS;
let initPromise;
/** 语言名 → `Language` 对象（**同一个 worker 里缓存** ✓，`Language.load` 实测是最贵的一步）。 */
const languages = new Map();

/** 把"看不出根因"的加载错误翻成人话 + 修法 ✓（P0 实测的那种静默陷阱）。 */
function explainLoadFailure(error) {
	const message = String(error?.message ?? error);
	if (/Unable to determine script URL/i.test(message)) {
		return {
			kind: 'esm-scope',
			why: `运行时文件被当成 ESM 求值了（${runtimePath}）：它所在的目录继承了一个 "type":"module" 的 package.json ⇒ `
				+ 'UMD 走 globalThis 分支、`__filename` 未定义。修法：把运行时命名为 `tree-sitter.cjs`（`.cjs` 永远是 CJS ✓），'
				+ '或在那个目录里放一份 `{"type":"commonjs"}` 的 package.json。',
		};
	}
	return { kind: 'runtime-load', why: `加载运行时失败（${runtimePath}）：${message}` };
}

async function ensureInit() {
	if (!initPromise) {
		initPromise = (async () => {
			TS = require(runtimePath);
			if (!TS || typeof TS.Parser !== 'function' || typeof TS.Language !== 'function') {
				const keys = TS && typeof TS === 'object' ? Object.keys(TS).join(',') : String(TS);
				throw Object.assign(new Error(`运行时的形状不对：require 拿到 ${keys}（期望有 Parser / Language）`), { kind: 'runtime-shape' });
			}
			// `locateFile` 给**绝对路径** ⇒ Emscripten 的 Node 分支用 `fs` 直接读 ✓（不需要任何 fetch/blob ✗）
			await TS.Parser.init({ locateFile: name => join(String(wasmDir), name) });
			return true;
		})();
	}
	return initPromise;
}

async function languageOf(language) {
	if (languages.has(language)) {
		return languages.get(language);
	}
	const file = join(String(wasmDir), `tree-sitter-${language}.wasm`);
	let bytes;
	try {
		bytes = readFileSync(file);
	} catch (e) {
		if (e?.code === 'ENOENT') {
			const available = [...languages.keys()].sort().join(', ') || '(本次还没有加载过任何语言)';
			throw Object.assign(new Error(`没有 ${language} 的 grammar：${file} 不存在（已加载过：${available}）`), { kind: 'no-grammar' });
		}
		throw Object.assign(new Error(`读 grammar 失败（${file}）：${String(e?.message ?? e)}`), { kind: 'no-grammar' });
	}
	let loaded;
	try {
		loaded = await TS.Language.load(bytes);
	} catch (e) {
		// ABI 不匹配会走到这里（"Invalid language version" 那一类）——**必须显式报**，不许当"解析出 0 个节点" ✗
		throw Object.assign(new Error(`grammar 加载失败（${language}）：${String(e?.message ?? e)}`), { kind: 'bad-grammar' });
	}
	languages.set(language, loaded);
	return loaded;
}

/** `mode`：`'facts'`（P0 自证用的小事实，默认 ✓）| `'extract'`（P2 建图用的符号与引用 ✓）。 */
async function parseOne({ language, text, file, mode = 'facts' }) {
	const started = Date.now();
	await ensureInit();
	const lang = await languageOf(String(language));
	const parser = new TS.Parser();
	let tree;
	try {
		parser.setLanguage(lang);
		tree = parser.parse(String(text ?? ''));
		if (mode === 'extract') {
			const extraction = extractFromTree(tree, String(text ?? ''));
			return {
				ok: true,
				file: file ? String(file) : undefined,
				language: String(language),
				mode: 'extract',
				ms: Date.now() - started,
				hasError: !!tree.rootNode?.hasError,
				extraction,
			};
		}
		const facts = factsFromTree(tree, { sourceBytes: Buffer.byteLength(String(text ?? ''), 'utf8') });
		return {
			ok: true,
			file: file ? String(file) : undefined,
			language: String(language),
			ms: Date.now() - started,
			facts,
		};
	} finally {
		// wasm 堆里的树与 parser 都要显式释放（不然长跑会一路涨 ✗）
		try { tree?.delete?.(); } catch { /* 释放失败不影响结果 ✓ */ }
		try { parser.delete?.(); } catch { /* 同上 */ }
	}
}

parentPort?.on('message', message => {
	const { id, request } = message ?? {};
	Promise.resolve()
		.then(() => parseOne(request ?? {}))
		.catch(error => {
			const explained = explainLoadFailure(error);
			const kind = typeof error?.kind === 'string' ? error.kind : explained.kind;
			const why = typeof error?.kind === 'string' ? String(error?.message ?? error) : explained.why;
			return { ok: false, kind, why, file: request?.file ? String(request.file) : undefined, language: request?.language ? String(request.language) : undefined };
		})
		.then(result => parentPort?.postMessage({ id, ...result }));
});
