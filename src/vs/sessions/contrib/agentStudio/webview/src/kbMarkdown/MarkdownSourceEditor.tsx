/**
 * CodeMirror 6 source editor for KB markdown notes.
 *
 * Replaces the plain <textarea> with syntax highlighting, wikilink autocompletion,
 * and versioned undo/redo (aligned with Glyph's MarkdownEditor.tsx).
 *
 * Dependencies (from npm cache, all verified present):
 *   @codemirror/view @codemirror/state @codemirror/commands
 *   @codemirror/lang-markdown @codemirror/autocomplete
 *   @codemirror/language @codemirror/language-data
 *   @lezer/highlight
 */

import {
	acceptCompletion,
	autocompletion,
	closeCompletion,
	completionKeymap,
	moveCompletionSelection,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useRef } from 'react';

interface MarkdownSourceEditorProps {
	content: string;
	onChange: (content: string) => void;
	/** Relative file paths in the workspace (used for wikilink autocomplete). */
	workspaceFiles?: { uri: string; name: string }[];
}

/**
 * Build a completion source for `[[wikilink]]` syntax:
 * matches `[[` followed by partial filenames.
 */
function wikilinkCompletionSource(opts: {
	filesRef: React.MutableRefObject<{ uri: string; name: string }[]>;
}) {
	return (context: { matchBefore: (rx: RegExp) => { text: string } | null; pos: number }) => {
		const match = context.matchBefore(/\[\[([^\]]*)$/);
		if (!match) return null;
		const partial = match.text.toLowerCase().replace(/^\[\[/, '');
		const files = opts.filesRef.current;
		if (files.length === 0) return null;

		const from = context.pos - match.text.length + 2; // after [[
		const to = context.pos;
		const lowerPartial = partial || '';

		const options = files
			.filter(f => f.name.toLowerCase().includes(lowerPartial))
			.slice(0, 20)
			.map(f => f.name);

		if (options.length === 0) return null;

		return {
			from,
			to,
			options: options.map(name => ({ label: name, type: 'text' })),
			filter: false,
		};
	};
}

const spellcheckCompartment = new Compartment();

export function MarkdownSourceEditor({ content, onChange, workspaceFiles }: MarkdownSourceEditorProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;

	const filesRef = useRef<{ uri: string; name: string }[]>(workspaceFiles ?? []);
	filesRef.current = workspaceFiles ?? [];

	// biome-ignore lint/correctness/useExhaustiveDependencies: content is synced via separate effect to avoid destroying the editor on every keystroke
	useEffect(() => {
		if (!containerRef.current) return;

		const glyphHighlight = HighlightStyle.define([
			{ tag: tags.heading1, class: 'cm-heading cm-heading-1' },
			{ tag: tags.heading2, class: 'cm-heading cm-heading-2' },
			{ tag: tags.heading3, class: 'cm-heading cm-heading-3' },
			{ tag: [tags.heading4, tags.heading5, tags.heading6], class: 'cm-heading' },
			{ tag: tags.strong, class: 'cm-strong' },
			{ tag: tags.emphasis, class: 'cm-emphasis' },
			{ tag: tags.strikethrough, class: 'cm-strikethrough' },
			{ tag: tags.link, class: 'cm-link' },
			{ tag: tags.url, class: 'cm-url' },
			{ tag: tags.processingInstruction, class: 'cm-meta' },
			{ tag: tags.monospace, class: 'cm-code' },
			{ tag: tags.quote, class: 'cm-quote' },
			{ tag: [tags.meta, tags.comment], class: 'cm-meta' },
			{ tag: tags.keyword, class: 'cm-keyword' },
			{ tag: tags.string, class: 'cm-string' },
			{ tag: tags.number, class: 'cm-number' },
		]);

		const view = new EditorView({
			state: EditorState.create({
				doc: content,
				extensions: [
					lineNumbers(),
					history(),
					// Completion keymap (Tab-accept, Esc-close, arrows-navigate)
					keymap.of([
						{ key: 'Tab', run: acceptCompletion },
						{ key: 'Escape', run: closeCompletion },
						{ key: 'ArrowDown', run: (v) => moveCompletionSelection(true)(v) },
						{ key: 'ArrowUp', run: (v) => moveCompletionSelection(false)(v) },
						...completionKeymap,
						...defaultKeymap,
						...historyKeymap,
					]),
					autocompletion({
						override: [
							wikilinkCompletionSource({ filesRef }),
						],
						activateOnTyping: true,
						closeOnBlur: false,
					}),
					markdown({ base: markdownLanguage, codeLanguages: languages }),
					syntaxHighlighting(glyphHighlight),
					spellcheckCompartment.of([]), // spellcheck disabled for now
					EditorView.lineWrapping,
					EditorView.updateListener.of(update => {
						if (update.docChanged) {
							onChangeRef.current(update.state.doc.toString());
						}
					}),
					EditorView.theme({
						'&': {
							height: '100%',
							fontSize: '13px',
							lineHeight: '1.6',
						},
						'.cm-scroller': {
							overflow: 'auto',
						},
						'.cm-content': {
							fontFamily: 'var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, monospace)',
						},
						'.cm-gutters': {
							fontFamily: 'var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, monospace)',
						},
					}),
				],
			}),
			parent: containerRef.current,
		});

		viewRef.current = view;

		return () => {
			view.destroy();
			viewRef.current = null;
		};
	}, []); // Only recreate when mount/unmount (keymap preset change — not applicable here)

	// Sync external content changes into the editor without destroying it
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		const current = view.state.doc.toString();
		if (current === content) return;
		view.dispatch({
			changes: { from: 0, to: current.length, insert: content },
		});
	}, [content]);

	return <div ref={containerRef} className="kb-cm-editor" />;
}
