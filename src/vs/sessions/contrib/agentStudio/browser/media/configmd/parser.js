/**
 * Default ConfigMD parser — pure-JavaScript re-implementation of the
 * built-in `builtInRenderMarkdown` function so that agent authors can
 * copy this file into their `<agentDir>/ui/parser.js` and customise it.
 *
 * The module must export a single `parse(markdown, options)` function.
 *   - markdown: string
 *   - options: { agentId?: string }
 *   - returns: HTML string
 *
 * This default implementation supports:
 *   - `<!-- agent-state:NAME -->...<!-- /agent-state:NAME -->` blocks
 *   - `<!-- agent-bind:NAME -->X<!-- /agent-bind:NAME -->` inline binds
 *   - Fenced code blocks (```lang ... ```)
 *   - Headings (#..######)
 *   - Todo list items (- [x] ...)
 *   - Unordered list items (- ...)
 *   - Ordered list items (1. ...)
 *   - Inline markup: **bold**, *italic*, `code`, [link](url)
 *   - Paragraphs (everything else)
 */
(function (module, exports) {
	'use strict';

	function builtInRenderMarkdown(md) {
		let src = md.replace(/\r\n/g, '\n');

		// Preserve <!-- agent-state:NAME -->...<!-- /agent-state:NAME --> blocks
		const stateBlocks = [];
		src = src.replace(
			/<!--\s*agent-state:([\w.-]+)\s*-->([\s\S]*?)<!--\s*\/agent-state:\1\s*-->/g,
			function (_m, name, body) {
				const idx = stateBlocks.length;
				stateBlocks.push({ name: name, body: body });
				return '\u0000STATE' + idx + '\u0000';
			}
		);

		// Preserve <!-- agent-bind:NAME -->X<!-- /agent-bind:NAME --> inline binds
		const bindBlocks = [];
		src = src.replace(
			/<!--\s*agent-bind:([\w.-]+)\s*-->([\s\S]*?)<!--\s*\/agent-bind:\1\s*-->/g,
			function (_m, name, body) {
				const idx = bindBlocks.length;
				bindBlocks.push({ name: name, body: body });
				return '\u0000BIND' + idx + '\u0000';
			}
		);

		const escape = function (s) {
			return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
		};

		// Code fences
		const codeBlocks = [];
		src = src.replace(/```([\w-]*)\n([\s\S]*?)```/g, function (_m, lang, code) {
			codeBlocks.push('<pre class="cmd-code"><code class="lang-' + escape(lang || 'text') + '">' + escape(code) + '</code></pre>');
			return '\u0000CODE' + (codeBlocks.length - 1) + '\u0000';
		});

		// Split into lines and run a small block-level parser
		const lines = src.split('\n');
		const out = [];
		let inUl = false;
		let inOl = false;
		const closeLists = function () {
			if (inUl) { out.push('</ul>'); inUl = false; }
			if (inOl) { out.push('</ol>'); inOl = false; }
		};

		const renderInline = function (text) {
			let t = escape(text);
			// links
			t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
			// bold then italic
			t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
			t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
			// inline code
			t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
			return t;
		};

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			// Heading
			const h = /^(#{1,6})\s+(.*)$/.exec(line);
			if (h) {
				closeLists();
				const level = h[1].length;
				const slug = h[2].trim().toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
				out.push('<h' + level + ' id="h-' + slug + '">' + renderInline(h[2]) + '</h' + level + '>');
				continue;
			}
			// Todo list item
			const todo = /^[\-\*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
			if (todo) {
				if (inOl) { out.push('</ol>'); inOl = false; }
				if (!inUl) { out.push('<ul class="cmd-tasklist">'); inUl = true; }
				const checked = todo[1].toLowerCase() === 'x';
				const text = renderInline(todo[2]);
				out.push('<li><label class="cmd-task"><input type="checkbox" data-agent-task ' + (checked ? 'checked' : '') + '/> ' + text + '</label></li>');
				continue;
			}
			// Unordered list item
			const ul = /^[\-\*]\s+(.*)$/.exec(line);
			if (ul) {
				if (inOl) { out.push('</ol>'); inOl = false; }
				if (!inUl) { out.push('<ul>'); inUl = true; }
				out.push('<li>' + renderInline(ul[1]) + '</li>');
				continue;
			}
			// Ordered list item
			const ol = /^\d+\.\s+(.*)$/.exec(line);
			if (ol) {
				if (inUl) { out.push('</ul>'); inUl = false; }
				if (!inOl) { out.push('<ol>'); inOl = true; }
				out.push('<li>' + renderInline(ol[1]) + '</li>');
				continue;
			}
			// Blank line
			if (!line.trim()) {
				closeLists();
				continue;
			}
			// Paragraph
			closeLists();
			out.push('<p>' + renderInline(line) + '</p>');
		}
		closeLists();

		let html = out.join('\n');

		// Restore code blocks
		html = html.replace(/\u0000CODE(\d+)\u0000/g, function (_m, idx) {
			return codeBlocks[parseInt(idx, 10)] || '';
		});
		// Restore agent-state blocks (recursively render the inner body)
		html = html.replace(/\u0000STATE(\d+)\u0000/g, function (_m, idx) {
			const blk = stateBlocks[parseInt(idx, 10)];
			if (!blk) { return ''; }
			const inner = builtInRenderMarkdown(blk.body);
			return '<div data-agent-state="' + escape(blk.name) + '">' + inner + '</div>';
		});
		// Restore agent-bind inline binds
		html = html.replace(/\u0000BIND(\d+)\u0000/g, function (_m, idx) {
			const blk = bindBlocks[parseInt(idx, 10)];
			if (!blk) { return ''; }
			return '<span data-agent-bind="' + escape(blk.name) + '">' + renderInline(blk.body) + '</span>';
		});

		return html;
	}

	// Export
	const parser = {
		parse: function (markdown, options) {
			return builtInRenderMarkdown(markdown);
		}
	};

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = parser;
	}
	if (typeof exports !== 'undefined') {
		exports.default = parser;
	}
})(typeof module !== 'undefined' ? module : { exports: {} }, typeof exports !== 'undefined' ? exports : {});
