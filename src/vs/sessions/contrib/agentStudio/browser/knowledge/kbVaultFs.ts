/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 知识库「库 / 笔记」文件系统工具 + 构建缓存（从 `kbImportController.ts` 外提，2026-10-12）。
 *
 * 外提原因：那个文件超了 2500 行的规模预算（`test/common/fileSizeBudget.test.ts` 守着），
 * 而这批成员全是**静态**的 —— 依赖都从参数进来（`IFileService` 等），没有 `this` 绑定 ⇒
 * 整体外提是机械操作，行为不变。类里保留同名的 `static` **薄转发**以保持对外 API 不变
 * （`agentStudio.contribution.ts` 等按 `KbImportController.resolveActiveVaultRoot` 调用）。
 *
 * ⚠ 改这里的行为前先看 `kbImportController.test.ts`（1169 行）—— 那是对应的护栏。
 */

import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { dirname } from '../../../../../base/common/resources.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { INativeEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IAgentStudioService } from '../../common/agentStudio.js';
import type { IChatModel } from './llm.js';
import { IKBSchema, sanitizeKbTopic } from './kbSchema.js';
import { extractSources, removeSources, parseFrontmatter, setStatus, STATUS_ACTIVE, STATUS_PENDING } from './frontmatter.js';
import { canonicalizeTitle, loadKbAliases } from './kbAliases.js';
import { nativeIpcBridge } from '../../common/configHtmlConfig.js';
import { KB_EXTRACT_DOC_TEXT_CHANNEL, KB_DOC_SOURCE_EXTENSIONS, type IKbExtractDocTextResult } from '../../common/kbDocConvertChannel.js';

// ─── 路径 / 存储键常量（原先是 `KbImportController` 的 static，逐字搬来，值未改动）───

export const KB_ROOT_SUBPATH= '.vssaros/knowledge-base';
export const KB_LIBRARY_SUBPATH= '库';
export const KB_RAW_SUBPATH= 'raw';
export const KB_NOTES_SUBPATH= '笔记';
export const KB_SUBS_TMP_SUBPATH= '.kb-subs-tmp';
export const SYS_INDEX_FILES: readonly string[] = ['index.md', 'overview.md', 'insights.md', 'log.md', 'lint-report.md', 'dedup-report.md', '知识体系.md'];
export const SKILL_DIR= '.kb-skills';
export const GATED_TYPES= new Set(['concept', 'comparison', 'synthesis', 'entity']);
export const STORAGE_KB_DIR= 'agentStudio.kb.kbDir';
export const STORAGE_VAULTS= 'agentStudio.kb.vaults';
export const STORAGE_ACTIVE= 'agentStudio.kb.active';

	/** static 版（供 `_buildAllPendingCore` 这类静态路径复用），保证反馈来源唯一、观感一致。 */
export function reportProcessing(
		agentStudioService: IAgentStudioService,
		logService: ILogService,
		active: boolean,
		label?: string,
		paths?: string[],
	): void {
		try {
			agentStudioService.reportKbProcessing({ active, label, paths });
			agentStudioService.requestLibraryBadge(
				active ? { source: 'kb', kind: 'building' } : { source: 'kb', kind: 'new', count: 1 });
		} catch (err) {
			// 上报失败绝不能影响导入/构建主流程
			logService.warn('[KbImportController] report processing state failed:', err);
		}
	}

	/**
	 * **只搬文件、不分析**：把原始文件原样复制到 `<vault>/库/raw/<原始文件名>`。
	 *
	 * 需求来源（2026-09-23）：用户要求「**快速**复制/移动文件到库，之后**在库中**再对新增文件
	 * 做分析归类、总结生成笔记」——即把「搬文件」与「LLM 分析」彻底解耦。
	 *
	 * 为什么必须拆：`handleFavoriteMessage` / `importContentAndBuild` 会先跑 schema 分类
	 * （一次 LLM），再跑阶段 2 抽取（agentic 多轮 LLM，真机实测**单请求超时就有 120s**）——
	 * 多文件时「搬文件」这种纯 IO 操作被拖成「卡住」（日志：`[1/7] start` 之后全是
	 * `Chat request timeout: 120000ms` + `_buildNoteAgentic`）。
	 * 本方法**只做文件 IO**（读字节 + 写字节 + 去重指纹），秒级返回；分类与抽取交给调用方
	 * 在**后台**用 `buildNotesFromLibrary` 异步进行。
	 *
	 * @returns 落盘后的绝对路径；失败返回 `undefined`（已 log；`quiet` 时不单独弹通知）
	 */

	/** 类型 → 目录映射（含 id / label / dir 三种键），供直连与 agentic 两条构建路径共用。 */
export function typeDirMapping(schema: IKBSchema): { typeToDir: Map<string, string>; defaultTypeDir: string | undefined } {
		const typeToDir = new Map<string, string>();
		for (const t of schema.types) {
			if (t.id) { typeToDir.set(t.id, t.dir); }
			if (t.label) { typeToDir.set(t.label, t.dir); }
			if (t.dir) { typeToDir.set(t.dir, t.dir); }
		}
		return { typeToDir, defaultTypeDir: schema.types.find(t => t.id === schema.defaultType)?.dir };
	}

	/**
	 * 静态方法：由 knowledgeBaseView 使用，需要显式传入所有依赖和 vault root。
	 * vaultRootUri 必须提供（在 view 端取自活动仓库根目录）。
	 */

