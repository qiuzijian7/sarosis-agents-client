// dump dist bundle 中 AuditSummary / getTimeline 上下文
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const text = readFileSync(join(dir, 'extension.js'), 'utf8');
for (const kw of ['AuditSummary', 'getTimeline', 'traceProvenance', 'observe']) {
	let idx = text.indexOf(kw);
	let shown = 0;
	while (idx !== -1 && shown < 3) {
		console.log(`[${kw} @${idx}] ...${text.slice(Math.max(0, idx - 100), idx + 150).replace(/\n/g, '\\n')}...\n`);
		shown++;
		idx = text.indexOf(kw, idx + 1);
	}
	if (shown === 0) console.log(`[${kw}] NOT FOUND`);
}
