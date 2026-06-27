/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tree-sitter Query Definitions — 扩展的 AST 节点映射和提取逻辑。
 *
 * 对标 codebase-memory-mcp 的 20+ 节点类型和 20+ 边类型。
 * 支持 14 种语言：TypeScript, JavaScript, Python, Go, Rust, Java, C++, C#, Ruby, PHP, TSX
 */

export type SyntaxNode = any; // tree-sitter SyntaxNode (any to avoid import issues)

// ─── AST Node Type → Graph Node Type Mapping (20+ types) ─────────────────────

export const AST_NODE_MAP: Record<string, string> = {
	// Functions (7 variants)
	'function_declaration': 'function',
	'function_definition': 'function',
	'function_item': 'function',
	'method_definition': 'function',
	'method_declaration': 'function',
	'constructor_declaration': 'function',
	'destructor_declaration': 'function',
	// Classes (5 variants)
	'class_declaration': 'class',
	'class_definition': 'class',
	'class_specifier': 'class',
	'impl_item': 'class',
	'struct_specifier': 'class',
	// Interfaces / Types (5 variants)
	'interface_declaration': 'interface',
	'type_alias_declaration': 'interface',
	'trait_item': 'interface',
	'protocol_declaration': 'interface',
	'type_declaration': 'interface',
	// Enums (3 variants)
	'enum_declaration': 'enum',
	'enum_item': 'enum',
	'enum_specifier': 'enum',
	// Variables / Constants (4 variants)
	'variable_declarator': 'variable',
	'global_variable_declaration': 'variable',
	'const_item': 'variable',
	'static_item': 'variable',
	// Modules / Namespaces (3 variants)
	'module_declaration': 'module',
	'namespace_declaration': 'module',
	'package_declaration': 'module',
};

// ─── Name Extraction ─────────────────────────────────────────────────────────

/** Extract the name from a definition node via the 'name' field. */
export function extractName(node: SyntaxNode): string | undefined {
	const nameNode = node.childForFieldName('name');
	if (nameNode) { return nameNode.text; }

	// Fallback: look for identifier/type_identifier child
	for (const child of node.children || []) {
		if (child.type === 'identifier' || child.type === 'type_identifier' || child.type === 'property_identifier') {
			return child.text;
		}
	}

	return undefined;
}

// ─── Call Expression Extraction ───────────────────────────────────────────────

/** Extract the callee name from a call expression. */
export function extractCalleeName(node: SyntaxNode): string | undefined {
	// TypeScript/JS: call_expression → function → identifier / member_expression
	const funcNode = node.childForFieldName('function');
	if (funcNode) {
		if (funcNode.type === 'identifier') {
			return funcNode.text;
		}
		if (funcNode.type === 'member_expression' || funcNode.type === 'field_expression' || funcNode.type === 'selector_expression') {
			const propNode = funcNode.childForFieldName('property') || funcNode.childForFieldName('field');
			if (propNode) { return propNode.text; }
			// Fallback: last identifier child
			for (let i = (funcNode.children || []).length - 1; i >= 0; i--) {
				const child = funcNode.children[i];
				if (child.type === 'identifier' || child.type === 'property_identifier' || child.type === 'field_identifier') {
					return child.text;
				}
			}
		}
	}

	// Python: call → function → identifier / attribute
	if (funcNode && funcNode.type === 'identifier') {
		return funcNode.text;
	}

	// Java: method_invocation → name → identifier
	const nameNode = node.childForFieldName('name');
	if (nameNode && nameNode.type === 'identifier') {
		return nameNode.text;
	}

	// Fallback: look for identifier in children
	for (const child of node.children || []) {
		if (child.type === 'identifier') { return child.text; }
	}

	return undefined;
}

// ─── Import Extraction ─────────────────────────────────────────────────────────

