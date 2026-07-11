/*---------------------------------------------------------------------------------------------
 *  Hyper-Extract (TS port) — VS Code tool descriptors (`kb_*` tools)
 *
 *  Registers a set of built-in tools that expose the knowledge engine to
 *  the agent. Mirrors Hyper-Extract's `he parse` / `he search` / `he ask`
 *  CLI surface as agent-callable tools. All tools are stateless: each call
 *  rebuilds a `KnowledgeManager` (cheap) and loads/persists the KB to disk.
 *
 *  Tools are named `kb_*` so they auto-map to the `knowledge` toolset
 *  (see toolsetConfig.ts). They are wired into `BuiltinToolProvider`
 *  via `_registerKnowledgeTools()`.
 *--------------------------------------------------------------------------------------------*/

import type { IToolDefinition, IToolResultContent } from '../../common/providers.js';
import { URI } from '../../../../../base/common/uri.js';
import { join } from '../../../../../base/common/path.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { IAiEmbeddingVectorService } from '../../../../../workbench/services/aiEmbeddingVector/common/aiEmbeddingVectorService.js';
import { KnowledgeManager } from './engine/knowledgeManager.js';
import { listMethods } from './engine/methodRegistry.js';
import { resolveChatModel, createEmbedder } from './knowledgeAdapters.js';
import { createFileStorageAdapter } from './knowledgeStorage.js';
import { appendKbOpLog, type IKbOpLogEntry, type KbOpStatus } from './kbOpLog.js';

export interface KnowledgeToolDeps {
	readonly fileService: IFileService;
	readonly configurationService: IConfigurationService;
	readonly embeddingService: IAiEmbeddingVectorService;
	/** Resolve the base dir used to resolve relative source/output file paths (workspace root). */
	readonly resolveBaseDir: () => Promise<string>;
	/** Resolve the KB storage root (`<userHome>/.saros/kb` by default, config-overridable). */
	readonly resolveStorageRoot: () => Promise<string>;
}

interface IKbToolDescriptor {
	readonly definition: IToolDefinition;
	readonly handler: (args: Record<string, unknown>, signal?: AbortSignal, agentId?: string) => Promise<IToolResultContent[] | { content: IToolResultContent[]; details?: Record<string, unknown> }>;
	/** Optional function: returns false to hide this tool (e.g. when embeddings are disabled). */
	readonly available?: () => boolean;
}

function txt(s: string): IToolResultContent[] {
	return [{ type: 'text', text: s }];
}

