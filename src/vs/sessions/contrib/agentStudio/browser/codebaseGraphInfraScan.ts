/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Infrastructure Scan — 基础设施即代码扫描。
 *
 * 对标 codebase-memory-mcp 的 pass_k8s.c + pass_infrascan.c。
 * 解析 Dockerfile、Kubernetes manifests、docker-compose、.env 文件，
 * 创建基础设施节点和配置关联边。
 */

import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';

export interface InfraNode {
	type: 'service' | 'deployment' | 'configmap' | 'secret' | 'namespace' | 'container' | 'volume' | 'ingress';
	name: string;
	filePath: string;
	startLine: number;
	properties: Record<string, any>;
}

export async function scanInfrastructure(
	fileService: IFileService,
	rootUri: URI
): Promise<{ nodes: InfraNode[]; edges: { source: string; target: string; type: string }[] }> {
	const nodes: InfraNode[] = [];
	const edges: { source: string; target: string; type: string }[] = [];

	// Scan for Dockerfiles
	await _scanForInfraFiles(fileService, rootUri, nodes, edges, new Set(), 0);

	return { nodes, edges };
}

async function _scanForInfraFiles(
	fileService: IFileService,
	dirUri: URI,
	nodes: InfraNode[],
	edges: { source: string; target: string; type: string }[],
	excludeDirs: Set<string>,
	depth: number
): Promise<void> {
	if (depth > 5) { return; }

	let stat;
	try { stat = await fileService.resolve(dirUri); } catch { return; }
	if (!stat.children) { return; }

	for (const child of stat.children) {
		if (excludeDirs.has(child.name) || child.name.startsWith('.')) { continue; }

		if (child.isDirectory) {
			await _scanForInfraFiles(fileService, child.resource, nodes, edges, excludeDirs, depth + 1);
		} else if (child.isFile) {
			const name = child.name.toLowerCase();

			// Dockerfile
			if (name === 'dockerfile' || name.startsWith('dockerfile.')) {
				try {
					const content = await fileService.readFile(child.resource);
					const dockerNodes = parseDockerfile(content.value.toString(), child.resource.fsPath);
					nodes.push(...dockerNodes);
				} catch { /* ignore */ }
			}

			// docker-compose
			else if (name === 'docker-compose.yml' || name === 'docker-compose.yaml') {
				try {
					const content = await fileService.readFile(child.resource);
					const composeNodes = parseDockerCompose(content.value.toString(), child.resource.fsPath);
					nodes.push(...composeNodes);
				} catch { /* ignore */ }
			}

			// K8s manifests
			else if (name.endsWith('.yml') || name.endsWith('.yaml')) {
				try {
					const content = await fileService.readFile(child.resource);
					const k8sNodes = parseK8sManifest(content.value.toString(), child.resource.fsPath);
					nodes.push(...k8sNodes);
				} catch { /* ignore */ }
			}

			// .env files
			else if (name === '.env' || name.startsWith('.env.')) {
				try {
					const content = await fileService.readFile(child.resource);
					const envNode = parseEnvFile(content.value.toString(), child.resource.fsPath);
					if (envNode) { nodes.push(envNode); }
				} catch { /* ignore */ }
			}
		}
	}
}

// ─── Dockerfile Parser ─────────────────────────────────────────────────────────

function parseDockerfile(content: string, filePath: string): InfraNode[] {
	const nodes: InfraNode[] = [];
	const lines = content.split('\n');

	let serviceName = filePath.split('/').pop()?.replace('Dockerfile', 'docker') || 'docker';

	// Container node
	const container: InfraNode = {
		type: 'container',
		name: serviceName,
		filePath,
		startLine: 1,
		properties: { baseImage: '', env: {}, ports: [], volumes: [] },
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line.startsWith('FROM ')) {
			container.properties.baseImage = line.substring(5).trim();
		} else if (line.startsWith('ENV ')) {
			const match = line.match(/^ENV\s+(\S+)\s*=\s*(.+)$/);
			if (match) { container.properties.env[match[1]] = match[2]; }
		} else if (line.startsWith('EXPOSE ')) {
			container.properties.ports.push(...line.substring(7).split(/\s+/).filter(Boolean));
		} else if (line.startsWith('VOLUME ')) {
			container.properties.volumes.push(line.substring(7).trim());
		}
	}

	nodes.push(container);
	return nodes;
}

