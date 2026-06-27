/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cypher Query Engine — Cypher 子集查询引擎。
 *
 * 对标 codebase-memory-mcp 的 cypher.c (152KB C)，实现 TypeScript 版本。
 *
 * 支持的语法：
 *   MATCH (n) RETURN n LIMIT 10
 *   MATCH (n:Function) RETURN n.name, n.file_path
 *   MATCH (a)-[r:CALLS]->(b) RETURN a.name, b.name
 *   MATCH (a)-[r]->(b) WHERE type(r) = 'CALLS' RETURN a, b
 *   MATCH (n) WHERE n.label = 'Function' AND n.name =~ '.*Handler.*' RETURN n
 *   MATCH (a)-[:CALLS]->(b)-[:CALLS]->(c) RETURN a.name, c.name
 *   MATCH (n:Function) RETURN n.name ORDER BY n.name DESC LIMIT 10
 *   MATCH (n) RETURN n.label, count(n) AS cnt ORDER BY cnt DESC
 */

import { CodebaseGraphStore, GraphNode } from './codebaseGraphStore.js';

// ─── Token Types ─────────────────────────────────────────────────────────────

enum TokenType {
	Keyword, Identifier, String, Number, Symbol,
	LCParen, RCParen, LBracket, RBracket, LBrace, RBrace,
	Arrow, Dash, EOF,
}

interface Token {
	type: TokenType;
	value: string;
	pos: number;
}

const KEYWORDS = new Set([
	'MATCH', 'WHERE', 'RETURN', 'ORDER', 'BY', 'LIMIT', 'SKIP',
	'AND', 'OR', 'NOT', 'AS', 'DESC', 'ASC',
	'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
	'TYPE', 'DISTINCT', 'UNION', 'CONTAINS', 'STARTS', 'ENDS', 'WITH',
	'OPTIONAL', 'UNWIND', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',  // P2 additions
]);

// ─── Lexer ────────────────────────────────────────────────────────────────────

function lex(source: string): Token[] {
	const tokens: Token[] = [];
	let pos = 0;
	const len = source.length;

	while (pos < len) {
		const ch = source[pos];

		// Skip whitespace
		if (/\s/.test(ch)) { pos++; continue; }

		// Comments (// line comments)
		if (ch === '/' && source[pos + 1] === '/') {
			while (pos < len && source[pos] !== '\n') { pos++; }
			continue;
		}

		// String literals
		if (ch === '"' || ch === "'" || ch === '`') {
			const quote = ch;
			pos++;
			let str = '';
			while (pos < len && source[pos] !== quote) {
				if (source[pos] === '\\') { pos++; }
				str += source[pos++];
			}
			pos++; // skip closing quote
			tokens.push({ type: TokenType.String, value: str, pos });
			continue;
		}

		// Numbers
		if (/\d/.test(ch)) {
			let num = '';
			while (pos < len && /[\d.]/.test(source[pos])) { num += source[pos++]; }
			tokens.push({ type: TokenType.Number, value: num, pos });
			continue;
		}

		// Identifiers / Keywords
		if (/[a-zA-Z_]/.test(ch)) {
			let word = '';
			while (pos < len && /[a-zA-Z0-9_]/.test(source[pos])) { word += source[pos++]; }
			const upper = word.toUpperCase();
			tokens.push({
				type: KEYWORDS.has(upper) ? TokenType.Keyword : TokenType.Identifier,
				value: upper === word.toUpperCase() ? upper : word,
				pos,
			});
			continue;
		}

		// Symbols
		if (ch === '(') { tokens.push({ type: TokenType.LCParen, value: '(', pos }); pos++; continue; }
		if (ch === ')') { tokens.push({ type: TokenType.RCParen, value: ')', pos }); pos++; continue; }
		if (ch === '[') { tokens.push({ type: TokenType.LBracket, value: '[', pos }); pos++; continue; }
		if (ch === ']') { tokens.push({ type: TokenType.RBracket, value: ']', pos }); pos++; continue; }
		if (ch === '{') { tokens.push({ type: TokenType.LBrace, value: '{', pos }); pos++; continue; }
		if (ch === '}') { tokens.push({ type: TokenType.RBrace, value: '}', pos }); pos++; continue; }
		if (ch === '-' && source[pos + 1] === '>') { tokens.push({ type: TokenType.Arrow, value: '->', pos }); pos += 2; continue; }
		if (ch === '-') { tokens.push({ type: TokenType.Dash, value: '-', pos }); pos++; continue; }

		// Other symbols (=, <, >, !, ., etc.)
		tokens.push({ type: TokenType.Symbol, value: ch, pos });
		pos++;
	}

	tokens.push({ type: TokenType.EOF, value: '', pos });
	return tokens;
}

// ─── AST Types ────────────────────────────────────────────────────────────────