/** Extract imported names from an import statement. */
export function extractImportNames(node: SyntaxNode): string[] {
	const names: string[] = [];
	_collectImportNames(node, names);
	if (names.length === 0) {
		// Default import — use source module name
		const sourceNode = node.childForFieldName('source');
		if (sourceNode) {
			const source = sourceNode.text.replace(/['"]/g, '');
			const parts = source.split('/');
			names.push(parts[parts.length - 1] || source);
		}
	}
	return names;
}

function _collectImportNames(node: SyntaxNode, names: string[]): void {
	// Skip source strings
	if (node.type === 'string' || node.type === 'string_literal') { return; }

	if (node.type === 'identifier' || node.type === 'type_identifier') {
		const parent = node.parent;
		if (parent && (
			parent.type === 'import_clause' ||
			parent.type === 'import_specifier' ||
			parent.type === 'named_imports' ||
			parent.type === 'aliased_import' ||
			parent.type === 'dotted_name' ||
			parent.type === 'import_from_statement' ||
			parent.type === 'import_specifier'
		)) {
			if (!names.includes(node.text)) { names.push(node.text); }
		}
	}

	for (const child of node.children || []) {
		_collectImportNames(child, names);
	}
}

// ─── Class Hierarchy Extraction ───────────────────────────────────────────────

/** Extract inherited/implemented types from a class declaration. */
export function extractInherits(node: SyntaxNode, kind: 'extends' | 'implements'): string[] {
	const result: string[] = [];

	// TypeScript/Java: class_declaration → heritage_clause (extends/implements)
	const heritage = node.childForFieldName('heritage');
	if (heritage) {
		for (const child of heritage.children || []) {
			if (child.type === 'extends_clause' && kind === 'extends') {
				_collectTypeNames(child, result);
			} else if (child.type === 'implements_clause' && kind === 'implements') {
				_collectTypeNames(child, result);
			}
		}
	}

	// Python: class_definition → superclasses (arguments)
	if (kind === 'extends') {
		const supers = node.childForFieldName('superclasses');
		if (supers) { _collectTypeNames(supers, result); }
	}

	// C++: class_specifier → base_class_clause
	const baseClause = node.childForFieldName('base_class_clause');
	if (baseClause) { _collectTypeNames(baseClause, result); }

	// Rust: impl_item → trait (for impl Trait for Type)
	if (kind === 'implements' && node.type === 'impl_item') {
		const traitNode = node.childForFieldName('trait');
		if (traitNode) { result.push(traitNode.text); }
	}

	// Go: type_declaration → type_spec → interface type
	// Ruby: class → superclass
	const superclass = node.childForFieldName('superclass');
	if (superclass && kind === 'extends') {
		_collectTypeNames(superclass, result);
	}

	return result;
}

function _collectTypeNames(node: SyntaxNode, result: string[]): void {
	for (const child of node.children || []) {
		if (child.type === 'identifier' || child.type === 'type_identifier' || child.type === 'constant') {
			result.push(child.text);
		}
		_collectTypeNames(child, result);
	}
}

// ─── Route Extraction ─────────────────────────────────────────────────────────

export interface RouteInfo {
	method: string;
	path: string;
}

/** Extract HTTP routes (Express, Fastify, NestJS, Flask, Django). */
export function extractRoutes(node: SyntaxNode): RouteInfo[] {
	const routes: RouteInfo[] = [];
	const httpMethods = /^(get|post|put|delete|patch|head|options|use|all)$/i;

	// TypeScript/JS: app.get('/path', handler) or router.post('/path', handler)
	if (node.type === 'call_expression') {
		const funcNode = node.childForFieldName('function');
		if (funcNode && (funcNode.type === 'member_expression' || funcNode.type === 'field_expression')) {
			const propNode = funcNode.childForFieldName('property') || funcNode.childForFieldName('field');
			if (propNode && httpMethods.test(propNode.text)) {
				const args = node.childForFieldName('arguments');
				if (args) {
					for (const arg of args.children || []) {
						if (arg.type === 'string' || arg.type === 'string_literal') {
							const path = arg.text.replace(/['"`]/g, '');
							routes.push({ method: propNode.text.toUpperCase(), path });
							break;
						}
					}
				}
			}
		}
	}

	// NestJS decorator: @Get('/path'), @Post('/path')
	if (node.type === 'decorator') {
		const expr = node.childForFieldName('expression');
		if (expr && expr.type === 'call_expression') {
			const funcNode = expr.childForFieldName('function');
			if (funcNode && httpMethods.test(funcNode.text)) {
				const args = expr.childForFieldName('arguments');
				if (args) {
					for (const arg of args.children || []) {
						if (arg.type === 'string' || arg.type === 'string_literal') {
							const path = arg.text.replace(/['"`]/g, '');
							routes.push({ method: funcNode.text.toUpperCase(), path });
							break;
						}
					}
				}
			}
		}
	}

	// Recurse
	for (const child of node.children || []) {
		routes.push(...extractRoutes(child));
	}

	return routes;
}

// ─── Event Extraction ──────────────────────────────────────────────────────────

/** Extract emit/on event names (Socket.IO, EventEmitter, etc.). */
export function extractEmits(node: SyntaxNode, kind: 'emit' | 'on'): string[] {
	const result: string[] = [];
	const targetMethod = kind === 'emit' ? /^(emit|dispatch|publish)$/ : /^(on|addEventListener|subscribe)$/;

	if (node.type === 'call_expression') {
		const funcNode = node.childForFieldName('function');
		if (funcNode && (funcNode.type === 'member_expression' || funcNode.type === 'field_expression')) {
			const propNode = funcNode.childForFieldName('property') || funcNode.childForFieldName('field');
			if (propNode && targetMethod.test(propNode.text)) {
				const args = node.childForFieldName('arguments');
				if (args) {
					for (const arg of args.children || []) {
						if (arg.type === 'string' || arg.type === 'string_literal') {
							result.push(arg.text.replace(/['"`]/g, ''));
							break;
						}
					}
				}
			}
		}
	}

	for (const child of node.children || []) {
		result.push(...extractEmits(child, kind));
	}

	return result;
}

// ─── Decorator Extraction ─────────────────────────────────────────────────────

/** Extract decorator names (TypeScript/Java/Python). */
export function extractDecorators(node: SyntaxNode): string[] {
	const result: string[] = [];

	if (node.type === 'decorator') {
		const expr = node.childForFieldName('expression');
		if (expr) {
			if (expr.type === 'identifier') {
				result.push(expr.text);
			} else if (expr.type === 'call_expression') {
				const funcNode = expr.childForFieldName('function');
				if (funcNode && funcNode.type === 'identifier') {
					result.push(funcNode.text);
				}
			}
		}
	}

	// Python: decorator_line
	if (node.type === 'decorator') {
		for (const child of node.children || []) {
			if (child.type === 'identifier' || child.type === 'dotted_name') {
				result.push(child.text);
			}
		}
	}

	// Java: annotation
	if (node.type === 'annotation' || node.type === 'marker_annotation') {
		const nameNode = node.childForFieldName('name');
		if (nameNode) { result.push(nameNode.text); }
	}

	for (const child of node.children || []) {
		result.push(...extractDecorators(child));
	}

	return result;
}

// ─── Complexity Analysis ──────────────────────────────────────────────────────

export interface ComplexityResult {
	cyclomatic: number;
	loops: number;
	conditionals: number;
}

/** Compute cyclomatic complexity by counting decision points. */
export function computeComplexity(rootNode: SyntaxNode, startLine: number, endLine: number): ComplexityResult {
	let loops = 0;
	let conditionals = 0;

	const visit = (node: SyntaxNode) => {
		const line = node.startPosition?.row + 1 || 0;
		if (line < startLine || line > endLine) {
			for (const child of node.children || []) { visit(child); }
			return;
		}

		switch (node.type) {
			// Loops
			case 'for_statement': case 'for_in_statement': case 'while_statement':
			case 'do_statement': case 'for_statement': case 'enhanced_for_statement':
			case 'for_each_statement': case 'loop_expression':
				loops++; break;
			// Conditionals
			case 'if_statement': case 'conditional_expression': case 'ternary_expression':
			case 'switch_statement': case 'case_clause': case 'when_clause':
			case 'match_arm':
				conditionals++; break;
			// Logical operators
			case 'binary_expression':
				if (node.text?.includes('&&') || node.text?.includes('||')) {
					conditionals++;
				}
				break;
		}

		for (const child of node.children || []) { visit(child); }
	};

	visit(rootNode);

	return {
		cyclomatic: 1 + loops + conditionals,
		loops,
		conditionals,
	};
}
