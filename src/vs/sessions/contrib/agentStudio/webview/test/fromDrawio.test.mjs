/**
 * fromDrawio 解析层端到端验证（node 运行，jsdom 提供 DOMParser）
 *
 * 运行方式：
 *   node test/fromDrawio.test.mjs
 *
 * 前置：esbuild 已把 src/features/mindmap/drawioSerializer.ts 打包成
 *       test/.drawioSerializer.cjs（见同目录 build-serializer.mjs）。
 * 该测试验证 drawio 真实 mxGraphModel XML 能正确解析为
 * { nodes, positions }，覆盖：顶点解析、坐标、边父子、图片节点、容错。
 */
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';

// 1) 注入 jsdom 的 DOMParser 到全局，供打包后的 serializer 使用
const dom = new JSDOM('<!DOCTYPE html><body></body>');
globalThis.DOMParser = dom.window.DOMParser;

// 2) 加载 esbuild 产出的 CJS bundle
const require = createRequire(import.meta.url);
const { fromDrawio } = require('./.drawioSerializer.cjs');

let passed = 0;
let failed = 0;
function check(name, cond) {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.error(`  ✗ ${name}`);
	}
}

// 一份真实 drawio mxGraphModel（含根节点 + 子节点 + 图片节点 + 边父子）
const sampleDrawio = `<?xml version="1.0" encoding="UTF-8"?>
<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" page="1" pageWidth="850" pageHeight="1100">
  <root>
    <mxCell id="0" />
    <mxCell id="1" parent="0" />
    <mxCell id="root" value="中心主题" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">
      <mxGeometry x="360" y="40" width="200" height="56" as="geometry"/>
    </mxCell>
    <mxCell id="a" value="分支A" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">
      <mxGeometry x="160" y="200" width="200" height="56" as="geometry"/>
    </mxCell>
    <mxCell id="b" value="分支B&lt;br/&gt;&lt;img src=&quot;data:image/png;base64,AAAA&quot; width=&quot;160&quot; height=&quot;90&quot;/&gt;" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1" imageRefs="https://x/y.png,https://z/w.png">
      <mxGeometry x="560" y="200" width="220" height="120" as="geometry"/>
    </mxCell>
    <mxCell id="a1" value="叶子A1" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">
      <mxGeometry x="80" y="360" width="200" height="56" as="geometry"/>
    </mxCell>
    <mxCell id="e_root_a" style="edgeStyle=orthogonalEdgeStyle;rounded=0;" edge="1" parent="1" source="root" target="a">
      <mxGeometry relative="1" as="geometry"/>
    </mxCell>
    <mxCell id="e_root_b" style="edgeStyle=orthogonalEdgeStyle;rounded=0;" edge="1" parent="1" source="root" target="b">
      <mxGeometry relative="1" as="geometry"/>
    </mxCell>
    <mxCell id="e_a_a1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;" edge="1" parent="1" source="a" target="a1">
      <mxGeometry relative="1" as="geometry"/>
    </mxCell>
  </root>
</mxGraphModel>`;

console.log('fromDrawio 解析层验证');
console.log('1) 基础解析');
const doc = fromDrawio(sampleDrawio);
check('解析出 4 个顶点节点（root/a/b/a1，0/1 为层节点被跳过）', doc.nodes.length === 4);
check('positions 含 root 坐标 x=360', doc.positions['root'] && doc.positions['root'].x === 360);
check('positions 含 b 坐标 width 不影响（y=200）', doc.positions['b'] && doc.positions['b'].y === 200);

console.log('2) 标题解析（含 <br> 与 <img> 剥离）');
const rootNode = doc.nodes.find((n) => n.id === 'root');
check('root 标题 = "中心主题"', rootNode && rootNode.title === '中心主题');
const bNode = doc.nodes.find((n) => n.id === 'b');
check('b 标题去掉 <br><img> 后 = "分支B"', bNode && bNode.title === '分支B');

console.log('3) 图片节点解析（imageRefs 属性 + value 内 <img>）');
check('b 解析出 imageRefs（含 2 个 src）', bNode && Array.isArray(bNode.imageRefs) && bNode.imageRefs.length === 2);
check('b.imageRefs[0] = https://x/y.png', bNode && bNode.imageRefs[0] === 'https://x/y.png');
check('b.imageRefs[1] = https://z/w.png', bNode && bNode.imageRefs[1] === 'https://z/w.png');

console.log('4) 边父子关系');
const aNode = doc.nodes.find((n) => n.id === 'a');
const a1Node = doc.nodes.find((n) => n.id === 'a1');
check('a 的 parentId = root', aNode && aNode.parentId === 'root');
check('b 的 parentId = root', bNode && bNode.parentId === 'root');
check('a1 的 parentId = a', a1Node && a1Node.parentId === 'a');
check('root 的 parentId = null', rootNode && rootNode.parentId === null);

console.log('5) 容错');
const empty = fromDrawio('<mxGraphModel><root></root></mxGraphModel>');
check('空 root → nodes=[]', empty.nodes.length === 0 && Object.keys(empty.positions).length === 0);
const noModel = fromDrawio('<not-drawio/>');
check('缺 mxGraphModel/root → 返回空 doc', noModel.nodes.length === 0 && noModel.positions && typeof noModel.positions === 'object');

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
