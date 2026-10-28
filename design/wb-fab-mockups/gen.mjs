import fs from 'node:fs';

export function mk(dir, name, title, lead, dl, ul, cap1, cap2) {
	const variant = String.fromCharCode(96 + parseInt(name.slice(0, 2), 10));
	const L = [];
	L.push('<!DOCTYPE html><html lang=zh-CN><head><meta charset=utf-8>');
	L.push('<title>' + title + '</title>');
	L.push('<link rel=stylesheet href=base.css><link rel=stylesheet href=variants.css>');
	L.push('</head><body>');
	L.push('<h1>' + title + '</h1>');
	L.push('<p class=lead>' + lead + '</p>');
	L.push('<div class=wrap>');
	L.push('<div class=spec>');
	L.push('<h2>' + title.split(' · ')[1] + '</h2>');
	L.push('<p class=tagline>' + lead + '</p>');
	L.push('<dl>');
	for (const kv of dl) { L.push('<dt>' + kv[0] + '</dt><dd>' + kv[1] + '</dd>'); }
	L.push('</dl>');
	L.push('<ul>');
	for (const u of ul) { L.push('<li>' + u + '</li>'); }
	L.push('</ul>');
	L.push('<a class=go href=index.html>← 看全部 6 个方案</a>');
	L.push('</div>');
	L.push('<div>');
	L.push('<div class=stage><span class=cap>' + cap1 + '</span><div data-variant=' + variant + '></div></div>');
	L.push('<div class=stage style=margin-top:30px><span class=cap>' + cap2 + '</span><div data-variant=' + variant + ' data-state=hover></div></div>');
	L.push('</div></div>');
	L.push('<script src=base.js></script>');
	L.push('</body></html>');
	fs.writeFileSync(dir + '/' + name + '.html', L.join('\n'));
	return name + '.html';
}
