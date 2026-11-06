// vssaros-browser：本机地址免审批（core/localPolicy.js）与截图参数（core/screenshot.js）。
// 运行：node dsh-plugins/vssaros-browser/test/local-policy.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_PAGE_OPS, isLocalUrl, isLoopbackHost, localExemptionOf } from '../lib/core/localPolicy.js';
import { normalizeScreenshotParams, screenshotText } from '../lib/core/screenshot.js';

let pass = 0;
const fail = [];
const check = (name, fn) => { try { fn(); pass += 1; } catch (error) { fail.push(`${name} → ${error.message}`); } };

check('本机主机名：localhost / *.localhost / 127.x / ::1；其余都不是', () => {
	for (const host of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) { assert.equal(isLoopbackHost(host), true, host); }
	for (const host of ['', 'localhost.evil.com', '127.0.0.1.nip.io', '10.0.0.1', '192.168.1.2', '0.0.0.0', 'example.com']) { assert.equal(isLoopbackHost(host), false, host); }
});
check('本机地址：只认 http(s)', () => {
	assert.equal(isLocalUrl('http://localhost:5173/'), true);
	assert.equal(isLocalUrl('https://127.0.0.1:8443/a?b'), true);
	assert.equal(isLocalUrl('http://[::1]:3000'), true);
	assert.equal(isLocalUrl('file:///C:/a.html'), false);
	assert.equal(isLocalUrl('http://localhost@evil.com/'), false, 'userinfo 伪装');
	assert.equal(isLocalUrl('https://example.com/?u=http://localhost'), false);
	assert.equal(isLocalUrl('not a url'), false);
});
check('免审批判定：navigate 看目标、点击输入看当前页；back / login / evaluate 等不免；askLocal 关掉', () => {
	assert.match(localExemptionOf('navigate', { url: 'http://localhost:5173' }, ''), /navigate/);
	assert.equal(localExemptionOf('navigate', { url: 'https://github.com' }, 'http://localhost:5173'), undefined, '从本机页去外部站点要问');
	for (const op of LOCAL_PAGE_OPS) {
		assert.ok(localExemptionOf(op, {}, 'http://127.0.0.1:5173/#/timer'), op);
		assert.equal(localExemptionOf(op, {}, 'https://mail.example.com/'), undefined, op);
		assert.equal(localExemptionOf(op, {}, ''), undefined, `${op}：读不到当前页 ⇒ 照常问`);
	}
	for (const op of ['back', 'reset', 'login', 'cookies', 'storage', 'evaluate']) {
		assert.equal(localExemptionOf(op, { url: 'http://localhost' }, 'http://localhost'), undefined, op);
	}
	assert.equal(localExemptionOf('navigate', { url: 'http://localhost' }, '', { askLocal: true }), undefined);
	assert.equal(localExemptionOf('click', {}, 'http://localhost', { askLocal: true }), undefined);
});
check('截图参数与文案', () => {
	assert.deepEqual(normalizeScreenshotParams({}), { quality: 70, fullPage: false });
	assert.deepEqual(normalizeScreenshotParams({ quality: 5, fullPage: true }), { quality: 30, fullPage: true });
	assert.deepEqual(normalizeScreenshotParams({ quality: 200 }), { quality: 90, fullPage: false });
	assert.match(screenshotText({ url: 'http://localhost:5173', title: '番茄钟', width: 1280, height: 720, attached: true }), /「番茄钟」 http:\/\/localhost:5173（可视区域 1280×720）。图片在下面/);
	assert.match(screenshotText({ attached: false }), /没有附件服务/);
});
check('接线：审批前先查本机地址，截图走附件、不内联 base64，截图不是动作类', () => {
	const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'index.js'), 'utf8');
	const consent = src.slice(src.indexOf('const requestConsent = async'), src.indexOf('// ④ 逐次问'));
	assert.ok(consent.indexOf('localExemptionOf(') > 0 && consent.indexOf('localExemptionOf(') < consent.indexOf('allowRules.match'), '本机判定在规则与逐次询问之前');
	assert.match(src, /attachments\.saveImage\(\{ mediaType: 'image\/jpeg'/);
	assert.match(src, /blocks\.push\(\{ type: 'image', attachment: value\.attachment \}\)/);
	const actionOps = /const ACTION_OPS = \[([^\]]*)\]/.exec(src)?.[1] ?? '';
	assert.ok(!actionOps.includes('screenshot'));
	assert.match(src, /'screenshot',\s*\n\];/);
});

console.log(`local-policy: ${pass} passed${fail.length ? `, ${fail.length} failed` : ''}`);
for (const line of fail) { console.log(`  ✗ ${line}`); }
if (fail.length) { process.exitCode = 1; }