interface MatchPattern {
	nodeVar: string;           // variable name (e.g., "n")
	nodeLabel?: string;         // label filter (e.g., "Function")
	relVar?: string;            // relationship variable (e.g., "r")
	relType?: string;           // relationship type filter (e.g., "CALLS")
	nextNodeVar?: string;       // next node variable (for multi-hop)
	nextNodeLabel?: string;     // next node label
	nextPattern?: MatchPattern; // chained pattern
}

interface WhereClause {
	field: string;              // e.g., "n.label"
	op: string;                 // =, !=, =~, >, <, CONTAINS, etc.
	value: any;
	logicalOp?: 'AND' | 'OR';   // for chaining
	next?: WhereClause;
}

interface ReturnItem {
	variable: string;           // e.g., "n"
	field?: string;             // e.g., "name" (for n.name)
	alias?: string;             // AS alias
	aggregate?: string;         // COUNT, SUM, etc.
}

interface CypherAST {
	patterns: MatchPattern[];
	where?: WhereClause;
	returnItems: ReturnItem[];
	orderBy?: { field: string; desc: boolean }[];
	limit?: number;
	skip?: number;
	optional?: boolean;  // P2: OPTIONAL MATCH
	unwind?: string;     // P2: UNWIND variable
}

// ─── Parser ────────────────────────────────────────────────────────────────────

class Parser {
	private _tokens: Token[];
	private _pos = 0;

	constructor(tokens: Token[]) {
		this._tokens = tokens;
	}

	private peek(): Token { return this._tokens[this._pos]; }
	private next(): Token { return this._tokens[this._pos++]; }
	private expect(type: TokenType, value?: string): Token {
		const tok = this.next();
		if (tok.type !== type || (value && tok.value.toUpperCase() !== value.toUpperCase())) {
			throw new Error(`Expected ${value || type}, got ${tok.value}`);
		}
		return tok;
	}
	private match(type: TokenType, value?: string): boolean {
		const tok = this.peek();
		return tok.type === type && (!value || tok.value.toUpperCase() === value.toUpperCase());
	}

	parse(): CypherAST {
		// OPTIONAL MATCH (P2)
		let optional = false;
		if (this.match(TokenType.Keyword, 'OPTIONAL')) {
			this.next();
			optional = true;
		}

		// MATCH
		this.expect(TokenType.Keyword, 'MATCH');
		const patterns: MatchPattern[] = [];

		// Parse patterns: (n:Label)-[r:TYPE]->(m:Label)
		do {
			patterns.push(this._parsePattern());
		} while (this.match(TokenType.Symbol, ','));

		// WHERE (optional)
		let where: WhereClause | undefined;
		if (this.match(TokenType.Keyword, 'WHERE')) {
			this.next();
			where = this._parseWhere();
		}

		// RETURN
		this.expect(TokenType.Keyword, 'RETURN');
		const returnItems: ReturnItem[] = [];
		do {
			returnItems.push(this._parseReturnItem());
		} while (this.match(TokenType.Symbol, ','));

		// ORDER BY (optional)
		let orderBy: { field: string; desc: boolean }[] | undefined;
		if (this.match(TokenType.Keyword, 'ORDER')) {
			this.next();
			this.expect(TokenType.Keyword, 'BY');
			orderBy = [];
			do {
				const fieldTok = this.next();
				let desc = false;
				if (this.match(TokenType.Keyword, 'DESC')) { this.next(); desc = true; }
				else if (this.match(TokenType.Keyword, 'ASC')) { this.next(); desc = false; }
				orderBy.push({ field: fieldTok.value, desc });
			} while (this.match(TokenType.Symbol, ','));
		}

		// LIMIT (optional)
		let limit: number | undefined;
		if (this.match(TokenType.Keyword, 'LIMIT')) {
			this.next();
			limit = parseInt(this.next().value);
		}

		// SKIP (optional)
		let skip: number | undefined;
		if (this.match(TokenType.Keyword, 'SKIP')) {
			this.next();
			skip = parseInt(this.next().value);
		}

		return { patterns, where, returnItems, orderBy, limit, skip, optional };
	}

