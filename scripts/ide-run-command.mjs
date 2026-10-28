// 在运行中的 dev IDE 里执行一个命令面板命令（真按键，不走 require 取命令表 ——
// dev 渲染进程里 window.require 不是 AMD require，拿不到命令注册表）。
//
// 用法：node scripts/ide-run-command.mjs --title vscode-file --text 重启Host --wait 2500
import CDP from 'chrome-remote-interface';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const port = Number(argOf('--port', '9222'));
const title = argOf('--title', 'vscode-file');
const text = argOf('--text', '');
const waitMs = Number(argOf('--wait', '2000'));

if (!text && Number(argOf('--undo', '0')) <= 0 && argOf('--click', '0') === '0') {
	console.error('用法：--text <命令面板里输入的词>（或 --undo N 做撤销模式 / --click 1 --click-x X --click-y Y 做点击）');
	process.exit(1);
}

const targets = await CDP.List({ port });
const target = targets.find(t => t.type === 'page' && t.title.includes(title));
if (!target) {
	console.error(`没找到标题含「${title}」的窗口；现有：${targets.filter(t => t.type === 'page').map(t => t.title).join(' | ')}`);
	process.exit(2);
}

const client = await CDP({ target, port });
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 按一个键（down + up）。modifiers: Alt=1 Ctrl=2 Meta=4 Shift=8 */
async function press(key, code, keyCode, modifiers = 0) {
	await client.Input.dispatchKeyEvent({
		type: 'rawKeyDown',
		key,
		code,
		windowsVirtualKeyCode: keyCode,
		nativeVirtualKeyCode: keyCode,
		modifiers,
	});
	await client.Input.dispatchKeyEvent({ type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
}

try {
	await client.Page.bringToFront();
	await sleep(300);

	// ── 点击模式：在窗口里点某个坐标（x,y，CSS 像素）──
	const clickX = Number(argOf('--click-x', '0'));
	const clickY = Number(argOf('--click-y', '0'));
	if (argOf('--click', '0') !== '0') {
		await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
		await sleep(80);
		await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
		await sleep(Number(argOf('--wait', '2000')));
		const shot2 = argOf('--shot', '');
		if (shot2) {
			const { data } = await client.Page.captureScreenshot({ format: 'png' });
			const fs = await import('node:fs');
			fs.writeFileSync(shot2, Buffer.from(data, 'base64'));
			console.log(`[ide-click] 已点击 (${clickX},${clickY})，截图 ${shot2}`);
		} else {
			console.log(`[ide-click] 已点击 (${clickX},${clickY})`);
		}
	} else {

	// ── 撤销模式：按 N 次 Ctrl+Z，并把编辑器脏状态回报出来（用于回退误输入）──
	const undoTimes = Number(argOf('--undo', '0'));
	if (undoTimes > 0) {
		for (let i = 0; i < undoTimes; i++) {
			await client.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
			await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90, modifiers: 2 });
			await sleep(250);
		}
		await sleep(600);
		const shot2 = argOf('--shot', '');
		if (shot2) {
			const { data } = await client.Page.captureScreenshot({ format: 'png' });
			const fs = await import('node:fs');
			fs.writeFileSync(shot2, Buffer.from(data, 'base64'));
			console.log(`[ide-undo] 截图已存 ${shot2}`);
		}
		const { result } = await client.Runtime.evaluate({
			returnByValue: true,
			expression: `JSON.stringify({
				dirtyTabs: Array.from(document.querySelectorAll('.tab.dirty')).map(e => e.getAttribute('aria-label') || e.textContent || ''),
				activeTab: (document.querySelector('.tab.active')||{}).textContent || '',
				lines: (document.querySelector('.view-lines')||{}).innerText ? document.querySelector('.view-lines').innerText.slice(0, 300) : ''
			})`,
		});
		console.log('[ide-undo] ' + (result.value ?? JSON.stringify(result)));
	} else {
		// Ctrl+Shift+P = 命令面板（modifiers: Ctrl(2) | Shift(8) = 10）
		// ⚠ key 字段必须是 'p'（VS Code 的键位匹配看 key+modifiers，填 code 不匹配 ⇒ 快捷键不触发、按键落到编辑器）
		await press('p', 'KeyP', 80, 10);
		await sleep(900);
		// 先截图确认**面板真的开了**（没开就别往下打字，否则会打进编辑器 ✗）
		const pre = argOf('--pre-shot', '');
		if (pre) {
			const { data } = await client.Page.captureScreenshot({ format: 'png' });
			const fs = await import('node:fs');
			fs.writeFileSync(pre, Buffer.from(data, 'base64'));
			console.log(`[ide-command] 输入前截图已存 ${pre}`);
		}
		await client.Input.insertText({ text });
		await sleep(900);
		const shot = argOf('--shot', '');
		if (shot) {
			const { data } = await client.Page.captureScreenshot({ format: 'png' });
			const fs = await import('node:fs');
			fs.writeFileSync(shot, Buffer.from(data, 'base64'));
			console.log(`[ide-command] 截图已存 ${shot}`);
		}
		if (argOf('--enter', '1') !== '0') {
			await press('Enter', 'Enter', 13, 0);
			await sleep(waitMs);
		}
		console.log(`[ide-command] 已在窗口「${target.title}」执行命令面板输入「${text}」`);
	}
	}
} finally {
	await client.close();
}
