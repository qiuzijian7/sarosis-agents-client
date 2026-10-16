// @vssaros/dsh-codebase — parser/extract：**真解析**（tree-sitter AST）→ 图谱符号与引用事实（纯函数，跑在 worker 里 ✓）。
//
// 它的唯一目标：**口径与 IDE 真源逐条对齐**（`browser/codebaseGraphWorkerCode.ts::walkAST` + `common/codebaseIndexDefaults.ts`），
// 这样 dsh 侧产出的图与 IDE 那张**能放在一起比**（P2 的验收就是"对账并如实报差"✓）。所以这里的每条规则都**照抄**，
// 并在注释里写明它在真源的哪一行 ✓；**有意不同**的地方一律显式标注（见下）✗→✓。
//
// ## 照抄的真源语义（每条都对应一个"看起来对、其实错"的坑）
//
//   ① **符号的唯一键是 `file::name`**（`qualifiedName = filePath + '::' + name`，真源 `workerCode:313`）
//      ⇒ **同文件同名符号合并成一个节点**（真源按 `project:qualifiedName` upsert ✓）。写错成 `file::Parent.Name`
//      会让节点数虚高、CALLS/USAGE 命中率虚高 ✗。
//   ② **CONTAINS 只有 file→symbol 一条**（`:328`），**没有** class→method。
//   ③ **整棵 AST 递归**（`:343-347`）⇒ 类成员（`method_definition` → `function`）也会成为节点；
//      而**箭头函数 / 匿名函数不抽**（不在 `AST_TO_NODE_TYPE` 里 ✓）。**有名字**（`extractName` 取不到就整条不产 ✓）。
//   ④ **CALLS**（`:300-305`）：节点类型 `call_expression|call|method_invocation|invocation_expression`，
//      **必须已有 enclosing 符号**（顶层裸调用不产边 ✓），callee = 真源 `_extractCalleeName`：先 `function` 字段、
//      取**左最标识符**（`obj.method()` ⇒ `obj` ✗ 那是真源的行为，我们对齐），只在 `member_expression` 无名字时回落到 `property` ✓。
//      边属性 `{ loopDepth }` ✓。
//   ⑤ **USAGE**（`:247-293`）：另一批节点类型（赋值 / 类型标注 / `new`），`{ access: 'read' | 'write' }`；
//      `this` 丢弃 ✓。**目标 label 只允许 `class|interface|variable`**（真源 `service:4217`）✓。
//   ⑥ **INHERITS / IMPLEMENTS**（`:330-338` + `:217-244`）：只有 `class|interface` 节点产；
//      目标**必须是 class|interface**（`:4166`）✓。⚠ 真源把"继承"叫 **INHERITS**（不是 EXTENDS）✓。
//   ⑦ **匹配不上就丢边**（真源三处 `continue` ✓）：我们**照丢**，但**如实计数**（真源没有计数 ⇒ 见下面的有意差异 ②）。
//
// ## 两条**有意不同**（照抄会教错 ✗，都写在代码里、并由 p3-41 钉住 ✓）
//
//   ⚠ ① **名字优先取 `name` 字段**。真源的 `extractName` 只按"declarator 链 + DFS 第一个 `IDENTIFIER_TYPES`"取名字，
//      而 `IDENTIFIER_TYPES`（`workerCode:93-96`）**不含 `property_identifier`** ⇒ 对 TS 的 `method_definition`
//      它会 DFS 到**形参名**（`area(x)` ⇒ 名字成了 `x` ✗✗），小括号为空时干脆取不到名（方法整条不产）。
//      我们改成：**先取 `name` 字段**（权威 ✓），只有取不到才走真源那两条（declarator 链 → DFS）——
//      这样 C/C++ 的返回类型陷阱照样躲得开 ✓，而 TS 方法名不会再错 ✗。
//      ⇒ 对账时会看到"我们的 method 节点比 IDE 多/名字更对"，那是**这条差异**，不是漂移 ✓。
//   ⚠ ② **额外如实计数**（`unmatched*`）：真源丢边时只有一行 info 日志 ✗；我们把它算成数字回传，
//      让"为什么调用链短了"可查 ✓（**不改图**，只加统计 ✓）。
//   ⚠ ③ **TS 的继承子句靠回退取到**：真源只认 `heritage` **字段**（`workerCode:230`），而 tree-sitter-typescript
//      把继承放在**命名子节点** `class_heritage` 上 ⇒ 照抄的话 **TS/TSX 的 INHERITS/IMPLEMENTS 恒为 0** ✗
//      （实测 AST 已写进 `inheritNamesOf` 的注释 ✓）。我们补一条回退 ⇒ 这两类边在 TS 上真有 ✓。
//   ⚠ ④ **同一个名字在文件里出现多次时**：真源按 `project:qualifiedName` upsert ⇒ 节点的 `startLine` 会被
//      **最后一次**出现覆盖 ✗；我们**保留第一次**（确定性、且"第一次声明"才是这个名字的直觉含义 ✓）。
//      这不是"谁对"，而是一条**真实存在的差异** ⇒ p3-41 的对账会把它算进"行号不一致"并写清原因 ✓。