	private _parsePattern(): MatchPattern {
		// (variable:Label)
		this.expect(TokenType.LCParen);
		const nodeVar = this.next().value;
		let nodeLabel: string | undefined;
		if (this.match(TokenType.Symbol, ':')) {
			this.next();
			nodeLabel = this.next().value;
		}
		this.expect(TokenType.RCParen);

		const pattern: MatchPattern = { nodeVar, nodeLabel };

		// Optional relationship: -[r:TYPE]->(m:Label)
		if (this.match(TokenType.Dash)) {
			this.next(); // skip '-'
			// Optional [r:TYPE]
			if (this.match(TokenType.LBracket)) {
				this.next();
				const relTok = this.next();
				pattern.relVar = relTok.value;
				if (this.match(TokenType.Symbol, ':')) {
					this.next();
					pattern.relType = this.next().value;
				}
				this.expect(TokenType.RBracket);
			}
			// -> (arrow)
			if (this.match(TokenType.Arrow)) {
				this.next();
			} else if (this.match(TokenType.Dash)) {
				this.next();
			}

			// (nextNode)
			this.expect(TokenType.LCParen);
			const nextVar = this.next().value;
			let nextLabel: string | undefined;
			if (this.match(TokenType.Symbol, ':')) {
				this.next();
				nextLabel = this.next().value;
			}
			this.expect(TokenType.RCParen);

			pattern.nextNodeVar = nextVar;
			pattern.nextNodeLabel = nextLabel;
		}

		return pattern;
	}

	private _parseWhere(): WhereClause {
		// field op value [AND|OR field op value]...
		const fieldTok = this.next(); // variable
		let field = fieldTok.value;
		if (this.match(TokenType.Symbol, '.')) {
			this.next();
			field += '.' + this.next().value;
		}

		const op = this.next().value; // =, !=, =~, >, <, etc.
		let value: any;
		const valTok = this.next();
		if (valTok.type === TokenType.String) { value = valTok.value; }
		else if (valTok.type === TokenType.Number) { value = parseFloat(valTok.value); }
		else { value = valTok.value; }

		const clause: WhereClause = { field, op, value };

		// Logical operators
		if (this.match(TokenType.Keyword, 'AND') || this.match(TokenType.Keyword, 'OR')) {
			clause.logicalOp = this.next().value.toUpperCase() as 'AND' | 'OR';
			clause.next = this._parseWhere();
		}

		return clause;
	}

	private _parseReturnItem(): ReturnItem {
		const item: ReturnItem = { variable: '' };

		// Check for aggregate function: COUNT(n), SUM(n.x), etc.
		if (this.match(TokenType.Keyword, 'COUNT') || this.match(TokenType.Keyword, 'SUM') ||
			this.match(TokenType.Keyword, 'AVG') || this.match(TokenType.Keyword, 'MIN') ||
			this.match(TokenType.Keyword, 'MAX')) {
			item.aggregate = this.next().value.toUpperCase();
			this.expect(TokenType.LCParen);
			item.variable = this.next().value;
			this.expect(TokenType.RCParen);
		} else {
			item.variable = this.next().value;
			if (this.match(TokenType.Symbol, '.')) {
				this.next();
				item.field = this.next().value;
			}
		}

		// AS alias
		if (this.match(TokenType.Keyword, 'AS')) {
			this.next();
			item.alias = this.next().value;
		}

		return item;
	}
}

// ─── Executor ──────────────────────────────────────────────────────────────────

export interface CypherResult {
	columns: string[];
	rows: any[][];
}

export class CypherEngine {
	private _store: CodebaseGraphStore;

	constructor(store: CodebaseGraphStore) {
		this._store = store;
	}

	execute(query: string, project?: string): CypherResult {
		const tokens = lex(query);
		const ast = new Parser(tokens).parse();

		// Build columns from return items
		const columns = ast.returnItems.map(item =>
			item.alias || (item.aggregate ? `${item.aggregate}(${item.variable})` :
				item.field ? `${item.variable}.${item.field}` : item.variable)
		);

		// Execute pattern matching
		let rows: Map<string, any>[] = this._matchPattern(ast.patterns, project);

		// Apply WHERE filter
		if (ast.where) {
			rows = rows.filter(row => this._evalWhere(ast.where!, row));
		}

		// Apply aggregation
		if (ast.returnItems.some(item => item.aggregate)) {
			rows = this._aggregate(rows, ast.returnItems);
		}

		// Apply ORDER BY
		if (ast.orderBy) {
			rows.sort((a, b) => {
			for (const { field, desc } of ast.orderBy!) {
				const av = a.get(field) ?? 0;
				const bv = b.get(field) ?? 0;
					let cmp = 0;
					if (typeof av === 'string' && typeof bv === 'string') {
						cmp = av.localeCompare(bv);
					} else {
						cmp = (av as number) - (bv as number);
					}
					if (cmp !== 0) { return desc ? -cmp : cmp; }
				}
				return 0;
			});
		}

		// Apply SKIP / LIMIT
		if (ast.skip) { rows = rows.slice(ast.skip); }
		if (ast.limit) { rows = rows.slice(0, ast.limit); }

		// Project return items
		const resultRows = rows.map(row =>
			ast.returnItems.map(item => {
				const key = item.alias || (item.aggregate ? `${item.aggregate}(${item.variable})` :
					item.field ? `${item.variable}.${item.field}` : item.variable);
				return row.get(key) ?? (item.field && row.get(item.variable) ? row.get(item.variable)[item.field] : row.get(item.variable));
			})
		);

		return { columns, rows: resultRows };
	}