export async function collectPendingSources(
		fileService: IFileService, vaultRoot: URI, logService: ILogService,
		notificationService: INotificationService, agentStudioService: IAgentStudioService,
	): Promise<{ libDir: URI; notesDir: URI; pending: URI[]; cache: Record<string, string> }> {
		const libDir = URI.joinPath(vaultRoot, KB_LIBRARY_SUBPATH);
		const notesDir = URI.joinPath(vaultRoot, KB_NOTES_SUBPATH);
		await stageDocSourcesToText(fileService, libDir, logService, notificationService, agentStudioService);
		const cache = await readBuildCache(fileService, vaultRoot);
		// 排除系统导航文件（index/overview/insights 等，由 maintainKbNavigation 维护，非素材）
		const libFiles = await collectMdFiles(fileService, libDir, SYS_INDEX_FILES);
		// 排除已知的构建产出笔记（cache values）：库/<typeDir>/ 下的 .md 多为已生成笔记，
		// 再当素材构建会造成「笔记→笔记」递归 churn。
		const builtNotes = new Set(Object.values(cache).map(p => p.toLowerCase()));
		const pending: URI[] = [];
		for (const f of libFiles) {
			if (builtNotes.has(f.fsPath.toLowerCase())) { continue; }   // 本身是别人产出的笔记 ⇒ 永不当素材
			const cachedNote = cache[f.fsPath];
			// ★ 2026-09-24（用户要求）：**素材被修改后要能被重新构建**。原先这里只查「缓存里有没有这个路径」
			//   ⇒ 改过的素材会被**永久跳过**（缓存是路径映射、不看内容）。改为「缓存条目是否新鲜」：
			//   笔记不存在 ⇒ 重建；笔记 mtime < 素材 mtime（素材在构建后又被改过）⇒ 重建。
			if (!cachedNote || !(await cacheEntryFresh(fileService, f, cachedNote))) {
				pending.push(f);
			}
		}
		return { libDir, notesDir, pending, cache };
	}

	/**
	 * 缓存条目是否「新鲜」＝ 笔记存在 **且** 笔记的 mtime ≥ 素材的 mtime（★ 2026-09-24）。
	 *
	 * 为什么 mtime 比较成立：构建完成时笔记**一定**被写过（`_writeFileBlocks` / `_injectSourcesIntoFiles` /
	 * `_enrichNewNotes` 顺序写盘）⇒ 那一刻起笔记 mtime ≥ 素材 mtime；所以后来「素材比笔记新」⇔ 素材在
	 * 构建完成后**又被修改过** ⇒ 需要重建（构建会就地 patch 更新那篇笔记，而不是新建）。
	 *
	 * ⚠ 三处缓存判定点（`_collectPendingSources` / `_buildNoteCore` / `_buildNoteAgentic`）都用它，
	 *   口径必须一致；别在某一处单独写回「只查存在性」的旧逻辑。
	 */

export async function cacheEntryFresh(fileService: IFileService, source: URI, notePath: string): Promise<boolean> {
		let srcMtime = 0, noteMtime = -1;
		try { srcMtime = (await fileService.resolve(source)).mtime ?? 0; } catch { /* 素材读不了 ⇒ 当不新鲜 */ }
		try { noteMtime = (await fileService.resolve(URI.file(notePath))).mtime ?? 0; } catch { return false; }  // 笔记不存在 ⇒ 不新鲜
		return noteMtime >= srcMtime;
	}

	/**
	 * 「非文本素材 → 文本」的**前置转换**（2026-09-23 需求）。
	 *
	 * ## 为什么必须有这一步
	 *
	 * 素材枚举只收 `.md`（见 `_collectMdFiles` 的 `endsWith('.md')`），且构建管线把素材
	 * **当纯文本**塞进 prompt（`readFile(...).toString()`）⇒ 库里的 PDF 既进不了候选列表、
	 * 即使强行喂进去也是二进制乱码。所以「支持 PDF 素材」= 先把 PDF 文字层落成同目录同名 `.md`，
	 * 之后**既有构建管线零改动**即可接手（这是本方案最大的好处）。
	 *
	 * ## 边界与取舍
	 *
	 * · **提取在主进程**（`vscode:kbExtractDocText` → 本机 `python` + `pypdf`）：
	 *   渲染进程没有 `child_process`。桥不可用（web 环境 / node 单测）时**静默跳过**，
	 *   批量构建本身照常进行。
	 * · **扫描件不写空 md**：有页无字时只提示（写空 md 会被当素材构建出一篇空笔记）。
	 * · **不重复提取**：同名 `.md` 比源文件新 ⇒ 跳过（否则每次批量构建都重跑一遍 python）。
	 * · 串行执行：本机 python 启停有成本，并发无收益，且会让进度文案乱序。
	 */

