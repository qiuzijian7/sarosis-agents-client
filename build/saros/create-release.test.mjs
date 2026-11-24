import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { gitlabToken, parseCurlResponse, resolveCurlBin } = require('./create-release.cjs');

function withEnv(name, value, fn) {
	const previous = process.env[name];
	if (value === undefined) { delete process.env[name]; } else { process.env[name] = value; }
	try { return fn(); } finally {
		if (previous === undefined) { delete process.env[name]; } else { process.env[name] = previous; }
	}
}

test('parseCurlResponse：正常 JSON 与状态码', () => {
	assert.deepEqual(parseCurlResponse('{"ok":true}\n201'), { status: 201, data: { ok: true } });
	assert.deepEqual(parseCurlResponse('{"message":"Unauthorized"}\n401'), { status: 401, data: { message: 'Unauthorized' } });
});

test('parseCurlResponse：没有状态行时保留完整响应，不切掉最后一个字符', () => {
	const raw = '{"message":"Unauthorized"}%http_code';
	assert.deepEqual(parseCurlResponse(raw), { status: 0, data: raw });
});

test('parseCurlResponse：文本响应与空输出', () => {
	assert.deepEqual(parseCurlResponse('hello\n200'), { status: 200, data: 'hello' });
	assert.deepEqual(parseCurlResponse(''), { status: 0, data: '' });
});

test('resolveCurlBin：显式覆盖优先，token 环境变量也优先于本机凭据', () => {
	withEnv('SAROS_CURL_BIN', '/tmp/custom-curl', () => {
		assert.equal(resolveCurlBin(), '/tmp/custom-curl');
	});
	withEnv('WOA_GITLAB_TOKEN', '  test-token  ', () => {
		assert.equal(gitlabToken(), 'test-token');
	});
});

test('resolveCurlBin：Windows 优先 System32 原生 curl，缺失时回退 PATH', { skip: process.platform !== 'win32' }, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saros-curl-'));
	try {
		withEnv('SAROS_CURL_BIN', undefined, () => withEnv('SystemRoot', root, () => {
			assert.equal(resolveCurlBin(), 'curl.exe');
			const native = path.join(root, 'System32', 'curl.exe');
			fs.mkdirSync(path.dirname(native), { recursive: true });
			fs.writeFileSync(native, '');
			assert.equal(resolveCurlBin(), native);
		}));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('发布前先做 git.woa 权限预检，再允许写 tag；URL 禁用 globbing', () => {
	const source = fs.readFileSync(path.join(process.cwd(), 'build/saros/create-release.cjs'), 'utf8');
	const preflight = source.indexOf('if (!args.dryRun) { gitlabPreflight(); }');
	const ensureTag = source.indexOf('ensureGitTag(tag, args.dryRun);', preflight);
	assert.ok(preflight > 0 && ensureTag > preflight, '权限预检必须早于任何 tag 写入');
	assert.match(source, /--globoff/);
	assert.match(source, /SystemRoot.*System32.*curl\.exe/);
	assert.match(source, /require\.main === module/);
	assert.match(source, /GITHUB_TOKEN\?\.trim\(\)/, '未启用 GitHub 时不应留下无效的镜像链接');
});
