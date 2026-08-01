/*---------------------------------------------------------------------------------------------
 *  Hyper-Extract (TS port) — File storage adapter
 *
 *  Persists a serialized knowledge base to `<root>/<id>/kb.json`
 *  via `IFileService`. Keeps the engine free of `vs/` imports: the engine
 *  declares `KBStorageAdapter`; this module is the concrete VS Code impl.
 *
 *  The `<root>` defaults to `<userDataPath>/knowledge-base` (see `resolveKbRoot`)
 *  and can be overridden via the `agentStudio.knowledge.storage.path` config.
 *  `migrateKnowledgeStorage` moves existing KBs when that root changes.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { join, isAbsolute } from '../../../../../base/common/path.js';
import { IFileService } from '../../../../../platform/files/common/files.js';

/**
 * Default KB subdirectory name under the VS Code user data root.
 * Full default path: `~/.vssaros/knowledge-base/`
 */
export const KB_DEFAULT_REL = 'knowledge-base';

/**
 * Resolve the absolute KB storage root.
 *
 * @param configValue - Value from `agentStudio.knowledge.storage.path` setting
 * @param dataRoot - The VS Code user data root path (e.g., `~/.vssaros/`)
 *
 * - Empty/undefined config  → `<dataRoot>/knowledge-base`
 * - `~` prefix              → expanded to `dataRoot`
 * - Absolute path           → used as-is
 * - Relative path           → resolved against `dataRoot`
 */
export function resolveKbRoot(configValue: string | undefined, dataRoot: string): string {
	const v = (configValue ?? '').trim();
	if (!v) {
		return join(dataRoot, KB_DEFAULT_REL);
	}
	const expanded = v.replace(/^~(?=$|[\\/])/, dataRoot);
	const resolved = isAbsolute(expanded) ? expanded : join(dataRoot, expanded);
	return resolved.replace(/[\\/]+$/, '');
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

	// Also migrate the legacy `favorites/` folder (written by the chat
	// "收藏到知识库" fallback) so existing favorites aren't orphaned on a root change.
	await migrateFavoritesFolder(fileService, oldUri, newUri);

	return migrated;
}

/**
 * Move a whole `favorites/` directory (legacy chat fallback) from `oldUri` to `newUri`.
 * No-op if the source is missing or the destination already exists.
 */
async function migrateFavoritesFolder(fileService: IFileService, oldUri: URI, newUri: URI): Promise<void> {
	const oldFav = URI.joinPath(oldUri, 'favorites');
	const newFav = URI.joinPath(newUri, 'favorites');
	try {
		const stat = await fileService.resolve(oldFav);
		if (!stat.children || stat.children.length === 0) { return; }
	} catch {
		return;
	}
	if (await fileService.exists(newFav)) {
		// Destination already has favorites; drop the orphaned source to avoid duplicates.
		try { await fileService.del(oldFav, { recursive: true }); } catch { /* ignore */ }
		return;
	}
	try {
		await fileService.move(oldFav, newFav, false);
	} catch {
		// best-effort: leave source in place if the move isn't supported
	}
}