export async function stageDocSourcesToText(
		fileService: IFileService,
		libDir: URI,
		logService: ILogService,
		notificationService: INotificationService,
		agentStudioService: IAgentStudioService,
	): Promise<void> {
		const bridge = nativeIpcBridge();
		const invoke = bridge?.ipcRenderer?.invoke;
		if (!invoke) {
			logService.info('[KbImportController] doc → text staging skipped: IPC bridge unavailable');
			return;
		}

		let sources: URI[];
		try {
			sources = await collectDocSources(fileService, libDir);
		} catch (err) {
			logService.warn('[KbImportController] doc → text: collect sources failed', err);
			return;
		}
		if (sources.length === 0) { return; }

		const noText: string[] = [];
		const failed: string[] = [];
		let converted = 0;

		for (let i = 0; i < sources.length; i++) {
			const src = sources[i];
			const name = src.path.split('/').pop() ?? '';
			const stem = name.replace(/\.[^.]+$/, '');
			const mdUri = URI.joinPath(URI.joinPath(src, '..'), stem + '.md');
			const stale = await isStaleMarkdown(fileService, mdUri, src);
			// ★ 后端升级迁移（2026-09-23）：旧 md 是 `pypdf` 纯文本产物（无图片/无结构）。
			//   升级到 PyMuPDF4LLM 后，这些旧文件**不会**因 mtime 过期而重提取 ⇒ 用户得手动删。
			//   这里额外检查来源行是否带新版标记 ⇒ 不带就重提取一次（之后新旧产物都带标记，不会反复）。
			if (!stale && !(await needsBackendUpgrade(fileService, mdUri))) { continue; }

			reportProcessing(agentStudioService, logService, true,
				`提取文档文本 ${i + 1}/${sources.length}：${name}`, [src.fsPath]);
			try {
				// ★ 图片落点（2026-09-23）：`<库/raw>/assets/<素材名>/`，markdown 里引用
				//   `assets/<素材名>/img-NN.png` —— 与「导入链接」把图片本地化到
				//   `库/raw/assets/<素材名>/` 的既有约定完全一致（预览与飞书同步都按相对路径解析）。
				const assetDir = URI.joinPath(URI.joinPath(src, '..'), 'assets', stem);
				const res = await invoke(KB_EXTRACT_DOC_TEXT_CHANNEL, {
					filePath: src.fsPath,
					markdownImagePrefix: `assets/${stem}`,
					targetImageDir: assetDir.fsPath,
				}) as IKbExtractDocTextResult | undefined;
				if (!res?.ok) {
					failed.push(`${name}（${res?.error ?? '未知错误'}）`);
					continue;
				}
				const text = (res.text ?? '').trim();
				if (!text) {
					// 有页无字 ⇒ 扫描件（无文字层）。**不写空 md**：否则会被当素材构建出空笔记。
					noText.push(`${name}（${res.pages ?? 0} 页）`);
					continue;
				}
				// ⚠ 不再套一层 `# <素材名>` 大标题：正文现在本身已是结构化 markdown
				//   （原文的 `# 动画优化` / `## 图解` / 列表层级都在），再包一层 H1 会抢层级。
				// ★ 2026-09-24：epub/docx 走同一出口 ⇒ 这里按后端给出**各自的单位**（页 / 章）。
				const archive = res.backend === 'epub' || res.backend === 'docx';
				const backendLabel = res.backend === 'pymupdf4llm' ? 'PyMuPDF4LLM 结构化解析'
					: res.backend === 'pypdf' ? 'pypdf 纯文本提取'
						: res.backend === 'epub' ? 'EPUB 章节解析'
							: res.backend === 'docx' ? 'DOCX 段落解析' : '未知后端';
				const amount = archive ? `共 ${res.pages ?? 0} 章` : `共 ${res.pages ?? 0} 页`;
				// ⚠「提取后端：」这个标记有**功能性作用**（不只是说明文案）：`_needsBackendUpgrade`
				//   靠它识别「旧版产物」并在下次批量构建时自动重提取 ⇒ 别删掉这个字段。
				const header = `> 来源：\`${name}\`（${backendLabel}；提取后端：${res.backend ?? 'unknown'}，${amount}`
					+ `${res.imageCount ? `，提取图片 ${res.imageCount} 张` : ''}`
					+ `${res.truncated ? '，文本已截断' : ''}）\n\n`;
				await fileService.writeFile(mdUri, VSBuffer.fromString(header + text + '\n'));
				converted++;
				logService.info(`[KbImportController] staged doc → text: ${src.fsPath} → ${mdUri.fsPath}`
					+ ` (${text.length} chars, ${res.imageCount ?? 0} image(s), backend=${res.backend ?? '?'})`);
			} catch (err) {
				failed.push(`${name}（${err instanceof Error ? err.message : String(err)}）`);
				logService.warn(`[KbImportController] doc → text failed: ${src.fsPath}`, err);
			}
		}

		if (converted > 0) {
			logService.info(`[KbImportController] doc → text staged ${converted} file(s) from ${sources.length} source(s)`);
		}
		if (noText.length) {
			notificationService.notify({
				severity: Severity.Info,
				message: `以下 PDF 未提取到文字（疑似扫描件，需 OCR 才能构建）：`
					+ `${noText.slice(0, 5).join('、')}${noText.length > 5 ? `…等 ${noText.length} 个` : ''}`,
				source: 'kb-build',
			});
		}
		if (failed.length) {
			notificationService.notify({
				severity: Severity.Warning,
				message: `PDF 文本提取失败：${failed.slice(0, 3).join('；')}${failed.length > 3 ? `…等 ${failed.length} 个` : ''}`,
				source: 'kb-build',
			});
		}
	}

	/** 递归收集需要「先转文本」的素材（跳过隐藏项与 `assets/` 图片目录）。 */
export async function collectDocSources(fileService: IFileService, dir: URI): Promise<URI[]> {
		const out: URI[] = [];
		const walk = async (current: URI): Promise<void> => {
			try {
				const stat = await fileService.resolve(current);
				if (!stat.children) { return; }
				for (const child of stat.children) {
					if (child.name.startsWith('.')) { continue; }
					if (child.isDirectory) {
						// `assets/` 是「导入链接」时的图片本地化目录（只可能含图片），无需递归
						if (child.name === 'assets') { continue; }
						await walk(child.resource);
					} else if (KB_DOC_SOURCE_EXTENSIONS.some(ext => child.name.toLowerCase().endsWith(ext))) {
						out.push(child.resource);
					}
				}
			} catch { /* ignore */ }
		};
		await walk(dir);
		return out;
	}

	/**
	 * 旧产物是否需要「提取后端升级」重提取（2026-09-23）。
	 *
	 * 背景：早期版本用 `pypdf` 纯文本提取（无图片、无结构、不可读）。升级到 PyMuPDF4LLM 后，
	 * 已存在的旧 md 因 mtime 较新而**不会被重提取** ⇒ 用户必须手动删文件才能享受新质量。
	 * 这里读 md 头部：不含新版标记 `提取后端：` ⇒ 视为需要重提取 ✓（自动迁移，一次到位）。
	 */

