/*---------------------------------------------------------------------------------------------
 *  Mindmap 纯逻辑层 单测
 *
 *  覆盖：
 *  - treeModel: buildForest / direction 推断 / 查询
 *  - layoutEngine: contour packing / computeLayout / computeChildrenLayout
 *  - nodeOperations: addChild / addSibling / delete / flip / balance
 *  - branchColors: 着色 / 清除
 *  - edgeSides: computeEdgeSides / updateAllEdgeSides
 *  - freemindLayout: 单根 / 左右分支 / 高度估算
 *
 *  断言策略：只断言确定性契约（相对位置关系、间距非负、不重叠、
 *  节点数边数正确），不断言绝对坐标。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { IMindmapData } from '../../common/mindmap/mindmapTypes.js';
import { LayoutEngine } from '../../common/mindmap/layoutEngine.js';
import { buildForest, getDescendants, getNextSibling, getPrevSibling,
	countChildrenPerSide, findTreeForNode, collectDescendantNodes,
	getDirectChildNodes, getParentNode, detectDirection } from '../../common/mindmap/treeModel.js';
import { addChild, addSibling, deleteAndFocusParent, flipBranch,
	toggleBalancedLayout } from '../../common/mindmap/nodeOperations.js';
import { applyBranchColors, clearAllColors } from '../../common/mindmap/branchColors.js';
import { computeEdgeSides, updateAllEdgeSides } from '../../common/mindmap/edgeSides.js';
import { freemindToCanvas, estimateNodeHeight, type IFreeMindNode } from '../../common/mindmap/freemindLayout.js';
import { genId } from '../../common/mindmap/idGenerator.js';

// ─── 辅助 ────────────────────────────────────────────────────────────────

function makeNode(
	id: string, x: number, y: number,
	w: number = 300, h: number = 60, text: string = '',
	type: 'text' | 'file' | 'link' | 'group' = 'text',
) {
	return { id, type, x, y, width: w, height: h, text };
}

function makeEdge(
	id: string, fromNode: string, toNode: string,
	fromSide: 'right' | 'left' = 'right', toSide: 'right' | 'left' = 'left',
) {
	return { id, fromNode, fromSide, toNode, toSide, fromEnd: 'none' as const, toEnd: 'arrow' as const };
}

// ─── 简单两节点树 ────────────────────────────────────────────────────────

function simpleTwoNodeData(): IMindmapData {
	return {
		nodes: [
			makeNode('r', 0, 0, 300, 60, 'Root'),
			makeNode('c1', 380, -10, 300, 60, 'Child 1'),
		],
		edges: [makeEdge('e1', 'r', 'c1')],
		mindmap: true,
	};
}

// ─── 三节点链 ────────────────────────────────────────────────────────────

function chainThreeData(): IMindmapData {
	return {
		nodes: [
			makeNode('r', 0, 0, 300, 60, 'Root'),
			makeNode('c1', 380, 0, 300, 60, 'Child'),
			makeNode('c2', 760, 0, 300, 60, 'GrandChild'),
		],
		edges: [
			makeEdge('e1', 'r', 'c1'),
			makeEdge('e2', 'c1', 'c2'),
		],
	};
}

// ─── 根含多子节点森林 ────────────────────────────────────────────────────

function multiChildData(): IMindmapData {
	return {
		nodes: [
			makeNode('r', 0, 0, 300, 60, 'Root'),
			makeNode('c1', 400, -80, 300, 60, 'A'),
			makeNode('c2', 400, 0, 300, 60, 'B'),
			makeNode('c3', 400, 80, 300, 60, 'C'),
		],
		edges: [
			makeEdge('e1', 'r', 'c1'),
			makeEdge('e2', 'r', 'c2'),
			makeEdge('e3', 'r', 'c3'),
		],
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// treeModel
// ═══════════════════════════════════════════════════════════════════════════

suite('Mindmap — treeModel', () => {

	suite('buildForest', () => {

		test('两节点树：1 根，depth 正确', () => {
			const forest = buildForest(simpleTwoNodeData());
			assert.strictEqual(forest.length, 1);
			assert.strictEqual(forest[0].node.id, 'r');
			assert.strictEqual(forest[0].depth, 0);
			assert.strictEqual(forest[0].children.length, 1);
			assert.strictEqual(forest[0].children[0].node.id, 'c1');
			assert.strictEqual(forest[0].children[0].depth, 1);
		});

		test('三节点链：depth 2', () => {
			const forest = buildForest(chainThreeData());
			assert.strictEqual(forest.length, 1);
			const root = forest[0];
			assert.strictEqual(root.children[0].children[0].node.id, 'c2');
			assert.strictEqual(root.children[0].children[0].depth, 2);
		});

		test('多子节点：3 子，方向均为 right（均在根右侧）', () => {
			const forest = buildForest(multiChildData());
			const root = forest[0];
			assert.strictEqual(root.children.length, 3);
			// 子节点中心 x=550 > 根中心 x=150 → 全都 right
			for (const child of root.children) {
				assert.strictEqual(child.direction, 'right');
			}
		});

		test('独立根节点（无边）：1 棵树、无子节点', () => {
			const data: IMindmapData = {
				nodes: [makeNode('r', 100, 200, 300, 60, 'Solo')],
				edges: [],
			};
			const forest = buildForest(data);
			assert.strictEqual(forest.length, 1);
			assert.strictEqual(forest[0].children.length, 0);
		});

		test('跳过 group 类型节点', () => {
			const data: IMindmapData = {
				nodes: [
					makeNode('r', 0, 0, 300, 60, 'Root'),
					makeNode('g1', 0, 0, 200, 200, '', 'group'),
					makeNode('c1', 380, 0, 300, 60, 'Child'),
				],
				edges: [
					makeEdge('e1', 'r', 'c1'),
				],
			};
			const forest = buildForest(data);
			assert.strictEqual(forest.length, 1);
			// group 不在 forest 中
			const gInForest = forest.find(t => t.node.id === 'g1');
			assert.strictEqual(gInForest, undefined);
		});

		test('多棵树：按子树大小降序排列', () => {
			const data: IMindmapData = {
				nodes: [
					makeNode('r1', 0, 0, 300, 60),
					makeNode('r2', 400, 0, 300, 60),
					makeNode('c1', 800, 0, 300, 60),
					makeNode('c2', 800, 100, 300, 60),
					makeNode('c3', 800, 200, 300, 60),
				],
				edges: [
					makeEdge('e1', 'r1', 'c1'),
					makeEdge('e2', 'c1', 'c2'),
					makeEdge('e3', 'c1', 'c3'),
				],
			};
			const forest = buildForest(data);
			assert.strictEqual(forest.length, 2);
			// r1 子树更大（4 节点）→ 应该排在 r2（1 节点）之前
			assert.strictEqual(forest[0].node.id, 'r1');
			assert.strictEqual(forest[1].node.id, 'r2');
		});
	});

	suite('查询', () => {
		test('findTreeForNode 找到目标', () => {
			const forest = buildForest(chainThreeData());
			const found = findTreeForNode(forest, 'c2');
			assert.ok(found);
			assert.strictEqual(found!.node.id, 'c2');
			assert.strictEqual(found!.depth, 2);
		});

		test('getDescendants 返回所有后代', () => {
			const forest = buildForest(chainThreeData());
			const desc = getDescendants(forest[0]);
			assert.strictEqual(desc.length, 2); // c1, c2
		});

		test('getNextSibling / getPrevSibling', () => {
			const forest = buildForest(multiChildData());
			const c1 = forest[0].children[0];
			const c2 = forest[0].children[1];
			const c3 = forest[0].children[2];

			const next = getNextSibling(c1);
			assert.ok(next);
			assert.strictEqual(next!.node.id, 'c2');

			const prev = getPrevSibling(c3);
			assert.ok(prev);
			assert.strictEqual(prev!.node.id, 'c2');
		});

		test('countChildrenPerSide', () => {
			// 两右侧一左侧
			const data: IMindmapData = {
				nodes: [
					makeNode('r', 0, 0, 300, 60),
					makeNode('cr1', 380, -80, 300, 60),
					makeNode('cr2', 380, 80, 300, 60),
					makeNode('cl1', -380, 0, 300, 60),
				],
				edges: [
					makeEdge('e1', 'r', 'cr1'),
					makeEdge('e2', 'r', 'cr2'),
					makeEdge('e3', 'r', 'cl1', 'right', 'left'),
				],
			};
			// cl1 在根左边 → left 侧
			// cr1/cr2 在根右边 → right 侧
			const forest = buildForest(data);
			const counts = countChildrenPerSide(forest[0]);
			// 修正边：cl1 的 edge fromSide=right 是错的，但它位置在左边，direction 会被 assignDirections 按位置修正
			assert.strictEqual(counts.right, 2);
			assert.strictEqual(counts.left, 1);
		});

		test('getParentNode / getDirectChildNodes 数据层查询', () => {
			const data = simpleTwoNodeData();
			const parent = getParentNode('c1', data);
			assert.ok(parent);
			assert.strictEqual(parent!.id, 'r');

			const children = getDirectChildNodes('r', data);
			assert.strictEqual(children.length, 1);
			assert.strictEqual(children[0].id, 'c1');
		});

		test('collectDescendantNodes BFS', () => {
			const forest = buildForest(chainThreeData());
			const desc = collectDescendantNodes('r', chainThreeData());
			assert.strictEqual(desc.length, 2);
			assert.ok(desc.some(n => n.id === 'c1'));
			assert.ok(desc.some(n => n.id === 'c2'));
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// layoutEngine
// ═══════════════════════════════════════════════════════════════════════════

suite('Mindmap — LayoutEngine', () => {

	const engine = new LayoutEngine({ horizontalGap: 80, verticalGap: 20, nodeWidth: 300, nodeHeight: 60 });

	suite('computeLayout', () => {

		test('空数据返回空 positions', () => {
			const result = engine.computeLayout({ nodes: [], edges: [] });
			assert.strictEqual(result.positions.size, 0);
		});

		test('两节点：子节点在父右侧 + horizontalGap', () => {
			const result = engine.computeLayout(simpleTwoNodeData());
			const rootPos = result.positions.get('r');
			const childPos = result.positions.get('c1');
			assert.ok(rootPos);
			assert.ok(childPos);
			// 子节点 x 应该 > 根 x + 根宽度（即 right 侧）
			assert.ok(childPos!.x > rootPos!.x + 300 - 1, `expected child x > ${rootPos!.x + 300}, got ${childPos!.x}`);
		});

		test('多子节点（同侧）：子节点 y 按顺序递增，不重叠', () => {
			const engineLocal = new LayoutEngine({ horizontalGap: 80, verticalGap: 20, nodeWidth: 300, nodeHeight: 60 });
			const result = engineLocal.computeLayout(multiChildData());
			const pos1 = result.positions.get('c1');
			const pos2 = result.positions.get('c2');
			const pos3 = result.positions.get('c3');
			assert.ok(pos1 && pos2 && pos3);

			// y 递增
			assert.ok(pos2.y > pos1.y, `c2.y(${pos2.y}) > c1.y(${pos1.y})`);
			assert.ok(pos3.y > pos2.y, `c3.y(${pos3.y}) > c2.y(${pos2.y})`);

			// 不重叠
			assert.ok(pos2.y >= pos1.y + 60 - 1, 'c2 should start at or below c1 bottom');
		});

		test('三节点链：不重叠', () => {
			const result = engine.computeLayout(chainThreeData());
			const posR = result.positions.get('r')!;
			const posC1 = result.positions.get('c1')!;
			const posC2 = result.positions.get('c2')!;

			assert.ok(posC1.x > posR.x + 300 - 1, 'c1 right of r');
			assert.ok(posC2.x > posC1.x + 300 - 1, 'c2 right of c1');
		});
	});

	suite('computeChildrenLayout', () => {
		test('局部重排仅影响子树、根节点位置不动', () => {
			const engineLocal = new LayoutEngine({ horizontalGap: 80, verticalGap: 20, nodeWidth: 300, nodeHeight: 60 });
			const result = engineLocal.computeChildrenLayout(multiChildData(), 'r');
			// 根节点不在 positions 中（保持原位置）
			assert.strictEqual(result.positions.has('r'), false);
			// 三个子节点都在 positions 中
			assert.ok(result.positions.has('c1'));
			assert.ok(result.positions.has('c2'));
			assert.ok(result.positions.has('c3'));
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// nodeOperations
// ═══════════════════════════════════════════════════════════════════════════

suite('Mindmap — nodeOperations', () => {

	const config = { nodeWidth: 300, nodeHeight: 60, horizontalGap: 80, verticalGap: 20 };

	suite('addChild', () => {
		test('为根节点添加子节点：节点数和边数正确', () => {
			const data: IMindmapData = {
				nodes: [makeNode('r', 0, 0, 300, 60, 'Root')],
				edges: [],
			};
			const result = addChild(data, 'r', config, 'New');
			assert.ok(result);
			assert.strictEqual(result!.data.nodes.length, 2);
			assert.strictEqual(result!.data.edges.length, 1);
			assert.ok(result!.newNodeId);

			const newNode = result!.data.nodes.find(n => n.id === result!.newNodeId);
			assert.ok(newNode);
			assert.strictEqual(newNode!.text, 'New');
		});

		test('非根节点加子：继承分支方向', () => {
			const result = addChild(simpleTwoNodeData(), 'c1', config, 'Grandchild');
			assert.ok(result);
			assert.strictEqual(result!.data.nodes.length, 3);
			assert.strictEqual(result!.data.edges.length, 2);
		});

		test('addChild 返回 relayoutParentId', () => {
			const result = addChild(simpleTwoNodeData(), 'c1', config);
			assert.ok(result);
			assert.strictEqual(result!.relayoutParentId, 'c1');
		});
	});

	suite('addSibling', () => {
		test('添加兄弟节点', () => {
			const result = addSibling(simpleTwoNodeData(), 'c1', config, 'Sibling');
			assert.ok(result);
			assert.strictEqual(result!.data.nodes.length, 3);
			// 新兄弟共享同一个父 'r'
			const newEdge = result!.data.edges.find(e =>
				e.fromNode === 'r' && e.id !== 'e1'
			);
			assert.ok(newEdge);
		});

		test('根节点加兄弟 → 化为 addChild', () => {
			const data: IMindmapData = {
				nodes: [makeNode('r', 0, 0, 300, 60, 'Root')],
				edges: [],
			};
			const result = addSibling(data, 'r', config, 'Child');
			assert.ok(result);
			// 根无父 → 加的是子
			assert.strictEqual(result!.data.nodes.length, 2);
			const edge = result!.data.edges[0];
			assert.strictEqual(edge.fromNode, 'r');
		});
	});

	suite('deleteAndFocusParent', () => {
		test('删除节点 + 重连孤儿子节点', () => {
			const data: IMindmapData = {
				nodes: [
					makeNode('r', 0, 0, 300, 60, 'Root'),
					makeNode('c1', 380, 0, 300, 60, 'Child'),
					makeNode('gc1', 760, 0, 300, 60, 'Grandchild'),
				],
				edges: [
					makeEdge('e1', 'r', 'c1'),
					makeEdge('e2', 'c1', 'gc1'),
				],
			};
			const result = deleteAndFocusParent(data, 'c1');
			assert.ok(result);
			// c1 删除，gc1 重连到 r
			assert.strictEqual(result!.data.nodes.length, 2);
			assert.strictEqual(result!.data.edges.length, 1);
			assert.strictEqual(result!.data.edges[0].fromNode, 'r');
			assert.strictEqual(result!.data.edges[0].toNode, 'gc1');
			assert.strictEqual(result!.focusNodeId, 'r');
		});

		test('不能删除根节点', () => {
			const data: IMindmapData = {
				nodes: [makeNode('r', 0, 0)],
				edges: [],
			};
			const result = deleteAndFocusParent(data, 'r');
			assert.strictEqual(result, null);
		});

		test('无子节点的叶子删除：直接移除', () => {
			const result = deleteAndFocusParent(simpleTwoNodeData(), 'c1');
			assert.ok(result);
			assert.strictEqual(result!.data.nodes.length, 1);
			assert.strictEqual(result!.data.nodes[0].id, 'r');
		});
	});

	suite('flipBranch', () => {
		test('翻转分支：x 坐标绕父中心镜像', () => {
			const result = flipBranch(simpleTwoNodeData(), 'c1');
			assert.ok(result);

			const parent = result!.data.nodes.find(n => n.id === 'r');
			const child = result!.data.nodes.find(n => n.id === 'c1');
			assert.ok(parent && child);

			// 子节点应该在父节点左侧（因为原来在右侧 → 翻转后到左侧）
			assert.ok(child!.x < parent!.x, `expected child x(${child!.x}) < parent x(${parent!.x})`);
		});

		test('根节点不能翻转', () => {
			const data: IMindmapData = {
				nodes: [makeNode('r', 0, 0)],
				edges: [],
			};
			const result = flipBranch(data, 'r');
			assert.strictEqual(result, null);
		});
	});

	suite('toggleBalancedLayout', () => {
		test('全在一侧 → 奇数位镜像到对侧', () => {
			const result = toggleBalancedLayout(multiChildData(), 'r');
			assert.ok(result);
			assert.strictEqual(result!.data.nodes.length, 4);
			assert.strictEqual(result!.relayoutParentId, 'r');
		});

		test('< 2 子节点返回 null', () => {
			const result = toggleBalancedLayout(simpleTwoNodeData(), 'r');
			assert.strictEqual(result, null);
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// branchColors
// ═══════════════════════════════════════════════════════════════════════════

suite('Mindmap — branchColors', () => {

	test('applyBranchColors：顶层分支获不同颜色', () => {
		const data: IMindmapData = {
			nodes: [
				makeNode('r', 0, 0, 300, 60),
				makeNode('c1', 380, -80, 300, 60),
				makeNode('c2', 380, 80, 300, 60),
			],
			edges: [
				makeEdge('e1', 'r', 'c1'),
				makeEdge('e2', 'r', 'c2'),
			],
		};
		const changed = applyBranchColors(data);
		assert.ok(changed.size > 0);

		const c1Node = data.nodes.find(n => n.id === 'c1');
		const c2Node = data.nodes.find(n => n.id === 'c2');
		assert.ok(c1Node!.color);
		assert.ok(c2Node!.color);
	});

	test('clearAllColors：清除所有颜色', () => {
		const data: IMindmapData = {
			nodes: [
				makeNode('r', 0, 0, 300, 60),
				makeNode('c1', 380, 0, 300, 60),
			],
			edges: [makeEdge('e1', 'r', 'c1')],
		};
		data.nodes[0].color = '1';
		data.nodes[1].color = '2';
		data.edges[0].color = '3';

		clearAllColors(data);
		for (const n of data.nodes) {
			assert.strictEqual(n.color, undefined);
		}
		for (const e of data.edges) {
			assert.strictEqual(e.color, undefined);
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// edgeSides
// ═══════════════════════════════════════════════════════════════════════════

suite('Mindmap — edgeSides', () => {

	test('computeEdgeSides：子节点在右侧 → fromSide=right, toSide=left', () => {
		const parent = makeNode('r', 0, 0, 200, 60);
		const child = makeNode('c1', 300, 0, 200, 60);
		const sides = computeEdgeSides(parent, child);
		assert.strictEqual(sides.fromSide, 'right');
		assert.strictEqual(sides.toSide, 'left');
	});

	test('computeEdgeSides：子节点在左侧 → fromSide=left, toSide=right', () => {
		const parent = makeNode('r', 300, 0, 200, 60);
		const child = makeNode('c1', 0, 0, 200, 60);
		const sides = computeEdgeSides(parent, child);
		assert.strictEqual(sides.fromSide, 'left');
		assert.strictEqual(sides.toSide, 'right');
	});

	test('updateAllEdgeSides 修正边侧', () => {
		const data: IMindmapData = {
			nodes: [
				makeNode('r', 0, 0, 300, 60),
				makeNode('c1', 400, 0, 300, 60),
			],
			edges: [
				{ id: 'e1', fromNode: 'r', fromSide: 'left', toNode: 'c1', toSide: 'right', fromEnd: 'none', toEnd: 'arrow' },
			],
		};
		const changed = updateAllEdgeSides(data);
		assert.ok(changed);
		assert.strictEqual(data.edges[0].fromSide, 'right');
		assert.strictEqual(data.edges[0].toSide, 'left');
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// freemindLayout
// ═══════════════════════════════════════════════════════════════════════════

suite('Mindmap — freemindLayout', () => {

	test('单根无子', () => {
		const roots: IFreeMindNode[] = [{ text: 'Root', position: 'right', children: [] }];
		const result = freemindToCanvas(roots);
		assert.ok(result);
		assert.strictEqual(result!.nodes.length, 1);
		assert.strictEqual(result!.edges.length, 0);
		assert.strictEqual(result!.mindmap, true);
		assert.strictEqual(result!.nodes[0].text, 'Root');
	});

	test('单根带一子', () => {
		const roots: IFreeMindNode[] = [{
			text: 'Root', position: 'right',
			children: [{ text: 'Child', position: 'right', children: [] }],
		}];
		const result = freemindToCanvas(roots);
		assert.ok(result);
		assert.strictEqual(result!.nodes.length, 2);
		assert.strictEqual(result!.edges.length, 1);
		assert.strictEqual(result!.edges[0].toEnd, 'arrow');
	});

	test('左右分支', () => {
		const roots: IFreeMindNode[] = [{
			text: 'Root', position: 'right',
			children: [
				{ text: 'Right', position: 'right', children: [] },
				{ text: 'Left', position: 'left', children: [] },
			],
		}];
		const result = freemindToCanvas(roots);
		assert.ok(result);
		assert.strictEqual(result!.nodes.length, 3);
		assert.strictEqual(result!.edges.length, 2);
	});

	test('estimateNodeHeight', () => {
		const h = estimateNodeHeight('short', 300, 60, 300);
		assert.ok(h >= 60, `h should be >= min 60, got ${h}`);
		assert.ok(h <= 80, `short text should not be tall, got ${h}`);

		const longLine = 'a'.repeat(200);
		const hLong = estimateNodeHeight(longLine, 300, 60, 300);
		assert.ok(hLong > 60, `long line should be taller than 60, got ${hLong}`);
		assert.ok(hLong <= 300);
	});

	test('多根节点', () => {
		const roots: IFreeMindNode[] = [
			{ text: 'Tree A', position: 'right', children: [] },
			{ text: 'Tree B', position: 'right', children: [] },
		];
		const result = freemindToCanvas(roots);
		assert.ok(result);
		assert.strictEqual(result!.nodes.length, 2);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 综合
// ═══════════════════════════════════════════════════════════════════════════

suite('Mindmap — 综合', () => {

	test('addChild + computeChildrenLayout → 布局正确（两子均衡分布左右两侧）', () => {
		const engineLocal = new LayoutEngine({ horizontalGap: 80, verticalGap: 20, nodeWidth: 300, nodeHeight: 60 });
		const data: IMindmapData = {
			nodes: [makeNode('r', 100, 200, 300, 60, 'Root')],
			edges: [],
		};

		// 加两个子节点：第一个 right，第二个 left（addChild 均衡策略：left<right 时选 left）
		const r1 = addChild(data, 'r', { nodeWidth: 300, nodeHeight: 60, horizontalGap: 80, verticalGap: 20 }, 'A')!;
		const r2 = addChild(r1.data, 'r', { nodeWidth: 300, nodeHeight: 60, horizontalGap: 80, verticalGap: 20 }, 'B')!;

		// 布局
		const layout = engineLocal.computeLayout(r2.data);
		assert.ok(layout.positions.size >= 3);

		const posA = layout.positions.get(r1.newNodeId!)!;
		const posB = layout.positions.get(r2.newNodeId!)!;

		// addChild 均衡：A 在右侧 → x >= 100 + 300 + 80 = 480
		//                 B 在左侧 → x <= 100 - 80 = 20
		const rightMinX = 100 + 300 + 80;
		const leftMaxX = 100 - 80;

		assert.ok(posA.x >= rightMinX - 2, `A on right: expected x >= ${rightMinX - 2}, got ${posA.x}`);
		assert.ok(posB.x <= leftMaxX + 2, `B on left: expected x <= ${leftMaxX + 2}, got ${posB.x}`);

		// 异侧子节点各自围绕根垂直居中 → y 接近（不重叠因为 X 分离）
		const rootCenterY = 200 + 60 / 2;
		assert.ok(Math.abs(posA.y - rootCenterY) < 60, `A roughly centered on root: A.y=${posA.y}, rootCY=${rootCenterY}`);
		assert.ok(Math.abs(posB.y - rootCenterY) < 60, `B roughly centered on root: B.y=${posB.y}, rootCY=${rootCenterY}`);
	});

	test('genId 生成 16 位 hex 且唯一性', () => {
		const ids = new Set<string>();
		for (let i = 0; i < 1000; i++) {
			const id = genId();
			assert.strictEqual(id.length, 16);
			assert.ok(/^[0-9a-f]{16}$/.test(id));
			assert.strictEqual(ids.has(id), false);
			ids.add(id);
		}
	});
});
