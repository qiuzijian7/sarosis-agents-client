// 重载运行中的 dev IDE 主窗口（让扩展宿主重新加载刚构建的 dist/extension.cjs.js）。
//
// 用法：node scripts/reload-dev-ide.mjs [--port 9222] [--title "Saroasis harness"]
//
// ⚠ 安全约束：**只重载匹配的某一个窗口**，且要求还有别的窗口存在
//   （只有一个窗口时 Page.reload 可能触发 window-all-closed ⇒ 整个 app 退出）。
import CDP from 'chrome-remote-interface';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const port = Number(argOf('--port', '9222'));
const title = argOf('--title', 'Saroasis harness');

const targets = await CDP.List({ port });
const pages = targets.filter(t => t.type === 'page');
console.log(`[reload] CDP ${port} 上有 ${pages.length} 个 page：`);
for (const p of pages) {
	console.log(`   · ${p.id}  ${p.title}`);
}

if (pages.length < 2) {
	console.error(`[reload] 只有 ${pages.length} 个窗口 ⇒ 拒绝重载（重载最后一个窗口可能让整个 app 退出）`);
	process.exit(2);
}

const target = pages.find(p => p.title.includes(title));
if (!target) {
	console.error(`[reload] 没找到标题含「${title}」的窗口`);
	process.exit(3);
}

const client = await CDP({ target, port });
try {
	await client.Page.enable();
	await client.Page.reload({ ignoreCache: false });
	console.log(`[reload] 已重载窗口「${target.title}」（${target.url}）`);
	const shot = args.includes('--shot') ? args[args.indexOf('--shot') + 1] : '';
	if (shot) {
		await new Promise(r => setTimeout(r, 4000));
		const { data } = await client.Page.captureScreenshot({ format: 'png' });
		const fs = await import('node:fs');
		fs.writeFileSync(shot, Buffer.from(data, 'base64'));
		console.log(`[reload] 截图已存 ${shot}`);
	}
} finally {
	await client.close();
}
