// P2-10 固定点终检：对 src 下所有引擎文件逐一检查是否被其他文件引用
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) walk(p, out);
		else if (name.endsWith('.ts')) out.push(p);
	}
	return out;
}

const files = walk(root);
const contents = new Map(files.map(f => [f, readFileSync(f, 'utf8')]));

for (const f of files) {
	if (f.includes('__tests__') || f.endsWith('extension.ts') || f.endsWith('.d.ts')) continue;
	const name = basename(f, '.ts');
	const needle = `/${name}.js'`;
	const refs = [];
	for (const [other, text] of contents) {
		if (other === f) continue;
		if (text.includes(needle)) refs.push(other.split('src').pop());
	}
	if (refs.length === 0) console.log(`FREE ${name}`);
}
console.log('--- done ---');
