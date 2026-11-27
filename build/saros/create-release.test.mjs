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
const { gitlabToken, parseCurlResponse, redactCurlDiagnostic, resolveCurlBin } = require('./create-release.cjs');

function releaseWithExecutor(execute, environment = process.env) {
	const file = fileURLToPath(new URL('./create-release.cjs', import.meta.url));
	const module = { exports: {} };
	runInNewContext(fs.readFileSync(file, 'utf8'), {
		require: name => name === 'child_process' ? { ...require(name), spawnSync: execute } : require(name),
		module, __dirname: path.dirname(file), process: { ...process, env: environment }, console, Buffer,
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

test('curl stdin format preserves HTTP status and 401 Bearer fallback without command-line percent expansion', () => {
	const temporaryFiles = [];
	let calls = 0;
	const release = releaseWithExecutor((_bin, args, options) => {
		assert.equal(options.shell, false);
		assert.deepEqual(Array.from(options.stdio), ['pipe', 'pipe', 'pipe']);
		assert.equal(args[0], '-q');
		assert.ok(!args.some(value => value.includes('%{http_code}')));
		assert.equal(args[args.indexOf('-w') + 1], '@-');
		assert.equal(options.input, '\\n%{http_code}');
		const responsePath = args[args.indexOf('-o') + 1];
		temporaryFiles.push(responsePath);
		assert.ok(path.isAbsolute(responsePath));
		const bodyPath = args[args.indexOf('--data-binary') + 1].slice(1);
		temporaryFiles.push(bodyPath);
		assert.equal(JSON.parse(fs.readFileSync(bodyPath, 'utf8')).name, '中文 & release');
		assert.equal(args.at(-1), 'https://example.test/api?tag=a&ref=b');
		calls++;
		if (calls === 1) {
			assert.ok(args.includes('PRIVATE-TOKEN: fake-token'));
			fs.writeFileSync(responsePath, '{"message":"Unauthorized"}');
			return { status: 0, stdout: '\n401', stderr: '' };
		}
		assert.ok(args.includes('Authorization: Bearer fake-token'));
		assert.ok(!args.includes('PRIVATE-TOKEN: fake-token'));
		fs.writeFileSync(responsePath, '{"ok":true}');
		return { status: 0, stdout: '\n200', stderr: '' };
	});
	const result = release.curl('POST', 'https://example.test/api?tag=a&ref=b', { headers: { 'PRIVATE-TOKEN': 'fake-token' }, json: { name: '中文 & release' }, fallbackBearer: true });
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { status: 200, data: { ok: true }, retriedWithBearer: true });
	assert.equal(calls, 2);
	assert.ok(temporaryFiles.every(file => !fs.existsSync(file)));
});

test('curl rejects invalid status and cleans request files on transport failure without leaking tokens', () => {
	const temporaryFiles = [];
	const invalid = releaseWithExecutor((_bin, args) => {
		temporaryFiles.push(args[args.indexOf('-o') + 1]);
		return { status: 0, stdout: '%http_code', stderr: 'write-out format unreadable' };
	});
	assert.throws(() => invalid.curl('GET', 'https://example.test'), /no valid HTTP status/);
	const failed = releaseWithExecutor((_bin, args) => {
		temporaryFiles.push(args[args.indexOf('-o') + 1]);
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
		'const execute = cp.spawnSync;',
		'cp.spawnSync = (_bin, _args, options) => execute(process.execPath, ["-e", "process.stderr.write(process.argv[1]); process.exit(7);", "PRIVATE-TOKEN: fake-secret"], options);',
		'const {curl} = require(process.argv[1]);',
		'try { curl("GET", "https://example.test", {headers:{"PRIVATE-TOKEN":"fake-secret"}}); } catch (error) { console.log(error.message); }',
	].join('\n');
	const { stdout, stderr } = await promisify(execFile)(process.execPath, ['-e', code, modulePath], { encoding: 'utf8', timeout: 30000 });
	assert.ok(!stdout.includes('fake-secret'));
	assert.equal(stderr, '');
	assert.ok(stdout.includes('[redacted]'));
});

test('native curl uses stdin status format against a loopback HTTP server', async t => {
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

test('native curl preserves JSON, multipart and raw uploads with spaces and Unicode paths', async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saros curl 中文-'));
	const asset = path.join(root, 'asset 中文 &.exe');
	fs.writeFileSync(asset, 'fixture asset bytes');
	const requests = [];
	const server = http.createServer((request, response) => {
		const chunks = [];
		request.on('data', chunk => chunks.push(chunk));
		request.on('end', () => {
			requests.push({ method: request.method, url: request.url, contentType: request.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') });
			response.writeHead(201, { 'Content-Type': 'application/json' });
			response.end('{"ok":true}');
		});
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(async () => { await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fs.rmSync(root, { recursive: true, force: true }); });
	const url = `http://127.0.0.1:${server.address().port}/api?tag=a&ref=b`;
	const modulePath = fileURLToPath(new URL('./create-release.cjs', import.meta.url));
	const code = [
		'const {curl}=require(process.argv[1]);',
		'const url=process.argv[2],asset=process.argv[3];',
		'const result=[curl("POST",url,{json:{name:"中文 & release"}}),curl("POST",url,{formFile:{path:asset,name:"fixture.exe"}}),curl("POST",url,{uploadFile:asset})];',
		'console.log(JSON.stringify(result));',
	].join('\n');
	const env = { ...process.env };
	delete env.SAROS_CURL_BIN;
	const { stdout } = await promisify(execFile)(process.execPath, ['-e', code, modulePath, url, asset], { env, encoding: 'utf8', timeout: 30_000 });
	assert.deepEqual(JSON.parse(stdout).map(result => result.status), [201, 201, 201]);
	assert.ok(requests.every(request => request.method === 'POST' && request.url === '/api?tag=a&ref=b'));
	assert.deepEqual(JSON.parse(requests[0].body), { name: '中文 & release' });
	assert.match(requests[1].contentType, /multipart\/form-data/);
	assert.ok(requests[1].body.includes('fixture asset bytes'));
	assert.equal(requests[2].body, 'fixture asset bytes');
});

test('resolveCurlBin：显式覆盖优先，token 环境变量也优先于本机凭据', () => {
	const custom = path.join(os.tmpdir(), 'custom-curl');
	withEnv('SAROS_CURL_BIN', custom, () => {
		assert.equal(resolveCurlBin(), custom);
	});
	withEnv('WOA_GITLAB_TOKEN', '  test-token  ', () => {
		assert.equal(gitlabToken(), 'test-token');
	});
});

test('resolveCurlBin：Windows 优先 System32 原生 curl，缺失时回退 PATH', { skip: process.platform !== 'win32' }, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saros-curl-'));
	try {
		const fallbackDir = path.join(root, 'path-curl');
		const fallback = path.join(fallbackDir, 'curl.exe');
		fs.mkdirSync(fallbackDir);
		fs.writeFileSync(fallback, '');
		withEnv('SAROS_CURL_BIN', undefined, () => withEnv('SystemRoot', root, () => withEnv('PATH', fallbackDir, () => {
			assert.equal(resolveCurlBin(), fallback);
			assert.ok(path.isAbsolute(resolveCurlBin()));
			const native = path.join(root, 'System32', 'curl.exe');
			fs.mkdirSync(path.dirname(native), { recursive: true });
			fs.writeFileSync(native, '');
			assert.equal(resolveCurlBin(), native);
		})));
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
	const localProbe = source.indexOf('if (args.checkCurl) { curlPreflight(); return; }');
	assert.ok(localProbe > 0 && localProbe < source.indexOf('const version = resolveVersion(args);'));
	assert.ok(source.indexOf('if (!args.dryRun) { curlPreflight(); }') < preflight);
});

function nativeVersion() {
	return { status: 0, stdout: 'curl 8.13.0 (Windows) libcurl/8.13.0 Schannel\nProtocols: file http https\n', stderr: '' };
}

function passLocalProbe(_binary, args, options) {
	if (args.includes('--version')) { return nativeVersion(); }
	assert.equal(args[args.indexOf('--proto') + 1], '=file');
	assert.ok(args.at(-1).startsWith('file:'));
	assert.equal(args[args.indexOf('-w') + 1], '@-');
	assert.equal(options.input, '\\n%{http_code}');
	assert.ok(!args.includes('-H'));
	fs.writeFileSync(args[args.indexOf('-o') + 1], 'curl 状态格式自检 &');
	return { status: 0, stdout: '\n000', stderr: '' };
}

test('curl preflight validates the local-only stdin transport and cleans probe files', () => {
	const files = [];
	const binary = path.join(os.tmpdir(), 'native-curl.exe');
	const release = releaseWithExecutor((bin, args, options) => {
		assert.equal(bin, binary);
		if (args.includes('-o')) { files.push(args[args.indexOf('-o') + 1]); }
		return passLocalProbe(bin, args, options);
	}, { ...process.env, SAROS_CURL_BIN: binary });
	assert.equal(release.curlPreflight().binary, binary);
	assert.ok(files.length === 1 && files.every(file => !fs.existsSync(file)));
});

test('Windows automatically skips Cygwin curl and verifies the next native candidate', { skip: process.platform !== 'win32' }, () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saros-curl-fallback-'));
	try {
		const first = path.join(root, 'cygwin', 'curl.exe');
		const second = path.join(root, 'native', 'curl.exe');
		for (const file of [first, second]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); }
		const release = releaseWithExecutor((binary, args, options) => {
			if (binary === first) { assert.ok(args.includes('--version')); return { status: 0, stdout: 'curl 8.0.0 (x86_64-pc-cygwin)\nProtocols: file http https\n', stderr: '' }; }
			assert.equal(binary, second);
			return passLocalProbe(binary, args, options);
		}, { ...process.env, SystemRoot: root, ProgramFiles: '', 'ProgramFiles(x86)': '', SAROS_CURL_BIN: '', PATH: [path.dirname(first), path.dirname(second)].join(path.delimiter) });
		assert.equal(release.curlPreflight().binary, second);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('explicit incompatible curl does not silently use a different binary', { skip: process.platform !== 'win32' }, () => {
	const release = releaseWithExecutor(() => ({ status: 0, stdout: 'curl 8.0.0 (x86_64-pc-cygwin)\nProtocols: file http https\n', stderr: '' }),
		{ ...process.env, SAROS_CURL_BIN: path.join(os.tmpdir(), 'explicit-curl.exe') });
	assert.throws(() => release.curlPreflight(), /SAROS_CURL_BIN.*原生 curl/s);
});

test('preflight catches format failures before any HTTP request', () => {
	let calls = 0;
	const release = releaseWithExecutor((_bin, args) => {
		calls++;
		if (args.includes('--version')) { return nativeVersion(); }
		assert.ok(args.at(-1).startsWith('file:'));
		return { status: 0, stdout: '%http_code', stderr: 'unsupported write-out' };
	}, { ...process.env, SAROS_CURL_BIN: path.join(os.tmpdir(), 'format-broken-curl') });
	assert.throws(() => release.curlPreflight(), /unsupported write-out/);
	assert.equal(calls, 2);
});

test('invalid HTTP output includes captured diagnostics but never retries a write', () => {
	let calls = 0;
	const release = releaseWithExecutor((_bin, args) => {
		calls++;
		fs.writeFileSync(args[args.indexOf('-o') + 1], '200');
		return { status: 0, stdout: 'broken format', stderr: 'PRIVATE-TOKEN: very-secret\nwrite-out read failed' };
	});
	assert.throws(() => release.curl('POST', 'https://example.test/?token=url-secret', { headers: { 'PRIVATE-TOKEN': 'very-secret' }, fallbackBearer: true }), error => {
		assert.match(error.message, /no valid HTTP status/);
		assert.match(error.message, /write-out read failed/);
		assert.match(error.message, /exit: 0/);
		assert.ok(!error.message.includes('very-secret') && !error.message.includes('url-secret'));
		return true;
	});
	assert.equal(calls, 1);
});

test('transport errors include curl exit codes and spawn timeout information', () => {
	const release = releaseWithExecutor(() => ({ status: 60, stdout: '000', stderr: 'SSL certificate problem', signal: null }));
	assert.throws(() => release.curl('GET', 'https://example.test'), /exit: 60.*HTTP: 000[\s\S]*SSL certificate problem/);
	const timedOut = releaseWithExecutor(() => ({ status: null, stdout: '', stderr: '', signal: 'SIGTERM', error: Object.assign(new Error('spawn timeout'), { code: 'ETIMEDOUT' }) }));
	assert.throws(() => timedOut.curl('GET', 'https://example.test'), /ETIMEDOUT/);
});

test('successful HTTP failures preserve status and body for existing permission checks', () => {
	const release = releaseWithExecutor((_bin, args) => {
		fs.writeFileSync(args[args.indexOf('-o') + 1], '{"message":"Forbidden"}');
		return { status: 0, stdout: '403', stderr: '' };
	});
	assert.deepEqual(JSON.parse(JSON.stringify(release.curl('GET', 'https://example.test'))), { status: 403, data: { message: 'Forbidden' } });
});

test('redaction handles Buffer output, authorization fallback and truncates only after removing secrets', () => {
	const text = Buffer.from('x'.repeat(1_500) + 'PRIVATE-TOKEN: very-secret\nAuthorization: Bearer very-secret\nhttps://example.test?token=url-secret\n{"secret":"json-secret"}\n' + 'y'.repeat(1_500));
	const cleaned = redactCurlDiagnostic(text, { 'PRIVATE-TOKEN': 'very-secret' });
	assert.ok(cleaned.length <= 2_000);
	for (const secret of ['very-secret', 'url-secret', 'json-secret']) { assert.ok(!cleaned.includes(secret)); }
});

test('GitLab 401 still switches headers only once and reports invalid credentials', () => {
	let calls = 0;
	const release = releaseWithExecutor((_bin, args) => {
		calls++;
		fs.writeFileSync(args[args.indexOf('-o') + 1], '{"message":"Unauthorized"}');
		return { status: 0, stdout: '401', stderr: '' };
	}, { ...process.env, WOA_GITLAB_TOKEN: 'test-token' });
	assert.throws(() => release.gitlabPreflight(), /HTTP 401/);
	assert.equal(calls, 2);
});

function releaseWithApi(handler) {
	return releaseWithExecutor((_bin, args) => {
		const method = args[args.indexOf('-X') + 1];
		const url = args.at(-1);
		assert.ok(!url.includes('/assets/links') && !url.includes('/attachments'), 'woa archives are linked from description, never reuploaded');
		const bodyIndex = args.indexOf('--data-binary');
		const json = bodyIndex >= 0 ? JSON.parse(fs.readFileSync(args[bodyIndex + 1].slice(1), 'utf8')) : undefined;
		const result = handler(method, url, json);
		fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify(result.data || {}));
		return { status: 0, stdout: `\n${result.status}`, stderr: '' };
	});
}

const releaseTag = 'v2.2.26289';
const releaseDownloads = [{ name: 'VsSarosUserSetup.exe', url: 'http://downloads.example/archive/2.2.26289/user/VsSarosUserSetup.exe' }];
const releaseDescription = ['## VsSaros ' + releaseTag, '发布记录 '.repeat(50), '### 下载', '| 平台 | 类型 | 下载 |', '|------|------|------|',
	`| Windows x64 | 用户级安装 | [${releaseDownloads[0].name}](${releaseDownloads[0].url}) (408.95 MiB) |`].join('\n');
const verifyOptions = { minDescLen: 200, minLinks: 1, expectedLinks: releaseDownloads };

test('woa v3 publishes and reruns both repositories without any assets.links support', () => {
	for (const project of ['1790708', '1764429']) {
		for (const existing of [false, true]) {
			let remote = existing ? { id: 42, tag: releaseTag, type: 'none', description: 'old tag baseline', attachments: [] } : undefined;
			const calls = [];
			const release = releaseWithApi((method, url, json) => {
				calls.push({ method, url, json });
				if (method === 'GET') { return remote ? { status: 200, data: remote } : { status: 404 }; }
				if (method === 'POST') {
					assert.equal(url, `https://git.woa.com/api/v3/projects/${project}/releases`);
					assert.ok(!Object.hasOwn(json, 'name'));
					remote = { id: 42, tag: releaseTag, type: 'release', attachments: [], description: 'created stub' };
					return { status: 201, data: remote };
				}
				assert.equal(method, 'PUT');
				assert.equal(url, `https://git.woa.com/api/v3/projects/${project}/releases/${releaseTag}`);
				remote = { ...remote, type: json.type, description: json.description };
				return { status: 200, data: remote };
			});
			assert.ok(release.upsertGitlabRelease(project, releaseTag, `VsSaros ${releaseTag}`, releaseDescription, {}).status < 300);
			assert.equal(release.verifyRelease(project, releaseTag, {}, verifyOptions).description, releaseDescription);
			release.upsertGitlabRelease(project, releaseTag, `VsSaros ${releaseTag}`, releaseDescription, {});
			release.verifyRelease(project, releaseTag, {}, verifyOptions);
			assert.equal(calls.filter(call => call.method === 'POST').length, existing ? 0 : 1);
		}
	}
});

test('release lookup permissions and malformed replies never trigger creation', () => {
	for (const response of [{ status: 403 }, { status: 500 }, { status: 200, data: { id: 0, tag: releaseTag } }, { status: 200, data: { id: 42, tag: 'wrong' } }]) {
		const release = releaseWithApi(method => { assert.equal(method, 'GET'); return response; });
		assert.throws(() => release.upsertGitlabRelease('1790708', releaseTag, 'VsSaros', releaseDescription, {}), /lookup failed/);
	}
});

test('a failed post-create PUT is propagated rather than accepting the created stub', () => {
	for (const status of [401, 403, 404, 500]) {
		const release = releaseWithApi(method => method === 'GET' ? { status: 404 }
			: method === 'POST' ? { status: 201, data: { id: 42 } } : { status });
		assert.equal(release.upsertGitlabRelease('1790708', releaseTag, 'VsSaros', releaseDescription, {}).status, status);
	}
});

test('woa release readback rejects stale links, stubs, wrong types and wrong tags', () => {
	const valid = { id: 42, tag: releaseTag, type: 'release', description: releaseDescription, attachments: [] };
	for (const data of [
		{ ...valid, description: 'created stub' },
		{ ...valid, description: releaseDescription.replace(releaseDownloads[0].url, 'https://wrong.example/file') },
		{ ...valid, description: 'long changelog '.repeat(30) },
		{ ...valid, type: 'none' },
		{ ...valid, tag: 'v2.2.26290' },
	]) {
		const release = releaseWithApi(method => { assert.equal(method, 'GET'); return { status: 200, data }; });
		assert.throws(() => release.verifyRelease('1790708', releaseTag, {}, verifyOptions));
	}
	for (const status of [401, 403, 404, 500]) {
		const release = releaseWithApi(() => ({ status }));
		assert.throws(() => release.verifyRelease('1790708', releaseTag, {}, verifyOptions), /verification failed/);
	}
});

test('PowerShell wrapper outputs UTF-8 under a legacy code page and preserves failure exit status', { skip: process.platform !== 'win32' }, async () => {
	const script = path.resolve('.ci/scripts/create-release.ps1').replace(/'/g, "''");
	for (const exitCode of [0, 7]) {
		const wrapper = [
			"$OutputEncoding = [Text.Encoding]::GetEncoding(936); [Console]::OutputEncoding = $OutputEncoding;",
			`function node { [Console]::Out.WriteLine('中文输出'); [Console]::Error.WriteLine('中文错误'); $global:LASTEXITCODE = ${exitCode} }`,
			`& '${script}' -CheckCurl`,
		].join(' ');
		const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(wrapper, 'utf16le').toString('base64')];
		try {
			const result = await promisify(execFile)('powershell.exe', args, { encoding: 'utf8', timeout: 30_000 });
			assert.equal(exitCode, 0);
			assert.ok(result.stdout.includes('中文输出'));
			assert.ok(result.stderr.includes('中文错误'));
		} catch (error) {
			if (exitCode === 0) { throw error; }
			assert.equal(error.code, 1);
			assert.ok(error.stdout.includes('中文输出'));
			assert.ok(error.stderr.includes('中文错误'));
			assert.ok(!error.stdout.includes('[OK]'));
		}
	}
});
