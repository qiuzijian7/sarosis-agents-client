/*---------------------------------------------------------------------------------------------
 *  Lightweight syntax highlighter using PrismLight + manual language registration.
 *
 *  The previous `Prism` import pulled in highlight.js (1369 KB) + refractor's
 *  full 200+ language set — ~47% of the webview bundle.  By switching to
 *  PrismLight and only registering the ~15 most common languages, we eliminate
 *  those heavy dependencies entirely.
 *
 *  Drop-in replacement for react-syntax-highlighter's Prism component.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
// Import PrismLight from its direct path (NOT the barrel index which has
// side-effect imports of async-languages that pull in highlight.js + all
// 200+ refractor languages).
import PrismLight from 'react-syntax-highlighter/dist/esm/prism-light';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

// ── Register only the languages we actually encounter in agent chat ──
// Each `registerLanguage` call pulls in a separate grammar module (~2-30 KB
// each). We keep this set small to minimize bundle growth.
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp';

PrismLight.registerLanguage('tsx', tsx);
PrismLight.registerLanguage('typescript', typescript);
PrismLight.registerLanguage('javascript', javascript);
PrismLight.registerLanguage('js', javascript);
PrismLight.registerLanguage('json', json);
PrismLight.registerLanguage('python', python);
PrismLight.registerLanguage('py', python);
PrismLight.registerLanguage('bash', bash);
PrismLight.registerLanguage('shell', bash);
PrismLight.registerLanguage('sh', bash);
PrismLight.registerLanguage('markdown', markdown);
PrismLight.registerLanguage('css', css);
PrismLight.registerLanguage('yaml', yaml);
PrismLight.registerLanguage('yml', yaml);
PrismLight.registerLanguage('sql', sql);
PrismLight.registerLanguage('rust', rust);
PrismLight.registerLanguage('go', go);
PrismLight.registerLanguage('java', java);
PrismLight.registerLanguage('csharp', csharp);
PrismLight.registerLanguage('cs', csharp);

interface LazySyntaxHighlighterProps {
	code: string;
	language: string;
	lineCount?: number;
	className?: string;
	/** Custom style overrides for the code block container */
	customStyle?: React.CSSProperties;
	/** Whether to wrap long lines (default: true) */
	wrapLongLines?: boolean;
	/** Optional props for the <code> tag */
	codeTagProps?: Record<string, unknown>;
}

/**
 * Drop-in replacement for react-syntax-highlighter's Prism component.
 * Uses PrismLight with a curated language set to keep the bundle small.
 */
export function LazySyntaxHighlighter({
	code,
	language,
	lineCount,
	className,
	customStyle,
	wrapLongLines = true,
	codeTagProps,
}: LazySyntaxHighlighterProps): React.ReactElement {
	// Normalize language to one we have registered; fallback to text
	const normalizedLang = language || 'text';

	return (
		<PrismLight
			style={oneDark}
			language={normalizedLang}
			PreTag="div"
			customStyle={{
				margin: 0,
				borderRadius: '0 0 6px 6px',
				fontSize: '12px',
				lineHeight: '1.5',
				...(customStyle ?? {}),
			}}
			showLineNumbers={(lineCount ?? code.split('\n').length) > 10}
			wrapLongLines={wrapLongLines}
			codeTagProps={codeTagProps}
		>
			{code}
		</PrismLight>
	);
}
