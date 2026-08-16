/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 复刻 Visual Assist X 的核心检索命令（快捷键 + UI）：
 *
 *  - `sarosis.openGraphFile`           Open File in Solution    （Shift+Alt+O）文件检索
 *  - `sarosis.findGraphReferences`     Find References          （Shift+Alt+F）引用查找
 *  - `sarosis.gotoGraphImplementation` Goto Implementation      （Alt+G）     跳转实现/覆写
 *  - `sarosis.listGraphMethods`        List Methods in File     （Alt+M）     当前文件符号列表
 *
 * 全部基于 codebaseGraphService（无 LSP 依赖），UI 统一为 QuickPick：
 *  - Open File：列出索引文件，模糊匹配文件名/路径，Enter 打开
 *  - Find References：列出指向该符号的入边引用（含边类型徽标），Enter 跳转
 *  - Goto Implementation：对方法沿继承树找派生类同名实现，多结果 Pick
 *  - List Methods：当前文件内所有 function/class 节点，Enter 跳转
 */

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { localize, localize2 } from '../../../../nls.js';
import { ICodebaseGraphService, GraphNode } from './codebaseGraphService.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ITextEditorOptions } from '../../../../platform/editor/common/editor.js';
import { basename } from '../../../../base/common/path.js';
import { OpenFileModal } from './widgets/openFileModal.js';
import { ImplementationsModal } from './widgets/implementationsModal.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { SearchCommandIds } from '../../../../workbench/contrib/search/common/constants.js';
import { ISearchService, QueryType, resultIsMatch, type ITextQuery, type ISearchComplete } from '../../../../workbench/services/search/common/search.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { escapeRegExpCharacters } from '../../../../base/common/strings.js';

/** 打开 URI 并定位到 line（1-based 行号）。 */
async function openAtLine(editorService: IEditorService, uri: URI, line: number | undefined): Promise<void> {
	const lineNo = Math.max(1, line ?? 1);
	const options: ITextEditorOptions = {
		selection: { startLineNumber: lineNo, startColumn: 1, endLineNumber: lineNo, endColumn: 1 },
		revealIfOpened: true,
		pinned: false,
	};
	await editorService.openEditor({ resource: uri, options });
}

/** 用图谱 project roots 把相对 filePath 还原为绝对 URI（stale 索引时不存在则跳过）。 */
async function resolveUri(graphService: ICodebaseGraphService, fileService: IFileService, node: { filePath?: string; project?: string }): Promise<URI | undefined> {
	if (!node.filePath) { return undefined; }
	const roots = graphService.getProjectRoots();
	const root = roots[node.project ?? '_default'];
	if (!root) { return undefined; }
	const uri = joinPath(URI.file(root), node.filePath);
	try {
		if (!await fileService.exists(uri)) { return undefined; }
	} catch { return undefined; }
	return uri;
}

/** 取当前活动编辑器光标处的单词（VAX 检索命令的公共入口）。 */
function getActiveWord(editorService: IEditorService): string | undefined {
	const editor = editorService.activeTextEditorControl as ICodeEditor | undefined;
	const model = editor?.getModel() as ITextModel | undefined;
	if (!editor || !model) { return undefined; }
	const position = editor.getPosition();
	if (!position) { return undefined; }
	return model.getWordAtPosition(position)?.word;
}

/** 取当前活动编辑器文件相对索引根的路径（用于排除"当前定义自身"）。
 *  注意 getProjectRoots 的 root 已经过 _normalizeRoot 归一化（小写、正斜杠、去尾分隔符），
 *  因此比较前必须对 fsPath 做同样归一化，否则 Windows 大小写/斜杠差异会导致匹配失败。 */
function getActiveFileRelPath(graphService: ICodebaseGraphService, editorService: IEditorService): string | undefined {
	const editor = editorService.activeTextEditorControl as ICodeEditor | undefined;
	const model = editor?.getModel() as ITextModel | undefined;
	if (!model) { return undefined; }
	const fsPath = normalizeFsPath(model.uri.fsPath);
	const roots = graphService.getProjectRoots();
	for (const [, root] of Object.entries(roots)) {
		const normalizedRoot = normalizeFsPath(root);
		if (fsPath.startsWith(normalizedRoot)) {
			return fsPath.slice(normalizedRoot.length).replace(/^[\\/]+/, '');
		}
	}
	return undefined;
}