export function buildKnowledgeToolDescriptors(deps: KnowledgeToolDeps): IKbToolDescriptor[] {

	async function buildManager(opts: { model?: string; provider?: string }): Promise<KnowledgeManager> {
		const chatModel = resolveChatModel(deps.configurationService, {
			providerId: opts.provider,
			modelId: opts.model,
		});
		const embedder = createEmbedder(deps.embeddingService);
		const storageRoot = await deps.resolveStorageRoot();
		const storage = createFileStorageAdapter(deps.fileService, storageRoot);
		return new KnowledgeManager({ llm: chatModel, embedder, storage, verbose: true });
	}

	function resolveFileUri(baseDir: string, filePath?: unknown): URI | undefined {
		const p = (filePath as string | undefined)?.trim();
		if (!p) { return undefined; }
		const isAbs = p.includes(':') || p.startsWith('/') || /^[A-Za-z]:/.test(p);
		return URI.file(isAbs ? p : join(baseDir, p));
	}

	/** Best-effort operation log for `kb_*` tools → `<kbRoot>/.op-log.jsonl`. */
	async function logKbTool(
		op: string, status: KbOpStatus,
		extra?: { source?: string; target?: string; detail?: Record<string, unknown>; error?: string },
	): Promise<void> {
		try {
			const root = await deps.resolveStorageRoot();
			await appendKbOpLog(deps.fileService, root, {
				ts: new Date().toISOString(), op, status, channel: 'engine',
				source: extra?.source, target: extra?.target,
				detail: extra?.detail, error: extra?.error,
			} as IKbOpLogEntry);
		} catch {
			// logging must never break the tool call
		}
	}

	async function readSource(args: Record<string, unknown>): Promise<string> {
		const text = (args['text'] as string | undefined)?.trim();
		if (text) { return text; }
		const fp = (args['file_path'] as string | undefined)?.trim();
		if (fp) {
			const baseDir = await deps.resolveBaseDir();
			const uri = resolveFileUri(baseDir, fp);
			if (uri) {
				try {
					const stat = await deps.fileService.readFile(uri);
					const content = stat.value.toString();
					if (content.trim()) { return content; }
				} catch {
					// fall through to empty
				}
			}
		}
		return '';
	}

	const embeddingEnabled = () => deps.embeddingService.isEnabled();
	const available = embeddingEnabled;

	const descriptors: IKbToolDescriptor[] = [
		// ── kb_list_templates ──────────────────────────────
		{
			definition: {
				name: 'kb_list_templates',
				description: 'List available knowledge-base templates (e.g. knowledge_graph, entity_list, faq). Call this first to discover which template id to pass to kb_build.',
				inputSchema: { type: 'object', properties: {} },
				category: 'knowledge',
				source: 'saros.knowledge',
			},
			handler: async () => {
				const tmpls = KnowledgeManager.availableTemplates();
				return txt(JSON.stringify(tmpls, null, 2));
			},
		},

		// ── kb_list_methods ──────────────────────────────
		{
			definition: {
				name: 'kb_list_methods',
				description: 'List available extraction methods (fine-tuned strategies like light_rag, itext2kg, atom). Call this to discover which `method` to pass to kb_build for tuning how entities/relationships are extracted.',
				inputSchema: { type: 'object', properties: {} },
				category: 'knowledge',
				source: 'saros.knowledge',
			},
			handler: async () => {
				const methods = listMethods();
				return txt(JSON.stringify(
					methods.map(m => ({ name: m.name, kind: m.kind, description: m.description, domain: m.domain })),
					null, 2,
				));
			},
		},

		// ── kb_build ──────────────────────────────────────
		{
			definition: {
				name: 'kb_build',
				description: 'Build a knowledge base from a document. Extracts entities/relationships (or a list) via LLM, embeds them, and persists the index. Returns the kb id for later kb_search / kb_ask. Provide either `text` or `file_path`.',
				inputSchema: {
					type: 'object',
					properties: {
						title: { type: 'string', description: 'Human-readable title for the knowledge base' },
						template_id: { type: 'string', description: 'Template id from kb_list_templates (default: knowledge_graph)' },
						method: { type: 'string', description: 'Optional extraction method to fine-tune how entities/relationships are extracted. Use kb_list_methods to discover available methods (e.g. light_rag, itext2kg, atom, hyper_rag). When set, the method overrides the template\'s default extraction strategy.' },
						text: { type: 'string', description: 'Raw document text to parse' },
						file_path: { type: 'string', description: 'Path to a text/markdown file to parse (relative to the workspace root)' },
						model: { type: 'string', description: 'Optional model id overriding the default LLM' },
						provider: { type: 'string', description: 'Optional BYOK provider id (default: openrouter)' },
					},
				},
				category: 'knowledge',
				source: 'saros.knowledge',
			},
			available,
		handler: async (args) => {
			const templateId = (args['template_id'] as string) || 'knowledge_graph';
			const method = (args['method'] as string) || undefined;
			const title = (args['title'] as string) || (method ?? templateId);
			const filePath = (args['file_path'] as string)?.trim();
			try {
				const source = await readSource(args);
					if (!source.trim()) {
						return txt(JSON.stringify({ success: false, error: 'Provide `text` or `file_path`.' }));
					}
					const manager = await buildManager({ model: args['model'] as string, provider: args['provider'] as string });
					const session = manager.create(templateId, { title, method });
					await manager.parseText(session, source);
					// 记录来源文件路径（用于 kb_list 展示）
					if (filePath) { (session as any)._sourcePath = filePath; }
					await manager.persist(session);
					void logKbTool('kb_build', 'success', { target: session.id, detail: { title, template: templateId, method, kind: session.kind, itemCount: session.meta.itemCount, source: filePath } });
					const result: Record<string, unknown> = {
						success: true,
						id: session.id,
						title: session.title,
						template: templateId,
						kind: session.kind,
						itemCount: session.meta.itemCount,
					};
					if (method) { result['method'] = method; }
					return txt(JSON.stringify(result, null, 2));
				} catch (err) {
					void logKbTool('kb_build', 'failure', { detail: { title, template: templateId, method }, error: err instanceof Error ? err.message : String(err) });
					return txt(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
				}
			},
		},

		// ── kb_ingest ───────────────────────────────────
		{
			definition: {
				name: 'kb_ingest',
				description: 'Add more documents to an existing knowledge base (by id). Re-extracts and merges with the existing index. Provide either `text` or `file_path`.',
				inputSchema: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Knowledge base id returned by kb_build' },
						text: { type: 'string', description: 'Raw document text to parse' },
						file_path: { type: 'string', description: 'Path to a text/markdown file to parse (relative to the workspace root)' },
						model: { type: 'string', description: 'Optional model id overriding the default LLM' },
						provider: { type: 'string', description: 'Optional BYOK provider id (default: openrouter)' },
					},
					required: ['id'],
				},
				category: 'knowledge',
				source: 'saros.knowledge',
			},
			available,
		handler: async (args) => {
			const id = args['id'] as string;
			try {
				if (!id) { return txt(JSON.stringify({ success: false, error: '`id` is required' })); }
				const source = await readSource(args);
					if (!source.trim()) {
						return txt(JSON.stringify({ success: false, error: 'Provide `text` or `file_path`.' }));
					}
					const manager = await buildManager({ model: args['model'] as string, provider: args['provider'] as string });
					const session = await manager.load(id);
					await manager.parseText(session, source);
					await manager.persist(session);
					void logKbTool('kb_ingest', 'success', { target: session.id, detail: { itemCount: session.meta.itemCount } });
					return txt(JSON.stringify({ success: true, id: session.id, itemCount: session.meta.itemCount }, null, 2));
				} catch (err) {
					void logKbTool('kb_ingest', 'failure', { target: id, error: err instanceof Error ? err.message : String(err) });
					return txt(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
				}
			},
		},

		// ── kb_search ───────────────────────────────────
		{
			definition: {
				name: 'kb_search',
				description: 'Semantic search over a built knowledge base (by id). Returns the most relevant entities/relationships or list items for a query.',
				inputSchema: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Knowledge base id' },
						query: { type: 'string', description: 'Search query' },
						top_k: { type: 'number', description: 'Number of results (default: 5)' },
					},
					required: ['id', 'query'],
				},
				category: 'knowledge',
				source: 'saros.knowledge',
			},
			available,
		handler: async (args) => {
			const id = args['id'] as string;
			const query = args['query'] as string;
			try {
				if (!id || !query) {
					return txt(JSON.stringify({ success: false, error: '`id` and `query` are required' }));
				}
				const topK = typeof args['top_k'] === 'number' ? Math.min(Math.max(1, args['top_k'] as number), 50) : 5;
				const manager = await buildManager({});
					const session = await manager.load(id);
					const result = await manager.search(session, query, topK);
					void logKbTool('kb_search', 'success', { target: id, detail: { query, topK } });
					return txt(JSON.stringify({ success: true, ...result }, null, 2));
				} catch (err) {
					void logKbTool('kb_search', 'failure', { target: id, detail: { query }, error: err instanceof Error ? err.message : String(err) });
					return txt(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
				}
			},
		},

		// ── kb_ask ──────────────────────────────────────
		{
			definition: {
				name: 'kb_ask',
				description: 'RAG question answering over a built knowledge base (by id). Retrieves relevant items and asks the LLM to answer grounded in them.',
				inputSchema: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Knowledge base id' },
						query: { type: 'string', description: 'The question to answer' },
						top_k: { type: 'number', description: 'Number of retrieved items to ground the answer (default: 5)' },
						model: { type: 'string', description: 'Optional model id for the answer synthesis' },
						provider: { type: 'string', description: 'Optional BYOK provider id (default: openrouter)' },
					},
					required: ['id', 'query'],
				},
				category: 'knowledge',
				source: 'saros.knowledge',
			},
			available,
		handler: async (args) => {
			const id = args['id'] as string;
			const query = args['query'] as string;
			try {
				if (!id || !query) {
					return txt(JSON.stringify({ success: false, error: '`id` and `query` are required' }));
				}
				const topK = typeof args['top_k'] === 'number' ? Math.min(Math.max(1, args['top_k'] as number), 50) : 5;
				const manager = await buildManager({ model: args['model'] as string, provider: args['provider'] as string });
					const session = await manager.load(id);
					const { text, retrieved } = await manager.chat(session, query, topK);
					void logKbTool('kb_ask', 'success', { target: id, detail: { query, topK, chars: text.length } });
					// 返回自然文本回答 + 检索来源（便于 Agent 理解）
					return [
						{ type: 'text', text },
						{ type: 'text', text: `\n\n---\n📎 Retrieved ${retrieved?.nodes?.length ?? retrieved?.items?.length ?? 0} items from "${session.title}" (id: ${id})` },
					];
				} catch (err) {
					void logKbTool('kb_ask', 'failure', { target: id, detail: { query }, error: err instanceof Error ? err.message : String(err) });
					return txt(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
				}
			},
		},

		// ── kb_export ───────────────────────────────────
	{
		definition: {
			name: 'kb_export',
			description: 'Export a built knowledge base to a Markdown file (Obsidian-style: [[wikilinks]] for nodes + a ```mermaid graph for graph templates; bullet/list rendering for list/model/set/hypergraph templates). Provide an `output_path` to write the .md file, or omit it to return the markdown inline.',
			inputSchema: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Knowledge base id returned by kb_build' },
					output_path: { type: 'string', description: 'Optional path to write the .md file (absolute, or relative to the workspace root). Omit to return markdown inline.' },
					title: { type: 'string', description: 'Optional document title (defaults to the KB title).' },
					mermaid: { type: 'boolean', description: 'Include the ```mermaid graph block. Default: true.' },
					wikilinks: { type: 'boolean', description: 'Use Obsidian [[wikilinks]] for node names. Default: true.' },
				},
				required: ['id'],
			},
			category: 'knowledge',
			source: 'saros.knowledge',
		},
		handler: async (args) => {
			const id = args['id'] as string;
			try {
				if (!id) { return txt(JSON.stringify({ success: false, error: '`id` is required' })); }
				const manager = await buildManager({});
				const session = await manager.load(id);
				const md = manager.exportMarkdown(session, {
					title: (args['title'] as string) || session.title,
					mermaid: args['mermaid'] !== false,
					wikilinks: args['wikilinks'] !== false,
				});
				const outArg = args['output_path'] as string | undefined;
				if (outArg) {
					const baseDir = await deps.resolveBaseDir();
					const uri = resolveFileUri(baseDir, outArg);
					if (!uri) { return txt(JSON.stringify({ success: false, error: '`output_path` is invalid' })); }
					await deps.fileService.createFolder(URI.joinPath(uri, '..'));
					await deps.fileService.writeFile(uri, VSBuffer.fromString(md));
					void logKbTool('kb_export', 'success', { target: uri.fsPath, detail: { id, bytes: md.length } });
					return txt(JSON.stringify({ success: true, path: uri.fsPath, bytes: md.length }, null, 2));
				}
				void logKbTool('kb_export', 'success', { target: 'inline', detail: { id, bytes: md.length } });
				return txt(JSON.stringify({ success: true, markdown: md }, null, 2));
			} catch (err) {
				void logKbTool('kb_export', 'failure', { target: id, error: err instanceof Error ? err.message : String(err) });
				return txt(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
			}
		},
	},

	// ── kb_list ─────────────────────────────────────
		{
			definition: {
				name: 'kb_list',
				description: 'List all persisted knowledge bases in this workspace.',
				inputSchema: { type: 'object', properties: {} },
				category: 'knowledge',
				source: 'saros.knowledge',
			},
			handler: async () => {
				try {
					const manager = await buildManager({});
					const list = await manager.listStored();
					void logKbTool('kb_list', 'success', { detail: { count: (list as unknown[]).length } });
					return txt(JSON.stringify({ success: true, knowledgeBases: list }, null, 2));
				} catch (err) {
					void logKbTool('kb_list', 'failure', { error: err instanceof Error ? err.message : String(err) });
					return txt(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
				}
			},
		},

		// ── kb_delete ───────────────────────────────────
		{
			definition: {
				name: 'kb_delete',
				description: 'Delete a knowledge base (by id) and its persisted index.',
				inputSchema: {
					type: 'object',
					properties: {
						id: { type: 'string', description: 'Knowledge base id' },
					},
					required: ['id'],
				},
				category: 'knowledge',
				source: 'saros.knowledge',
			},
		handler: async (args) => {
			const id = args['id'] as string;
			try {
				if (!id) { return txt(JSON.stringify({ success: false, error: '`id` is required' })); }
				const manager = await buildManager({});
				await manager.delete(id);
					void logKbTool('kb_delete', 'success', { target: id });
					return txt(JSON.stringify({ success: true, deleted: id }, null, 2));
				} catch (err) {
					void logKbTool('kb_delete', 'failure', { target: id, error: err instanceof Error ? err.message : String(err) });
					return txt(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }));
				}
			},
		},
	];

	return descriptors;
}