/** AST 节点类型 → 图谱 label（**逐字照抄** `common/codebaseIndexDefaults.ts:265-289` ✓，由 p3-41 与守卫对账）。 */
export const AST_TO_NODE_TYPE = {
	'function_declaration': 'function',
	'function_definition': 'function',
	'function_item': 'function',
	'method_definition': 'function',
	'method_declaration': 'function',
	'constructor_declaration': 'function',
	'destructor_declaration': 'function',
	'class_declaration': 'class',
	'class_definition': 'class',
	'class_specifier': 'class',
	'impl_item': 'class',
	'struct_specifier': 'class',
	'interface_declaration': 'interface',
	'type_alias_declaration': 'interface',
	'trait_item': 'interface',
	'protocol_declaration': 'interface',
	'enum_declaration': 'enum',
	'enum_item': 'enum',
	'enum_specifier': 'enum',
	'variable_declarator': 'variable',
	'global_variable_declaration': 'variable',
	'const_item': 'variable',
	'static_item': 'variable',
};

/** 扩展名 → tree-sitter 语言（**逐字照抄** `codebaseIndexDefaults.ts:136-152` ✓）。未列出的扩展名不参与真解析 ✓。 */
export const EXTENSION_TO_LANGUAGE = {
	'.ts': 'typescript',
	'.tsx': 'tsx',
	'.mts': 'typescript',
	'.cts': 'typescript',
	'.js': 'javascript',
	'.jsx': 'javascript',
	'.mjs': 'javascript',
	'.py': 'python',
	'.go': 'go',
	'.rs': 'rust',
	'.java': 'java',
	'.rb': 'ruby',
	'.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.h': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp',
	'.cs': 'c-sharp',
	'.php': 'php',
};

/** 真源 `workerCode:93-96` 的标识符类型集合（**不含** `property_identifier` —— 有意差异 ① 的由来 ✓）。 */
const IDENTIFIER_TYPES = new Set(['identifier', 'field_identifier', 'type_identifier', 'namespace_identifier', 'template_name', 'destructor_name']);
/** 真源 `workerCode:150-155` 的循环节点（用来算 `loopDepth` ✓）。 */
const LOOP_NODE_TYPES = new Set(['for_statement', 'while_statement', 'do_statement']);
/** 真源 `workerCode:300`：调用点类型。 */
const CALL_NODE_TYPES = new Set(['call_expression', 'call', 'method_invocation', 'invocation_expression']);
/** 真源 `workerCode:247-252`：使用点类型。 */
const USAGE_NODE_TYPES = new Set(['assignment_expression', 'assignment', 'augmented_assignment_expression', 'compound_assignment_expression', 'type_annotation', 'type_identifier', 'type_hint', 'new_expression', 'object_creation_expression']);
/** CALLS/USAGE 的目标 label 限制（真源 `service:4217` 只用 USAGE；CALLS 真源不限 —— 我们照真源 ✓）。 */
const USAGE_TARGET_LABELS = new Set(['class', 'interface', 'variable']);
/** INHERITS/IMPLEMENTS 的目标 label 限制（真源 `service:4166` ✓）。 */
const INHERIT_TARGET_LABELS = new Set(['class', 'interface']);

export { IDENTIFIER_TYPES, USAGE_TARGET_LABELS, INHERIT_TARGET_LABELS, LOOP_NODE_TYPES };

/** 文件相对路径 → 语言名（`/` 分隔的小写扩展名；认不出 ⇒ undefined ✓）。 */
export function languageOfFile(relPath) {
	const name = String(relPath ?? '').toLowerCase();
	const dot = name.lastIndexOf('.');
	if (dot < 0) {
		return undefined;
	}
	return EXTENSION_TO_LANGUAGE[name.slice(dot)];
}

const textOf = (node, source) => (node && typeof node.startIndex === 'number' && typeof node.endIndex === 'number'
	? source.slice(node.startIndex, node.endIndex)
	: undefined);

function fieldOf(node, field) {
	try {
		return node?.childForFieldName?.(field) ?? undefined;
	} catch {
		return undefined;
	}
}

