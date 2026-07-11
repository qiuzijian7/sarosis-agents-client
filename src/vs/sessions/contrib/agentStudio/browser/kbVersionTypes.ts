/*---------------------------------------------------------------------------------------------
 *  KB Version Management — Type definitions.
 *
 *  Mirrors SoloMD's `git_history.rs` types for the AutoGit per-note version
 *  history system. All types are serialised across the host↔webview postMessage
 *  boundary, so they must be plain data (no methods, no circular refs).
 *--------------------------------------------------------------------------------------------*/

/** Read-only workspace git status (mirrors SoloMD `WorkspaceStatus`). */
export interface KbWorkspaceStatus {
	initialized: boolean;
	headSha: string | null;
	headMessage: string | null;
	dirty: boolean;
	branch: string | null;
}

/** A single commit's metadata (mirrors SoloMD `CommitMeta`). */
export interface KbCommitMeta {
	sha: string;
	shortSha: string;
	message: string;
	author: string;
	/** Seconds since UNIX epoch (UTC). */
	time: number;
}

/** One line in a diff hunk. */
export interface KbDiffLine {
	kind: 'context' | 'add' | 'remove';
	text: string;
}

/** A structured diff hunk (mirrors SoloMD `DiffHunk`). */
export interface KbDiffHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: KbDiffLine[];
}

/** Full diff result for a single file at a single commit (mirrors SoloMD `DiffResult`). */
export interface KbDiffResult {
	fromSha: string | null;
	toSha: string;
	hunks: KbDiffHunk[];
	/** Standard unified-diff text (for raw display / copy). */
	unified: string;
}
