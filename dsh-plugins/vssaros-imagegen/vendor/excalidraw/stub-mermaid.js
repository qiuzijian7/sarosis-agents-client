/**
 * mermaid-to-excalidraw 的替身（体积取舍）。
 *
 * 为什么 stub 掉：Excalidraw 0.18 自带"把 mermaid 转成画布元素"的功能，
 * 但它会拖进 mermaid + cytoscape + katex（约 2.6MB）。
 * 我们不需要这个功能，换成会明确报错的替身：真被调用时告诉用户"没随包"，
 * 而不是悄悄少一个功能。
 */
export const convertMermaidToExcalidraw = async () => {
	throw new Error('mermaid 转画布没有随 VsSaros 随包（体积取舍：mermaid + cytoscape + katex 约 2.6MB）');
};
export const convertMermaidToExcalidrawElements = async () => {
	throw new Error('mermaid 转画布没有随 VsSaros 随包（体积取舍：mermaid + cytoscape + katex 约 2.6MB）');
};
