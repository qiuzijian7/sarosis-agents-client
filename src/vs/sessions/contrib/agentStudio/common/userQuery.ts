/*---------------------------------------------------------------------------------------------
 *  userQuery.ts
 *
 *  Wraps the human user's raw input message in <user_query>...</user_query> so the
 *  model can unambiguously distinguish the user's actual request from injected
 *  system / skill / memory / context blocks.
 *
 *  Applied at the user-message packaging boundary (agentDriverService builds the
 *  main-agent user message; unifiedSubAgentDispatch builds the sub-agent task
 *  message). The wrapped text is what reaches the LLM and is persisted in the
 *  transcript; the webview chat bubble still shows the raw, unwrapped text.
 *--------------------------------------------------------------------------------------------*/

const USER_QUERY_OPEN = '<user_query>';
const USER_QUERY_CLOSE = '</user_query>';

/**
 * Wrap raw user input in <user_query>...</user_query>.
 *
 * Idempotent: if the text is already fully wrapped (e.g. replayed from a prior
 * turn's persisted transcript), it is returned unchanged to avoid nested tags.
 */
export function wrapUserQuery(text: string): string {
	if (!text) {
		return text;
	}
	const trimmed = text.trim();
	if (trimmed.startsWith(USER_QUERY_OPEN) && trimmed.endsWith(USER_QUERY_CLOSE)) {
		return text;
	}
	return `${USER_QUERY_OPEN}${text}${USER_QUERY_CLOSE}`;
}

/**
 * Strip the <user_query>...</user_query> wrapper added by {@link wrapUserQuery}.
 *
 * The wrapper exists purely so the LLM can tell the user's real instruction
 * apart from injected system / skill / memory blocks. Any surface that shows the
 * text back to the human (notifications, toasts, history lists) must unwrap it
 * first — otherwise the raw `<user_query>` tag leaks into the UI.
 *
 * Idempotent: text without the wrapper is returned unchanged (trimmed of the
 * surrounding whitespace only when a wrapper was actually removed).
 */
export function unwrapUserQuery(text: string): string {
	if (!text) {
		return text;
	}
	const trimmed = text.trim();
	if (trimmed.startsWith(USER_QUERY_OPEN) && trimmed.endsWith(USER_QUERY_CLOSE)) {
		return trimmed.slice(USER_QUERY_OPEN.length, trimmed.length - USER_QUERY_CLOSE.length);
	}
	return text;
}