/** 真源 `workerCode:99-130`：沿 declarator 链取真正的函数名（躲开 C/C++ 的返回类型 ✗）。 */
function declaratorName(node, source) {
	const isWrapper = type => type === 'function_declarator' || type === 'pointer_declarator' || type === 'reference_declarator' || type === 'parenthesized_declarator' || type === 'init_declarator';
	let current = node;
	for (let i = 0; i < 12; i += 1) {
		let decl = fieldOf(current, 'declarator');
		if (!decl) {
			decl = (current.children ?? []).find(child => isWrapper(child.type));
		}
		if (!decl) {
			break;
		}
		current = decl;
		if (isWrapper(current.type)) {
			continue;
		}
		break;
	}
	while (current.type === 'qualified_identifier') {
		const inner = fieldOf(current, 'name');
		if (!inner || typeof inner.startIndex !== 'number') {
			break;
		}
		if (inner.type === 'qualified_identifier') {
			current = inner;
			continue;
		}
		return textOf(inner, source);
	}
	if (IDENTIFIER_TYPES.has(current.type)) {
		return textOf(current, source);
	}
	return undefined;
}

/** 真源 `workerCode:136-146`：DFS 取第一个"标识符"（含 `name` 节点 ✓）。 */
function firstIdentifier(node, source) {
	if (IDENTIFIER_TYPES.has(node.type)) {
		return textOf(node, source);
	}
	if (node.type === 'name') {
		return textOf(node, source);
	}
	for (const child of node.children ?? []) {
		const found = firstIdentifier(child, source);
		if (found !== undefined) {
			return found;
		}
	}
	return undefined;
}

/**
 * 声明 → 名字。**有意差异 ①**：先取 `name` 字段（见文件头 ✗→✓），再走真源那两条 ✓。
 * 这个顺序对 TS/JS/Python/Go/Rust/Java 都正确，同时保住 C/C++ 的 declarator 链 ✓。
 */
export function nameOfDeclaration(node, source) {
	const direct = textOf(fieldOf(node, 'name'), source);
	if (direct) {
		return direct;
	}
	if (node.type === 'function_definition' || node.type === 'function_declaration' || node.type === 'function_declarator') {
		const viaDeclarator = declaratorName(node, source);
		if (viaDeclarator !== undefined) {
			return viaDeclarator;
		}
	}
	return firstIdentifier(node, source);
}

/** 真源 `workerCode:169-181`：callee 名字（`obj.method()` ⇒ `obj` —— 真源行为，我们对齐 ✓）。 */
function calleeName(node, source) {
	const fn = fieldOf(node, 'function');
	if (!fn) {
		return undefined;
	}
	const name = nameOfDeclaration(fn, source) ?? firstIdentifier(fn, source);
	if (name) {
		return name;
	}
	if (fn.type === 'member_expression') {
		return textOf(fieldOf(fn, 'property'), source);
	}
	return undefined;
}

/** 真源 `workerCode:217-244`：继承/实现的基名（C++ base_class_clause / TS heritage / Python superclasses / Ruby superclass ✓）。 */
export function inheritNamesOf(node, source) {
	const result = { inherits: [], implements: [] };
	const collectInto = (n, out) => {
		for (const child of n.children ?? []) {
			if (child.type === 'identifier' || child.type === 'type_identifier' || child.type === 'constant') {
				const text = textOf(child, source);
				if (text) {
					out.push(text);
				}
			}
			collectInto(child, out);
		}
	};
	// ⚠ 有意差异 ③（实测取证，p3-41 钉住）：真源只认 `heritage` **字段**（`workerCode:230`），
	// 而 `tree-sitter-typescript` 里 `class_declaration` **没有** `heritage` 字段 —— 继承子句在
	// 一个**命名子节点** `class_heritage` 下（`extends_clause` / `implements_clause` 各一个 ✓，
	// 实测 AST：`class_declaration [name type body] → class_heritage → extends_clause / implements_clause`）。
	// ⇒ 照抄的话 **TS/TSX 的继承边恒为 0** ✗（只有靠字段的 C++/Python/Ruby 才有 ✓）。
	// 我们**补一条回退**：字段没有就找 `class_heritage`（并直接认 `extends_clause`/`implements_clause` 命名子节点 ✓）。
	const heritage = fieldOf(node, 'heritage') ?? (node.namedChildren ?? []).find(child => child.type === 'class_heritage');
	const clauseOf = parent => (parent?.namedChildren ?? []).filter(child => child.type === 'extends_clause' || child.type === 'implements_clause');
	const clauses = heritage ? (clauseOf(heritage).length ? clauseOf(heritage) : [heritage]) : clauseOf(node);
	for (const clause of clauses) {
		if (clause.type === 'extends_clause') {
			collectInto(clause, result.inherits);
		} else if (clause.type === 'implements_clause') {
			collectInto(clause, result.implements);
		} else {
			// 与真源同形：其它类型的 heritage 一律当 inherits ✓（C++ base_class_clause / Ruby superclass …）
			collectInto(clause, result.inherits);
		}
	}
	for (const field of ['superclasses', 'base_class_clause', 'superclass', 'trait']) {
		const found = fieldOf(node, field);
		if (found) {
			collectInto(found, result.inherits);
		}
	}
	return result;
}

