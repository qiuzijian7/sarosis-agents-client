// @vssaros/dsh-relay 自检（进程内：不联网、不起 Host、不碰真 app）：
//   node dsh-plugins/vssaros-relay/test/run-relay-agent-check.mjs
//
// 覆盖 Node Agent 落地后的六件事（**行为级断言**，不是文本匹配）：
//   1) 随包产物在（files 覆盖 lib/agent.js、lib/codebuddy.js —— 漏打包最难发现）；
//   2) 上游请求头：`X-Model-ID` 带 vendor 前缀；`X-Domain` 从 JWT 的 iss 推导；
//   3) 工具 schema 消毒：additionalProperties 被剥、空 properties 被替换、
//      无 properties 的 object 被注入 `_freeform`（**且占位符真的写回** ——
//      Python 侧踩过：漏写回 ⇒ 消毒后仍不合法 ⇒ 网关照样 400）；
//   4) 目录解析：三种失败形态分得开（code≠0 / models=null / 全被过滤）；
//   5) 反向通道：URL 用 `?token=`（WebSocket API 不能加 header）、
//      hello/catalog 上报、invoke ⇒ chunk ⇒ invoke_end 的帧序列；
//   6) 跨层对账：凭据引用 `VSSAROS_CODEBUDDY_KEY` 与 vssaros-bridge **逐字一致**。
//
// 口径：全部用夹具（假 WebSocket / 假上游 / 假 fetch），可以钉绝对期望值。

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
	buildChannelUrl,
	createNodeAgent,
	AGENT_STATE,
} from '../lib/agent.js';
import {
	chatHeaders,
	identityHeaders,
	parseCatalogResponse,
	sanitizeSchemaForIoaGateway,
	sanitizeToolsForIoaGateway,
} from '../lib/codebuddy.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); };

/** 造一个只含 claims 的 JWT（不验签）。 */
function makeJwt(claims) {
	const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
	return `${b64({ alg: 'HS256' })}.${b64(claims)}.sig`;
}

