import type { IFrontmatter } from '../frontmatter';

function formatValue(v: unknown): string {
	if (Array.isArray(v)) return v.map(formatValue).join(', ');
	if (v !== null && typeof v === 'object') {
		// Nested mapping already flattened into rows; render as `k: v` inline.
		return Object.entries(v as Record<string, unknown>)
			.map(([k, val]) => `${k}: ${formatValue(val)}`)
			.join(', ');
	}
	if (v === null || v === undefined) return '';
	return String(v);
}

/** Flatten nested mappings into `parent.child` rows so every scalar gets its
 * own table line (matches the "flatten nested mapping" goal). */
function flattenRows(
	data: Record<string, unknown>,
	prefix: string,
	rows: [string, unknown][],
): void {
	for (const [k, v] of Object.entries(data)) {
		const key = prefix ? `${prefix}.${k}` : k;
		if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
			flattenRows(v as Record<string, unknown>, key, rows);
		} else {
			rows.push([key, v]);
		}
	}
}

export function FrontmatterBlock({ data }: { data: IFrontmatter }): React.ReactElement {
	const rows: [string, unknown][] = [];
	flattenRows(data.data, '', rows);
	if (rows.length === 0) return <></>;
	return (
		<details className="kb-frontmatter" open>
			<summary>Frontmatter</summary>
			<table>
				<tbody>
					{rows.map(([k, v]) => (
						<tr key={k}>
							<td className="kb-fm-key">{k}</td>
							<td className="kb-fm-val">{formatValue(v)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</details>
	);
}
