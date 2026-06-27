/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Environment Variable URL Scanner — 环境变量 URL 扫描。
 *
 * 对标 codebase-memory-mcp 的 pass_envscan.c (15KB C)。
 *
 * 功能：
 * 1. 扫描 .env, Dockerfile, *.sh, *.yaml, *.toml, *.tf, *.properties
 * 2. 提取环境变量赋值
 * 3. 过滤密钥（AWS_SECRET_ACCESS_KEY, *_TOKEN, *_PASSWORD 等）
 * 4. 提取 URL 值 → 建立 ENV_URL 边
 */

import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';

export interface EnvBinding {
	key: string;
	value: string;
	url?: string;
	filePath: string;
	lineNo: number;
	isSecret: boolean;
}

const SECRET_PATTERNS = [
	/secret/i, /password/i, /passwd/i, /token/i, /api[_-]?key/i,
	/private[_-]?key/i, /access[_-]?key/i, /credential/i,
	/AWS_SECRET/i, /JWT_SECRET/i, /DB_PASS/i,
];

const URL_REGEX = /https?:\/\/[^\s"'`]+/gi;

const ENV_FILE_EXTENSIONS = ['.env', '.env.local', '.env.production', '.env.development'];
const CONFIG_EXTENSIONS = ['.yaml', '.yml', '.toml', '.properties', '.tf', '.sh'];
const DOCKERFILE_NAMES = ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml'];

export async function scanEnvUrls(rootPath: string, fileService: IFileService): Promise<EnvBinding[]> {
	const bindings: EnvBinding[] = [];

	// Scan directory tree for env/config files
	const configFiles = await findConfigFiles(rootPath, fileService);

	for (const filePath of configFiles) {
		try {
			const content = await fileService.readFile(URI.file(filePath));
			const text = content.value.toString();
			const fileName = filePath.split(/[/\\]/).pop() || filePath;

			const fileBindings = parseEnvFile(text, filePath, fileName);
			bindings.push(...fileBindings);
		} catch { /* ignore */ }
	}

	return bindings;
}

function parseEnvFile(text: string, filePath: string, fileName: string): EnvBinding[] {
	const bindings: EnvBinding[] = [];
	const lines = text.split('\n');

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line || line.startsWith('#')) { continue; }

		// .env / .properties format: KEY=value
		let match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/i);
		if (match) {
			const key = match[1];
			let value = match[2].replace(/^["']|["']$/g, '');
			bindings.push(createBinding(key, value, filePath, i + 1));
			continue;
		}

		// Dockerfile: ENV KEY=value or ENV KEY value
		if (fileName.startsWith('Dockerfile')) {
			match = line.match(/^ENV\s+([A-Z_][A-Z0-9_]*)\s*=?\s*(.*)$/i);
			if (match) {
				bindings.push(createBinding(match[1], match[2].replace(/^["']|["']$/g, ''), filePath, i + 1));
				continue;
			}
		}

		// YAML: KEY: value
		if (fileName.endsWith('.yaml') || fileName.endsWith('.yml')) {
			match = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
			if (match) {
				bindings.push(createBinding(match[1], match[2].replace(/^["']|["']$/g, ''), filePath, i + 1));
				continue;
			}
		}

		// Shell: export KEY=value
		if (fileName.endsWith('.sh')) {
			match = line.match(/^export\s+([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
			if (match) {
				bindings.push(createBinding(match[1], match[2].replace(/^["']|["']$/g, ''), filePath, i + 1));
			}
		}
	}

	return bindings;
}

function createBinding(key: string, value: string, filePath: string, lineNo: number): EnvBinding {
	const isSecret = SECRET_PATTERNS.some(p => p.test(key));
	const urls = value.match(URL_REGEX);
	return {
		key,
		value: isSecret ? '***REDACTED***' : value,
		url: urls && urls.length > 0 ? urls[0] : undefined,
		filePath,
		lineNo,
		isSecret,
	};
}

async function findConfigFiles(rootPath: string, fileService: IFileService): Promise<string[]> {
	const results: string[] = [];
	await scanDir(URI.file(rootPath), fileService, results, 0);
	return results;
}

async function scanDir(dirUri: URI, fileService: IFileService, results: string[], depth: number): Promise<void> {
	if (depth > 15) { return; }
	try {
		const stat = await fileService.resolve(dirUri);
		if (!stat.children) { return; }
		for (const child of stat.children) {
			if (child.name.startsWith('.') && child.name !== '.env' && !child.name.startsWith('.env.')) { continue; }
			if (child.name === 'node_modules' || child.name === '.git') { continue; }
			if (child.isDirectory) {
				await scanDir(child.resource, fileService, results, depth + 1);
			} else if (child.isFile) {
				const name = child.name;
				if (ENV_FILE_EXTENSIONS.includes(name) || DOCKERFILE_NAMES.includes(name) ||
					CONFIG_EXTENSIONS.some(ext => name.endsWith(ext))) {
					results.push(child.resource.fsPath);
				}
			}
		}
	} catch { /* ignore */ }
}
