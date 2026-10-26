/*---------------------------------------------------------------------------------------------
 *  index.js — standalone 入口（IDE webview / 独立浏览器页用）
 *
 * 由 `webapp/build.mjs` 打成 `lib/detail.bundle.js`（**自带 React**）。
 * 插件服务端出的壳只提供 `<div id="root">` + `<script src="…/react-detail.js">`。
 *--------------------------------------------------------------------------------------------*/
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createDetailView } from './detailView.js';

const { MemoryDetailPage } = createDetailView(React);

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    React.createElement(MemoryDetailPage, {
      // 独立页没有「上一屏」可退 ⇒ 用 history.back()（从 IDE 打开时历史里有上一页）
      onBack: () => { try { window.history.back(); } catch (e) { /* 忽略 */ } },
    }),
  );
}
