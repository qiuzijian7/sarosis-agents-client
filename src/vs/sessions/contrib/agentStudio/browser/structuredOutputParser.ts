/*---------------------------------------------------------------------------------------------
 *  Structured AI Output Parser
 *
 *  Replaces the fragile _parseAiResponseToPlanTasks() method with a
 *  schema-driven approach. Instead of 4 ad-hoc JSON extraction strategies
 *  + manual field normalization, we define the expected output schema
 *  declaratively and validate/normalize against it.
 *
 *  Design:
 *  1. Schema definition via ISchemaField descriptors
 *  2. Multi-strategy JSON extraction (retained but simplified)
 *  3. Schema validation with detailed error reporting
 *  4. Field normalization with alias mapping
 *  5. Default value injection for missing fields
 *
 *  This is Effect Schema-inspired but implemented without external deps.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../../platform/log/common/log.js';

// ─── Schema Types ─────────────────────────────────────────────────────────

export type SchemaFieldType = 'string' | 'number' | 'boolean' | 'array' | 'object';

export interface ISchemaField {
	/** Field name — the canonical name */
	readonly name: string;
	/** Field type */
	readonly type: SchemaFieldType;
	/** Alternative names the AI might use (e.g., "task_id" → "id") */
	readonly aliases?: string[];
	/** Default value if the field is missing */
	readonly default?: unknown;
	/** Whether this field is required */
	readonly required?: boolean;
	/** For array type: schema of array items */
	readonly items?: ISchemaField;
	/** For object type: nested schema */
	readonly properties?: ISchemaField[];
	/** Min value for numbers, min length for strings/arrays */
	readonly min?: number;
	/** Max value for numbers, max length for strings/arrays */
	readonly max?: number;
	/** Validation function */
	readonly validate?: (value: unknown) => boolean;
}

export interface ISchema {
	/** Schema name for error reporting */
	readonly name: string;
	/** Top-level fields */
	readonly fields: ISchemaField[];
}

export interface IValidationResult<T> {
	/** Whether validation succeeded */
	readonly success: boolean;
	/** The validated and normalized data */
	readonly data: T;
	/** Validation errors (empty if success) */
	readonly errors: IValidationError[];
}

export interface IValidationError {
	readonly path: string;
	readonly message: string;
	readonly value?: unknown;
}

// ─── Task Decomposition Schema ────────────────────────────────────────────

/**
 * Schema for the AI task decomposition response.
 * This is the single source of truth for what the AI should output.
 */
export const TASK_DECOMPOSITION_SCHEMA: ISchema = {
	name: 'TaskDecomposition',
	fields: [
		{
			name: 'tasks',
			type: 'array',
			required: true,
			aliases: ['subtasks', 'items', 'steps'],
			items: {
				name: 'task',
				type: 'object',
				properties: [
					{
						name: 'id',
						type: 'string',
						required: true,
						aliases: ['task_id', 'taskId', 'key', 'number'],
						default: '',
						min: 1,
					},
					{
						name: 'title',
						type: 'string',
						required: true,
						aliases: ['task_name', 'taskName', 'name', 'summary'],
						default: 'Untitled Task',
						min: 1,
					},
					{
						name: 'description',
						type: 'string',
						required: false,
						aliases: ['task_description', 'taskDescription', 'desc', 'detail', 'details'],
						default: '',
					},
					{
						name: 'suggestedRole',
						type: 'string',
						required: false,
						aliases: ['role', 'required_role', 'requiredRole', 'agent_role', 'agentRole'],
						default: 'Software Developer',
					},
					{
						name: 'suggestedAssignee',
						type: 'string',
						required: false,
						aliases: ['assignee', 'owner', 'agent', 'assigned_to', 'assignedTo'],
						default: '',
					},
					{
						name: 'dependencies',
						type: 'array',
						required: false,
						aliases: ['depends_on', 'dependsOn', 'deps', 'prerequisites', 'after'],
						default: [],
						items: { name: 'dep', type: 'string' },
					},
					{
						name: 'priority',
						type: 'number',
						required: false,
						aliases: ['priority_level', 'priorityLevel', 'urgency'],
						default: 2,
						min: 0,
						max: 10,
					},
				],
			},
		},
	],
};

