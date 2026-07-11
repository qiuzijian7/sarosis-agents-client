import { type ComponentPropsWithoutRef, isValidElement, type ReactNode } from 'react';
import { PrismLight as SyntaxHighlighter, oneDark } from './prismLanguages';
import { CopyButton } from './CopyButton';
import { CsvTable } from './CsvTable';

interface CodeProps {
	className?: string;
	children?: ReactNode;
}

function extractText(node: ReactNode): string {
	if (typeof node === 'string') return node;
	if (Array.isArray(node)) return node.map(extractText).join('');
	if (isValidElement<CodeProps>(node) && node.props.children) {
		return extractText(node.props.children);
	}
	return '';
}

export function CodeBlockComponent(props: ComponentPropsWithoutRef<'pre'>): React.ReactElement {
	const { children } = props;
	if (isValidElement<CodeProps>(children)) {
		const className = children.props.className ?? '';
		const code = extractText(children.props.children).trim();
		if (/\blanguage-mermaid\b/.test(className)) {
			return (
				<div className="kb-diagram-placeholder">
					<div className="kb-diagram-label">Mermaid 图示（需安装 mermaid 依赖后启用渲染）</div>
					<pre className="kb-diagram-code">{code}</pre>
				</div>
			);
		}
		if (/\blanguage-d2\b/.test(className)) {
			return (
				<div className="kb-diagram-placeholder">
					<div className="kb-diagram-label">D2 图示（需安装 @terrastruct/d2 依赖后启用渲染）</div>
					<pre className="kb-diagram-code">{code}</pre>
				</div>
			);
		}
		if (/\blanguage-csv\b/.test(className)) return <CsvTable code={code} delimiter="," />;
		if (/\blanguage-tsv\b/.test(className)) return <CsvTable code={code} delimiter={'\t'} />;
		const lang = /\blanguage-([\w-]+)\b/.exec(className)?.[1];
		return (
			<div className="code-block-wrapper">
				{code && <CopyButton text={code} />}
				<SyntaxHighlighter language={lang} style={oneDark} PreTag="pre" CodeTag="code">
					{code}
				</SyntaxHighlighter>
			</div>
		);
	}
	return <pre {...props}>{children}</pre>;
}
