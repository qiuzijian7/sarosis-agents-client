/*---------------------------------------------------------------------------------------------
 *  Chat input attachment hyperlinks
 *
 *  When a user adds text/image files to the chat composer they are stored as
 *  structured `IChatAttachment` objects (carrying the real base64 data) and also
 *  embedded into the input text as markdown-style hyperlinks, e.g.
 *
 *      [📄 notes.txt](saros-attachment://att-123)
 *      [📷 screenshot.png](saros-attachment://att-456)
 *
 *  This makes the attachment visible & clickable inside the textarea. On send we
 *  strip those hyperlink references (the real data travels through the structured
 *  `attachments` channel → `buildUserContentParts` → `MessageFormatConverter`),
 *  so the prompt text stays clean while the file/image content still reaches the
 *  LLM correctly.
 *--------------------------------------------------------------------------------------------*/

import type { IChatAttachment } from './agentChatTypes.js';

/** Custom URI scheme used to reference a pending attachment by its id. */
export const ATTACHMENT_LINK_SCHEME = 'saros-attachment';

/** Matches a whole markdown link whose target uses the attachment scheme. */
const ATTACHMENT_LINK_RE = new RegExp(`\\[[^\\]]*\\]\\(${ATTACHMENT_LINK_SCHEME}://[^)\\s]+\\)`, 'g');

/** Leading emoji used to distinguish image vs file attachments in the label. */
function iconFor(type: IChatAttachment['type']): string {
	return type === 'image' ? '📷' : '📄';
}

/**
 * Format a single attachment as an inline markdown hyperlink.
 * Example: `[📄 notes.txt](saros-attachment://att-123)`
 */
export function formatAttachmentHyperlink(att: IChatAttachment): string {
	return `[${iconFor(att.type)} ${att.name}](${ATTACHMENT_LINK_SCHEME}://${att.id})`;
}

/**
 * Format multiple attachments as a single space-joined hyperlink string,
 * suitable for appending to the input box text.
 */
export function formatAttachmentsHyperlinks(attachments: ReadonlyArray<IChatAttachment>): string {
	return attachments.map(formatAttachmentHyperlink).join(' ');
}

/**
 * Extract the attachment ids referenced by hyperlinks embedded in the given text.
 * Returns `[]` when none are present. Order follows first-appearance in text.
 */
export function extractAttachmentIds(text: string): string[] {
	const ids: string[] = [];
	let m: RegExpExecArray | null;
	ATTACHMENT_LINK_RE.lastIndex = 0;
	while ((m = ATTACHMENT_LINK_RE.exec(text)) !== null) {
		// m[0] is the full match like "[📄 notes.txt](saros-attachment://att-123)"
		const inner = m[0];
		const schemeIdx = inner.indexOf(`${ATTACHMENT_LINK_SCHEME}://`);
		const start = schemeIdx + `${ATTACHMENT_LINK_SCHEME}://`.length;
		const end = inner.indexOf(')', start);
		ids.push(inner.slice(start, end));
	}
	return ids;
}

/**
 * Remove embedded attachment hyperlink references from text, returning clean
 * prompt text. Used right before sending so the LLM sees the user's words
 * without the (now-redundant) `saros-attachment://` tokens. The actual file /
 * image data is delivered through the structured `attachments` channel.
 */
export function stripAttachmentHyperlinks(text: string): string {
	return text.replace(ATTACHMENT_LINK_RE, '').trim();
}