// ─── Structured Output Parser ─────────────────────────────────────────────

export class StructuredOutputParser {

	constructor(private readonly logService: ILogService) { }

	/**
	 * Parse AI response string into structured data using the provided schema.
	 *
	 * Steps:
	 * 1. Extract JSON from the response (multiple strategies)
	 * 2. Parse JSON
	 * 3. Normalize field names (alias → canonical)
	 * 4. Validate against schema
	 * 5. Apply defaults for missing fields
	 */
	parse<T>(aiResponse: string, schema: ISchema): IValidationResult<T> {
		this.logService.info(`[StructuredOutput] Parsing response for schema "${schema.name}", length=${aiResponse.length}`);

		// Step 1: Extract JSON
		const jsonStr = this._extractJson(aiResponse);
		if (!jsonStr) {
			return this._fail<T>('root', 'Could not extract JSON from AI response', aiResponse.substring(0, 200));
		}

		// Step 2: Parse JSON
		let parsed: unknown;
		try {
			parsed = JSON.parse(jsonStr);
		} catch (e) {
			// Try to fix common issues
			const fixed = this._tryFixJson(jsonStr);
			if (fixed) {
				parsed = fixed;
			} else {
				return this._fail<T>('root', `JSON parse error: ${e instanceof Error ? e.message : String(e)}`, jsonStr.substring(0, 200));
			}
		}

		// Step 3-5: Normalize, validate, apply defaults
		const errors: IValidationError[] = [];
		const normalized = this._normalizeAndValidate(parsed, schema, '', errors);

		return {
			success: errors.length === 0 || errors.every(e => !e.path.includes('required')), // Allow non-critical errors
			data: normalized as T,
			errors,
		};
	}

	/**
	 * Parse specifically for the task decomposition schema.
	 * Returns the normalized tasks array directly.
	 */
	parseTaskDecomposition(aiResponse: string): {
		tasks: Array<{
			id: string;
			title: string;
			description: string;
			suggestedRole: string;
			suggestedAssignee: string;
			dependencies: string[];
			priority: number;
		}>;
		errors: IValidationError[];
	} {
		const result = this.parse<{ tasks: Array<Record<string, unknown>> }>(aiResponse, TASK_DECOMPOSITION_SCHEMA);

		if (!result.data.tasks || !Array.isArray(result.data.tasks)) {
			return {
				tasks: [],
				errors: [...result.errors, { path: 'tasks', message: 'No tasks array found in response' }],
			};
		}

		// Map each task to the expected format
		const tasks = result.data.tasks.map((raw, index) => {
			const task = raw as Record<string, unknown>;
			return {
				id: this._asString(task.id, `T${index + 1}`),
				title: this._asString(task.title, `Task ${index + 1}`),
				description: this._asString(task.description, ''),
				suggestedRole: this._asString(task.suggestedRole, 'Software Developer'),
				suggestedAssignee: this._asString(task.suggestedAssignee, ''),
				dependencies: this._asStringArray(task.dependencies),
				priority: this._asNumber(task.priority, 2),
			};
		});

		return { tasks, errors: result.errors };
	}

	// ─── JSON Extraction Strategies ────────────────────────────────────────

