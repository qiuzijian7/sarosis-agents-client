/*---------------------------------------------------------------------------------------------
 *  kbDocConvertChannel（common 侧）— 知识库「非文本素材 → 文本」的通道契约。
 *
 *  ⚠ 为什么单独放 common：通道名与返回类型要**同时**被
 *    · `electron-main/kbDocConvertChannel.ts`（实现，含 `child_process`）
 *    · 渲染侧 `browser/kbImportController.ts`（调用）
 *    使用，而渲染进程**不能** import electron-main 模块（会拖进 node 专属依赖）。
 *    与 `common/subAgentKernelProcChannel.ts` 的拆法完全一致 ⇒ 单一真源。
 *--------------------------------------------------------------------------------------------*/

/** 渲染侧 `ipcRenderer.invoke` 与主进程 `validatedIpcMain.handle` 共用的通道名。 */
export const KB_EXTRACT_DOC_TEXT_CHANNEL = 'vscode:kbExtractDocText';

/**
 * 支持「先转文本」的素材扩展名。
 *
 * ★ 2026-09-24（用户要求「pdf/doc/epub 直接给 LLM 解读」）：
 *   · `.pdf`  —— 主进程 python（PyMuPDF4LLM 结构化 / pypdf 回退，含图片导出）；
 *   · `.epub` / `.docx` —— 主进程 TS 自解析 zip（`common/kbArchiveExtract.ts`，**零外部依赖、不需 python**）。
 * 三者统一出口：同目录同名 `.md`（知识库构建管线零改动接手）+ 聊天框可直接拿到纯文本附件。
 */
export const KB_DOC_SOURCE_EXTENSIONS: readonly string[] = ['.pdf', '.epub', '.docx'];

/**
 * `vscode:kbExtractDocText` 的入参。
 *
 * `markdownImagePrefix` / `targetImageDir` 一起决定**图片怎么落地**：
 *   · 提取出的图片文件统一复制到 `targetImageDir`（绝对路径，由主进程 mkdir + 复制）；
 *   · markdown 正文里的图片引用改写成 `<markdownImagePrefix>/img-01.png`（相对路径，
 *     与知识库「图片相对引用」的约定一致 —— 预览与飞书同步都按相对路径解析）。
 *
 * 二者都由渲染侧（`kbImportController`）算好传入，主进程不需要知道 vault 结构 ⇒ 职责清晰。
 */
export interface IKbExtractDocTextRequest {
	/** 待提取的文档绝对路径（pdf / epub / docx）。 */
	filePath: string;
	/** 写进 markdown 的图片相对路径前缀，例如 `assets/动画优化`。缺省则不产图片引用。 */
	markdownImagePrefix?: string;
	/** 图片实际落盘的绝对目录，例如 `E:\VsSarosVault\库\raw\assets\动画优化`。 */
	targetImageDir?: string;
}

/** `vscode:kbExtractDocText` 的返回形态。 */
export interface IKbExtractDocTextResult {
	ok: boolean;
	/** Markdown 文本（仅 `ok=true`；扫描件无文字层时可能为空串）。 */
	text?: string;
	/** PDF 总页数 —— 用于区分「空文档」与「扫描件（有页无字）」。 */
	pages?: number;
	/** 提取并落盘的图片张数。 */
	imageCount?: number;
	/** 实际使用的提取后端（便于排查与日志）。 */
	backend?: 'pymupdf4llm' | 'pypdf' | 'epub' | 'docx';
	/** 文本超上限被截断。 */
	truncated?: boolean;
	/** 失败原因（仅 `ok=false`）。 */
	error?: string;
}
