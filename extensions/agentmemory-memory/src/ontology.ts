/*---------------------------------------------------------------------------------------------
 *  G4: 本体引导解析 — 对齐 cognee modules/ontology
 *  G5: Memify 图谱丰富化 — 对齐 cognee modules/memify + tasks/memify
 *
 *  OntologyConfig: 定义实体类型和关系类型，指导 LLM 提取
 *  MemifyPipeline: 多 pass 图谱增强 (dedup → merge → refine → infer)
 *--------------------------------------------------------------------------------------------*/

// ─── G4: Ontology ─────────────────────────────────────────────────────

export interface OntologyEntity {
	type: string;           // e.g. "Person", "Project", "Tool", "Concept"
	properties?: string[];   // e.g. ["name", "version", "author"]
}

export interface OntologyRelation {
	type: string;           // e.g. "uses", "depends_on", "created_by"
	sourceType: string;     // e.g. "Project"
	targetType: string;     // e.g. "Tool"
}

export interface OntologyConfig {
	name: string;
	entities: OntologyEntity[];
	relations: OntologyRelation[];
}

/** 默认软件开发本体 */
export const DEFAULT_SOFTWARE_ONTOLOGY: OntologyConfig = {
	name: 'Software Development',
	entities: [
		{ type: 'Project', properties: ['name', 'language', 'framework'] },
		{ type: 'Module', properties: ['name', 'path'] },
		{ type: 'Function', properties: ['name', 'signature'] },
		{ type: 'Concept', properties: ['name', 'description'] },
		{ type: 'Tool', properties: ['name', 'version'] },
		{ type: 'Pattern', properties: ['name', 'description'] },
		{ type: 'Error', properties: ['type', 'message'] },
	],
	relations: [
		{ type: 'depends_on', sourceType: 'Module', targetType: 'Module' },
		{ type: 'uses', sourceType: 'Project', targetType: 'Tool' },
		{ type: 'implements', sourceType: 'Function', targetType: 'Pattern' },
		{ type: 'causes', sourceType: 'Error', targetType: 'Function' },
		{ type: 'related_to', sourceType: 'Concept', targetType: 'Concept' },
	],
};

/**
 * 生成 ontology 引导的 LLM prompt
 */
export function buildOntologyPrompt(ontology: OntologyConfig): string {
	const entityList = ontology.entities
		.map(e => `  - ${e.type}${e.properties ? ` (properties: ${e.properties.join(', ')})` : ''}`)
		.join('\n');
	const relationList = ontology.relations
		.map(r => `  - ${r.sourceType} --[${r.type}]--> ${r.targetType}`)
		.join('\n');

	return `Extract entities and relationships using the following ontology:

## Entity Types
${entityList}

## Relationship Types
${relationList}

Return as XML:
<entities>
  <entity type="Project" name="..." >
    <prop name="language">TypeScript</prop>
  </entity>
</entities>
<relations>
  <relation type="uses" source="ProjectName" target="ToolName" />
</relations>

Only extract entities and relations that match the ontology above.`;
}

// ─── G5: Memify Pipeline ──────────────────────────────────────────────

export interface MemifyEntity {
	id: string;
	type: string;
	name: string;
	properties: Record<string, unknown>;
}

export interface MemifyRelation {
	id: string;
	type: string;
	source: string;
	target: string;
}

export interface MemifyGraph {
	entities: MemifyEntity[];
	relations: MemifyRelation[];
}

export interface MemifyResult {
	graph: MemifyGraph;
	passes: Array<{ name: string; changes: number; details: string }>;
}

/**
 * G5: Memify 多 pass 丰富化管道
 * 对齐 cognee memify pipeline: dedup → merge → refine → infer
 */
export class MemifyPipeline {
	private _ontPrompts: string[] = [];

	constructor(ontology?: OntologyConfig) {
		if (ontology) {
			this._ontPrompts.push(buildOntologyPrompt(ontology));
		}
	}