/** 真源 `workerCode:253-293`：使用点（读/写区分；`this` 丢弃 ✓）。 */
function collectUsages(node, source, owner, usages) {
	const add = (name, access) => {
		if (name && name.length > 0 && name !== 'this') {
			usages.push({ owner, name, access });
		}
	};
	if (node.type === 'assignment_expression' || node.type === 'assignment' || node.type === 'augmented_assignment_expression' || node.type === 'compound_assignment_expression') {
		const left = fieldOf(node, 'left') ?? fieldOf(node, 'target');
		if (left) {
			if (left.type === 'identifier' || left.type === 'field_identifier') {
				add(textOf(left, source), 'write');
			} else {
				const prop = fieldOf(left, 'property') ?? fieldOf(left, 'field');
				if (prop && (prop.type === 'property_identifier' || prop.type === 'identifier')) {
					add(textOf(prop, source), 'write');
				}
			}
		}
		return;
	}
	if (node.type === 'type_annotation' || node.type === 'type_hint') {
		for (const child of node.children ?? []) {
			if (child.type === 'type_identifier' || child.type === 'identifier') {
				add(textOf(child, source), 'read');
			}
		}
		return;
	}
	if (node.type === 'type_identifier') {
		add(textOf(node, source), 'read');
		return;
	}
	if (node.type === 'new_expression' || node.type === 'object_creation_expression') {
		const ctor = fieldOf(node, 'constructor') ?? fieldOf(node, 'type') ?? fieldOf(node, 'class');
		if (ctor) {
			add(textOf(ctor, source), 'read');
		}
	}
}

/**
 * 树 → 抽取结果（**与真源 `walkAST` 同序**：先记调用/使用、再落节点、再递归 ✓）。
 *
 * @returns `{ symbols, calls, usages, inherits, namedNodes }`
 *   · `symbols`：`[{ name, label, kind, line, endLine }]`，顺序 = DFS 前序、**同名只留第一个**（真源合并语义 ✓）
 *   · `calls`：`[{ owner, name, loopDepth }]`（`owner` = 所属符号名；无所属 ⇒ 不产 ✓）
 *   · `usages`：`[{ owner, name, access }]`
 *   · `inherits`：`[{ owner, name, type: 'INHERITS' | 'IMPLEMENTS' }]`
 */
export function extractFromTree(tree, source) {
	const root = tree?.rootNode;
	const symbols = [];
	const calls = [];
	const usages = [];
	const inherits = [];
	const seen = new Set();
	let namedNodes = 0;
	if (!root) {
		return { symbols, calls, usages, inherits, namedNodes };
	}
	const walk = (node, owner, loopDepth) => {
		const label = AST_TO_NODE_TYPE[node.type];
		let myOwner = owner;
		if (CALL_NODE_TYPES.has(node.type) && owner) {
			const callee = calleeName(node, source);
			if (callee) {
				calls.push({ owner, name: callee, loopDepth });
			}
		}
		if (USAGE_NODE_TYPES.has(node.type) && owner) {
			collectUsages(node, source, owner, usages);
		}
		if (label) {
			const name = nameOfDeclaration(node, source);
			if (name) {
				if (!seen.has(name)) {
					seen.add(name);
					symbols.push({
						name,
						label,
						kind: node.type,
						line: node.startPosition ? node.startPosition.row + 1 : undefined,
						endLine: node.endPosition ? node.endPosition.row + 1 : undefined,
					});
				}
				if (label === 'class' || label === 'interface') {
					const bases = inheritNamesOf(node, source);
					for (const base of bases.inherits) {
						inherits.push({ owner: name, name: base, type: 'INHERITS' });
					}
					for (const base of bases.implements) {
						inherits.push({ owner: name, name: base, type: 'IMPLEMENTS' });
					}
				}
				myOwner = name; // 真源：抽到符号后，**它**成为后续子节点的 enclosing（含类成员与外层都算 ✓）
			}
		}
		const nextLoop = LOOP_NODE_TYPES.has(node.type) ? loopDepth + 1 : loopDepth;
		for (const child of node.children ?? []) {
			walk(child, myOwner, nextLoop);
		}
	};
	for (const child of root.children ?? []) {
		walk(child, undefined, 0);
	}
	namedNodes = countNamed(root);
	return { symbols, calls, usages, inherits, namedNodes };
}

function countNamed(node, limit = 200_000) {
	let count = 0;
	const stack = [node];
	while (stack.length && count < limit) {
		const current = stack.pop();
		if (!current) {
			continue;
		}
		if (current.isNamed) {
			count += 1;
		}
		for (const child of current.children ?? []) {
			stack.push(child);
		}
	}
	return count;
}
