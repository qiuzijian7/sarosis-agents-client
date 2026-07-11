/*---------------------------------------------------------------------------------------------
 *  Hyper-Extract (TS port) — File storage adapter
 *
 *  Persists a serialized knowledge base to `<root>/<id>/kb.json`
 *  via `IFileService`. Keeps the engine free of `vs/` imports: the engine
 *  declares `KBStorageAdapter`; this module is the concrete VS Code impl.
 *
 *  The `<root>` defaults to `<userHome>/.saros/kb` (see `resolveKbRoot`)
 *  and can be overridden via the `agentStudio.knowledge.storage.path` config.
 *  `migrateKnowledgeStorage` moves existing KBs when that root changes.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { join, isAbsolute } from '../../../../../base/common/path.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { KBStorageAdapter, KnowledgeSessionMeta, SerializedKB } from './engine/knowledgeManager.js';

/**
 * Default relative sub-path under the user home.
 * Phase E (subsystem unification): aligned with the Vault sidebar default
 * (`~/.saros/knowledge-base`) so Agent kb_* tools and the sidebar share one
 * storage root. Legacy data at `~/.saros/kb` is auto-migrated on config change
 * via `migrateKnowledgeStorage` (called from `_maybeMigrateKbStorage`).
 */
export const KB_DEFAULT_REL = join('.saros', 'knowledge-base');

/**
 * Resolve the absolute KB storage root.
 *
 * - Empty/undefined config  → `<userHome>/.saros/kb`
 * - `~` prefix              → expanded to the user home
 * - Absolute path           → used as-is
 * - Relative path           → resolved against the user home
 */
export function resolveKbRoot(configValue: string | undefined, userHome: string): string {
	const v = (configValue ?? '').trim();
	if (!v) {
		return join(userHome, KB_DEFAULT_REL);
	}
	const expanded = v.replace(/^~(?=$|[\\/])/, userHome);
	const resolved = isAbsolute(expanded) ? expanded : join(userHome, expanded);
	return resolved.replace(/[\\/]+$/, '');
}

export function createFileStorageAdapter(fileService: IFileService, root: string): KBStorageAdapter {
	const uriFor = (id: string) => URI.file(join(root, id, 'kb.json'));

	function metaFromPayload(p: SerializedKB): KnowledgeSessionMeta {
		const m = (p.metadata ?? {}) as Record<string, unknown>;
		return {
			id: (m['id'] as string) ?? '',
			templateId: (m['templateId'] as string) ?? 'knowledge_graph',
			title: (m['title'] as string) ?? 'Untitled',
			kind: (m['kind'] as 'graph' | 'list') ?? 'graph',
			itemCount: 0,
			createdAt: (m['createdAt'] as string) ?? new Date().toISOString(),
			updatedAt: (m['updatedAt'] as string) ?? new Date().toISOString(),
		};
	}

	return {
		async read(id: string): Promise<SerializedKB | undefined> {
			try {
				const stat = await fileService.readFile(uriFor(id));
				return JSON.parse(stat.value.toString()) as SerializedKB;
			} catch {
				return undefined;
			}
		},

		async write(id: string, payload: SerializedKB): Promise<void> {
			const uri = uriFor(id);
			await fileService.createFolder(URI.joinPath(uri, '..'));
			await fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(payload, null, 2)));
		},

		async remove(id: string): Promise<void> {
			try {
				await fileService.del(uriFor(id), { recursive: true });
			} catch {
				// already gone
			}
		},

		async list(): Promise<KnowledgeSessionMeta[]> {
			try {
				const dirUri = URI.file(root);
				const stat = await fileService.resolve(dirUri, { resolveMetadata: true });
				const out: KnowledgeSessionMeta[] = [];
				if (stat.children) {
					for (const child of stat.children) {
						if (!child.isDirectory) { continue; }
						try {
							const p = await this.read(child.name);
							if (p?.metadata) { out.push(metaFromPayload(p)); }
						} catch {
							// skip corrupt entry
						}
					}
				}
				return out;
			} catch {
				return [];
			}
		},
	};
}

/** List knowledge-base ids (sub-directory names) under a storage root. */
export async function listKbIds(fileService: IFileService, root: string): Promise<string[]> {
	try {
		const stat = await fileService.resolve(URI.file(root));
		if (!stat.children) { return []; }
		return stat.children.filter(c => c.isDirectory).map(c => c.name);
	} catch {
		return [];
	}
}

/**
 * Move every knowledge base from `oldRoot` to `newRoot`.
 *
 * Safe to call repeatedly: existing targets at `newRoot` are skipped (no
 * overwrite), and each migrated source sub-directory is deleted afterwards.
 * Returns the number of successfully migrated knowledge bases.
 */
export async function migrateKnowledgeStorage(fileService: IFileService, oldRoot: string, newRoot: string): Promise<number> {
	if (!oldRoot || !newRoot || oldRoot === newRoot) { return 0; }

	let oldStat;
	try {
		oldStat = await fileService.resolve(URI.file(oldRoot));
	} catch {
		return 0;
	}
	if (!oldStat.children || oldStat.children.length === 0) { return 0; }

	const oldUri = URI.file(oldRoot);
	const newUri = URI.file(newRoot);
	let migrated = 0;

	for (const child of oldStat.children) {
		if (!child.isDirectory) { continue; }
		const id = child.name;
		const oldFile = URI.joinPath(oldUri, id, 'kb.json');
		const newFile = URI.joinPath(newUri, id, 'kb.json');

		// Don't clobber a KB that already exists at the destination.
		if (await fileService.exists(newFile)) {
			// Still clean up the orphaned source to avoid duplicates.
			try { await fileService.del(URI.joinPath(oldUri, id), { recursive: true }); } catch { /* ignore */ }
			continue;
		}

		try {
			const content = await fileService.readFile(oldFile);
			await fileService.createFolder(URI.joinPath(newUri, id));
			await fileService.writeFile(newFile, content.value);
			await fileService.del(URI.joinPath(oldUri, id), { recursive: true });
			migrated++;
		} catch {
			// skip corrupt / unreadable entry
		}
	}

	return migrated;
}