/** 归一化路径：统一小写 + 正斜杠 + 去尾分隔符（对齐 codebaseGraphService._normalizeRoot）。 */
function normalizeFsPath(p: string): string {
	return p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

/** 取当前活动编辑器光标所在行号（1-based；无编辑器返回 undefined）。 */
function getActiveLineNumber(editorService: IEditorService): number | undefined {
	const editor = editorService.activeTextEditorControl as ICodeEditor | undefined;
	if (!editor) { return undefined; }
	const position = editor.getPosition();
	return position ? position.lineNumber : undefined;
}

/** 把 fsPath 还原为相对首个匹配 project root 的相对路径（找不到则原样返回）。 */
function toRelPath(fsPath: string, roots: Record<string, string>): string {
	const normalized = normalizeFsPath(fsPath);
	for (const root of Object.values(roots)) {
		const nr = normalizeFsPath(root);
		if (normalized.startsWith(nr)) {
			return normalized.slice(nr.length).replace(/^[\\/]+/, '');
		}
	}
	return fsPath;
}

/**
 * 方案 2 兜底：当图谱里没有同名函数节点（C++ 成员函数等未被索引器提取）时，
 * 用 ISearchService 全文搜索 `\b<word>\s*\(` 找"实现/定义/调用"候选行，作为跳转落点。
 * 返回已解析的绝对 URI + 1-based 行号（已排除光标处的"定义自身"）。
 */
async function findImplementationsByContentSearch(
	searchService: ISearchService,
	graphService: ICodebaseGraphService,
	word: string,
	currentFile: string | undefined,
	currentLine: number | undefined,
	logService: ILogService,
	TAG: string,
): Promise<{ uri: URI; line: number }[]> {
	const roots = graphService.getProjectRoots();
	const folderQueries = Object.values(roots).map(root => ({ folder: URI.file(root) }));
	if (folderQueries.length === 0) { return []; }

	const query: ITextQuery = {
		type: QueryType.Text,
		folderQueries,
		contentPattern: {
			pattern: `\\b${escapeRegExpCharacters(word)}\\s*\\(`,
			isRegExp: true,
			isWordMatch: false,
		},
		maxResults: 200,
	};

	let complete: ISearchComplete;
	try {
		complete = await searchService.textSearch(query, CancellationToken.None);
	} catch (e) {
		logService.info(TAG, `[content-fallback] textSearch threw: ${String(e)}`);
		return [];
	}

	const out: { uri: URI; line: number }[] = [];
	const seen = new Set<string>();
	let raw = 0;
	for (const fm of complete.results) {
		const resource = fm.resource;
		if (!resource) { continue; }
		for (const r of (fm.results || [])) {
			if (!resultIsMatch(r)) { continue; }
			for (const rl of r.rangeLocations) {
				raw++;
				const line = rl.source.startLineNumber;
				const key = `${resource.fsPath}::${line}`;
				if (seen.has(key)) { continue; }
				// 排除光标处的"定义自身"（同文件同行不视为候选）
				if (currentFile && toRelPath(resource.fsPath, roots) === currentFile && line === currentLine) {
					continue;
				}
				seen.add(key);
				out.push({ uri: resource, line });
			}
		}
	}
	logService.info(TAG, `[content-fallback] rawMatches=${raw}, candidates=${out.length}`);
	return out;
}

/**
 * 从源码行向上扫描最近的 struct/class 声明名。
 * 支持 `struct REPLAYMODULE_API Foo`（宏前缀，取第二个标识符）与 `class Foo : public Bar`（继承，取第一个）。
 * lineNumber 为 1-based 光标行；返回类名或 undefined。
 */
function findClassAtLine(lines: string[], lineNumber: number): string | undefined {
	for (let i = lineNumber - 2; i >= 0; i--) {
		const line = lines[i] ?? '';
		const m = line.match(/^\s*(?:struct|class)\s+([A-Za-z_]\w*)/);
		if (!m) { continue; }
		const rest = line.slice(line.indexOf(m[1]) + m[1].length);
		// 第一个标识符后紧跟 { 或 : → 它就是类名（struct Foo / class Foo : Base）
		if (/^\s*[{:]/.test(rest)) { return m[1]; }
		// 宏前缀场景（struct REPLAYMODULE_API Foo）→ 取下一个标识符
		const m2 = rest.match(/^\s*([A-Za-z_]\w*)/);
		return m2 ? m2[1] : m[1];
	}
	return undefined;
}

// ─── 1. Open File in Solution（Shift+Alt+O）───────────────────────────────

registerAction2(class OpenGraphFileAction extends Action2 {
	constructor() {
		super({
			id: 'sarosis.openGraphFile',
			title: localize2('sarosis.openGraphFile', 'Open File in Codebase'),
			f1: true,
			category: localize2('sarosis.category', 'Saros'),
			keybinding: {
				primary: KeyMod.Shift | KeyMod.Alt | KeyCode.KeyO,
				weight: KeybindingWeight.WorkbenchContrib,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const graphService = accessor.get(ICodebaseGraphService);
		const instantiationService = accessor.get(IInstantiationService);
		const logService = accessor.get(ILogService);

		if (!graphService.hasGraphData()) {
			logService.info('[CodebaseGraph]', 'Open File requested but graph has no data');
			return;
		}

		// 打开类 VS 的 Open File in Solution 模态对话框（标题/三列表格/搜索/复选框/OK/Cancel）
		await instantiationService.createInstance(OpenFileModal).open();
	}
});

// ─── 2. Find References（Shift+Alt+F）────────────────────────────────────

interface IRefPickItem extends IQuickPickItem {
	uri?: URI;
	line?: number;
}

registerAction2(class FindGraphReferencesAction extends Action2 {
	constructor() {
		super({
			id: 'sarosis.findGraphReferences',
			title: localize2('sarosis.findGraphReferences', 'Find References'),
			f1: true,
			category: localize2('sarosis.category', 'Saros'),
			keybinding: {
				// Shift+Alt+F 让位给"Search view 搜索选中词"；Find References 改绑 Ctrl+Shift+Alt+F
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyMod.Alt | KeyCode.KeyF,
				weight: KeybindingWeight.WorkbenchContrib,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const graphService = accessor.get(ICodebaseGraphService);
		const editorService = accessor.get(IEditorService);
		const fileService = accessor.get(IFileService);
		const quickInputService = accessor.get(IQuickInputService);
		const logService = accessor.get(ILogService);

		if (!graphService.hasGraphData()) {
			logService.info('[CodebaseGraph]', 'Find References requested but graph has no data');
			return;
		}
		const word = getActiveWord(editorService);
		if (!word) {
			logService.info('[CodebaseGraph:FindRefs]', 'ABORT: no word under cursor');
			return;
		}

		const refs = graphService.getNodeReferences(word);
		if (!refs || refs.length === 0) {
			logService.info('[CodebaseGraph]', `No references found for "${word}"`);
			return;
		}

		// sidebar 无引用视图：用 QuickPick 展示（file:line，回车跳转）
		const picker = quickInputService.createQuickPick<IRefPickItem>();
		const disposables = new DisposableStore();
		disposables.add(picker);
		picker.placeholder = localize('sarosis.findGraphReferences.title', 'References of “{0}” ({1})', word, refs.length);
		picker.matchOnDescription = true;
		picker.items = [];
		const items: IRefPickItem[] = [];
		const seen = new Set<string>();
		for (const r of refs) {
			const uri = await resolveUri(graphService, fileService, r.node);
			if (!uri) { continue; }
			const key = `${uri.toString()}:${r.node.startLine ?? ''}`;
			if (seen.has(key)) { continue; }
			seen.add(key);
			items.push({
				label: `$(references) ${r.node.name}`,
				description: `${r.edgeType} (${r.access})`,
				detail: r.node.filePath ? `${r.node.filePath}:${r.node.startLine ?? ''}` : r.node.qualifiedName,
				uri,
				line: r.node.startLine,
			});
		}
		picker.items = items;
		logService.info('[CodebaseGraph:FindRefs]', `showing picker with ${items.length} references`);
		disposables.add(picker.onDidAccept(async () => {
			const picked = picker.selectedItems[0];
			if (picked?.uri && picked.line) {
				await openAtLine(editorService, picked.uri, picked.line);
			}
			disposables.dispose();
		}));
		disposables.add(picker.onDidHide(() => disposables.dispose()));
		picker.show();
	}
});

// ─── 3. Goto Implementation（Alt+G）──────────────────────────────────────

registerAction2(class GotoGraphImplementationAction extends Action2 {
	constructor() {
		super({
			id: 'sarosis.gotoGraphImplementation',
			title: localize2('sarosis.gotoGraphImplementation', 'Go to Implementation'),
			f1: true,
			category: localize2('sarosis.category', 'Saros'),
			keybinding: {
				// Alt+G：菜单栏 mnemonic 已改为 Ctrl+Alt+字母，不再拦截
				primary: KeyMod.Alt | KeyCode.KeyG,
				weight: KeybindingWeight.WorkbenchContrib + 10,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const graphService = accessor.get(ICodebaseGraphService);
		const editorService = accessor.get(IEditorService);
		const fileService = accessor.get(IFileService);
		const logService = accessor.get(ILogService);
		const TAG = '[CodebaseGraph:GotoImpl]';

		logService.info(TAG, 'run() entered');

		if (!graphService.hasGraphData()) {
			logService.info(TAG, 'ABORT: graph has no data');
			return;
		}
		const word = getActiveWord(editorService);
		if (!word) {
			logService.info(TAG, 'ABORT: no word under cursor');
			return;
		}
		logService.info(TAG, `searching implementations of "${word}"`);

		const searchService = accessor.get(ISearchService);
		const currentFile = getActiveFileRelPath(graphService, editorService);
		const currentLine = getActiveLineNumber(editorService);
		const activeEditor = editorService.activeTextEditorControl as ICodeEditor | undefined;
		const activeModel = activeEditor?.getModel() as ITextModel | undefined;
		const activeLines = activeModel?.getValue().split('\n') ?? [];

		const candidates: { node: GraphNode; via: string }[] = [];
		const seen = new Set<string>();

		// 一次搜索拿全部同名节点（方法语义 + 词性判定共用，避免对方法名重复全量扫描）
		const results = await graphService.searchGraphAsync({ namePattern: word, limit: 200 });
		const allNodes = (results.nodes || []).filter(n => n.name === word);
		const isFn = (n: GraphNode): boolean => (n.type ?? n.label) === 'function';
		const fnNodes = allNodes.filter(isFn);
		const classNodes = allNodes.filter(n => (n.type ?? n.label) === 'class' || (n.type ?? n.label) === 'interface');
		logService.info(TAG, `search: ${fnNodes.length} same-name function nodes, ${allNodes.length - fnNodes.length} other-type nodes, rawTotal=${results.total}`);

		// 分支 A：词确实是类/接口名（且无同名函数）→ 沿继承树收集派生类（VAX 类语义）
		if (classNodes.length > 0 && fnNodes.length === 0) {
			const hierarchy = graphService.getClassHierarchy(word, 'derived', 6);
			if (hierarchy) {
				const collect = (n: typeof hierarchy): void => {
					for (const d of n.derived) {
						const key = d.node.qualifiedName ?? '';
						if (!seen.has(key)) {
							seen.add(key);
							candidates.push({ node: d.node as any, via: d.kind });
						}
						collect(d);
					}
				};
				collect(hierarchy);
				logService.info(TAG, `class-hierarchy: found ${candidates.length} derived classes`);
			}
		}

		// 分支 B：方法/函数语义 → 列出所有同名函数定义（override 实现），其余类型作次选
		if (candidates.length === 0) {
			const otherNodes = allNodes.filter(n => !isFn(n));
			for (const node of fnNodes) {
				const key = `${node.filePath ?? ''}::${node.startLine ?? ''}`;
				if (seen.has(key)) { continue; }
				// 排除"当前定义自身"（同文件同行的声明/定义不视为实现候选）
				if (currentFile && node.filePath === currentFile && node.startLine === currentLine) {
					logService.info(TAG, `skip self: ${key}`);
					continue;
				}
				seen.add(key);
				candidates.push({ node, via: 'implementation' });
			}
			for (const node of otherNodes) {
				const key = `${node.filePath ?? ''}::${node.startLine ?? ''}`;
				if (seen.has(key)) { continue; }
				if (currentFile && node.filePath === currentFile && node.startLine === currentLine) {
					continue;
				}
				seen.add(key);
				candidates.push({ node, via: 'other' });
			}
		}

		logService.info(TAG, `candidates=${candidates.length}`);

		// 图谱候选 → picker 项
		const items: IRefPickItem[] = [];
		for (const c of candidates) {
			const uri = await resolveUri(graphService, fileService, c.node);
			items.push({
				label: `$(type-hierarchy-sub) ${c.node.name}`,
				description: c.via,
				detail: c.node.filePath ? `${c.node.filePath}:${c.node.startLine ?? ''}` : c.node.qualifiedName,
				uri,
				line: c.node.startLine,
			});
		}

		// 方案 2 兜底：图谱无同名函数节点（C++ 成员函数等未被索引器提取）→ 全文搜索 `\b<word>\s*\(`
		if (items.length === 0) {
			const contentCands = await findImplementationsByContentSearch(searchService, graphService, word, currentFile, currentLine, logService, TAG);
			for (const c of contentCands) {
				items.push({
					label: `$(file) ${word}`,
					description: localize('sarosis.gotoGraphImplementation.contentFallback', 'file content'),
					detail: `${c.uri.fsPath}:${c.line}`,
					uri: c.uri,
					line: c.line,
				});
			}
			logService.info(TAG, `content-fallback added ${contentCands.length} items`);
		}

		if (items.length === 0) {
			logService.info(TAG, 'ABORT: no implementations found (class needs INHERITS edges; method needs same-name function nodes in index; content search found nothing)');
			return;
		}

		// 优先直接跳转"光标所在类的自身实现"：
		// 光标在类内方法声明（如基类 virtual 声明）Alt+G → 直接跳到本类 out-of-line/inline 实现（`类名::方法名(`）。
		// 唯一命中时直接 openAtLine，避免 QuickPick；派生实现列表保留给纯虚函数/调用点场景。
		const className = activeLines.length > 0 ? findClassAtLine(activeLines, currentLine ?? 1) : undefined;
		if (className) {
			const selfImplRe = new RegExp(`\\b${escapeRegExpCharacters(className)}\\s*::\\s*${escapeRegExpCharacters(word)}\\s*\\(`);
			// 先查当前文件（自身实现通常与声明同文件/inline，零文件读取），命中即跳；
			// 未命中再读其他候选文件（跨文件 out-of-line 定义），降低磁盘 IO。
			let target: IRefPickItem | undefined;
			const activeUriKey = activeModel ? activeModel.uri.toString() : undefined;
			const rest: IRefPickItem[] = [];
			for (const it of items) {
				if (!it.uri || it.line == null) { continue; }
				if (it.uri.toString() === activeUriKey) {
					const lineText = activeLines[it.line - 1] ?? '';
					if (lineText && selfImplRe.test(lineText)) { target = it; break; }
				} else {
					rest.push(it);
				}
			}
			if (!target) {
				const lineCache = new Map<string, string[]>();
				for (const it of rest) {
					const key = it.uri!.toString();
					let ls = lineCache.get(key);
					if (ls === undefined) {
						try {
							const content = await fileService.readFile(it.uri!);
							ls = content.value.toString().split('\n');
						} catch { ls = []; }
						lineCache.set(key, ls);
					}
					const lineText = ls[it.line! - 1] ?? '';
					if (lineText && selfImplRe.test(lineText)) { target = it; break; }
				}
			}
			if (target) {
				logService.info(TAG, `self-implementation: found ${className}::${word} — jumping ${target.detail}`);
				if (target.uri && target.line) {
					await openAtLine(editorService, target.uri, target.line);
					return;
				}
			}
		}

		// 独立 UI：弹出 ImplementationsModal 展示可跳转候选（替代 QuickPick）
		const implementationsModal = new ImplementationsModal(editorService);
		implementationsModal.open(localize('sarosis.gotoGraphImplementation.title', 'Implementations of “{0}”', word), items);
		logService.info(TAG, `showing implementations modal with ${items.length} items`);
	}
});

// ─── 4. List Methods in File（Alt+M）─────────────────────────────────────

registerAction2(class ListGraphMethodsAction extends Action2 {
	constructor() {
		super({
			id: 'sarosis.listGraphMethods',
			title: localize2('sarosis.listGraphMethods', 'List Methods in Current File'),
			f1: true,
			category: localize2('sarosis.category', 'Saros'),
			keybinding: {
				// Alt+M：菜单栏 mnemonic 已改为 Ctrl+Alt+字母，不再拦截
				primary: KeyMod.Alt | KeyCode.KeyM,
				weight: KeybindingWeight.WorkbenchContrib + 10,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const graphService = accessor.get(ICodebaseGraphService);
		const quickInputService = accessor.get(IQuickInputService);
		const editorService = accessor.get(IEditorService);
		const fileService = accessor.get(IFileService);
		const logService = accessor.get(ILogService);
		const TAG = '[CodebaseGraph:ListMethods]';

		logService.info(TAG, 'run() entered');

		if (!graphService.hasGraphData()) {
			logService.info(TAG, 'ABORT: graph has no data');
			return;
		}
		const editor = editorService.activeTextEditorControl as ICodeEditor;
		const model = editor?.getModel() as ITextModel | undefined;
		if (!editor || !model) {
			logService.info(TAG, 'ABORT: no active text editor / model');
			return;
		}

		// 当前文件相对路径：从 project roots 反查
		const fsPath = model.uri.fsPath;
		const roots = graphService.getProjectRoots();
		let relPath: string | undefined;
		for (const [, root] of Object.entries(roots)) {
			if (fsPath.startsWith(root)) {
				relPath = fsPath.slice(root.length).replace(/^[\\/]+/, '');
				break;
			}
		}
		logService.info(TAG, `fsPath=${fsPath}, roots=${JSON.stringify(roots)}, relPath=${relPath ?? 'undefined'}`);
		if (!relPath) {
			logService.info(TAG, 'ABORT: file not under any indexed project root');
			return;
		}

		const results = await graphService.searchGraphAsync({
			filePattern: relPath,
			label: 'function',
			limit: 300,
		});
		const nodes = (results.nodes || []).sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
		logService.info(TAG, `searchGraphAsync(filePattern=${relPath}) returned ${nodes.length} nodes`);

		const picker = quickInputService.createQuickPick<IRefPickItem>();
		const disposables = new DisposableStore();
		disposables.add(picker);
		picker.placeholder = localize('sarosis.listGraphMethods.title', 'Methods in {0}', basename(fsPath));
		picker.matchOnDescription = true;
		picker.items = [];

		const items: IRefPickItem[] = [];
		for (const node of nodes) {
			const uri = await resolveUri(graphService, fileService, node);
			items.push({
				label: `$(symbol-method) ${node.name}`,
				description: `line ${node.startLine ?? ''}`,
				detail: node.type,
				uri,
				line: node.startLine,
			});
		}
		picker.items = items;
		logService.info(TAG, `showing picker with ${items.length} items`);

		disposables.add(picker.onDidAccept(async () => {
			const [sel] = picker.selectedItems;
			if (sel?.uri && sel.line) {
				await openAtLine(editorService, sel.uri, sel.line);
			}
			picker.hide();
		}));
		disposables.add(picker.onDidHide(() => disposables.dispose()));
		picker.show();
	}
});

// ─── 5. Search Selection in Files（Shift+Alt+F）──────────────────────────

/**
 * 在原生 Search view 中填入光标选中的单词进行搜索（对齐 VAX/VS 的 Find in Files 习惯）。
 * 优先级：编辑器选区文本 > 光标处单词。若两者皆无，仅打开 Search view。
 */
registerAction2(class SearchSelectionInFilesAction extends Action2 {
	constructor() {
		super({
			id: 'sarosis.searchSelectionInFiles',
			title: localize2('sarosis.searchSelectionInFiles', 'Search Selected Text in Files'),
			f1: true,
			category: localize2('sarosis.category', 'Saros'),
			keybinding: {
				// Shift+Alt+F：搜索选中词（Find References 已让位到 Ctrl+Shift+Alt+F）
				primary: KeyMod.Shift | KeyMod.Alt | KeyCode.KeyF,
				weight: KeybindingWeight.WorkbenchContrib + 10,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const commandService = accessor.get(ICommandService);
		const logService = accessor.get(ILogService);
		const TAG = '[CodebaseGraph:SearchSelection]';

		logService.info(TAG, 'run() entered');

		// 优先取选区文本，其次取光标处单词
		const editor = editorService.activeTextEditorControl as ICodeEditor | undefined;
		const model = editor?.getModel() as ITextModel | undefined;
		let query: string | undefined;
		if (editor && model) {
			const selection = editor.getSelection();
			const selectedText = selection && !selection.isEmpty()
				? model.getValueInRange(selection)
				: undefined;
			if (selectedText && selectedText.trim().length > 0) {
				query = selectedText.trim();
			} else {
				const position = editor.getPosition();
				query = position ? model.getWordAtPosition(position)?.word : undefined;
			}
		}
		logService.info(TAG, `query=${query ?? '(none)'}`);

		// 调原生 findInFiles：打开 Search view 并填入 query、触发搜索
		await commandService.executeCommand(SearchCommandIds.FindInFilesActionId, {
			query: query ?? '',
			triggerSearch: true,
		});
	}
});