// ─── docker-compose Parser ─────────────────────────────────────────────────────

function parseDockerCompose(content: string, filePath: string): InfraNode[] {
	const nodes: InfraNode[] = [];
	try {
		// Simple YAML parsing for services section
		const servicesMatch = content.match(/^services:\s*\n([\s\S]*?)(?=\n[a-z]|\Z)/m);
		if (servicesMatch) {
			const servicesBlock = servicesMatch[1];
			const serviceMatches = servicesBlock.matchAll(/^\s{2}(\S+):\s*\n([\s\S]*?)(?=^\s{2}\S|\Z)/gm);
			for (const match of serviceMatches) {
				const name = match[1];
				const config = match[2];
				const env: Record<string, string> = {};
				const envMatch = config.matchAll(/^\s+environment:\s*\n([\s\S]*?)(?=^\s+\S|\Z)/gm);
				for (const em of envMatch) {
					const envLines = em[1].split('\n');
					for (const line of envLines) {
						const m = line.match(/^\s+-\s+(\S+):?\s*(.*)$/);
						if (m) { env[m[1]] = m[2] || ''; }
					}
				}
				nodes.push({
					type: 'service',
					name,
					filePath,
					startLine: 1,
					properties: { env },
				});
			}
		}
	} catch { /* ignore parse errors */ }
	return nodes;
}

// ─── K8s Manifest Parser ──────────────────────────────────────────────────────

function parseK8sManifest(content: string, filePath: string): InfraNode[] {
	const nodes: InfraNode[] = [];

	// Simple YAML parsing for K8s manifests
	const apiVersionMatch = content.match(/^apiVersion:\s*(.+)$/m);
	const kindMatch = content.match(/^kind:\s*(.+)$/m);
	const nameMatch = content.match(/^\s+name:\s*(.+)$/m);

	if (kindMatch && nameMatch) {
		const kind = kindMatch[1].trim();
		const name = nameMatch[1].trim();

		const nodeTypeMap: { [key: string]: InfraNode['type'] } = {
			'Deployment': 'deployment',
			'Service': 'service',
			'ConfigMap': 'configmap',
			'Secret': 'secret',
			'Namespace': 'namespace',
			'Ingress': 'ingress',
		};

		const nodeType = nodeTypeMap[kind] || 'service';
		const node: InfraNode = {
			type: nodeType,
			name,
			filePath,
			startLine: 1,
			properties: {
				apiVersion: apiVersionMatch?.[1]?.trim() || '',
				kind,
			},
		};

		// Extract containers for Deployments
		if (kind === 'Deployment') {
			const containersMatch = content.matchAll(/image:\s*(\S+)/g);
			node.properties.containers = Array.from(containersMatch).map(m => m[1]);
		}

		// Extract data for ConfigMaps/Secrets
		if (kind === 'ConfigMap' || kind === 'Secret') {
			const dataMatch = content.match(/^data:\s*\n([\s\S]*?)(?=^---|\Z)/m);
			if (dataMatch) {
				const dataLines = dataMatch[1].split('\n');
				const data: Record<string, string> = {};
				for (const line of dataLines) {
					const m = line.match(/^\s+(\S+):\s*(.*)$/);
					if (m) { data[m[1]] = m[2]; }
				}
				node.properties.data = data;
			}
		}

		nodes.push(node);
	}

	return nodes;
}

// ─── .env Parser ───────────────────────────────────────────────────────────────

function parseEnvFile(content: string, filePath: string): InfraNode | undefined {
	const config: Record<string, string> = {};
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) { continue; }
		const match = trimmed.match(/^(\S+)=(.*)$/);
		if (match) { config[match[1]] = match[2]; }
	}

	if (Object.keys(config).length === 0) { return undefined; }

	return {
		type: 'configmap',
		name: filePath.split('/').pop() || '.env',
		filePath,
		startLine: 1,
		properties: { config },
	};
}