	private _extractJson(aiResponse: string): string | null {
		// Strategy 1: Markdown code block ```json ... ```
		// Limit search to first 4096 chars to avoid catastrophic backtracking
		const searchHead = aiResponse.substring(0, 4096);
		const mdMatch = searchHead.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
		if (mdMatch) {
			this.logService.info('[StructuredOutput] Strategy 1: Extracted from markdown code block');
			return mdMatch[1].trim();
		}

		// Strategy 2: Response starts with JSON object/array (possibly after preamble)
		const trimmed = aiResponse.trim();
		// Skip common AI preamble text like "Sure! Here's the JSON:" or "Here is the plan:"
		const jsonStartMatch = trimmed.match(/[\[{]/);
		if (jsonStartMatch && jsonStartMatch.index !== undefined && jsonStartMatch.index < 200) {
			const startIdx = jsonStartMatch.index;
			const endIdx = this._findMatchingBracket(trimmed, startIdx);
			if (endIdx !== -1) {
				this.logService.info('[StructuredOutput] Strategy 2: Found JSON near start of response');
				return trimmed.substring(startIdx, endIdx + 1);
			}
		}

		// Strategy 3: Find first { ... } or [ ... ] pair anywhere
		const firstBrace = aiResponse.indexOf('{');
		const firstBracket = aiResponse.indexOf('[');
		const startIdx = firstBrace === -1 ? firstBracket :
			firstBracket === -1 ? firstBrace :
				Math.min(firstBrace, firstBracket);

		if (startIdx !== -1) {
			const endIdx = this._findMatchingBracket(aiResponse, startIdx);
			if (endIdx !== -1) {
				this.logService.info('[StructuredOutput] Strategy 3: Found JSON by bracket matching');
				return aiResponse.substring(startIdx, endIdx + 1);
			}
		}

		// Strategy 4: Search for known schema keys and extract enclosing object
		const knownKeys = ['"tasks"', '"subtasks"', '"phases"', '"items"'];
		for (const key of knownKeys) {
			const keyIdx = aiResponse.indexOf(key);
			if (keyIdx !== -1) {
				// Find the enclosing JSON object by searching backwards for '{'
				// and forwards for the matching '}'
				const objStart = aiResponse.lastIndexOf('{', keyIdx);
				if (objStart !== -1) {
					const objEnd = this._findMatchingBracket(aiResponse, objStart);
					if (objEnd !== -1) {
						this.logService.info(`[StructuredOutput] Strategy 4: Found JSON by key "${key}"`);
						return aiResponse.substring(objStart, objEnd + 1);
					}
				}
			}
		}

		return null;
	}

	/**
	 * Find the matching closing bracket for the first opening bracket.
	 */
	private _findMatchingBracket(text: string, startIdx: number = 0): number {
		let depth = 0;
		let inString = false;
		let escape = false;

		for (let i = startIdx; i < text.length; i++) {
			const ch = text[i];

			if (escape) {
				escape = false;
				continue;
			}

			if (ch === '\\' && inString) {
				escape = true;
				continue;
			}

			if (ch === '"') {
				inString = !inString;
				continue;
			}

			if (inString) { continue; }

			if (ch === '{' || ch === '[') { depth++; }
			if (ch === '}' || ch === ']') {
				depth--;
				if (depth === 0) { return i; }
			}
		}

		return -1;
	}

	/**
	 * Try to fix common JSON issues produced by AI models.
	 * Handles: trailing commas, comments, single quotes, unescaped
	 * newlines in strings, Python-style booleans, and missing quotes
	 * around keys.
	 */
	private _tryFixJson(jsonStr: string): unknown | null {
		let fixed = jsonStr;

		try {
			// Fix 1: Remove trailing commas before } or ]
			fixed = fixed.replace(/,\s*([}\]])/g, '$1');
			try { return JSON.parse(fixed); } catch { /* continue */ }

			// Fix 2: Remove single-line and multi-line comments
			fixed = fixed.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
			try { return JSON.parse(fixed); } catch { /* continue */ }

			// Fix 3: Replace single quotes with double quotes
			// (careful not to replace escaped single quotes inside strings)
			fixed = fixed.replace(/(?<!\\)'([^']*?)(?<!\\)'/g, '"$1"');
			try { return JSON.parse(fixed); } catch { /* continue */ }

			// Fix 4: Replace Python-style booleans (True/False → true/false)
			fixed = fixed.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');
			try { return JSON.parse(fixed); } catch { /* continue */ }

			// Fix 5: Unescaped newlines inside string values
			// Replace raw newlines that appear between double quotes
			fixed = this._escapeNewlinesInStrings(fixed);
			try { return JSON.parse(fixed); } catch { /* continue */ }

			// Fix 6: Unquoted keys (e.g., {name: "foo"} → {"name": "foo"})
			fixed = fixed.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');
			try { return JSON.parse(fixed); } catch { /* continue */ }
		} catch { /* all fixes failed */ }

