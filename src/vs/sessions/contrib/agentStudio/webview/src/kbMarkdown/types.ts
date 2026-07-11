/* Shared types for the Glyph-style markdown rendering layer (react-markdown
 * pipeline) that replaces the old BlockSuite/AFFiNE KB editor. */

/** A note in the open vault, as known to the host kernel. */
export interface WorkspaceFile {
	/** Absolute `file://` URI string of the note. */
	uri: string;
	/** Filename stem (without the `.md`/`.markdown` extension), lowercased when used for matching. */
	name: string;
}

export interface ResolvedWikilink {
	uri: string | null;
	heading?: string;
}
