/*---------------------------------------------------------------------------------------------
 *  kbDocConvertChannel — 知识库「非文本素材 → Markdown」的主进程 IPC channel 宿主。
 *
 *  ⚠ 为什么必须在主进程：渲染进程**没有 child_process**（沙箱），而 PDF 解析要 spawn
 *    本机 Python。这与 `larkCliChannel` / `voxLaunchChannel` 同一理由，调用方式也复用
 *    同一套：渲染侧 `nativeIpcBridge()?.ipcRenderer?.invoke('vscode:…')`。
 *
 *  ## 提取后端（2026-09-23 升级）
 *
 *  ① **PyMuPDF4LLM**（首选）：真正生成 **Markdown 结构**（标题层级 / 列表嵌套 / 表格），
 *     并把 PDF 内的**图片导出为文件** —— 这正是旧实现（pypdf 纯文本）完全丢失的部分：
 *     旧产物 0 图片、无标题、段落被拆散、页眉混入正文（用户实测「结构混乱、缺少图片、
 *     完全不可阅读」）。
 *  ② **pypdf**（回退）：未安装 pymupdf4llm 时的保底，逐页纯文本。
 *
 *  ## 协议
 *
 *  · 脚本把 markdown 写到 `<outDir>/doc.md`、图片写到 `<outDir>/images/img-NN.png`；
 *    **stdout 只输出一行 JSON**（`{ok,backend,pages,chars,images}`）⇒ 不再靠 stdout 传正文。
 *  · 图片**由本进程**复制到调用方给的 `targetImageDir`（渲染侧算好的绝对路径），
 *    markdown 里的引用已在脚本内改写为 `<markdownImagePrefix>/img-NN.png`（相对路径，
 *    与知识库「图片相对引用」约定一致 ⇒ 预览与飞书同步都能解析）。
 *  · 临时目录用完即删。
 *
 *  ## 设计取舍
 *
 *  · 图片重命名为 `img-01.png` 这类**安全名**：原始名来自 PDF 文件名，常含中文/空格，
 *    作为 markdown 链接（webview 里要 URL 编码）容易出问题 ⇒ 统一改名，来源信息由
 *    所在目录 `assets/<素材名>/` 承载。
 *  · 文本 NFKC 归一化：PDF 常把汉字映射成「康熙部首」等兼容码位（实测 `⽅⾯` 而非 `方面`）。
 *  · 只做提取、不决定落点 ⇒ 文件写入仍由渲染侧（`IFileService`）负责，单一真源。
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { validatedIpcMain } from '../../../../base/parts/ipc/electron-main/ipcMain.js';
import { spawn } from 'child_process';
import {
	existsSync, statSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, copyFileSync, rmSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
// 通道名 / 契约与渲染侧共用（common 侧是单一真源）
import {
	KB_EXTRACT_DOC_TEXT_CHANNEL,
	type IKbExtractDocTextRequest,
	type IKbExtractDocTextResult,
} from '../common/kbDocConvertChannel.js';
// epub/docx → Markdown（纯 TS、零外部依赖；见该模块头部说明）
import { extractArchiveMarkdown } from '../common/kbArchiveExtract.js';

/** PDF 走 python（pymupdf/pypdf）；epub/docx 走纯 TS 解 zip（见 kbArchiveExtract）。 */
const PDF_EXT = '.pdf';
/** 归档类（epub/docx）：纯 TS 解 zip，**不需要 python**。 */
const ARCHIVE_EXTS = new Set(['.epub', '.docx']);

/** 该扩展名是否支持提取（与 `KB_DOC_SOURCE_EXTENSIONS` 保持一致）。 */
function supportedExt(ext: string): boolean {
	return ext === PDF_EXT || ARCHIVE_EXTS.has(ext);
}

/** 单次提取超时：大 PDF + 首次加载 pymupdf 都要留足余量。 */
const TIMEOUT_MS = 300_000;

/** 提取文本上限（8MB）：超出部分截断（markdown 比纯文本更占空间，故比旧值放宽）。 */
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

/** 提取脚本文件名（写进系统临时目录，固定名可覆盖，避免堆积）。 */
const SCRIPT_NAME = 'saros-kb-extract-doc.py';