export async function needsBackendUpgrade(fileService: IFileService, mdUri: URI): Promise<boolean> {
		try {
			const head = (await fileService.readFile(mdUri)).value.toString().slice(0, 400);
			return !head.includes('提取后端：');
		} catch {
			return false;   // 读不到就先不动（下次批量构建再说）
		}
	}

	/**
	 * 源文件相对同名 md 是否**已过期**（= 需要（重新）提取）。
	 * md 不存在、或比源文件旧 ⇒ `true`；md 更新 ⇒ `false`（跳过）。
	 */

export async function isStaleMarkdown(fileService: IFileService, mdUri: URI, srcUri: URI): Promise<boolean> {
		try {
			const [md, src] = await Promise.all([fileService.resolve(mdUri), fileService.resolve(srcUri)]);
			const mdTime = md.mtime ?? 0;
			const srcTime = src.mtime ?? 0;
			return !(mdTime > 0 && mdTime >= srcTime);
		} catch {
			return true;   // md 不存在（resolve 抛错）⇒ 需要提取
		}
	}

	/** 文件系统路径等价比较（忽略斜杠差异、尾部分隔符与大小写）。 */
export function sameFsPath(a: string, b: string): boolean {
		const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
		return norm(a) === norm(b);
	}

	/** 目录为空时删除（用于迁移后清理旧的空分类目录）；非空或出错时静默忽略。 */
export async function removeDirIfEmpty(fileService: IFileService, dir: URI): Promise<void> {
		try {
			const stat = await fileService.resolve(dir);
			if (stat.isDirectory && (stat.children?.length ?? 0) === 0) {
				await fileService.del(dir);
			}
		} catch { /* ignore */ }
	}

	/**
	 * 从库文件解析分类（type/topic），用于兜底落笔记的分类目录：
	 *   - 消息导入：库文件为 frontmatter 包裹的 .md → 从 frontmatter 的 type/topic 读；
	 *   - 文件导入：库文件为原始文件副本（无 frontmatter）→ 从目录路径推导
	 *     （库/<typeDir>/<topic>/<原始文件名>，分类信息由入库时的目录承载）。
	 */