		return null;
	}

	/**
	 * Escape raw newlines that appear inside double-quoted string values.
	 */
	private _escapeNewlinesInStrings(text: string): string {
		let result = '';
		let inString = false;
		let escape = false;

		for (let i = 0; i < text.length; i++) {
			const ch = text[i];

			if (escape) {
				result += ch;
				escape = false;
				continue;
			}

			if (ch === '\\' && inString) {
				result += ch;
				escape = true;
				continue;
			}

			if (ch === '"') {
				inString = !inString;
				result += ch;
				continue;
			}

			if (inString && (ch === '\n' || ch === '\r')) {
				result += ch === '\n' ? '\\n' : '\\r';
				continue;
			}

			result += ch;
		}

		return result;
	}

	// ─── Schema Normalization & Validation ─────────────────────────────────

	private _normalizeAndValidate(
		data: unknown,
		schema: ISchema | ISchemaField,
		path: string,
		errors: IValidationError[],
	): unknown {
		if (typeof data !== 'object' || data === null) {
			if ('required' in schema && schema.required) {
				errors.push({ path, message: `Expected object, got ${typeof data}`, value: data });
			}
			return this._applyDefault(schema as ISchemaField);
		}

		const obj = data as Record<string, unknown>;
		const fields = 'fields' in schema ? schema.fields : 'properties' in schema ? (schema as ISchemaField).properties : [];
		const result: Record<string, unknown> = {};

		for (const field of fields || []) {
			// Resolve value: check canonical name first, then aliases
			let value = obj[field.name];
			let foundViaAlias: string | undefined;

			if (value === undefined && field.aliases) {
				for (const alias of field.aliases) {
					if (obj[alias] !== undefined) {
						value = obj[alias];
						foundViaAlias = alias;
						break;
					}
				}
			}

			if (foundViaAlias) {
				this.logService.info(`[StructuredOutput] Normalized field: ${foundViaAlias} → ${field.name}`);
			}

			const fieldPath = path ? `${path}.${field.name}` : field.name;

			if (value === undefined) {
				if (field.required && field.default === undefined) {
					errors.push({ path: fieldPath, message: `Required field "${field.name}" is missing` });
				}
				result[field.name] = this._applyDefault(field);
				continue;
			}

			// Type coercion & validation
			result[field.name] = this._validateField(value, field, fieldPath, errors);
		}

		// Handle the special "phases" → "tasks" unwrapping
		if ('tasks' in result === false && 'phases' in obj && Array.isArray(obj.phases)) {
			this.logService.info('[StructuredOutput] Unwrapping phases structure into flat tasks array');
			const allTasks: unknown[] = [];
			for (const phase of obj.phases) {
				if (typeof phase === 'object' && phase !== null && 'tasks' in phase && Array.isArray((phase as Record<string, unknown>).tasks)) {
					allTasks.push(...(phase as Record<string, unknown>).tasks as unknown[]);
				}
			}
			result.tasks = allTasks;
		}

		return result;
	}

	private _validateField(value: unknown, field: ISchemaField, path: string, errors: IValidationError[]): unknown {
		// Type check
		if (!this._checkType(value, field.type)) {
			// Try type coercion
			const coerced = this._tryCoerce(value, field.type);
			if (coerced !== undefined) {
				value = coerced;
			} else {
				errors.push({
					path,
					message: `Expected ${field.type}, got ${typeof value}`,
					value,
				});
				return this._applyDefault(field);
			}
		}

		// Array items validation
		if (field.type === 'array' && Array.isArray(value) && field.items) {
			value = value.map((item, i) => {
				const itemPath = `${path}[${i}]`;
				if (field.items!.type === 'object' && field.items!.properties) {
					return this._normalizeAndValidate(item, field.items!, itemPath, errors);
				}
				return this._validateField(item, field.items!, itemPath, errors);
			});
		}

		// Object properties validation
		if (field.type === 'object' && typeof value === 'object' && value !== null && field.properties) {
			value = this._normalizeAndValidate(value, field, path, errors);
		}

		// Range validation
		if (field.type === 'number' && typeof value === 'number') {
			let numValue: number = value;
			if (field.min !== undefined && numValue < field.min) {
				errors.push({ path, message: `Value ${numValue} is less than minimum ${field.min}`, value: numValue });
				numValue = field.min;
			}
			if (field.max !== undefined && numValue > field.max) {
				errors.push({ path, message: `Value ${numValue} exceeds maximum ${field.max}`, value: numValue });
				numValue = field.max;
			}
			value = numValue;
		}

		// String length validation
		if (field.type === 'string' && typeof value === 'string') {
			if (field.min !== undefined && value.length < field.min) {
				errors.push({ path, message: `String length ${value.length} is less than minimum ${field.min}`, value });
			}
		}

		// Custom validation
		if (field.validate && !field.validate(value)) {
			errors.push({ path, message: `Custom validation failed`, value });
		}

		return value;
	}

	private _checkType(value: unknown, type: SchemaFieldType): boolean {
		switch (type) {
			case 'string': return typeof value === 'string';
			case 'number': return typeof value === 'number';
			case 'boolean': return typeof value === 'boolean';
			case 'array': return Array.isArray(value);
			case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
		}
	}

	private _tryCoerce(value: unknown, type: SchemaFieldType): unknown {
		switch (type) {
			case 'number':
				if (typeof value === 'string') {
					const num = Number(value);
					if (!isNaN(num)) { return num; }
				}
				break;
			case 'string':
				if (typeof value === 'number' || typeof value === 'boolean') {
					return String(value);
				}
				break;
			case 'array':
				if (typeof value === 'string') {
					// Try to parse as JSON array
					try {
						const parsed = JSON.parse(value);
						if (Array.isArray(parsed)) { return parsed; }
					} catch { /* not a JSON string */ }
				}
				break;
		}
		return undefined;
	}

	private _applyDefault(field: ISchemaField): unknown {
		if (field.default !== undefined) { return field.default; }
		switch (field.type) {
			case 'string': return '';
			case 'number': return 0;
			case 'boolean': return false;
			case 'array': return [];
			case 'object': return {};
		}
	}

	private _fail<T>(path: string, message: string, value?: unknown): IValidationResult<T> {
		return {
			success: false,
			data: {} as T,
			errors: [{ path, message, value }],
		};
	}

	// ─── Type-safe value extraction helpers ────────────────────────────────

	private _asString(value: unknown, fallback: string): string {
		if (typeof value === 'string' && value.length > 0) { return value; }
		if (typeof value === 'number') { return String(value); }
		return fallback;
	}

	private _asNumber(value: unknown, fallback: number): number {
		if (typeof value === 'number') { return value; }
		if (typeof value === 'string') {
			const num = Number(value);
			return isNaN(num) ? fallback : num;
		}
		return fallback;
	}

	private _asStringArray(value: unknown): string[] {
		if (Array.isArray(value)) {
			return value.map(v => typeof v === 'string' ? v : String(v));
		}
		if (typeof value === 'string') {
			// Try to parse as JSON
			try {
				const parsed = JSON.parse(value);
				if (Array.isArray(parsed)) { return this._asStringArray(parsed); }
			} catch { /* not JSON */ }
			// Single string dependency
			if (value.length > 0) { return [value]; }
		}
		if (typeof value === 'number') { return [String(value)]; }
		return [];
	}
}
