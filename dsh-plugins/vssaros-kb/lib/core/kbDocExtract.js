// @vssaros/dsh-kb — 「非文本素材 → Markdown」前置转换（P2，2026-10-14）。
//
// ## 它复刻的是谁
// 真源两半：**主进程桥** `electron-main/kbDocConvertChannel.ts`（spawn python 跑提取脚本 ✓）＋
// **调用侧** `browser/knowledge/kbVaultFs.ts` 的 `stageDocSourcesToText`（`:162-264` ✓）。
// dsh 侧不需要 IPC（Host 本来就是 Node、有 child_process ✓）⇒ 桥塌缩成**直接 spawn** ✓。
//
// ## 口径（逐条照真源，不是"差不多" ✗）
//   · **python 脚本用随包副本** `scripts/saros-kb-extract-doc.py`（与真源内嵌的 EXTRACT_SCRIPT
//     **逐字节一致** ✓ —— 由 `dshPluginPackages.test.ts` 的守卫钉住 ✓，与 feishu-sync.mjs 同一手法 ✓）。
//     ⚠ 真源是"每次写临时文件再跑"（脚本是内嵌字符串 ✓）；我们是**文件** ⇒ 直接跑它，不落临时件 ✓
//     （行为等价：同一份脚本 ✓；少一次写盘 ✓）。
//   · 环境：`PYTHONIOENCODING=utf-8` ＋ `PYTHONUTF8=1`（Windows 默认 GBK 会写坏中文 ✓）；超时 300s ✓；
//     出口协议 = stdout **最后一行 JSON**（`{ok,backend,pages,chars,images}` ✓）＋ stderr 的 `[SAROS-ERROR]` ✓。
//   · 文本上限 **8MB**（超出截断 ＋ truncated=true ✓）—— 注意真源是 `text.slice(0, 字节数)`
//     （**按字符切**、拿字节数当上限 ✓ —— 这个"错位"照抄，别顺手修 ✗）。
//   · 图片：脚本内已把引用改写为 `<imagePrefix>/img-NN.png` ✓；JS 侧只把临时目录的图复制到
//     `targetImageDir`（真源 `copyImages` ✓：逐张 await ✓）。
//   · 调用侧语义（`stageDocSourcesToText` ✓）：**串行** ✓；同名 .md 比源新 ⇒ 跳过 ✓；
//     头 400 字符里没有 `提取后端：` ⇒ 当旧产物**重提取一次**（后端升级迁移 ✓）；
//     有页无字 ⇒ **不写空 md**（扫描件只报告 ✓）；头部来源行的格式逐字照 `:233-235` ✓。
//
// ## 三种素材的分工（与真源一致 ✓）
//   · **PDF** ⇒ 本机 python ＋ 随包脚本（PyMuPDF4LLM/pypdf ✓）。§16.3 曾说这条链"纯 Node 可跑"——
//     **对 epub/docx 成立、对 PDF 不成立** ✗（真源同样要 python ✓）。python 解析链：config.kbPythonPath
//     → SAROS_KB_PYTHON → SAROS_VOX_PYTHON → PATH 的 python（真源是设置项在前 ✓；dsh 没有设置服务 ⇒
//     用插件配置 ✓，这是**有意偏离**，记在这里 ✓）。
//   · **epub/docx** ⇒ `./kbArchiveExtract.js`（真源 `common/kbArchiveExtract.ts` 的逐字移植 ✓，
//     zlib 解 zip、零外部依赖 ✓ —— **不需要 python** ✓）。防漂移：p3-82 拿**真源自己的测试套件**
//     （7 例 ✓）跑在本副本上 ✓。
import { spawn } from 'node:child_process';
import { promises as fsp, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
// epub/docx 解 zip → Markdown（真源 common/kbArchiveExtract.ts 的逐字移植 ✓，防漂移见该文件头 ✓）
import { extractArchiveMarkdown } from './kbArchiveExtract.js';

/** 单次提取超时（照真源 `TIMEOUT_MS = 300_000` ✓ —— 大 PDF ＋ 首次加载 pymupdf 都要留余量 ✓）。 */
export const EXTRACT_TIMEOUT_MS = 300_000;
/** 提取文本上限（照真源 `MAX_TEXT_BYTES = 8 * 1024 * 1024` ✓）。 */
export const MAX_TEXT_BYTES = 8 * 1024 * 1024;
/** 素材扩展名清单（照真源 `KB_DOC_SOURCE_EXTENSIONS` ✓ —— 改了要同步真源那边的守卫测试 ✓）。 */
export const DOC_SOURCE_EXTENSIONS = ['.pdf', '.epub', '.docx'];
/** 后端升级标记（**有功能作用** ✓：`needsBackendUpgrade` 靠它认旧产物 ⇒ 别删 ✓，真源 `:231-232` ✓）。 */
export const BACKEND_MARKER = '提取后端：';

/** 随包 python 脚本的绝对路径（包内 `scripts/` ✓ —— 守卫钉住它与真源逐字节一致 ✓）。 */
export const EXTRACT_SCRIPT_PATH = fileURLToPath(new URL('../../scripts/saros-kb-extract-doc.py', import.meta.url));

/** python 解释器解析链（真源 `resolvePythonPath` ✓：设置项在 dsh 侧换成插件配置 `kbPythonPath` ✓）。 */
export function resolvePythonPath(config) {
	const fromConfig = String(config?.kbPythonPath ?? '').trim();
	const fromEnv = String(process.env.SAROS_KB_PYTHON ?? '').trim();
	const fromVoxEnv = String(process.env.SAROS_VOX_PYTHON ?? '').trim();
	return fromConfig || fromEnv || fromVoxEnv || 'python';
}

/** 取 stdout 里**最后一个** JSON 行（照真源 `parseLastJson` ✓ —— 库可能先输出警告 ✓）。 */
export function parseLastJson(out) {
	const lines = String(out ?? '').split(/\r?\n/).filter(line => line.trim().startsWith('{'));
	for (let i = lines.length - 1; i >= 0; i--) {
		try { return JSON.parse(lines[i]); } catch { /* 试上一行 */ }
	}
	return undefined;
}

/** 解析 stderr 里的 `[SAROS-ERROR] <原因>` 行（照真源 `parseError` ✓）。 */
export function parseErrorLine(stderr) {
	const line = String(stderr ?? '').split(/\r?\n/).find(item => item.includes('[SAROS-ERROR]'));
	if (!line) { return undefined; }
	return line.slice(line.indexOf('[SAROS-ERROR]') + '[SAROS-ERROR]'.length).trim() || undefined;
}

/** spawn python 跑提取脚本（照真源 `runPython` ✓：超时 ＋ 编码兜底 ＋ ENOENT 给出可执行的建议 ✓）。 */
function runPython(python, script, args) {
	return new Promise((resolve, reject) => {
		let child;
		try {
			child = spawn(python, [script, ...args], {
				windowsHide: true,
				env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
			});
		} catch (err) { reject(err); return; }
		const stdout = [];
		const stderr = [];
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) { return; }
			settled = true;
			try { child.kill(); } catch { /* 已退出 */ }
			reject(new Error(`提取超时（${EXTRACT_TIMEOUT_MS / 1000}s）`));
		}, EXTRACT_TIMEOUT_MS);
		child.stdout?.on('data', chunk => stdout.push(chunk));
		child.stderr?.on('data', chunk => stderr.push(chunk));
		child.on('error', err => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			const hint = err && err.code === 'ENOENT'
				? `找不到 python 解释器「${python}」。请用插件配置 kbPythonPath 指定绝对路径，或把 python 加入 PATH（也可设 SAROS_KB_PYTHON）。`
				: err.message;
			reject(new Error(hint));
		});
		child.on('close', code => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), code });
		});
	});
}

