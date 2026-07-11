/*---------------------------------------------------------------------------------------------
 *  Knowledge Base operation log
 *
 *  Every mutation against the knowledge base (side-panel Vault path *and* the
 *  agent-tool engine path) is appended as one JSON line to
 *  `<kbRoot>/.op-log.jsonl` — i.e. `~/.saros/kb/.op-log.jsonl` by default.
 *
 *  The log is best-effort: any failure while writing it is swallowed so that
 *  logging never breaks the operation it is recording.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { join } from '../../../../../base/common/path.js';
import { IFileService } from '../../../../../platform/files/common/files.js';

/** Which knowledge-base surface produced the operation. */
export type KbOpChannel = 'vault' | 'engine';

/** Outcome of the operation. */
export type KbOpStatus = 'success' | 'failure';

export interface IKbOpLogEntry {
	/** ISO-8601 timestamp (auto-filled if omitted). */
	ts: string;
	/** Operation name, e.g. `kb.import.folder`, `kb_build`, `note.create`. */
	op: string;
	/** `vault` = side-panel library/notes; `engine` = agent `kb_*` tools. */
	channel: KbOpChannel;
	status: KbOpStatus;
	/** Source path / URL. */
	source?: string;
	/** Target path / knowledge-base id. */
	target?: string;
	/** Operation-specific structured detail. */
	detail?: Record<string, unknown>;
	/** Error message (present when `status === 'failure'`). */
	error?: string;
}

/** File name of the operation log, written under the KB storage root. */
export const KB_OP_LOG_FILE = '.op-log.jsonl';

/** Resolve the `.op-log.jsonl` URI for a given KB storage root directory. */
export function kbOpLogUri(rootDir: string): URI {
	return URI.file(join(rootDir, KB_OP_LOG_FILE));
}

/**
 * Append one JSONL line to `<rootDir>/.op-log.jsonl`.
 *
 * Uses a read-modify-write so lines stay well-formed even when multiple
 * operations race. Parent directory is created on demand.
 */
export async function appendKbOpLog(
	fileService: IFileService,
	rootDir: string,
	entry: IKbOpLogEntry,
): Promise<void> {
	try {
		const uri = kbOpLogUri(rootDir);
		await fileService.createFolder(URI.file(rootDir));

		let existing = '';
		try {
			existing = (await fileService.readFile(uri)).value.toString();
		} catch {
			// File does not exist yet → start fresh.
		}

		const line = JSON.stringify({ ...entry, ts: entry.ts || new Date().toISOString() });
		const next = existing.length === 0
			? line + '\n'
			: (existing.endsWith('\n') ? existing : existing + '\n') + line + '\n';

		await fileService.writeFile(uri, VSBuffer.fromString(next));
	} catch {
		// Logging must never break the underlying operation.
	}
}