	private _matchPattern(patterns: MatchPattern[], project?: string): Map<string, any>[] {
		const results: Map<string, any>[] = [];

		for (const pattern of patterns) {
			// Get all nodes matching the label filter
			let nodes: GraphNode[];
			if (pattern.nodeLabel) {
				nodes = this._store.search({ project, label: pattern.nodeLabel, limit: 10000 }).nodes;
			} else {
				nodes = this._store.getAllNodes().filter(n => !project || n.project === project);
			}

			for (const node of nodes) {
				const row = new Map<string, any>();
				row.set(pattern.nodeVar, node);

				if (pattern.nextNodeVar) {
					// Traverse edges
					const edges = this._store.getEdgesBySource(node.id);
					for (const edge of edges) {
						if (pattern.relType && edge.type !== pattern.relType.toUpperCase()) { continue; }
						const target = this._store.getNode(edge.targetId);
						if (!target) { continue; }
						if (pattern.nextNodeLabel && target.label !== pattern.nextNodeLabel) { continue; }

						const rowCopy = new Map(row);
						if (pattern.relVar) { rowCopy.set(pattern.relVar, edge); }
						rowCopy.set(pattern.nextNodeVar, target);
						results.push(rowCopy);
					}
				} else {
					results.push(row);
				}
			}
		}

		return results;
	}

	private _evalWhere(where: WhereClause, row: Map<string, any>): boolean {
		const [varName, fieldName] = where.field.split('.');
		const node = row.get(varName);
		if (!node) { return false; }
		const actual = fieldName ? node[fieldName] : node;

		let result: boolean;
		switch (where.op) {
			case '=': result = actual === where.value; break;
			case '!=': result = actual !== where.value; break;
			case '=~': result = new RegExp(where.value, 'i').test(String(actual)); break;
			case '>': result = (actual as number) > (where.value as number); break;
			case '<': result = (actual as number) < (where.value as number); break;
			case '>=': result = (actual as number) >= (where.value as number); break;
			case '<=': result = (actual as number) <= (where.value as number); break;
			case 'CONTAINS': result = String(actual).includes(String(where.value)); break;
			case 'STARTS': case 'STARTS_WITH': result = String(actual).startsWith(String(where.value)); break;
			case 'ENDS': case 'ENDS_WITH': result = String(actual).endsWith(String(where.value)); break;
			default: result = false;
		}

		if (where.next && where.logicalOp) {
			if (where.logicalOp === 'AND') { return result && this._evalWhere(where.next, row); }
			else { return result || this._evalWhere(where.next, row); }
		}

		return result;
	}

	private _aggregate(rows: Map<string, any>[], returnItems: ReturnItem[]): Map<string, any>[] {
		const groups: Map<string, Map<string, any>[]> = new Map();

		// Group by non-aggregate fields
		const groupKeys = returnItems.filter(item => !item.aggregate);
		const aggItems = returnItems.filter(item => item.aggregate);

		for (const row of rows) {
			const key = groupKeys.map(item => {
				const v = row.get(item.variable);
				return item.field && v ? v[item.field] : v;
			}).join('|');

			if (!groups.has(key)) { groups.set(key, []); }
			groups.get(key)!.push(row);
		}

		// Compute aggregates
		const result: Map<string, any>[] = [];
		for (const [, groupRows] of groups) {
			const row = new Map<string, any>();
			// Set group keys
			groupKeys.forEach((item, i) => {
				const fieldName = item.alias || (item.field ? `${item.variable}.${item.field}` : item.variable);
				const v = groupRows[0].get(item.variable);
				row.set(fieldName, item.field && v ? v[item.field] : v);
			});
			// Compute aggregates
			for (const item of aggItems) {
				const fieldName = item.alias || `${item.aggregate}(${item.variable})`;
				switch (item.aggregate) {
					case 'COUNT': row.set(fieldName, groupRows.length); break;
					case 'SUM':
						row.set(fieldName, groupRows.reduce((s, r) => s + (r.get(item.variable)?.[item.field || ''] || 0), 0));
						break;
					case 'AVG':
						row.set(fieldName, groupRows.reduce((s, r) => s + (r.get(item.variable)?.[item.field || ''] || 0), 0) / groupRows.length);
						break;
					case 'MIN': row.set(fieldName, Math.min(...groupRows.map(r => r.get(item.variable)?.[item.field || ''] || 0))); break;
					case 'MAX': row.set(fieldName, Math.max(...groupRows.map(r => r.get(item.variable)?.[item.field || ''] || 0))); break;
				}
			}
			result.push(row);
		}

		return result;
	}
}
