// CodeBuddy 上游客户端（**本插件自包含的一份**）
//
// 为什么自己有一份而不是复用 `vssaros-bridge/lib/codebuddy.js`：
// dsh 插件之间**没有**依赖关系（各插件只依赖 `@deepseek-ai/dsh`），
// 跨插件 import 会让打包/安装链断掉 ⇒ 这里按同一套契约重写一份。
//
// 与中转站侧 `Saros-switch/services/codebuddy/` 的关系：**协议同源**。
// 改动时两边要一起改（中转站那份是 Python，这里是 JS）。
//
// 三条必须记住的差异（踩过）：
//   ① `body.model` 是**裸 id**（`glm-5.1-ioa`），但 `X-Model-ID` 必须带 **vendor 前缀**
//      （`f/glm-5.1-ioa`）—— 少了前缀上游直接 400 `invalid_parameter_value`；
//   ② 请求体用 **gzip**（网关接受明文，但压缩更稳，IDE 侧也这么做）；
//   ③ 工具 schema 要**消毒**（网关拒 `additionalProperties` / 空 `properties`）。
import { gzipSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';

export const CODEBUDDY_DEFAULT_ENDPOINT = 'https://copilot.tencent.com';
export const CODEBUDDY_SSO_DOMAIN = 'tencent.sso.codebuddy.cn';

/**
 * token 指纹（sha256 前 12 位）—— **只用于对账**，不是凭据本身。
 *
 * 用途：目录拉不到时，能一眼看出"Host 用的 token 与磁盘上那份是不是同一份"
 * （凭据服务可能 resolve 到别的值 ⇒ 平台回 models=null ⇒ 表现为"模型数 0"）✓
 */
export function tokenFingerprint(accessToken) {
	try {
		return createHash('sha256').update(String(accessToken ?? '')).digest('hex').slice(0, 12);
	} catch {
		return '';
	}
}

const IDE_TYPE = 'VSCode';
const IDE_NAME = 'VSCode';
const IDE_VERSION = '1.122.0';
const PRODUCT_VERSION = '4.3.20019762';

/** 目录错误码（与中转站一致）。 */
export const CATALOG_ERROR_UNAVAILABLE = 'catalog_unavailable';
export const CATALOG_ERROR_NO_CREDENTIAL_CATALOG = 'no_credential_catalog';
export const CATALOG_ERROR_EMPTY = 'catalog_empty';

const IOA_MAX_SCHEMA_DEPTH = 32;
const IOA_MAX_SCHEMA_NODES = 200_000;

// ─── JWT ────────────────────────────────────────────────────────────────────

/** 解 JWT payload（不验签，只取 claims）。 */
export function decodeJwtPayload(token) {
	try {
		const parts = String(token ?? '').split('.');
		if (parts.length !== 3) { return undefined; }
		const payload = parts[1];
		const padded = payload + '=='.slice(0, (4 - payload.length % 4) % 4);
		return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
	} catch {
		return undefined;
	}
}

/** 从 JWT 的 iss 取租户 id（`.../realms/sso-<tenantId>`）。 */
export function extractTenantIdFromIss(iss) {
	const match = /\/realms\/sso-([^/]+)$/.exec(String(iss ?? ''));
	return match ? match[1] : '';
}

/**
 * 从 JWT 的 iss 取 SSO 域名（给 `X-Domain` 用）。
 * CN 站点实测是 `www.codebuddy.cn`，而 IDE 侧硬编码的是 `tencent.sso.codebuddy.cn`
 * ⇒ 优先从 token 推导，取不到才回落默认值。
 */
export function extractSsoDomainFromIss(iss, fallback = CODEBUDDY_SSO_DOMAIN) {
	const text = String(iss ?? '').trim();
	if (!text.includes('://')) { return fallback; }
	const host = text.split('://', 2)[1].split('/', 1)[0].trim();
	return host || fallback;
}

/** token 里的身份（user_id = sub，tenant/sso 域取自 iss）。 */
export function identityOf(accessToken) {
	const jwt = decodeJwtPayload(accessToken);
	const iss = typeof jwt?.iss === 'string' ? jwt.iss : '';
	return {
		userId: typeof jwt?.sub === 'string' ? jwt.sub : '',
		tenantId: extractTenantIdFromIss(iss),
		ssoDomain: extractSsoDomainFromIss(iss),
	};
}

// ─── 请求头 ────────────────────────────────────────────────────────────────

/** 身份头（所有请求都要带）。 */
export function identityHeaders(accessToken) {
	const { userId, tenantId, ssoDomain } = identityOf(accessToken);
	return {
		'Authorization': `Bearer ${accessToken}`,
		'X-IDE-Type': IDE_TYPE,
		'X-IDE-Name': IDE_NAME,
		'X-IDE-Version': IDE_VERSION,
		'X-Product-Version': PRODUCT_VERSION,
		'X-Env-ID': 'production',
		'X-User-Id': userId,
		'X-Enterprise-Id': tenantId,
		'X-Tenant-Id': tenantId,
		'X-Domain': ssoDomain,
		'X-Product': 'SaaS',
		'User-Agent': `${IDE_NAME}/${IDE_VERSION} CodeBuddy/${PRODUCT_VERSION}`,
	};
}

/** 聊天头（`/v2/chat/completions`）。 */
export function chatHeaders(accessToken, { modelId = '', vendor = '', conversationId = '' } = {}) {
	return {
		...identityHeaders(accessToken),
		'Content-Type': 'application/json',
		'Accept': 'text/event-stream',
		'X-Model-ID': vendor ? `${vendor}/${modelId}` : modelId,
		'X-Agent-Intent': 'craft',
		'X-Conversation-Id': conversationId || randomUUID(),
		'X-Conversation-Request-Id': randomUUID(),
		'X-Conversation-Message-Id': randomUUID(),
		'X-Request-Id': randomUUID(),
	};
}

// ─── 目录解析（GET /v3/config）────────────────────────────────────────────

/** 目录条目能不能当聊天模型用（对齐 IDE 的 `isChatCapableModel`）。 */
export function isChatCapableModel(model) {
	if (!model || typeof model !== 'object' || !model.id) { return false; }
	const tags = Array.isArray(model.tags) ? model.tags : [];
	if (tags.some(tag => typeof tag === 'string' && tag.includes('image'))) { return false; }
	const maxOutput = Number(model.maxOutputTokens || 0);
	if (!model.maxInputTokens && maxOutput <= 256) { return false; }
	return true;
}

function modelMetaOf(model) {
	const reasoning = (model && typeof model.reasoning === 'object' && model.reasoning) || {};
	return {
		id: String(model?.id || ''),
		name: String(model?.name || model?.id || ''),
		vendor: String(model?.vendor || ''),
		max_output_tokens: model?.maxOutputTokens || 0,
		max_input_tokens: model?.maxInputTokens || 0,
		supports_tool_call: Boolean(model?.supportsToolCall),
		supports_images: Boolean(model?.supportsImages),
		supports_reasoning: Boolean(model?.supportsReasoning),
		only_reasoning: Boolean(model?.onlyReasoning),
		temperature: model?.temperature ?? null,
		reasoning: {
			effort: String(reasoning.effort || ''),
			summary: String(reasoning.summary || ''),
		},
	};
}

/** agents 里的权威 allow-list：优先 `craft`，否则 `ask`。 */
function agentAllowList(data) {
	const agents = Array.isArray(data?.agents) ? data.agents : [];
	let fallback = [];
	for (const agent of agents) {
		if (!agent || typeof agent !== 'object') { continue; }
		const name = String(agent.name || '').trim().toLowerCase();
		const models = Array.isArray(agent.models) ? agent.models.filter(m => typeof m === 'string') : [];
		if (name === 'craft') { return models; }
		if (name === 'ask' && !fallback.length) { fallback = models; }
	}
	return fallback;
}

/**
 * 解析 `/v3/config` 的响应体。
 *
 * 三条必须分清的失败形态（**静默给空列表是最糟的**）：
 *   ① `code !== 0` 或 `data` 缺失 → 网关拒绝了；
 *   ② `data.models === null` → 该凭据在平台侧就没有目录（HTTP 200 但空）；
 *   ③ 目录存在但被过滤光了。
 */
export function parseCatalogResponse(payload) {
	let body = payload;
	if (typeof body === 'string') {
		try { body = JSON.parse(body); } catch { return { ok: false, models: [], model_meta: {}, error: CATALOG_ERROR_UNAVAILABLE, message: '响应不是合法 JSON' }; }
	}
	if (!body || typeof body !== 'object') {
		return { ok: false, models: [], model_meta: {}, error: CATALOG_ERROR_UNAVAILABLE, message: '响应结构不是对象' };
	}
	if (body.code !== 0 || !body.data || typeof body.data !== 'object') {
		return { ok: false, models: [], model_meta: {}, error: CATALOG_ERROR_UNAVAILABLE, message: String(body.msg || `code=${body.code}`) };
	}
	const rawModels = body.data.models;
	if (rawModels === null || rawModels === undefined) {
		// ★ 诊断（2026-10-28）：别让"模型数 0"变成无解释的黑洞 ⇒ 把**凭据指纹**与**平台原始响应**打出来。
		//   指纹可与磁盘 `.credentials.yaml` 里那份对账 ⇒ 能立刻分清
		//   「凭据服务给的不是同一份 token」与「平台对这份 token 确实没有目录」。
		// ⚠ 这里**不能**引用 `accessToken` / `endpoint`：它们属于外层 `listModels()` 的作用域，
		//   在本函数里是未定义变量 ⇒ 一走到这个分支就抛 `ReferenceError: accessToken is not defined`
		//   ⇒ 整个 `listModels()` 失败 ⇒ **模型数变 0**（比"没有诊断"危害大得多，踩过）。
		//   ⇒ 只打平台响应体，凭据指纹由调用方（listModels）负责。
		console.log('[vssaros-relay][catalog] 该凭据在平台侧没有模型目录（data.models=null）');
		console.log('[vssaros-relay][catalog] 平台响应前 400 字：' + JSON.stringify(body).slice(0, 400));
		return { ok: false, models: [], model_meta: {}, error: CATALOG_ERROR_NO_CREDENTIAL_CATALOG, message: '该凭据在平台侧没有模型目录（data.models=null）' };
	}
	if (!Array.isArray(rawModels)) {
		return { ok: false, models: [], model_meta: {}, error: CATALOG_ERROR_UNAVAILABLE, message: 'data.models 不是数组' };
	}
	const itemsById = new Map();
	const metaById = new Map();
	for (const item of rawModels) {
		if (!item || typeof item !== 'object') { continue; }
		const id = String(item.id || '').trim();
		if (!id || itemsById.has(id)) { continue; }
		itemsById.set(id, item);
		metaById.set(id, modelMetaOf(item));
	}
	const ordered = [];
	for (const id of agentAllowList(body.data)) {
		if (id && !ordered.includes(id)) { ordered.push(id); }
	}
	for (const id of itemsById.keys()) {
		if (!ordered.includes(id)) { ordered.push(id); }
	}
	const capable = ordered.filter(id => isChatCapableModel(itemsById.get(id)));
	if (!capable.length) {
		return { ok: false, models: [], model_meta: {}, error: CATALOG_ERROR_EMPTY, message: '模型目录为空或全部被过滤' };
	}
	const modelMeta = {};
	for (const id of capable) {
		if (metaById.has(id)) { modelMeta[id] = metaById.get(id); }
	}
	return { ok: true, models: capable, model_meta: modelMeta, error: '', message: '' };
}

/**
 * 拉取模型目录。
 * @returns {Promise<{ok:boolean, models:string[], model_meta:object, error:string, message:string}>}
 */
export async function listModels(accessToken, { endpoint = CODEBUDDY_DEFAULT_ENDPOINT, fetchImpl = fetch, signal } = {}) {
	const url = new URL('/v3/config', endpoint).toString();
	try {
		const res = await fetchImpl(url, {
			method: 'GET',
			headers: {
				...identityHeaders(accessToken),
				'Accept': 'application/json, text/plain, */*',
				'X-Requested-With': 'XMLHttpRequest',
			},
			signal,
		});
		if (!res.ok) {
			return { ok: false, models: [], model_meta: {}, error: CATALOG_ERROR_UNAVAILABLE, message: `HTTP ${res.status}` };
		}
		return parseCatalogResponse(await res.text());
	} catch (e) {
		return { ok: false, models: [], model_meta: {}, error: CATALOG_ERROR_UNAVAILABLE, message: String((e && e.message) || e) };
	}
}

// ─── 工具 schema 消毒（IOA 网关）───────────────────────────────────────────

function placeholder() {
	return {
		type: 'object',
		description: 'Omitted for IOA gateway compatibility',
		properties: {
			_omitted: { type: 'string', description: 'Original schema omitted to satisfy gateway limits' },
		},
	};
}

function isEmptyProperties(value) {
	return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

/** 只读扫描：schema 是否含网关不兼容模式或超出上限。 */
export function needsSanitize(node) {
	const seen = new Set();
	const stack = [[node, 0]];
	let count = 0;
	while (stack.length) {
		const [current, depth] = stack.pop();
		if (!current || typeof current !== 'object') { continue; }
		if (seen.has(current)) { continue; }
		seen.add(current);
		count += 1;
		if (count > IOA_MAX_SCHEMA_NODES) { return true; }
		if (depth > IOA_MAX_SCHEMA_DEPTH) { return true; }
		if (Array.isArray(current)) {
			for (const item of current) { stack.push([item, depth + 1]); }
			continue;
		}
		if ('additionalProperties' in current) { return true; }
		if (isEmptyProperties(current.properties)) { return true; }
		if (current.type === 'object' && !('properties' in current) && !('additionalProperties' in current)) { return true; }
		for (const value of Object.values(current)) {
			if (value && typeof value === 'object') { stack.push([value, depth + 1]); }
		}
	}
	return false;
}

/**
 * 把一份 JSON Schema 修成 IOA 网关能接受的样子（只克隆，不改入参）。
 * ⚠ 原节点**没有** `properties` 键时，注入的占位符必须显式补上 ——
 *   漏了就会输出「`type:object` 但没有 properties」，网关照样 400。
 */
export function sanitizeSchemaForIoaGateway(schema) {
	if (!needsSanitize(schema)) { return { schema, issues: [] }; }
	const issues = [];
	const seen = new Set();
	let count = 0;

	const normalize = (node, depth) => {
		if (!node || typeof node !== 'object') { return node; }
		if (depth > IOA_MAX_SCHEMA_DEPTH) {
			issues.push(`schema depth exceeded ${IOA_MAX_SCHEMA_DEPTH} at depth ${depth}`);
			return placeholder();
		}
		if (seen.has(node)) {
			issues.push(`circular schema reference at depth ${depth}`);
			return placeholder();
		}
		seen.add(node);
		count += 1;
		if (count > IOA_MAX_SCHEMA_NODES) {
			issues.push(`schema exceeded ${IOA_MAX_SCHEMA_NODES} nodes`);
			return placeholder();
		}
		if (Array.isArray(node)) { return node.map(item => normalize(item, depth + 1)); }
		const out = {};
		if ('additionalProperties' in node) { issues.push(`additionalProperties stripped at depth ${depth}`); }
		let outProperties = node.properties;
		let propertiesReplaced = false;
		if (isEmptyProperties(outProperties)) {
			outProperties = { _no_params: { type: 'boolean', description: 'No parameters needed' } };
			propertiesReplaced = true;
			issues.push(`empty properties replaced with _no_params at depth ${depth}`);
		}
		if (node.type === 'object' && !('properties' in node) && !('additionalProperties' in node)) {
			outProperties = {
				_freeform: {
					type: 'object',
					description: 'Arbitrary key-value pairs (freeform object)',
					properties: { _value: { type: 'string', description: 'A value (stringified)' } },
				},
			};
			propertiesReplaced = true;
			issues.push(`object without properties, injected _freeform placeholder at depth ${depth}`);
		}
		for (const [key, value] of Object.entries(node)) {
			if (key === 'additionalProperties') { continue; }
			if (key === 'properties' && propertiesReplaced) {
				out[key] = normalize(outProperties, depth + 1);
				continue;
			}
			out[key] = (value && typeof value === 'object') ? normalize(value, depth + 1) : value;
		}
		if (propertiesReplaced && !('properties' in out)) {
			out.properties = normalize(outProperties, depth + 1);
		}
		return out;
	};

	return { schema: normalize(schema, 0), issues };
}

/** 批量消毒 `tools` 数组（只处理 OpenAI function tool 形态）。 */
export function sanitizeToolsForIoaGateway(tools) {
	if (!Array.isArray(tools)) { return { tools: [], issues: [] }; }
	const sanitized = [];
	const issues = [];
	for (const tool of tools) {
		if (!tool || typeof tool !== 'object') { sanitized.push(tool); continue; }
		const fn = tool.function;
		if (!fn || typeof fn !== 'object' || fn.parameters === undefined || fn.parameters === null) {
			sanitized.push(tool);
			continue;
		}
		const result = sanitizeSchemaForIoaGateway(fn.parameters);
		for (const issue of result.issues) { issues.push(`tool=${fn.name || ''}: ${issue}`); }
		sanitized.push({ ...tool, function: { ...fn, parameters: result.schema } });
	}
	return { tools: sanitized, issues };
}

// ─── 聊天（POST /v2/chat/completions）─────────────────────────────────────

/**
 * 发起一次流式聊天，产出 SSE 的 `data:` 载荷（已剥前缀）。
 *
 * @param {string} accessToken
 * @param {object} body        OpenAI 形态的请求体（relay 下发的）
 * @param {object} [options]   { modelId, vendor, endpoint, fetchImpl, signal }
 * @returns {AsyncGenerator<string>}
 */
export async function* streamChat(accessToken, body, options = {}) {
	const {
		endpoint = CODEBUDDY_DEFAULT_ENDPOINT,
		fetchImpl = fetch,
		signal,
	} = options;
	const payload = { ...body };
	payload.stream = true;
	if (Array.isArray(payload.tools) && payload.tools.length) {
		const { tools, issues } = sanitizeToolsForIoaGateway(payload.tools);
		if (issues.length) { console.warn(`[vssaros-relay] 工具 schema 已消毒：${issues.slice(0, 3).join('; ')}`); }
		payload.tools = tools;
	}
	const modelId = options.modelId || String(payload.model || '');
	const vendor = options.vendor || '';
	const raw = Buffer.from(JSON.stringify(payload), 'utf8');
	const res = await fetchImpl(new URL('/v2/chat/completions', endpoint).toString(), {
		method: 'POST',
		headers: { ...chatHeaders(accessToken, { modelId, vendor }), 'Content-Encoding': 'gzip' },
		body: gzipSync(raw),
		signal,
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(`CodeBuddy 上游返回 HTTP ${res.status}：${String(detail).slice(0, 300)}`);
	}
	if (!res.body) { return; }
	const decoder = new TextDecoder('utf-8');
	let buffer = '';
	for await (const chunk of res.body) {
		buffer += decoder.decode(chunk, { stream: true });
		let index;
		while ((index = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (!line.startsWith('data:')) { continue; }
			const data = line.slice(5).trim();
			if (data) { yield data; }
		}
	}
	const tail = (buffer + decoder.decode()).trim();
	if (tail.startsWith('data:')) {
		const data = tail.slice(5).trim();
		if (data) { yield data; }
	}
}