/**
 * 提取脚本（Python）。用法：`script.py <pdf> <outDir> [imagePrefix]`
 *
 * 输出协议：
 *   · `<outDir>/doc.md` —— markdown 正文（图片引用已改写）
 *   · `<outDir>/images/img-NN.ext` —— 导出的图片（安全名）
 *   · stdout 单行 JSON —— `{"ok":true,"backend":"…","pages":N,"chars":M,"images":K}`；
 *     失败时 `{"ok":false,"error":"…"}` 且**非零退出码**
 *
 * ⚠ 三处刻意的写法：
 *   · `sys.stdout/stderr.reconfigure(utf-8)`：Windows 默认 GBK，遇到生僻字符（实测 U+2F45）
 *     会抛 `UnicodeEncodeError` 让整个提取失败 ⇒ 必须显式设 UTF-8 + errors='replace'。
 *   · 换行统一用 `chr(10).join(...)`：**避免在本 TS 模板字符串里写 `\n` 转义**（易错）。
 *   · 图片引用同时替换原文与 URL 编码形式：不同 pymupdf4llm 版本可能输出编码后的链接。
 */
const EXTRACT_SCRIPT = `# -*- coding: utf-8 -*-
# Saros 知识库：PDF → Markdown（由 kbDocConvertChannel 生成，请勿手改）
import sys, os, json, re, unicodedata, urllib.parse

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

NL = chr(10)


def fail(msg):
    sys.stderr.write('[SAROS-ERROR] ' + str(msg) + NL)
    sys.stdout.write(json.dumps({'ok': False, 'error': str(msg)}, ensure_ascii=False) + NL)
    sys.stdout.flush()
    sys.exit(2)


if len(sys.argv) < 3:
    fail('用法: script.py <pdf> <outDir> [imagePrefix]')

pdf = sys.argv[1]
out_dir = sys.argv[2]
prefix = (sys.argv[3] if len(sys.argv) > 3 else '').strip()

if not os.path.isfile(pdf):
    fail('文件不存在: ' + pdf)
pdf = os.path.abspath(pdf)

os.makedirs(out_dir, exist_ok=True)
img_dir = os.path.join(out_dir, 'images')
os.makedirs(img_dir, exist_ok=True)

# ⚠ 必须切到输出目录：pymupdf4llm 的 image_path 收的是**相对路径**（'images'），
#   而相对路径基于进程 cwd —— 不 chdir，图片会落到别处（实测 images 数为 0）。
#   之所以坚持用相对路径：这样生成的 markdown 里写的是 images/xxx.png，
#   后续「改写为 assets/<素材名>/img-NN.png」才能按前缀匹配到。
os.chdir(out_dir)

md = None
backend = 'pypdf'
pages = 0

# ① 首选 PyMuPDF4LLM：结构化 markdown + 图片导出
try:
    import pymupdf4llm
    import pymupdf
    _doc = pymupdf.open(pdf)
    pages = _doc.page_count
    _doc.close()
    md = pymupdf4llm.to_markdown(pdf, write_images=True, image_path='images',
                                 image_format='png', dpi=150)
    backend = 'pymupdf4llm'
except Exception as e:
    sys.stderr.write('[SAROS-WARN] pymupdf4llm 不可用，回退 pypdf: ' + str(e) + NL)

# ② 回退：pypdf 纯文本（无图片、无结构，仅保证「能出文本」）
if md is None:
    try:
        try:
            from pypdf import PdfReader
        except Exception:
            from PyPDF2 import PdfReader
        _reader = PdfReader(pdf)
        pages = len(_reader.pages)
        _parts = []
        for i, page in enumerate(_reader.pages):
            try:
                t = page.extract_text() or ''
            except Exception:
                t = ''
            t = t.strip()
            if t:
                _parts.append('## 第 %d 页' % (i + 1))
                _parts.append('')
                _parts.append(t)
        md = NL.join(_parts)
    except Exception as e:
        fail('提取失败: ' + str(e))

# ③ NFKC 归一化（修「康熙部首」等兼容码位；代价：中文全角标点变半角，不影响语义）
md = unicodedata.normalize('NFKC', md)

# ④ 清理 U+FFFD 占位符（实测 3 页文档里有 35 个）
#
#   成因：PDF 用**子集字体**且缺少字形到 Unicode 的映射时，PyMuPDF 只能输出 U+FFFD。
#   实测这些位置原本分两类，必须**区别对待**（用旧 pypdf 产物交叉验证得出）：
#     · 词间空格 —— 例 Unreal?Engine?4?中的?UI?优化技巧（pypdf 侧为 UnrealEngine4中的UI优化技巧）；
#       若直接丢弃，整串会黏在一起，可读性反而更差 ⇒ 两侧都是「字母/数字/汉字」时补一个空格；
#     · 项目符号 / 句末符号 —— 例「计算每个节点的大小。?」（原本是实心圆点）、
#       「合理设置Visibility?」（原本是空心圆点）；已无信息可恢复 ⇒ 直接丢弃。
#   ⚠ 用 chr(0xFFFD) 而不是字面量：避免在本 TS 模板字符串里写 unicode 转义（会被 TS 先解析掉）。
REPLACEMENT = chr(0xFFFD)
if REPLACEMENT in md:
    _fixed = []
    _len = len(md)
    for _i, _ch in enumerate(md):
        if _ch != REPLACEMENT:
            _fixed.append(_ch)
            continue
        _prev = md[_i - 1] if _i > 0 else ''
        _next = md[_i + 1] if _i + 1 < _len else ''
        # isalnum() 对汉字返回 True、对「。」「】」「]」等标点返回 False ⇒ 正好用来判定「词间」
        _fixed.append(' ' if (_prev.isalnum() and _next.isalnum()) else '')
    md = ''.join(_fixed)

# ⑤ 图片重命名为安全名，并把 markdown 里的引用改写为 <prefix>/img-NN.ext
try:
    imgs = sorted(f for f in os.listdir(img_dir) if os.path.isfile(os.path.join(img_dir, f)))
except Exception:
    imgs = []

# ⚠ 实测：pymupdf4llm 写进 markdown 的图片引用是**绝对路径**，且与传入的 image_path
#   可能在「大小写 / 8.3 短名」上不一致（实测它写 C:/Users/qiuzijian/…，而传入的是
#   C:/Users/QIUZIJ~1/…）⇒ **任何前缀匹配都不可靠**（曾因此残留绝对路径 ⇒ 预览必裂图）。
#   ⇒ 改为「解析每个链接的 basename → 查表替换」，对前缀形态完全免疫。
mapping = {}
for i, old in enumerate(imgs, 1):
    ext = os.path.splitext(old)[1].lower() or '.png'
    new = 'img-%02d%s' % (i, ext)
    if new != old:
        os.replace(os.path.join(img_dir, old), os.path.join(img_dir, new))
    mapping[old] = (prefix + '/' + new) if prefix else new

if mapping:
    def _fix_link(m):
        url = m.group(1)
        # chr(92) = 反斜杠：避免在本 TS 模板字符串里出现转义歧义
        base = urllib.parse.unquote(os.path.basename(url.replace(chr(92), '/')))
        target = mapping.get(base)
        return '](' + target + ')' if target else m.group(0)
    # ⚠⚠ 两个坑（都实测踩过）：
    #   ① 反斜杠必须写**双份** —— 本脚本嵌在 TS 模板字符串里，单反斜杠 + 括号会被 TS
    #      当转义序列吃掉，生成的 Python 正则会退化成 ](([^)]+)) ⇒ 匹配错乱
    #      （实测产出多一个右括号的图片引用）；
    #   ② 本脚本的注释里**绝对不能出现反引号**（会提前闭合 TS 模板字符串）。
    md = re.sub(r'\\]\\(([^)]+)\\)', _fix_link, md)

with open(os.path.join(out_dir, 'doc.md'), 'w', encoding='utf-8') as f:
    f.write(md)

sys.stdout.write(json.dumps({
    'ok': True, 'backend': backend, 'pages': pages,
    'chars': len(md), 'images': len(imgs),
}, ensure_ascii=False) + NL)
sys.stdout.flush()
`;