/** 把导出图片复制到目标目录（照真源 `copyImages` ✓：逐张 await、失败只警告 ✓）。 */
async function copyImages(srcDir, dstDirRaw, warn) {
	const dstDir = String(dstDirRaw ?? '').trim();
	if (!dstDir || !existsSync(srcDir)) { return 0; }
	let copied = 0;
	try {
		await fsp.mkdir(dstDir, { recursive: true });
		for (const name of readdirSync(srcDir)) {
			const from = join(srcDir, name);
			try {
				if (!statSync(from).isFile()) { continue; }
				await fsp.copyFile(from, join(dstDir, name));
				copied++;
			} catch (err) { warn?.(`复制图片失败：${from}（${String(err?.message ?? err)}）`); }
		}
	} catch (err) { warn?.(`复制图片目录失败 → ${dstDir}（${String(err?.message ?? err)}）`); }
	return copied;
}

/**
 * 提取单个文件（照真源 `KbDocConvertChannel.extract` ✓）。
 * ⚠ 本刀只支持 **.pdf** ✓；`.epub`/`.docx` 得到**明确的"尚未移植"错误**（不静默 ✗ —— 见文件头 ✓）。
 * @returns `{ ok, text?, pages?, imageCount?, backend?, truncated?, error? }`
 */