	/**
	 * 执行完整 memify 管道
	 */
	async memify(input: MemifyGraph): Promise<MemifyResult> {
		const passes: MemifyResult['passes'] = [];
		let graph = { ...input, entities: [...input.entities], relations: [...input.relations] };

		// Pass 1: Dedup — 去重实体 (相同 type+name)
		const before = graph.entities.length;
		graph = this._dedupPass(graph);
		const dedupRemoved = before - graph.entities.length;
		passes.push({
			name: 'dedup',
			changes: dedupRemoved,
			details: `Removed ${dedupRemoved} duplicate entities`,
		});

		// Pass 2: Merge — 合并同名实体的属性
		const beforeProps = graph.entities.reduce((s, e) => s + Object.keys(e.properties).length, 0);
		graph = this._mergePass(graph);
		const afterProps = graph.entities.reduce((s, e) => s + Object.keys(e.properties).length, 0);
		passes.push({
			name: 'merge',
			changes: afterProps - beforeProps,
			details: `Merged ${afterProps - beforeProps} properties`,
		});

		// Pass 3: Refine — 精化关系 (移除自引用、重复边)
		const beforeRels = graph.relations.length;
		graph = this._refinePass(graph);
		const refineRemoved = beforeRels - graph.relations.length;
		passes.push({
			name: 'refine',
			changes: refineRemoved,
			details: `Removed ${refineRemoved} invalid/duplicate relations`,
		});

		// Pass 4: Infer — 推理传递关系 (A→B, B→C ⇒ A→C for depends_on)
		const beforeInfer = graph.relations.length;
		graph = this._inferPass(graph);
		const inferAdded = graph.relations.length - beforeInfer;
		passes.push({
			name: 'infer',
			changes: inferAdded,
			details: `Inferred ${inferAdded} transitive relations`,
		});

		return { graph, passes };
	}

	/** Pass 1: 去重 — 相同 type+name 的实体只保留一个 */
	private _dedupPass(graph: MemifyGraph): MemifyGraph {
		const seen = new Map<string, MemifyEntity>();
		for (const e of graph.entities) {
			const key = `${e.type}::${e.name.toLowerCase()}`;
			if (!seen.has(key)) {
				seen.set(key, e);
			}
		}
		const entityIds = new Set(Array.from(seen.values()).map(e => e.id));
		return {
			entities: Array.from(seen.values()),
			relations: graph.relations.filter(r => entityIds.has(r.source) && entityIds.has(r.target)),
		};
	}

	/** Pass 2: 合并 — 合并同名实体的属性 */
	private _mergePass(graph: MemifyGraph): MemifyGraph {
		const byKey = new Map<string, MemifyEntity[]>();
		for (const e of graph.entities) {
			const key = `${e.type}::${e.name.toLowerCase()}`;
			if (!byKey.has(key)) byKey.set(key, []);
			byKey.get(key)!.push(e);
		}
		const merged: MemifyEntity[] = [];
		for (const [, group] of byKey) {
			if (group.length === 1) {
				merged.push(group[0]);
			} else {
				const props: Record<string, unknown> = {};
				for (const e of group) {
					Object.assign(props, e.properties);
				}
				merged.push({ ...group[0], properties: props });
			}
		}
		return { entities: merged, relations: graph.relations };
	}

	/** Pass 3: 精化 — 移除自引用 + 重复边 */
	private _refinePass(graph: MemifyGraph): MemifyGraph {
		const seen = new Set<string>();
		const filtered = graph.relations.filter(r => {
			if (r.source === r.target) return false; // 自引用
			const key = `${r.source}::${r.type}::${r.target}`;
			if (seen.has(key)) return false; // 重复
			seen.add(key);
			return true;
		});
		return { entities: graph.entities, relations: filtered };
	}

	/** Pass 4: 推理 — 传递关系推理 (A depends_on B, B depends_on C ⇒ A depends_on C) */
	private _inferPass(graph: MemifyGraph): MemifyGraph {
		const TRANSITIVE_TYPES = ['depends_on', 'related_to', 'uses'];
		const newRelations: MemifyRelation[] = [];
		const existingKeys = new Set(graph.relations.map(r => `${r.source}::${r.type}::${r.target}`));

		for (const ttype of TRANSITIVE_TYPES) {
			const edges = graph.relations.filter(r => r.type === ttype);
			// 构建邻接表
			const adj = new Map<string, string[]>();
			for (const e of edges) {
				if (!adj.has(e.source)) adj.set(e.source, []);
				adj.get(e.source)!.push(e.target);
			}
			// 对每个节点做 BFS (深度 2) 查找传递关系
			for (const [src, targets] of adj) {
				for (const mid of targets) {
					const midTargets = adj.get(mid) ?? [];
					for (const tgt of midTargets) {
						if (tgt === src) continue; // 避免环
						const key = `${src}::${ttype}::${tgt}`;
						if (!existingKeys.has(key)) {
							existingKeys.add(key);
							newRelations.push({
								id: `inferred-${src}-${ttype}-${tgt}-${Date.now()}`,
								type: ttype,
								source: src,
								target: tgt,
							});
						}
					}
				}
			}
		}

		return {
			entities: graph.entities,
			relations: [...graph.relations, ...newRelations],
		};
	}
}