/** 假 WebSocket：记录发出的帧，可手动投递服务端帧。 */
class FakeSocket {
	constructor(url) {
		this.url = url;
		this.sent = [];
		this.readyState = 1;
		this.closed = false;
	}
	send(text) { this.sent.push(JSON.parse(text)); }
	close() { this.closed = true; this.readyState = 3; }
	/** 服务端下发一帧。 */
	deliver(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
	frames(type) { return this.sent.filter((f) => f.t === type); }
}

// ─── 1) 随包产物 ───────────────────────────────────────────────────────────

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
for (const file of ['lib/index.js', 'lib/page.js', 'lib/agent.js', 'lib/codebuddy.js']) {
	check(`随包产物含 ${file}`, (pkg.files || []).includes(file), `files=${JSON.stringify(pkg.files)}`);
}

// ─── 2) 上游请求头 ─────────────────────────────────────────────────────────

const cnJwt = makeJwt({ sub: 'u-1', iss: 'https://www.codebuddy.cn/auth/realms/sso-tenant-9' });
const cnHeaders = identityHeaders(cnJwt);
check('X-Domain 从 iss 推导（CN 站点）', cnHeaders['X-Domain'] === 'www.codebuddy.cn', cnHeaders['X-Domain']);
check('X-Tenant-Id 从 iss 推导', cnHeaders['X-Tenant-Id'] === 'tenant-9', cnHeaders['X-Tenant-Id']);
check('X-User-Id = JWT.sub', cnHeaders['X-User-Id'] === 'u-1', cnHeaders['X-User-Id']);

const chat = chatHeaders(cnJwt, { modelId: 'glm-5.1-ioa', vendor: 'f' });
check('X-Model-ID 带 vendor 前缀', chat['X-Model-ID'] === 'f/glm-5.1-ioa', chat['X-Model-ID']);
check('X-Model-ID 缺 vendor 时退回裸 id', chatHeaders(cnJwt, { modelId: 'glm-5.1-ioa' })['X-Model-ID'] === 'glm-5.1-ioa', '');
check('Authorization 用 Bearer', chat['Authorization'] === `Bearer ${cnJwt}`, '');

// ─── 3) 工具 schema 消毒 ───────────────────────────────────────────────────

const sanitized = sanitizeSchemaForIoaGateway({
	type: 'object',
	additionalProperties: false,
	properties: {
		empty: { type: 'object', properties: {} },
		free: { type: 'object' },
		ok: { type: 'string' },
	},
});
check('additionalProperties 被剥', !('additionalProperties' in sanitized.schema), Object.keys(sanitized.schema).join(','));
check('空 properties 被替换成 _no_params', !!sanitized.schema.properties?.empty?.properties?._no_params, JSON.stringify(sanitized.schema.properties?.empty));
check('无 properties 的 object 注入 _freeform', !!sanitized.schema.properties?.free?.properties?._freeform, JSON.stringify(sanitized.schema.properties?.free));
check('合规字段原样保留', sanitized.schema.properties?.ok?.type === 'string', JSON.stringify(sanitized.schema.properties?.ok));
check('入参不被修改', sanitized.schema !== undefined, '');

const tools = sanitizeToolsForIoaGateway([{
	type: 'function',
	function: { name: 'read', parameters: { type: 'object', additionalProperties: false, properties: {} } },
}]);
check('tools 批量消毒后 parameters 合规', !!tools.tools[0].function.parameters.properties?._no_params, JSON.stringify(tools.tools[0].function.parameters));
check('tools 消毒有 issue 记录', tools.issues.length > 0, JSON.stringify(tools.issues));

// ─── 4) 目录解析的三种失败形态 ─────────────────────────────────────────────

const unavailable = parseCatalogResponse({ code: 500, msg: 'boom' });
check('code≠0 ⇒ 目录不可用', unavailable.ok === false && unavailable.error === 'catalog_unavailable', unavailable.error);
const noCatalog = parseCatalogResponse({ code: 0, data: { models: null } });
check('models=null ⇒ 该凭据无目录', noCatalog.error === 'no_credential_catalog', noCatalog.error);
const empty = parseCatalogResponse({ code: 0, data: { models: [{ id: 'pic', tags: ['image'], maxOutputTokens: 4096 }] } });
check('全被过滤 ⇒ 目录为空', empty.error === 'catalog_empty', empty.error);
const okCatalog = parseCatalogResponse({
	code: 0,
	data: {
		agents: [{ name: 'craft', models: ['glm-5.1-ioa'] }],
		models: [
			{ id: 'glm-5.1-ioa', vendor: 'f', maxOutputTokens: 40960, maxInputTokens: 200000 },
			{ id: 'tiny', maxOutputTokens: 128 },
		],
	},
});
check('allow-list 优先 + 过滤补全小模型', okCatalog.ok === true && okCatalog.models.join(',') === 'glm-5.1-ioa', JSON.stringify(okCatalog.models));
check('model_meta 带 vendor', okCatalog.model_meta?.['glm-5.1-ioa']?.vendor === 'f', JSON.stringify(okCatalog.model_meta?.['glm-5.1-ioa']));

// ─── 5) 反向通道 ───────────────────────────────────────────────────────────

const url = buildChannelUrl('http://relay.example.com:8000/', 'nd_abc', 'nt_tok');
check('通道 URL 用 ws 协议', url.startsWith('ws://relay.example.com:8000/api/nodes/nd_abc/channel'), url);
check('令牌走 query（WS 不能加 header）', url.endsWith('?token=nt_tok'), url);
const wss = buildChannelUrl('https://relay.example.com', 'nd_abc', 'nt_tok');
check('https ⇒ wss', wss.startsWith('wss://'), wss);

const sockets = [];
// ⚠ 夹具必须**就是** socket 本身（不是包一层）：Agent 会把 onopen/onmessage/send
//   直接挂在这个对象上 ⇒ 包一层就全挂错了（第一次跑就栽在这）。
globalThis.WebSocket = class extends FakeSocket {
	constructor(url) { super(url); sockets.push(this); }
};
const agent = createNodeAgent({
	getRelayUrl: () => 'http://relay.example.com:8000',
	getNode: () => ({ nodeId: 'nd_abc', nodeToken: 'nt_tok' }),
	getAccessToken: () => 'at-1',
	listModelsImpl: async () => ({ ok: true, models: ['glm-5.1-ioa'], model_meta: { 'glm-5.1-ioa': { vendor: 'f' } }, error: '' }),
	streamChatImpl: async function* () {
		yield '{"choices":[{"delta":{"content":"hi"}}]}';
		yield '{"choices":[{"finish_reason":"stop"}]}';
	},
	onState: () => { },
});
agent.start();
const sock = sockets[0];
sock.onopen?.();
await new Promise((r) => setTimeout(r, 10));

check('连接建立后状态=connected', agent.status().state === AGENT_STATE.CONNECTED, agent.status().state);
check('hello 帧已上报', sock.frames('hello').length === 1, JSON.stringify(sock.frames('hello')));
check('catalog 帧已上报', sock.frames('catalog').length === 1, JSON.stringify(sock.frames('catalog')[0]?.v?.models));
check('catalog 带模型列表', (sock.frames('catalog')[0]?.v?.models || []).includes('glm-5.1-ioa'), JSON.stringify(sock.frames('catalog')[0]?.v));

sock.deliver({ t: 'invoke', v: { request_id: 'inv_1', method: 'chat.completions', body: { model: 'glm-5.1-ioa' } } });
await new Promise((r) => setTimeout(r, 20));
const chunks = sock.frames('chunk');
check('invoke ⇒ 回传 chunk 分片', chunks.length === 2, JSON.stringify(chunks));
check('chunk 的 seq 严格递增', chunks.map((c) => c.v.seq).join(',') === '0,1', JSON.stringify(chunks.map((c) => c.v.seq)));
check('chunk 带 request_id', chunks[0]?.v?.request_id === 'inv_1', JSON.stringify(chunks[0]?.v));
const ends = sock.frames('invoke_end');
check('invoke ⇒ 有 invoke_end', ends.length === 1, JSON.stringify(ends));
check('invoke_end 状态 ok', ends[0]?.v?.status === 'ok', JSON.stringify(ends[0]?.v));

sock.deliver({ t: 'invoke', v: { request_id: 'inv_2', method: 'not-a-method', body: {} } });
await new Promise((r) => setTimeout(r, 10));
const errEnd = sock.frames('invoke_end').find((f) => f.v.request_id === 'inv_2');
check('不支持的方法 ⇒ invoke_end error', errEnd?.v?.status === 'error', JSON.stringify(errEnd?.v));

agent.stop();
check('stop 后状态=stopped', agent.status().state === AGENT_STATE.STOPPED, agent.status().state);
delete globalThis.WebSocket;

// ─── 6) 跨层对账：凭据引用逐字一致 ─────────────────────────────────────────

const bridgeCode = readFileSync(resolve(root, '..', 'vssaros-bridge', 'lib', 'codebuddy.js'), 'utf8');
const relayCode = readFileSync(join(root, 'lib', 'index.js'), 'utf8');
const bridgeRef = /CODEBUDDY_CREDENTIAL_REF\s*=\s*'([^']+)'/.exec(bridgeCode)?.[1] || '';
const relayRef = /CODEBUDDY_CREDENTIAL_REF\s*=\s*'([^']+)'/.exec(relayCode)?.[1] || '';
check('凭据引用与 vssaros-bridge 逐字一致', bridgeRef === relayRef && relayRef === 'VSSAROS_CODEBUDDY_KEY', `bridge=${bridgeRef} relay=${relayRef}`);
// 页面内联脚本在**JS 模板字符串**里 ⇒ 会被拼成一行 ⇒ 行注释会吃掉后续代码。
// ⇒ 真正该保证的不变量是「**内联脚本能被解析**」（能解析 ⇒ 没被注释吃掉）。
//   （早期版本断言「没有 // 行注释」，但那是文本规则 ⇒ 与后续维护者反复冲突 ✗
//     ⇒ 改成行为断言：解析失败才算失败。）
let pageScriptOk = false;
let pageScriptError = '';
try {
	const { renderPage } = await import(pathToFileURL(join(root, 'lib', 'page.js')).href);
	const html = renderPage({ relayUrl: 'http://relay.example.com/' });
	const match = /<script>([\s\S]*?)<\/script>/.exec(html);
	if (!match) {
		pageScriptError = '页面里没有内联脚本';
	} else {
		new Function(match[1]);
		pageScriptOk = true;
	}
} catch (e) {
	pageScriptError = String((e && e.message) || e);
}
check('页面内联脚本可解析（没被行注释吃掉）', pageScriptOk, pageScriptError);

// ─── 汇总 ──────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.ok);
for (const r of results) {
	console.log(`  ${r.ok ? '✓' : '✗'}  ${r.name}${r.ok ? '' : `  —— ${r.detail}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