export class KbDocConvertChannel extends Disposable {

	constructor(
		private readonly logService: ILogService,
		private readonly configurationService: IConfigurationService,
	) {
		super();
		this.registerChannels();
	}

	override dispose(): void {
		validatedIpcMain.removeHandler(KB_EXTRACT_DOC_TEXT_CHANNEL);
		super.dispose();
	}

	private registerChannels(): void {
		validatedIpcMain.handle(KB_EXTRACT_DOC_TEXT_CHANNEL, async (_event, payload?: IKbExtractDocTextRequest) => {
			return this.extract(payload);
		});
	}

	/**
	 * 提取单个文件。
	 *
	 * 入参校验放在最前面（通道可能被任何渲染侧代码调用）：必须是**已存在的 PDF 文件**。
	 */
	private async extract(req?: IKbExtractDocTextRequest): Promise<IKbExtractDocTextResult> {
		const target = req?.filePath?.trim();
		if (!target) { return { ok: false, error: 'filePath 必填' }; }
		const ext = target.slice(target.lastIndexOf('.')).toLowerCase();
		if (!supportedExt(ext)) {
			return { ok: false, error: `暂不支持提取该类型（目前支持 ${PDF_EXT} / .epub / .docx）：${target}` };
		}
		try {
			if (!existsSync(target) || !statSync(target).isFile()) {
				return { ok: false, error: `文件不存在或不是普通文件：${target}` };
			}
		} catch (err) {
			return { ok: false, error: `无法访问文件：${String(err)}` };
		}

		// ★ 2026-09-24：epub/docx 走**纯 TS** 路径（零外部依赖、不需 python）——
		//   放在 python 解析之前，避免用户没装 python 时整条链路不可用。
		if (ARCHIVE_EXTS.has(ext)) {
			return this.extractArchive(target, ext);
		}

		const script = this.ensureScript();
		if (!script) { return { ok: false, error: '无法写入提取脚本（临时目录不可用）' }; }

		const python = this.resolvePythonPath();
		const tmpDir = mkdtempSync(join(tmpdir(), 'saros-kb-pdf-'));
		const started = Date.now();
		try {
			const { stdout, stderr, code } = await this.runPython(python, script, [
				target, tmpDir, req?.markdownImagePrefix ?? '',
			]);
			const meta = parseLastJson(stdout);
			const errorLine = parseError(stderr);

			if (code !== 0 || !meta?.ok) {
				const reason = meta?.error ?? errorLine ?? `python 退出码 ${code}`;
				this.logService.warn(`[KbDocConvert] extract failed (${target}): ${reason}`);
				return { ok: false, error: reason };
			}

			const mdFile = join(tmpDir, 'doc.md');
			let text = existsSync(mdFile) ? readFileSync(mdFile, 'utf-8') : '';
			let truncated = false;
			if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
				text = text.slice(0, MAX_TEXT_BYTES);
				truncated = true;
				this.logService.warn(`[KbDocConvert] markdown truncated to ${MAX_TEXT_BYTES} bytes: ${target}`);
			}

			// 图片：复制到调用方指定的目录（相对引用已在脚本内改写）
			const imageCount = this.copyImages(join(tmpDir, 'images'), req?.targetImageDir);

			this.logService.info(`[KbDocConvert] ${meta.backend}: ${meta.pages ?? '?'} page(s), `
				+ `${text.length} char(s), ${imageCount} image(s) in ${Date.now() - started}ms: ${target}`);
			return {
				ok: true, text, pages: meta.pages ?? 0, imageCount,
				backend: meta.backend === 'pymupdf4llm' ? 'pymupdf4llm' : 'pypdf',
				truncated,
			};
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			this.logService.warn(`[KbDocConvert] extract threw (${target}): ${reason}`);
			return { ok: false, error: reason };
		} finally {
			try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 临时目录清理失败可忽略 */ }
		}
	}

	/**
	 * epub / docx → Markdown（**纯 TS**：`kbArchiveExtract`，不 spawn python）。
	 *
	 * 出口语义与 PDF 分支一致：`text` = Markdown 正文；`pages` 用**章节数** ⇒
	 * 调用方那句「有页无字 ⇒ 不写空 md」的判定对「解出来是空的」同样成立。
	 *
	 * ⚠ v1 不导出归档内的图片（docx 的 `w:drawing` / epub 的插图）：图片需要额外落盘 +
	 *   正文引用改写，而这两个格式的图片引用（`r:embed` 关系表 / epub 相对路径）比 PDF 复杂；
	 *   先保证**文字可读、可检索**（这正是「给 LLM 解读」的核心需求）。
	 */
	private extractArchive(target: string, ext: string): IKbExtractDocTextResult {
		const started = Date.now();
		try {
			const buf = readFileSync(target);
			const r = extractArchiveMarkdown(target, buf);
			if (!r.ok) {
				this.logService.warn(`[KbDocConvert] archive extract failed (${target}): ${r.error}`);
				return { ok: false, error: r.error ?? '解析失败' };
			}
			let text = r.markdown ?? '';
			let truncated = false;
			if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
				text = text.slice(0, MAX_TEXT_BYTES);
				truncated = true;
				this.logService.warn(`[KbDocConvert] markdown truncated to ${MAX_TEXT_BYTES} bytes: ${target}`);
			}
			const backend: 'epub' | 'docx' = ext === '.epub' ? 'epub' : 'docx';
			this.logService.info(`[KbDocConvert] ${backend}: ${r.chapters ?? 0} chapter(s), `
				+ `${text.length} char(s) in ${Date.now() - started}ms: ${target}`);
			return { ok: true, text, pages: r.chapters ?? 0, imageCount: 0, backend, truncated };
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			this.logService.warn(`[KbDocConvert] archive extract threw (${target}): ${reason}`);
			return { ok: false, error: reason };
		}
	}

	/** 把导出图片复制到目标目录；未指定目标目录时返回 0（markdown 里会是无前缀的相对名）。 */
	private copyImages(srcDir: string, dstDirRaw: string | undefined): number {
		const dstDir = dstDirRaw?.trim();
		if (!dstDir || !existsSync(srcDir)) { return 0; }
		let copied = 0;
		try {
			mkdirSync(dstDir, { recursive: true });
			for (const name of readdirSync(srcDir)) {
				const from = join(srcDir, name);
				try {
					if (!statSync(from).isFile()) { continue; }
					copyFileSync(from, join(dstDir, name));
					copied++;
				} catch (err) {
					this.logService.warn(`[KbDocConvert] copy image failed: ${from}`, err);
				}
			}
		} catch (err) {
			this.logService.warn(`[KbDocConvert] copy images failed → ${dstDir}`, err);
		}
		return copied;
	}

	/**
	 * python 解释器：settings `sarosis.kb.pythonPath` → env `SAROS_KB_PYTHON`
	 * → env `SAROS_VOX_PYTHON`（该机器上已配好 python 的用户可直接复用）→ `python`（PATH）。
	 */
	private resolvePythonPath(): string {
		const configured = (this.configurationService.getValue('sarosis.kb.pythonPath') as string | undefined)?.trim();
		const fromEnv = process.env['SAROS_KB_PYTHON']?.trim();
		const fromVoxEnv = process.env['SAROS_VOX_PYTHON']?.trim();
		return configured || fromEnv || fromVoxEnv || 'python';
	}

	/** 把提取脚本写到系统临时目录（固定文件名，反复覆盖，不留垃圾）。 */
	private ensureScript(): string | undefined {
		try {
			const file = join(tmpdir(), SCRIPT_NAME);
			writeFileSync(file, EXTRACT_SCRIPT, 'utf-8');
			return file;
		} catch (err) {
			this.logService.warn(`[KbDocConvert] failed to write extract script: ${String(err)}`);
			return undefined;
		}
	}

	/** spawn python 跑提取脚本，带超时与编码兜底。 */
	private runPython(python: string, script: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
		return new Promise((resolve, reject) => {
			let child;
			try {
				child = spawn(python, [script, ...args], {
					windowsHide: true,
					env: {
						...process.env as Record<string, string>,
						// 与 voxLaunchChannel 一致：Windows 默认 GBK 会把中文写坏
						PYTHONIOENCODING: 'utf-8',
						PYTHONUTF8: '1',
					},
				});
			} catch (err) {
				reject(err);
				return;
			}

			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) { return; }
				settled = true;
				try { child.kill(); } catch { /* 已退出 */ }
				reject(new Error(`提取超时（${TIMEOUT_MS / 1000}s）`));
			}, TIMEOUT_MS);

			child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
			child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
			child.on('error', (err: Error) => {
				if (settled) { return; }
				settled = true;
				clearTimeout(timer);
				// ENOENT = 找不到解释器，把可执行的建议直接给到用户
				const hint = (err as NodeJS.ErrnoException).code === 'ENOENT'
					? `找不到 python 解释器「${python}」。请在设置 sarosis.kb.pythonPath 指定绝对路径，或把 python 加入 PATH。`
					: err.message;
				reject(new Error(hint));
			});
			child.on('close', (code: number | null) => {
				if (settled) { return; }
				settled = true;
				clearTimeout(timer);
				resolve({
					stdout: Buffer.concat(stdout).toString('utf8'),
					stderr: Buffer.concat(stderr).toString('utf8'),
					code,
				});
			});
		});
	}
}

/** 取 stdout 里**最后一个** JSON 行（脚本只打一行，但库可能先输出些警告）。 */
function parseLastJson(out: string): {
	ok?: boolean; error?: string; pages?: number; chars?: number; images?: number; backend?: string;
} | undefined {
	const lines = out.split(/\r?\n/).filter(l => l.trim().startsWith('{'));
	for (let i = lines.length - 1; i >= 0; i--) {
		try { return JSON.parse(lines[i]); } catch { /* 试上一行 */ }
	}
	return undefined;
}

/** 解析 stderr 里的 `[SAROS-ERROR] <原因>` 行。 */
function parseError(stderr: string): string | undefined {
	const line = stderr.split(/\r?\n/).find(l => l.includes('[SAROS-ERROR]'));
	if (!line) { return undefined; }
	return line.slice(line.indexOf('[SAROS-ERROR]') + '[SAROS-ERROR]'.length).trim() || undefined;
}
