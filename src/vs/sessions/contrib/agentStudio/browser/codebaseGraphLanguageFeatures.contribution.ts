/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 基于 Codebase 图谱的 C++ 语言功能（无 C++ LSP 扩展时的跳转兜底）：
 *
 *  - DefinitionProvider：注册到 cpp 语言，数据源为 codebaseGraphService
 *    （tree-sitter WASM 索引的 C++ 符号）。解锁 Ctrl+鼠标左键 / F12 / Peek Definition。
 *  - ReferenceProvider：注册到 cpp 语言，数据源为 getNodeReferences 入边查询，
 *    解锁 Shift+F12（Find All References）与 Alt+F12（Peek References）。
 *
 * 背景：编辑器侧 Ctrl+点击跳转的硬 gate 是 `definitionProvider.has(model)`
 *  （goToDefinitionAtPosition.ts:291）。项目不含 clangd/cpptools，而 codebaseGraphService
 *  只做后台索引、从未注册任何 language feature —— 因此 C++ 完全无法跳转。
 *  本文件补上这条接线：把图谱查询结果转成 LocationLink[] 返回。
 */

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { DefinitionProvider, Location, LocationLink, ReferenceContext, ReferenceProvider } from '../../../../editor/common/languages.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ICodebaseGraphService } from './codebaseGraphService.js';

/** 图谱中可视为"定义"的节点类型（Ctrl+点击跳转目标）。 */
const DEFINITION_NODE_TYPES = new Set(['function', 'class', 'interface', 'enum', 'variable']);

/** 单个 provider 调用最多返回的候选数（同名符号过多时截断，避免 Peek 卡顿）。 */
const MAX_RESULTS = 20;

class CodebaseGraphCppDefinitionProvider implements DefinitionProvider {

	readonly _debugDisplayName = 'CodebaseGraphCppDefinitionProvider';

	constructor(
		@ICodebaseGraphService private readonly graphService: ICodebaseGraphService,
		@IFileService private readonly fileService: IFileService,
	) {
	}

	async provideDefinition(model: ITextModel, position: Position, token: CancellationToken): Promise<LocationLink[] | undefined> {
		// 图谱无数据（未索引完成 / 未启用）时不提供跳转
		if (token.isCancellationRequested || !this.graphService.hasGraphData()) {
			return undefined;
		}

		const wordInfo = model.getWordAtPosition(position);
		if (!wordInfo || !wordInfo.word) {
			return undefined;
		}
		const word = wordInfo.word;

		// 1) 图谱按名称查候选符号（内存路径为正则、SQLite 路径为 FTS5/LIKE，均接受原始标识符；
		//    不转义——word 来自 getWordAtPosition（纯标识符），转义会破坏 LIKE 的 '%q%' 语义）
		const nodes = await this.graphService.searchNodesAsync(word, undefined, 50);
		if (token.isCancellationRequested || nodes.length === 0) {
			return undefined;
		}

		const roots = this.graphService.getProjectRoots();
		const links: LocationLink[] = [];

		for (const node of nodes) {
			if (token.isCancellationRequested) {
				break;
			}
			// 精确匹配符号名 + 限定可跳转的节点类型
			if (node.name !== word || !DEFINITION_NODE_TYPES.has(node.type)) {
				continue;
			}
			if (!node.filePath || !node.startLine || node.startLine < 1) {
				continue;
			}
			const root = roots[node.project ?? '_default'];
			if (!root) {
				continue;
			}

			const uri = joinPath(URI.file(root), node.filePath);
			const col = await this._findWordColumn(uri, node.startLine, word, token);
			const lineIdx = node.startLine - 1; // 图谱 startLine 为 1-based，编辑器 Range 为 0-based
			const selectionRange = new Range(lineIdx, col, lineIdx, col + word.length);

			links.push({
				originSelectionRange: new Range(position.lineNumber - 1, wordInfo.startColumn - 1, position.lineNumber - 1, wordInfo.endColumn - 1),
				uri,
				range: selectionRange,
				targetSelectionRange: selectionRange
			});

			if (links.length >= MAX_RESULTS) {
				break;
			}
		}

		return links.length > 0 ? links : undefined;
	}

