/*---------------------------------------------------------------------------------------------
 *  MindMapPanel — 思维导图 React 面板（agentStudio 第三视图，与 Workflow/Trace 并列）。
 *
 *  架构对齐：
 *    - 状态走 workflowEditor store（zustand + zundo time-travel），与 WorkflowEditor 同源，
 *      因此脑图节点可无缝切到工作流视图继续编辑（共享 Saros.* 节点命名空间）。
 *    - 画布复用 LiteGraphCanvas 的「LiteGraph 画布 + widgetBridge overlay」渲染链路。
 *    - 序列化走 ComfyGraphAdapter（wf JSON）做持久化，drawioSerializer 做飞书兼容导出。
 *
 *  面板能力：放射布局、导入(drawio / markdown)、导出 drawio、插入图片节点。
 *---------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWorkflowEditorStore } from '../workflowEditor/store';
import { computeRadialLayout as radialLayout, type MindMapNodeData } from './radialLayout';
import { fromDrawio as drawioToMindMap, toDrawioBlob as buildDrawioBlob } from './drawioSerializer';
import { markdownToMindMap } from './markdownImport';
import { MIND_MAP_TYPE, MIND_MAP_IMAGE_TYPE } from './MindMapNode';
import { MaxGraphMindMapRenderer } from './maxGraphRenderer';
import { createMaxGraph } from './maxgraphFactory';
import { toRenderModel } from './maxGraphRenderer.types';
import './MindMapPanel.css';

interface MindMapPanelProps {
  /** 宿主在切换视图时传入，决定画布是否处于激活态。 */
  active?: boolean;
}

export function MindMapPanel({ active = true }: MindMapPanelProps) {
  const store = useWorkflowEditorStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importMode, setImportMode] = useState<'drawio' | 'markdown'>('drawio');
  const [importText, setImportText] = useState('');
  const [showImport, setShowImport] = useState(false);

  // 从 store 的 Saros.MindMap* 节点抽取脑图数据（与 radialLayout 输入对齐）。
  const mindMapData = useMemo<MindMapNodeData[]>(() => {
    return store.nodes
      .filter((n) => n.type === MIND_MAP_TYPE || n.type === MIND_MAP_IMAGE_TYPE)
      .map((n) => ({
        id: n.id,
        parentId: (n.data?.parentId as string) ?? null,
        title: (n.data?.label as string) ?? '',
        imageRefs: (n.data?.imageRefs as string[]) ?? undefined,
        note: (n.data?.note as string) ?? undefined,
      }));
  }, [store.nodes]);

  // 画布宿主 ref 与 maxGraph 渲染器实例（B 阶段：用 maxGraph 替代 LiteGraphCanvas 渲染脑图）。
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<MaxGraphMindMapRenderer | null>(null);

  // 数据变化时重新布局 + 重绘（布局仍走 radialLayout，渲染走 maxGraph）。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) { return; }
    if (!rendererRef.current) {
      rendererRef.current = new MaxGraphMindMapRenderer(host, { factory: createMaxGraph });
    }
    const { positions } = radialLayout({ nodes: mindMapData });
    rendererRef.current.render(toRenderModel(mindMapData, positions));
  }, [mindMapData]);

  // 卸载时释放渲染器。
  useEffect(() => {
    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, []);

  const applyRadialLayout = useCallback(() => {
    const { positions } = radialLayout({ nodes: mindMapData });
    useWorkflowEditorStore.setState({
      nodes: store.nodes.map((n) => {
        const p = positions[n.id];
        return p ? { ...n, position: { x: p.x, y: p.y } } : n;
      }),
    });
  }, [mindMapData, store.nodes]);

  const handleExportDrawio = useCallback(() => {
    const { positions } = radialLayout({ nodes: mindMapData });
    const blob = buildDrawioBlob({ nodes: mindMapData, positions });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mindmap.drawio';
    a.click();
    URL.revokeObjectURL(url);
  }, [mindMapData]);

  const handleImportFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) { return; }
    const text = await file.text();
    const doc = importMode === 'drawio' ? drawioToMindMap(text) : { nodes: markdownToMindMap(text), positions: {} };
    const nodes = doc.nodes.map((d, i) => ({
      id: d.id,
      type: d.imageRefs?.length ? MIND_MAP_IMAGE_TYPE : MIND_MAP_TYPE,
      position: doc.positions?.[d.id] ?? { x: 120 + i * 40, y: 120 + i * 40 },
      data: { label: d.title, parentId: d.parentId, note: d.note, imageRefs: d.imageRefs },
    }));
    const edges = doc.nodes
      .filter((d) => d.parentId)
      .map((d) => ({ id: `e-${d.parentId}-${d.id}`, source: d.parentId!, target: d.id }));
    useWorkflowEditorStore.setState({ nodes, edges });
    setShowImport(false);
  }, [importMode]);

  const insertImageNode = useCallback(() => {
    // 复用 workflow 的 mediaImport 后端把图片存 IndexedDB，返回 ref 后建图片节点。
    store.addNode(MIND_MAP_IMAGE_TYPE, { x: 200, y: 200 });
  }, [store]);

  const handleImportMarkdown = useCallback(() => {
    const doc = { nodes: markdownToMindMap(importText || '') };
    const nodes = doc.nodes.map((d, i) => ({
      id: d.id,
      type: MIND_MAP_TYPE,
      position: { x: 120 + i * 40, y: 120 + i * 40 },
      data: { label: d.title, parentId: d.parentId, note: d.note },
    }));
    const edges = doc.nodes
      .filter((d) => d.parentId)
      .map((d) => ({ id: `e-${d.parentId}-${d.id}`, source: d.parentId!, target: d.id }));
    useWorkflowEditorStore.setState({ nodes, edges });
    setShowImport(false);
    setImportText('');
  }, [importText]);

  return (
    <div className="mindmap-panel" data-active={active}>
      <div className="mindmap-toolbar">
        <button onClick={applyRadialLayout} title="放射状布局">⌖ 放射布局</button>
        <button onClick={() => setShowImport((v) => !v)} title="导入">⬇ 导入</button>
        <button onClick={handleExportDrawio} title="导出为飞书可读 .drawio">⬆ 导出 .drawio</button>
        <button onClick={insertImageNode} title="插入图片节点">🖼 图片节点</button>
        <span className="mindmap-count">{mindMapData.length} 个主题</span>
      </div>
      {showImport && (
        <div className="mindmap-import">
          <div className="mindmap-import-tabs">
            <button className={importMode === 'drawio' ? 'on' : ''} onClick={() => setImportMode('drawio')}>drawio 文件</button>
            <button className={importMode === 'markdown' ? 'on' : ''} onClick={() => setImportMode('markdown')}>Markdown 文本</button>
          </div>
          {importMode === 'drawio' ? (
            <input ref={fileRef} type="file" accept=".drawio,.xml" onChange={handleImportFile} />
          ) : (
            <>
              <textarea
                placeholder={'# 根主题\n## 分支 A\n### 叶子\n## 分支 B'}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                rows={8}
              />
              <button onClick={handleImportMarkdown}>解析并导入</button>
            </>
          )}
        </div>
      )}
      <div className="mindmap-canvas-host" ref={hostRef} data-renderer="maxgraph">
        {/* maxGraph 画布在此挂载（B 阶段由 MaxGraphMindMapRenderer 接管，替代 LiteGraphCanvas） */}
      </div>
    </div>
  );
}
