import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { gitlabToken, parseCurlResponse, resolveCurlBin } = require('./create-release.cjs');

function releaseWithExecutor(execute) {
	const file = fileURLToPath(new URL('./create-release.cjs', import.meta.url));
	const module = { exports: {} };
	runInNewContext(fs.readFileSync(file, 'utf8'), {
		require: name => name === 'child_process' ? { execFileSync: execute } : require(name),
		module, __dirname: path.dirname(file), process, console,
	}, { filename: file });
	return module.exports;
}

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

test('curl format file preserves HTTP status and 401 Bearer fallback without command-line percent expansion', () => {
	const temporaryFiles = [];
	let calls = 0;
	const release = releaseWithExecutor((_bin, args, options) => {
		assert.equal(options.shell, false);
		assert.deepEqual(Array.from(options.stdio), ['pipe', 'pipe', 'pipe']);
		assert.equal(args[0], '-q');
		assert.ok(!args.some(value => value.includes('%{http_code}')));
		const format = args[args.indexOf('-w') + 1];
		assert.ok(format.startsWith('@'));
		const formatPath = format.slice(1);
		temporaryFiles.push(formatPath);
		assert.equal(fs.readFileSync(formatPath, 'utf8'), '\\n%{http_code}');
		const bodyPath = args[args.indexOf('--data-binary') + 1].slice(1);
		temporaryFiles.push(bodyPath);
		assert.equal(JSON.parse(fs.readFileSync(bodyPath, 'utf8')).name, '中文 & release');
		assert.equal(args.at(-1), 'https://example.test/api?tag=a&ref=b');
		calls++;
		if (calls === 1) {
			assert.ok(args.includes('PRIVATE-TOKEN: fake-token'));
			return '{"message":"Unauthorized"}\n401';
		}
		assert.ok(args.includes('Authorization: Bearer fake-token'));
		assert.ok(!args.includes('PRIVATE-TOKEN: fake-token'));
		return '{"ok":true}\n200';
	});
	const result = release.curl('POST', 'https://example.test/api?tag=a&ref=b', { headers: { 'PRIVATE-TOKEN': 'fake-token' }, json: { name: '中文 & release' }, fallbackBearer: true });
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { status: 200, data: { ok: true }, retriedWithBearer: true });
	assert.equal(calls, 2);
	assert.ok(temporaryFiles.every(file => !fs.existsSync(file)));
});

test('curl rejects invalid status and cleans request files on transport failure without leaking tokens', () => {
	const temporaryFiles = [];
	const invalid = releaseWithExecutor((_bin, args) => {
		temporaryFiles.push(args[args.indexOf('-w') + 1].slice(1));
		return '{"message":"Unauthorized"}%http_code';
	});
	assert.throws(() => invalid.curl('GET', 'https://example.test'), /no valid HTTP status/);
	const failed = releaseWithExecutor((_bin, args) => {
		temporaryFiles.push(args[args.indexOf('-w') + 1].slice(1));
		throw new Error('command failed PRIVATE-TOKEN: fake-secret');
	});
	assert.throws(() => failed.curl('GET', 'https://example.test', { headers: { 'PRIVATE-TOKEN': 'fake-secret' } }), error => {
		assert.ok(!error.message.includes('fake-secret'));
		assert.ok(error.message.includes('[redacted]'));
		return true;
	});
	assert.ok(temporaryFiles.every(file => !fs.existsSync(file)));
});

test('real subprocess stderr stays captured until authentication details are redacted', async () => {
	const modulePath = fileURLToPath(new URL('./create-release.cjs', import.meta.url));
	const code = [
		'const cp = require("node:child_process");',
		'const execute = cp.execFileSync;',
		'cp.execFileSync = (_bin, _args, options) => execute(process.execPath, ["-e", "process.stderr.write(process.argv[1]); process.exit(7);", "PRIVATE-TOKEN: fake-secret"], options);',
		'const {curl} = require(process.argv[1]);',
		'try { curl("GET", "https://example.test", {headers:{"PRIVATE-TOKEN":"fake-secret"}}); } catch (error) { console.log(error.message); }',
	].join('\n');
	const { stdout, stderr } = await promisify(execFile)(process.execPath, ['-e', code, modulePath], { encoding: 'utf8', timeout: 30000 });
	assert.ok(!stdout.includes('fake-secret'));
	assert.equal(stderr, '');
	assert.ok(stdout.includes('[redacted]'));
});

test('native curl reads status format files against a loopback HTTP server', async t => {
	const server = http.createServer((request, response) => {
		response.setHeader('Content-Type', 'application/json');
		if (request.headers.authorization === 'Bearer loopback-token') {
			response.end('{"ok":true}');
		} else {
			response.writeHead(401);
			response.end('{"message":"Unauthorized"}');
		}
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
	const modulePath = fileURLToPath(new URL('./create-release.cjs', import.meta.url));
	const url = `http://127.0.0.1:${server.address().port}/api?tag=a&ref=b`;
	const code = 'const {curl}=require(process.argv[1]); console.log(JSON.stringify(curl("GET",process.argv[2],{headers:{"PRIVATE-TOKEN":"loopback-token"},fallbackBearer:true})));';
	const env = { ...process.env };
	delete env.SAROS_CURL_BIN;
	const { stdout } = await promisify(execFile)(process.execPath, ['-e', code, modulePath, url], { env, encoding: 'utf8', timeout: 30000 });
	assert.deepEqual(JSON.parse(stdout), { status: 200, data: { ok: true }, retriedWithBearer: true });
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
