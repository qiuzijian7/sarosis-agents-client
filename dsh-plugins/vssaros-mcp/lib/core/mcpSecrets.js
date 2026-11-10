// @vssaros/dsh-mcp — 远程 MCP 的**凭据仓库**（secrets 获取层第一块）。
//
// 设计要点（照上游 DS Bot `secrets.json` + `$DSH_SECRET_` 的思路，但复用本项目既有格式）：
//   · 真值只放 `<数据根>/mcp-secrets.json`（尽力 mode 600），mcp.json 里只写 `${env:MCP_<ID>_<FIELD>}`；
//   · `parseMcpServers` 不需要改：它本来就支持 `${env:VAR}`，只要在解析时把 secrets 合成的 env 传进去；
//   · 网关注册的是**原始占位符**，每次转发才解析 ⇒ 改 token 无需重启 Host（网关 401 重试也会重新解析）；
//   · 工具/日志里绝不给真值：secretView 只返回字段名与引用名。
//
// 边界：这里解决「凭据如何存放与引用」，**不解决 OAuth 获取**
// （discovery / DCR / CIMD / PKCE / device flow / refresh 尚未落地），
// 所以 mcpCatalog 里 auth=oauth 的条目仍被明确拒绝安装，不制造「装了连不上」的条目。

import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const SECRETS_FILE = 'mcp-secrets.json';
export const SECRET_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const FIELD_RE = /^[A-Za-z0-9_]{1,40}$/;
const ENV_PREFIX = 'MCP';

export const secretsPathOf = dataRoot => join(dataRoot, SECRETS_FILE);
/** mcp.json 旁边就是凭据文件（数据根），调用方不必自己拼路径。 */
export const secretsPathForMcpConfig = mcpConfigPath => join(dirname(mcpConfigPath), SECRETS_FILE);
/** 以 mcp.json 路径为锚的便捷读写（插件侧只需要知道配置路径）。 */
export const readSecretsForMcpConfig = mcpConfigPath => readSecrets(dirname(mcpConfigPath));
export const writeSecretsForMcpConfig = (mcpConfigPath, data) => writeSecrets(dirname(mcpConfigPath), data);

/** `secrets[id][field]` → 可写进 mcp.json 的 `${env:...}` 变量名。 */
export function secretEnvName(id, field) {
	const norm = value => String(value ?? '').replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
	return `${ENV_PREFIX}_${norm(id)}_${norm(field)}`;
}

/** 读凭据；文件不存在/坏 JSON 一律返回空壳（不抛，不制造新故障）。 */
export async function readSecrets(dataRoot) {
	try {
		const json = JSON.parse(await readFile(secretsPathOf(dataRoot), 'utf8'));
		if (json && typeof json === 'object' && !Array.isArray(json)
			&& json.secrets && typeof json.secrets === 'object' && !Array.isArray(json.secrets)) {
			return { version: 1, ...json, secrets: json.secrets };
		}
	} catch { /* 不存在/坏 JSON ⇒ 空壳 */ }
	return { version: 1, secrets: {} };
}

/** 落盘；Windows 上 chmod 可能无效，仍尽力设置（不因失败而中断写入）。 */
export async function writeSecrets(dataRoot, data) {
	const p = secretsPathOf(dataRoot);
	await mkdir(dirname(p), { recursive: true });
	await writeFile(p, JSON.stringify(data, null, 2), { mode: 0o600 });
	try { await chmod(p, 0o600); } catch { /* Windows / 受限 FS */ }
}

/**
 * secrets → 合成环境变量映射。`base` 通常是 process.env；secrets 优先级更高，
 * 这样 `${env:MCP_AMAP_KEY}` 一定能解析，而 parseMcpServers 与双侧镜像都不用动。
 */
export function secretsAsEnv(data, base = {}) {
	const env = { ...base };
	for (const [id, fields] of Object.entries(data?.secrets ?? {})) {
		if (!fields || typeof fields !== 'object' || Array.isArray(fields)) { continue; }
		for (const [field, value] of Object.entries(fields)) {
			if (typeof value === 'string' && value) { env[secretEnvName(id, field)] = value; }
		}
	}
	return env;
}

/** 设置/合并字段（纯函数）。value 传空串表示删除该字段；字段全空则删掉整条 id。 */
export function planSecretSet(raw, params = {}) {
	const id = String(params?.id ?? '').trim();
	if (!SECRET_ID_RE.test(id)) {
		throw new Error(`id 不合法：${id} —— 只允许字母/数字/连字符/下划线且 ≤32 字符。`);
	}
	const fields = params?.fields;
	if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length === 0) {
		throw new Error('fields 需要一个非空对象（如 {"token":"..."}）。');
	}
	const next = { version: 1, ...raw, secrets: { ...(raw?.secrets ?? {}) } };
	const current = next.secrets[id] && typeof next.secrets[id] === 'object' && !Array.isArray(next.secrets[id])
		? { ...next.secrets[id] } : {};
	for (const [key, value] of Object.entries(fields)) {
		if (!FIELD_RE.test(key)) { throw new Error(`字段名不合法：${key}`); }
		if (typeof value !== 'string') { throw new Error(`字段 ${key} 的值必须是字符串。`); }
		if (value === '') { delete current[key]; } else { current[key] = value; }
	}
	if (Object.keys(current).length === 0) { delete next.secrets[id]; }
	else { next.secrets[id] = current; }
	return { id, next };
}

/** 删除一条凭据（纯函数）；不存在时抛错，不做无操作写盘。 */
export function planSecretDelete(raw, params = {}) {
	const id = String(params?.id ?? '').trim();
	if (!SECRET_ID_RE.test(id)) { throw new Error(`id 不合法：${id}`); }
	const next = { version: 1, ...raw, secrets: { ...(raw?.secrets ?? {}) } };
	if (!next.secrets[id]) { throw new Error(`没有 ${id} 的凭据（不做无操作写盘）。`); }
	delete next.secrets[id];
	return { id, next };
}

/** 脱敏视图：只给 id、字段名、该填进 mcp.json 的 `${env:...}` 引用名，**不给值**。 */
export function secretView(raw) {
	return Object.entries(raw?.secrets ?? {}).map(([id, fields]) => {
		const keys = Object.keys(fields ?? {}).sort();
		return {
			id,
			fields: keys,
			refs: keys.map(field => '${env:' + secretEnvName(id, field) + '}'),
		};
	});
}
