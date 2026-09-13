/*---------------------------------------------------------------------------------------------
 *  AgentStudio Source Control — workspace folder merge helpers
 *
 *  Pure folder-set logic shared by the SCM folder sync. Extracted so the merge
 *  rules can be unit tested without a live workspace context service.
 *--------------------------------------------------------------------------------------------*/

/** Minimal folder shape needed for merging (compatible with `IWorkspaceFolder`). */
export interface IMergeableFolder {
	readonly uri: { readonly fsPath: string };
	readonly name: string;
}

/** Minimal folder shape used as a merge target. */
export interface IFolderTarget {
	readonly uri: { readonly fsPath: string };
	readonly name: string;
}

/**
 * Case- and separator-insensitive key for de-duplicating folder paths.
 *
 * Windows paths are compared case-insensitively and mixed separators are
 * normalised, so `G:\Foo\` and `g:/foo` are treated as the same folder.
 */
export function normalizeFolderKey(fsPath: string): string {
	return fsPath.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

/**
 * Merge SCM target roots into the current workspace folder list.
 *
 * The active workspace's roots are added to whatever the window already has
 * instead of replacing it. This matters for a multi-root `.code-workspace`:
 * blindly replacing `folders` with a single workspace's roots collapsed the
 * explorer to one project, dropping every other declared folder.
 *
 * Ordering is stable — existing folders keep their slot, missing targets are
 * appended — so switching the active workspace does not reshuffle the explorer.
 */
export function mergeWorkspaceFolders<Uri, Folder extends { readonly uri: Uri; readonly name: string }>(
	currentFolders: readonly Folder[],
	targets: readonly Folder[],
): Folder[] {
	const merged: Folder[] = [];
	const seen = new Set<string>();

	for (const folder of currentFolders) {
		const key = normalizeFolderKey((folder.uri as { fsPath: string }).fsPath);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		merged.push(folder);
	}

	for (const target of targets) {
		const key = normalizeFolderKey((target.uri as { fsPath: string }).fsPath);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		merged.push(target);
	}

	return merged;
}

/**
 * Whether two folder lists describe the same folder set in the same order.
 *
 * Used to skip a redundant `updateFolders` call, which would otherwise churn
 * the git extension and re-scan every root on every active-workspace change.
 */
export function folderListsMatch<Uri>(
	currentFolders: readonly { readonly uri: Uri }[],
	candidateFolders: readonly { readonly uri: Uri }[],
): boolean {
	if (currentFolders.length !== candidateFolders.length) {
		return false;
	}
	return currentFolders.every((folder, index) =>
		normalizeFolderKey((folder.uri as { fsPath: string }).fsPath) === normalizeFolderKey((candidateFolders[index].uri as { fsPath: string }).fsPath));
}