export function parseLibCategory(libContent: string, libDir?: URI, libFileUri?: URI, logService?: ILogService): { typeDir: string; topic: string } {
		const fm = libContent.match(/^---\n([\s\S]*?)\n---/);
		const pick = (key: string): string | undefined => {
			const m = fm?.[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
			return m?.[1].trim();
		};
		const fmType = pick('type');
		const fmTopic = pick('topic');
		if (fmType || fmTopic) {
			return { typeDir: fmType ?? 'note', topic: sanitizeKbTopic(fmTopic ?? '') ?? '未分类' };
		}
		if (libDir && libFileUri) {
			const rel = libFileUri.path.substring(libDir.path.length).replace(/^\/+/, '');
			const segs = rel.split('/').filter(s => !!s);
			if (segs.length >= 3) {
				// segs[1] 本该是 topic 目录名，但历史上它可能承载整段导入提示词。
				// sanitizeKbTopic 现会对句子/超长输入返回 undefined，此时回退「未分类」，
				// 而不是把提示词直接建成目录。
				const rawTopic = decodeURIComponent(segs[1]);
				const safeTopic = sanitizeKbTopic(rawTopic);
				if (safeTopic) {
					return { typeDir: decodeURIComponent(segs[0]), topic: safeTopic };
				}
				logService?.warn(`[KbImportController] _parseLibCategory rejected topic candidate (looks like sentence): ${rawTopic.slice(0, 60)}`);
			}
		}
		return { typeDir: 'note', topic: '未分类' };
	}

	/**
	 * 兜底（库目录版）：将原始输出落为 <outputDir>/<safeName>.md（不附加 typeDir 前缀，
	 * 因 outputDir 的路径已暗示所属类型）。内容过短（<100 字符）返回 undefined。
	 */

export async function salvageSingleNoteToDir(raw: string, safeName: string, outputDir: URI, fileService: IFileService): Promise<string | undefined> {
		const body = raw
			.replace(/^```(?:markdown|md|text)?\s*\n/i, '')
			.replace(/\n```\s*$/m, '')
			.trim();
		if (body.length < 100) { return undefined; }
		await fileService.createFolder(outputDir);
		const fileUri = URI.joinPath(outputDir, `${sanitizeFsName(safeName) || '未命名'}.md`);
		const now = new Date();
		const pad = (n: number) => String(n).padStart(2, '0');
		const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
		const content = body.startsWith('---')
			? body
			: ['---', 'type: note', `title: ${safeName}`, `created: ${date}`, '---', '', body].join('\n');
		await fileService.writeFile(fileUri, VSBuffer.fromString(content));
		return fileUri.fsPath;
	}

	// ─── 构建缓存 ─────────────────────────────────────────────────────────────

export async function readBuildCache(fileService: IFileService, vaultRoot: URI): Promise<Record<string, string>> {
		try { return JSON.parse((await fileService.readFile(URI.joinPath(vaultRoot, '.kb-build-cache.json'))).value.toString()); } catch { return {}; }
	}

export async function writeBuildCache(fileService: IFileService, vaultRoot: URI, cache: Record<string, string>): Promise<void> {
		try { await fileService.writeFile(URI.joinPath(vaultRoot, '.kb-build-cache.json'), VSBuffer.fromString(JSON.stringify(cache, null, 2))); } catch { /* ignore */ }
	}

	/**
	 * 剔除构建缓存中与给定路径相关的条目（2026-09-23，删除收口 P0-A）。
	 *
	 * 命中规则（大小写不敏感、**含子路径**，便于删除目录时一次性收敛）：
	 *  · key 命中（源文件被删）：这条「已构建」记录已无意义，留着只会在**同名素材重新出现**时
	 *    让批量构建误判「已构建」而永久跳过；
	 *  · value 命中（**已建笔记被删**）：必须清掉，否则 `_buildAllPendingCore` 的
	 *    `pending = libFiles.filter(f => !cache[f.fsPath] && …)` 会把它的源**永久排除在 pending 之外**
	 *    ⇒ 「删掉笔记后，批量构建再也建不出来」。
	 *
	 * @returns 被剔除的条目数（0 = 无需写盘）
	 */

export async function purgeBuildCacheEntries(fileService: IFileService, vaultRoot: URI, deletedFsPaths: string[]): Promise<number> {
		if (deletedFsPaths.length === 0) { return 0; }
		const cache = await readBuildCache(fileService, vaultRoot);
		const targets = deletedFsPaths.map(p => p.toLowerCase().replace(/[\\/]+$/, ''));
		const hit = (candidate: string): boolean => {
			const c = candidate.toLowerCase();
			return targets.some(t => c === t || c.startsWith(t + '\\') || c.startsWith(t + '/'));
		};
		let removed = 0;
		for (const [src, note] of Object.entries(cache)) {
			if (hit(src) || hit(note)) { delete cache[src]; removed++; }
		}
		if (removed > 0) { await writeBuildCache(fileService, vaultRoot, cache); }
		return removed;
	}

	/**
	 * **保留笔记**、只剔除其中已失效的来源（2026-09-23，删除收口 P0-B）。
	 *
	 * 为什么不直接删笔记：`cascadeDeleteLibraryNotes` 在「两阶段工作流」下是**有意禁用的 stub**
	 * （返回 `[]`，且有契约测试 `kbImportController.test.ts` 守着）—— 引擎不自动删用户笔记。
	 * 但删掉库源文件后，笔记 frontmatter 的 `sources` 会留着已不存在的文件名，导致两个问题：
	 *  · `applyDeabstractionGating` 按去重来源数决定 `status`（≥2 → active）⇒ 来源数**虚高**，状态失真；
	 *  · 溯源/双链指向空气（「体检」的 broken-link 只在正文 `[[x]]` 上生效，sources 字段无人管）。
	 * 于是这里按「库内现有 `.md` 的 basename 集合」判定失效来源、逐条剔除；重跑门控由调用方负责。
	 *
	 * ⚠ 匹配口径必须与 `extractSources` 一致：`normalizeSourceRef` 归一为**小写 basename（带扩展名）**。
	 *
	 * @param extraNoteDirs 额外扫描的笔记目录（如「笔记」分区）—— 它们同样带 `sources` 溯源
	 * @returns notes=被改写的笔记绝对路径；removed=剔除的来源条数
	 */

export async function pruneMissingSources(
		fileService: IFileService, libDir: URI, extraNoteDirs: URI[] = [],
	): Promise<{ notes: string[]; removed: number }> {
		// ① 现有库文件的 basename 集合（不排除导航文件：多收一点只会更保守、更不容易误删来源）
		const existing = new Set<string>();
		try {
			for (const f of await collectMdFiles(fileService, libDir)) {
				existing.add((f.path.split('/').pop() ?? '').toLowerCase());
			}
		} catch {
			return { notes: [], removed: 0 };
		}

		// ② 扫描笔记（库内混居 + 额外目录），剔除「库里已找不到」的来源
		const scanned = new Set<string>();
		const notes: string[] = [];
		let removed = 0;
		for (const dir of [libDir, ...extraNoteDirs]) {
			let files: URI[];
			try { files = await collectMdFiles(fileService, dir); } catch { continue; }
			for (const f of files) {
				if (scanned.has(f.fsPath)) { continue; }
				scanned.add(f.fsPath);
				let raw: string;
				try { raw = (await fileService.readFile(f)).value.toString(); } catch { continue; }
				const missing = new Set(extractSources(raw).filter(s => !existing.has(s)));
				if (missing.size === 0) { continue; }
				const { content: updated, changed } = removeSources(raw, missing);
				if (!changed) { continue; }
				try {
					await fileService.writeFile(f, VSBuffer.fromString(updated));
					notes.push(f.fsPath);
					removed += missing.size;
				} catch { /* skip */ }
			}
		}
		return { notes, removed };
	}

	/** 当前已构建的「构建源」绝对路径集合（小写）。供视图显示真实构建状态（P2）。 */
export async function listBuiltSourcePaths(fileService: IFileService, vaultRoot: URI): Promise<Set<string>> {
		const cache = await readBuildCache(fileService, vaultRoot);
		return new Set(Object.keys(cache).map(p => p.toLowerCase()));
	}

	/**
	 * 清理构建缓存里的**孤儿条目**（2026-09-23，P1）：key（源）或 value（已建笔记）已不存在的记录。
	 *
	 * 与 `purgeBuildCacheEntries` 的分工：那个是「知道删了什么路径」时的精准剔除（删除收口用）；
	 * 这个是「不知道谁被删了」时的全量体检（用于**外部删除** —— 在系统资源管理器/手机端删文件，
	 * 完全不经知识库视图，也就没有 `_settleAfterDelete` 收口）。
	 *
	 * @returns 被剔除的条目数
	 */

export async function purgeStaleBuildCacheEntries(fileService: IFileService, vaultRoot: URI): Promise<number> {
		const cache = await readBuildCache(fileService, vaultRoot);
		const exists = async (p: string): Promise<boolean> => fileService.resolve(URI.file(p)).then(() => true, () => false);
		let removed = 0;
		for (const [src, note] of Object.entries(cache)) {
			if (!(await exists(src)) || !(await exists(note))) { delete cache[src]; removed++; }
		}
		if (removed > 0) { await writeBuildCache(fileService, vaultRoot, cache); }
		return removed;
	}

export async function listAllNoteSubdirs(fileService: IFileService, notesDir: URI): Promise<string[]> {
		const set = new Set<string>();
		// raw 是源文件存放区，不应作为笔记归类目标目录暴露给 LLM
		const excludeDirs = new Set([KB_RAW_SUBPATH]);
		try {
			const st = await fileService.resolve(notesDir);
			if (st.children) {
				for (const c of st.children) {
					if (c.isDirectory && !c.name.startsWith('.') && !excludeDirs.has(c.name)) {
						set.add(c.name);
						try {
							const sub = await fileService.resolve(c.resource);
							if (sub.children) for (const cc of sub.children) {
								if (cc.isDirectory && !cc.name.startsWith('.')) set.add(`${c.name}/${cc.name}`);
							}
						} catch { /* ignore */ }
					}
				}
			}
		} catch { /* ignore */ }
		return [...set].sort();
	}

	/**
	 * 供 FILE 块 prompt 使用的**目录候选**（2026-09-23 用户要求）。
	 *
	 * 为什么要与 `_listAllNoteSubdirs` 分开：笔记区里除了引擎产出，还有**用户手写的笔记目录**
	 * （如 `01_学习 / 02_工作 / 03_生活`）。把它们当作候选喂给模型，LLM 就会把技术笔记塞进
	 * 用户自己的分类体系里 —— 用户明确要求：**只把 LLM 自己建的目录作为候选**。
	 *
	 * 判定规则（两条，任一不满足即排除）：
	 *  ① 名称不是「手写区惯例」：`01_xxx` / `02-xxx` 这类**数字前缀**目录（PARA 风格）；
	 *  ② 目录（含其子目录）里**确实存在引擎产出的笔记** —— 依据 frontmatter 的 `sources` / `status`
	 *     字段判定（构建阶段 `_injectSourcesIntoFiles` 必然写入 `sources`；手写笔记一般没有）。
	 * 用②而不是写死名字，是为了**自维护**：以后 LLM 新开的目录会自然进入候选，用户新加的手写目录会被自然排除。
	 */

export async function listEngineNoteDirs(fileService: IFileService, notesDir: URI): Promise<string[]> {
		const all = await listAllNoteSubdirs(fileService, notesDir);
		const out: string[] = [];
		for (const rel of all) {
			if (/^\d+[_-]/.test(rel)) { continue; }   // ① 手写区惯例（01_学习…）
			const dir = URI.joinPath(notesDir, ...rel.split('/'));
			if (await dirHasEngineNotes(fileService, dir)) { out.push(rel); }
		}
		return out;
	}

	/** 目录（含子目录）里是否存在引擎产出的笔记：frontmatter 带 `sources` 或 `status`。 */
export async function dirHasEngineNotes(fileService: IFileService, dir: URI): Promise<boolean> {
		let files: URI[];
		try {
			files = await collectMdFiles(fileService, dir);
		} catch {
			return false;
		}
		for (const f of files) {
			try {
				const raw = (await fileService.readFile(f)).value.toString();
				const { frontmatter } = parseFrontmatter(raw);
				if (frontmatter && ('sources' in frontmatter || 'status' in frontmatter)) { return true; }
			} catch { /* 读不了就跳过，不影响判定 */ }
		}
		return false;
	}

	// ─── 路径解析 ─────────────────────────────────────────────────────────────

	/**
	 * 解析**当前活动 vault 的根目录**。
	 *
	 * ⚠ 做成 **static** 是为了单一真源：实例（导入落盘）与视图外调用方（例如 Explorer 右键
	 *   「移动到知识库」在导入前判断「文件是否已在库内」）必须得出**完全相同的路径**，
	 *   否则「库内判定」会和实际落盘目录不一致 —— 该跳过的没跳过（甚至把库文件搬走）。
	 */

export function resolveActiveVaultRoot(storageService: IStorageService, envService: INativeEnvironmentService, logService?: ILogService): URI {
		// 获取基础根目录（用户可在 KB 视图设置面板中配置）
		const customRoot = storageService.get(STORAGE_KB_DIR, StorageScope.APPLICATION);
		const baseRoot = (typeof customRoot === 'string' && customRoot.trim())
			? URI.file(customRoot.trim())
			: URI.joinPath(envService.userHome, ...KB_ROOT_SUBPATH.split('/'));

		// 如果 KB 视图中有活动仓库（vault），导入应该落到该仓库下
		try {
			const activeId = storageService.get(STORAGE_ACTIVE, StorageScope.APPLICATION);
			if (typeof activeId === 'string' && activeId.trim()) {
				const raw = storageService.get(STORAGE_VAULTS, StorageScope.APPLICATION);
				if (typeof raw === 'string') {
					const vaults: { id: string; customPath?: string }[] = JSON.parse(raw);
					const activeVault = vaults.find(v => v.id === activeId);
					if (activeVault?.customPath) {
						return URI.file(activeVault.customPath);
					}
					// 默认 vault 路径：baseRoot/vaultId
					if (activeVault) {
						const computed = URI.joinPath(baseRoot, activeId);
						// ★ 2026-09-23 诊断日志：命中这条 fallback ⇒ 后续**会在
						//   `<kbDir>/<vaultId>` 下写文件**（`库/raw/...`），从而创建出
						//   那个「凭空多出的 `<时间戳>-<随机>` 目录」。正常配置（vault 有
						//   `customPath`）永远不会走到这里 ⇒ 一旦出现就是定位线索。
						logService?.warn(`[KB][vault-dir] resolveActiveVaultRoot fallback → ${computed.fsPath}`
							+ ` (vaultId=${activeId} 无 customPath)\nstack=${new Error().stack}`);
						return computed;
					}
				}
			}
		} catch { /* storage parse error → 回退到 baseRoot */ }

		return baseRoot;
	}

export function isWithinVault(uri: URI, vaultRoot: URI): boolean {
		const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
		const root = norm(vaultRoot.fsPath);
		if (!root) { return false; }
		const target = norm(uri.fsPath);
		return target === root || target.startsWith(root + '/');
	}

	/** 清理文件系统非法字符（Windows: < > : " / \ | ? * 和控制字符），限长 80。 */
export function sanitizeFsName(name: string): string {
		const cleaned = (name ?? '')
			.replace(/[<>:"/\\|?*\x00-\x1f]/g, '') // 非法字符
			.replace(/\s+/g, ' ')                   // 合并空白
			.trim()
			.replace(/[.]+$/g, '');                 // 去尾部点号（Windows 不允许）
		const out = cleaned || 'untitled';
		return out.length > 80 ? out.slice(0, 80) : out;
	}

	/**
	 * 计算库文件相对于库根目录的路径，返回 `库/<相对路径>` 格式的双链引用。
	 * 例如 libDir= `/vault/库`, file= `/vault/库/概念/UE5-GC/GC_Mechanism.html`
	 * → `库/概念/UE5-GC/GC_Mechanism.html`。
	 */

export function relativeFromLib(libFileUri: URI, libDir: URI): string {
		const libPrefix = libDir.fsPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
		const filePath = libFileUri.fsPath.replace(/\\/g, '/').toLowerCase();
		const rel = filePath.startsWith(libPrefix + '/') ? filePath.substring(libPrefix.length + 1) : filePath;
		return `库/${rel}`;
	}

	// ─── vault 锁 ─────────────────────────────────────────────────────────────

	/** Stage 1：LLM 结构化分析（主题 / 类型 / 路径规划）。 */
export async function runStage1Analysis(
		content: string, schemaText: string, candidates: string,
		chatModel: IChatModel, logService: ILogService,
	): Promise<string> {
		const system = '你是一位知识库架构师，擅长将零散素材结构化为 wiki 笔记。只输出中文纯文本分析。';
		const userPrompt = [
			'## KB Schema（笔记类型定义，落盘路径请优先使用这些 typeDir）',
			schemaText,
			'',
			'## 现有笔记目录（优先复用，含用户自建目录如 学习/工作/生活）',
			candidates || '  (none)',
			'',
			'## 待结构化素材',
			content,
			'',
			'请输出一份结构化规划（中文，纯文本），包括：',
			'1. 内容主题与核心要点（3-5 条）',
			'2. 适用的笔记类型（必须来自 KB Schema 的 type，不要自造类型）',
			'3. 建议落盘路径（优先复用现有目录；若无匹配则按 schema 的 <typeDir>/<topic> 新建）',
			'4. 将素材拆分为几篇笔记，每篇的标题与大纲',
		].join('\n');
		try {
			return await chatModel.complete(system, userPrompt, 0.4);
		} catch (e) {
			logService.warn('[KbImportController] stage1 analysis failed, proceeding without analysis:', e);
			return '';
		}
	}

	/** Stage 2：解析 FILE 块并确定性落盘（按 schema 类型目录归类；模型未带前缀时按 frontmatter.type 二次归类）。 */
export async function writeFileBlocks(
		blocks: { path: string; content: string }[],
		notesDir: URI,
		vaultRoot: URI,
		fileService: IFileService,
		logService: ILogService,
		typeToDir?: ReadonlyMap<string, string>,
		defaultTypeDir?: string,
	): Promise<string[]> {
		const written: string[] = [];
		const dirSet = typeToDir ? new Set(typeToDir.values()) : new Set<string>();
		const isWithin = (uri: URI) => uri.fsPath.toLowerCase().startsWith(vaultRoot.fsPath.toLowerCase());
		const used = new Set<string>(); // 同批次已用路径
		for (const b of blocks) {
			let rel = (b.path || '').replace(/^[\\/]+/, '');
			rel = rel.replace(/^笔记[\\/]/i, '').replace(/^notes[\\/]/i, '');
			if (!rel) { continue; }
			let segs = rel.split(/[\\/]+/).filter(s => s && s !== '.' && s !== '..');
			if (segs.length === 0) { continue; }

			// 1) 模型已带 schema 类型目录前缀（概念/对比/…）→ 保留并据此归类
			let prefixDir: string | undefined;
			if (dirSet.has(segs[0])) {
				prefixDir = segs[0];
				segs = segs.slice(1); // 余下视为文件名（可能含主题子目录 概念/主题/xxx.md）
			}

			// 2) 模型**只给了裸文件名**（完全没给目录）→ 依据 frontmatter.type / defaultTypeDir 兜底，
			//    避免笔记平铺到笔记区根目录（历史 bug：笔记全部平铺、无目录）。
			//    ★ 2026-09-23 目录决定权交给 LLM：**模型自己给出的目录一律尊重**，
			//      这里只在 `segs.length === 1`（路径里确实没有目录）时才兜底 ——
			//      旧实现在「首段不是 schema 类型目录」时也会强行改写，那会覆盖掉 LLM 按知识体系规划的目录。
			if (!prefixDir && segs.length === 1) {
				const fmType = frontmatterType(b.content);
				prefixDir = (fmType && typeToDir?.get(fmType)) || defaultTypeDir;
			}

			// 3) 仍无法判定类型：平铺到 notesDir（保持旧行为，避免丢失），不加类型前缀
			const routedSegs = prefixDir ? [prefixDir, ...segs] : segs;

			const parentSegs = routedSegs.slice(0, -1);
			const filename = routedSegs[routedSegs.length - 1];
			const stem = filename.replace(/\.md$/i, '');
			const ext = filename.slice(stem.length);
			let targetUri = URI.joinPath(notesDir, ...routedSegs);
			if (!isWithin(targetUri)) { continue; }
			// 同批次同名冲突：自动改名 xxx_2.md，避免同名不同类笔记互相覆盖
			let finalName = filename;
			let n = 2;
			while (used.has(targetUri.toString())) {
				finalName = `${stem}_${n}${ext}`;
				targetUri = URI.joinPath(notesDir, ...parentSegs, finalName);
				n++;
			}
			used.add(targetUri.toString());
			try {
				const parentUri = URI.joinPath(notesDir, ...parentSegs);
				await fileService.createFolder(parentUri);
				await fileService.writeFile(targetUri, VSBuffer.fromString(b.content ?? ''));
				written.push(targetUri.fsPath);
			} catch (e) {
				logService.warn('[KbImportController] writeFileBlock failed:', e);
			}
		}
		return written;
	}

	/** 从笔记内容 frontmatter 提取 type 字段（id / label 均可），用于 FILE 块落盘时的二次归类。 */
export function frontmatterType(content: string): string | undefined {
		try {
			const fm = parseFrontmatter(content).frontmatter;
			if (!fm) { return undefined; }
			const t = fm.type;
			if (Array.isArray(t)) { return typeof t[0] === 'string' ? t[0] : undefined; }
			return typeof t === 'string' ? t : undefined;
		} catch {
			return undefined;
		}
	}

export async function applyDeabstractionGating(fileService: IFileService, libDir: URI): Promise<{ active: number; pending: number }> {
		const notes = await collectMdFiles(fileService, libDir, SYS_INDEX_FILES);
		// P1 同义归一：读 <kbDir>/aliases.json，让「GC机制/垃圾回收」等表述归同一 canonical 共享来源数
		const aliases = await loadKbAliases(fileService, dirname(libDir));
		// Pass1：收集所有派生类笔记的 (uri, 归一标题, 来源集合)，按「同义归一后的 canonical」聚合来源
		const collected: { uri: URI; normTitle: string; sources: string[] }[] = [];
		const byTitle = new Map<string, Set<string>>();
		for (const n of notes) {
			let raw: string;
			try { raw = (await fileService.readFile(n)).value.toString(); } catch { continue; }
			const type = (await readNoteFrontmatterType(fileService, n) ?? '').toLowerCase();
			if (!GATED_TYPES.has(type)) { continue; }
			const { frontmatter } = parseFrontmatter(raw);
			const title = (frontmatter?.['title'] ?? n.path.split(/[\\/]/).pop() ?? '').toString();
			const normTitle = canonicalizeTitle(title, aliases);
			if (!normTitle) { continue; }
			const sources = extractSources(raw).map(s => s.toLowerCase());
			collected.push({ uri: n, normTitle, sources });
			let set = byTitle.get(normTitle);
			if (!set) { set = new Set<string>(); byTitle.set(normTitle, set); }
			for (const s of sources) { set.add(s); }
		}
		// Pass2：按同 canon 来源总数决定 status 并落盘
		let active = 0;
		let pending = 0;
		for (const c of collected) {
			const distinct = byTitle.get(c.normTitle)?.size ?? 0;
			const target = distinct >= 2 ? STATUS_ACTIVE : STATUS_PENDING;
			let raw: string;
			try { raw = (await fileService.readFile(c.uri)).value.toString(); } catch { continue; }
			const { content: updated, changed } = setStatus(raw, target);
			if (changed) {
				await fileService.writeFile(c.uri, VSBuffer.fromString(updated));
			}
			if (target === STATUS_ACTIVE) { active++; } else { pending++; }
		}
		return { active, pending };
	}

	// ─── 静态辅助方法 ─────────────────────────────────────────────────────────

export async function collectMdFiles(fileService: IFileService, dir: URI, exclude?: string | readonly string[]): Promise<URI[]> {
		const out: URI[] = [];
		const excludeSet = new Set(exclude ? (Array.isArray(exclude) ? exclude : [exclude]) : []);
		const walk = async (current: URI): Promise<void> => {
			try {
				const stat = await fileService.resolve(current);
				if (!stat.children) { return; }
				for (const child of stat.children) {
					if (child.name.startsWith('.')) { continue; }
					if (child.isDirectory) { await walk(child.resource); }
					else if (child.name.endsWith('.md') && !excludeSet.has(child.name)) {
						out.push(child.resource);
					}
				}
			} catch { /* ignore */ }
		};
		await walk(dir);
		return out;
	}

export async function readNoteFrontmatterType(fileService: IFileService, uri: URI): Promise<string | undefined> {
		try {
			const raw = (await fileService.readFile(uri)).value.toString();
			const head = raw.slice(0, 2048);
			const fmMatch = head.match(/^---\s*\n([\s\S]*?)\n---/);
			if (!fmMatch) { return undefined; }
			const typeMatch = fmMatch[1].match(/^type:\s*(.+)$/m);
			if (!typeMatch) { return undefined; }
			let value = typeMatch[1].trim();
			value = value.replace(/^["']|["']$/g, '');
			value = value.replace(/\s*#.*$/, '').trim();
			return value || undefined;
		} catch { return undefined; }
	}