export async function extractDocText(filePath, { python = 'python', imagePrefix = '', targetImageDir = '', scriptPath = EXTRACT_SCRIPT_PATH, log, warn } = {}) {
	const target = String(filePath ?? '').trim();
	if (!target) { return { ok: false, error: 'filePath 必填' }; }
	const ext = target.slice(target.lastIndexOf('.')).toLowerCase();
	// ★ epub/docx ⇒ 纯 TS 解 zip（照真源 `extractArchive` ✓ —— 不 spawn python ✓；
	//   模块是 `kbArchiveExtract.js` 的逐字移植 ✓（唯一偏离：解压改 **await** —— Host 单线程纪律 ✓，
	//   见该文件头 ✓）；防漂移靠 p3-82 的黄金表（同一批夹具两边各跑、逐输出比 ✓）。
	if (ext === '.epub' || ext === '.docx') {
		try {
			const buf = readFileSync(target);
			const r = await extractArchiveMarkdown(target, buf);
			if (!r.ok) { return { ok: false, error: r.error ?? '解析失败' }; }
			let text = r.markdown ?? '';
			let truncated = false;
			if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
				// ⚠ 照真源：拿**字节数**比上限、按**字符数**切（与 PDF 分支同一处错位 ✓ —— 别顺手修齐 ✗）。
				text = text.slice(0, MAX_TEXT_BYTES);
				truncated = true;
			}
			log?.(`[kb] ${ext === '.epub' ? 'epub' : 'docx'}：${r.chapters ?? 0} 章，${text.length} 字符：${target}`);
			// pages 用**章节数** ⇒ 调用方"有页无字 ⇒ 不写空 md"的判定对"解出来是空的"同样成立（真源注释 ✓）
			return { ok: true, text, pages: r.chapters ?? 0, imageCount: 0, backend: ext === '.epub' ? 'epub' : 'docx', truncated };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}
	if (ext !== '.pdf') {
		return { ok: false, error: `暂不支持提取该类型（目前支持 ${DOC_SOURCE_EXTENSIONS.join(' / ')}）：${target}` };
	}
	try {
		if (!existsSync(target) || !statSync(target).isFile()) { return { ok: false, error: `文件不存在或不是普通文件：${target}` }; }
	} catch (err) { return { ok: false, error: `无法访问文件：${String(err)}` }; }

	const tmpDir = mkdtempSync(join(tmpdir(), 'saros-kb-pdf-'));
	try {
		const { stdout, stderr, code } = await runPython(python, scriptPath, [target, tmpDir, String(imagePrefix ?? '')]);
		const meta = parseLastJson(stdout);
		const errorLine = parseErrorLine(stderr);
		if (code !== 0 || !meta?.ok) {
			return { ok: false, error: meta?.error ?? errorLine ?? `python 退出码 ${code}` };
		}
		const mdFile = join(tmpDir, 'doc.md');
		let text = existsSync(mdFile) ? readFileSync(mdFile, 'utf-8') : '';
		let truncated = false;
		if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
			// ⚠ 照真源：拿**字节数**比上限、按**字符数**切（`text.slice(0, MAX_TEXT_BYTES)` ✓ —— 别顺手修齐 ✗）。
			text = text.slice(0, MAX_TEXT_BYTES);
			truncated = true;
		}
		const imageCount = await copyImages(join(tmpDir, 'images'), targetImageDir, warn);
		log?.(`[kb] ${meta.backend}：${meta.pages ?? '?'} 页，${text.length} 字符，${imageCount} 张图：${target}`);
		return {
			ok: true, text, pages: meta.pages ?? 0, imageCount,
			backend: meta.backend === 'pymupdf4llm' ? 'pymupdf4llm' : 'pypdf',
			truncated,
		};
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	} finally {
		try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 临时目录清理失败可忽略（真源同 ✓） */ }
	}
}

/** 递归收集需要「先转文本」的素材（照真源 `collectDocSources` ✓：跳过隐藏项与 `assets/` 图片目录 ✓）。 */
export async function collectDocSources(libDir, out = []) {
	let entries = [];
	try { entries = await fsp.readdir(libDir, { withFileTypes: true }); } catch { return out; }
	for (const entry of entries) {
		if (entry.name.startsWith('.')) { continue; }
		const abs = join(libDir, entry.name);
		if (entry.isDirectory()) {
			// `assets/` 是图片本地化目录（只可能含图片），无需递归（真源 `:276-277` ✓）
			if (entry.name === 'assets') { continue; }
			await collectDocSources(abs, out);
		} else if (DOC_SOURCE_EXTENSIONS.some(ext => entry.name.toLowerCase().endsWith(ext))) {
			out.push(abs);
		}
	}
	return out;
}

