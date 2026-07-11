/* Render a ```csv / ```tsv fenced block as an HTML table. Papaparse is not
 * installed offline, so we use a small RFC-4180-ish splitter (quoted fields,
 * escaped `""`, embedded delimiters/newlines). */

function splitRow(line: string, delim: string): string[] {
	const out: string[] = [];
	let cur = '';
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (inQuotes) {
			if (ch === '"') {
				if (line[i + 1] === '"') {
					cur += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				cur += ch;
			}
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === delim) {
			out.push(cur);
			cur = '';
		} else {
			cur += ch;
		}
	}
	out.push(cur);
	return out;
}

export function CsvTable({ code, delimiter }: { code: string; delimiter: string }): React.ReactElement {
	const lines = code.split(/\r?\n/).filter((l) => l.length > 0);
	if (lines.length === 0) return <pre>{code}</pre>;
	const rows = lines.map((l) => splitRow(l, delimiter));
	const head = rows[0];
	const body = rows.slice(1);
	return (
		<div className="kb-csv-table-wrap">
			<table className="kb-csv-table">
				<thead>
					<tr>
						{head.map((c, i) => (
							<th key={i}>{c}</th>
						))}
					</tr>
				</thead>
				<tbody>
					{body.map((r, ri) => (
						<tr key={ri}>
							{r.map((c, ci) => (
								<td key={ci}>{c}</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
