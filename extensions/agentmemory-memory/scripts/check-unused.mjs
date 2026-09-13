// P2-10: 影子模块零引用核查（import.meta.url 自定位 cwd，勿依赖 shell cwd）
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
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

const targets = process.argv.slice(2);
for (const t of targets) {
	const needle = `/${t}.js'`;
	const refs = [];
	for (const [f, text] of contents) {
		if (f.endsWith(`${t}.ts`)) continue;
		if (text.includes(needle)) refs.push(f.split('src').pop());
	}
	console.log(refs.length === 0 ? `FREE ${t}` : `REF  ${t} <= ${refs.join(', ')}`);
}
