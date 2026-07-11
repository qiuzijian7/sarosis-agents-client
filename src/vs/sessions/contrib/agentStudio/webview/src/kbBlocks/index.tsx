/*---------------------------------------------------------------------------------------------
 *  KB note renderer — react-markdown pipeline (replaces the old BlockSuite /
 *  AFFiNE WYSIWYG editor).
 *
 *  Mounted by `KbBlocksEditorPane`. The host injects `window.__KB_INIT__` with
 *  `{ docId, markdown, workspaceFiles, currentFilePath }` BEFORE this script runs.
 *  `.md` is the single source of truth; source-mode edits are serialized back to
 *  disk via `kbblocks.save`.
 *--------------------------------------------------------------------------------------------*/

import { createRoot } from 'react-dom/client';
import { KbMarkdownApp } from '../kbMarkdown/KbMarkdownApp';
import '../kbMarkdown/kb-markdown.css';

const container = document.getElementById('root');
if (container) {
	const root = createRoot(container);
	root.render(<KbMarkdownApp />);
}