	/** 读取目标文件第 lineNo 行，返回 word 首次出现的列号（0-based）；失败/未找到返回 0。 */
	private async _findWordColumn(uri: URI, lineNo: number, word: string, token: CancellationToken): Promise<number> {
		if (token.isCancellationRequested) {
			return 0;
		}
		try {
			const content = await this.fileService.readFile(uri);
			const lineText = content.value.toString().split(/\r?\n/)[lineNo - 1];
			if (!lineText) {
				return 0;
			}
			const idx = lineText.indexOf(word);
			return idx >= 0 ? idx : 0;
		} catch {
			return 0;
		}
	}
}

class CodebaseGraphCppReferenceProvider implements ReferenceProvider {

	readonly _debugDisplayName = 'CodebaseGraphCppReferenceProvider';

	constructor(
		@ICodebaseGraphService private readonly graphService: ICodebaseGraphService,
		@IFileService private readonly fileService: IFileService,
	) {
	}

	async provideReferences(model: ITextModel, position: Position, context: ReferenceContext, token: CancellationToken): Promise<Location[] | undefined> {
		if (token.isCancellationRequested || !this.graphService.hasGraphData()) {
			return undefined;
		}
		const wordInfo = model.getWordAtPosition(position);
		if (!wordInfo || !wordInfo.word) {
			return undefined;
		}
		const word = wordInfo.word;

		// 入边引用查询（CALLS / INHERITS / IMPLEMENTS / IMPORTS / USAGE …）
		const refs = this.graphService.getNodeReferences(word);
		if (!refs || refs.length === 0) {
			return undefined;
		}

		const roots = this.graphService.getProjectRoots();
		const locations: Location[] = [];
		for (const ref of refs) {
			if (token.isCancellationRequested) {
				break;
			}
			const n = ref.node;
			if (!n.filePath || !n.startLine || n.startLine < 1) { continue; }
			const root = roots[n.project ?? '_default'];
			if (!root) { continue; }
			const uri = joinPath(URI.file(root), n.filePath);
			const lineIdx = n.startLine - 1;
			const col = await this._findWordColumn(uri, n.startLine, word, token);
			locations.push({
				uri,
				range: new Range(lineIdx, col, lineIdx, col + Math.max(1, word.length)),
			});
			if (locations.length >= MAX_RESULTS) { break; }
		}
		return locations.length > 0 ? locations : undefined;
	}

	/** 读取目标文件第 lineNo 行，返回 word 首次出现的列号（0-based）；失败/未找到返回 0。 */
	private async _findWordColumn(uri: URI, lineNo: number, word: string, token: CancellationToken): Promise<number> {
		if (token.isCancellationRequested) { return 0; }
		try {
			const content = await this.fileService.readFile(uri);
			const lineText = content.value.toString().split(/\r?\n/)[lineNo - 1];
			if (!lineText) { return 0; }
			const idx = lineText.indexOf(word);
			return idx >= 0 ? idx : 0;
		} catch {
			return 0;
		}
	}
}

class CodebaseGraphLanguageFeaturesContribution extends Disposable {
	static readonly ID = 'sessions.codebaseGraphLanguageFeatures';

	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		// C++：基于图谱的跳转定义（无 LSP 依赖）
		this._register(languageFeaturesService.definitionProvider.register(
			{ language: 'cpp', scheme: 'file' },
			instantiationService.createInstance(CodebaseGraphCppDefinitionProvider)
		));

		// C++：基于图谱的引用查找（Shift+F12 / Alt+F12 / Peek References）
		this._register(languageFeaturesService.referenceProvider.register(
			{ language: 'cpp', scheme: 'file' },
			instantiationService.createInstance(CodebaseGraphCppReferenceProvider)
		));
	}
}

registerWorkbenchContribution2(CodebaseGraphLanguageFeaturesContribution.ID, CodebaseGraphLanguageFeaturesContribution, WorkbenchPhase.BlockStartup);