/** 同名 md 是否已过期（照真源 `isStaleMarkdown` ✓：md 不存在或比源旧 ⇒ true ✓）。 */
export async function isStaleMarkdown(mdPath, srcPath) {
	try {
		const [md, src] = await Promise.all([fsp.stat(mdPath), fsp.stat(srcPath)]);
		const mdTime = md.mtimeMs ?? 0;
		const srcTime = src.mtimeMs ?? 0;
		return !(mdTime > 0 && mdTime >= srcTime);
	} catch {
		return true;   // md 不存在 ⇒ 需要提取（真源同 ✓）
	}
}

/** 旧产物是否需要「提取后端升级」重提取（照真源 `needsBackendUpgrade` ✓：读头部 400 字符 ✓）。 */
export async function needsBackendUpgrade(mdPath) {
	try {
		const head = (await fsp.readFile(mdPath, 'utf8')).slice(0, 400);
		return !head.includes(BACKEND_MARKER);
	} catch {
		return false;   // 读不到就先不动（真源同 ✓）
	}
}

/**
 * 「非文本素材 → 同名 .md」前置转换（照真源 `stageDocSourcesToText` ✓）：**串行** ✓。
 * ⚠ 这一步是**写**（往 库/ 落 .md ＋ assets/ 图片）⇒ 调用方必须先拿 vault 锁 ✓。
 * @returns `{ sources, converted, skippedFresh, noText: string[], failed: string[] }`
 */
export async function stageDocSourcesToText(libDir, { python = 'python', scriptPath = EXTRACT_SCRIPT_PATH, log, warn } = {}) {
	const result = { sources: 0, converted: 0, skippedFresh: 0, noText: [], failed: [] };
	let sources = [];
	try { sources = await collectDocSources(libDir); } catch (err) { warn?.(`收集素材失败：${String(err?.message ?? err)}`); return result; }
	result.sources = sources.length;
	for (const src of sources) {
		const name = src.split(/[\\/]/).pop() ?? '';
		const stem = name.replace(/\.[^.]+$/, '');
		const srcDir = dirname(src);
		const mdPath = join(srcDir, stem + '.md');
		const stale = await isStaleMarkdown(mdPath, src);
		if (!stale && !(await needsBackendUpgrade(mdPath))) { result.skippedFresh++; continue; }
		log?.(`提取文档文本：${name}`);
		try {
			const assetDir = join(srcDir, 'assets', stem);
			const res = await extractDocText(src, {
				python, scriptPath, log, warn,
				imagePrefix: `assets/${stem}`,
				targetImageDir: assetDir,
			});
			if (!res.ok) { result.failed.push(`${name}（${res.error ?? '未知错误'}）`); continue; }
			const text = String(res.text ?? '').trim();
			if (!text) {
				// 有页无字 ⇒ 扫描件。**不写空 md**（否则会被当素材构建出空笔记 ✓，真源 `:218-220` ✓）
				result.noText.push(`${name}（${res.pages ?? 0} 页）`);
				continue;
			}
			// ⚠ 头部来源行逐字照真源 `:225-235` ✓（archive 单位是"章"、PDF 是"页" ✓；不套 H1 ✓）
			const archive = res.backend === 'epub' || res.backend === 'docx';
			const backendLabel = res.backend === 'pymupdf4llm' ? 'PyMuPDF4LLM 结构化解析'
				: res.backend === 'pypdf' ? 'pypdf 纯文本提取'
					: res.backend === 'epub' ? 'EPUB 章节解析'
						: res.backend === 'docx' ? 'DOCX 段落解析' : '未知后端';
			const amount = archive ? `共 ${res.pages ?? 0} 章` : `共 ${res.pages ?? 0} 页`;
			const header = `> 来源：\`${name}\`（${backendLabel}；提取后端：${res.backend ?? 'unknown'}，${amount}`
				+ `${res.imageCount ? `，提取图片 ${res.imageCount} 张` : ''}`
				+ `${res.truncated ? '，文本已截断' : ''}）\n\n`;
			await fsp.writeFile(mdPath, header + text + '\n', 'utf8');
			result.converted++;
			log?.(`staged: ${src} → ${mdPath}（${text.length} 字符，${res.imageCount ?? 0} 张图，backend=${res.backend ?? '?'}）`);
		} catch (err) {
			result.failed.push(`${name}（${err instanceof Error ? err.message : String(err)}）`);
		}
	}
	return result;
}
