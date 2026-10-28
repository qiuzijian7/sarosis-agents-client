import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve('design/wb-fab-mockups');
const css = fs.readFileSync(path.join(dir, 'base.css'), 'utf8') + String.fromCharCode(10) + fs.readFileSync(path.join(dir, 'variants.css'), 'utf8');
const js = fs.readFileSync(path.join(dir, 'base.js'), 'utf8');

let n = 0;
for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.html'))) {
	const p = path.join(dir, f);
	let t = fs.readFileSync(p, 'utf8');
	if (t.indexOf('href=base.css') >= 0) {
		t = t.replace('<link rel=stylesheet href=base.css><link rel=stylesheet href=variants.css>', '<style>' + css + '</style>');
		t = t.replace('<link rel=stylesheet href=base.css>', '<style>' + css + '</style>');
	}
	if (t.indexOf('src=base.js') >= 0) {
		t = t.replace('<script src=base.js></script>', '<script>' + js + '</script>');
	}
	fs.writeFileSync(p, t);
	n++;
}
console.log('已把 ' + n + ' 个页面改成单文件（CSS/JS 内联）');
