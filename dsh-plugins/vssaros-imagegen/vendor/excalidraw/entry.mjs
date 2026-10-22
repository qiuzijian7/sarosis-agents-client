/**
 * 画布 bundle 的入口（Excalidraw + React 一起打进产物 ⇒ 页面不需要任何外部依赖）。
 *
 * 为什么 react 也打进来：画布页是**我们自己的插件页**（不是 dsh 的客户端包），页面里没有 React 可借 ⇒
 * 与其引 CDN（离线不可用）不如直接打进去（React 18 MIT ≈ 130KB）。
 *
 * 暴露出来的这几样就是画布页要用的全部能力：
 *   Excalidraw / createRoot / createElement —— 渲染
 *   exportToBlob / serializeAsJSON —— 导出选区 PNG（给 Agent 看）与存取场景
 */
export { Excalidraw, exportToBlob, serializeAsJSON } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
export { createRoot } from 'react-dom/client';
export { createElement } from 'react';
