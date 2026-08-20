/*---------------------------------------------------------------------------------------------
 *  workflowManager — ComfyTV workflow 上传/链接（对齐 ComfyTV 前端 api + workflowCombo）。
 *
 *  ComfyTV 的 ImageStage 顶部有两个按钮：
 *    - ⬆ Upload workflow → POST /comfytv/workflows/import {kind, filename, content}
 *    - 🔗 Link workflow   → GET /comfytv/workflows/native?kind= → POST /comfytv/workflows/link
 *  成功后前端 addOptionEverywhere(kind, label) 把新 label 塞进所有相关节点的
 *  workflow COMBO options，并 setDirtyCanvas 重绘。
 *
 *  本模块是纯函数层（无 React / 无 LiteGraph 直接依赖），负责：
 *    - 调 ComfyTV 后端端点（通过 ComfyUI baseUrl 直连，ComfyUI 开 --enable-cors-header）
 *    - 把「新增 workflow option」广播成全局事件，由 LiteGraphCanvas 落地到
 *      已存在节点的 widget.options（对齐 addOptionEverywhere）。
 *--------------------------------------------------------------------------------------------*/

export interface ImportWorkflowResult {
	ok: boolean;
	kind: string;
	label: string;
	file_path?: string;
	error?: string;
}

export interface NativeWorkflow {
	path: string;
	name: string;
	mtime?: number;
	size?: number;
	is_linked?: boolean;
	linked_id?: number | null;
}

export interface LinkWorkflowResult {
	ok: boolean;
	kind?: string;
	label?: string;
	file_path?: string;
	link_type?: number;
	error?: string;
}

function comfyUrl(baseUrl: string, path: string): string {
	return `${baseUrl.replace(/\/$/, '')}${path}`;
}

/** POST /comfytv/workflows/import — 上传 ComfyUI 画布 JSON 内容为 ComfyTV workflow。 */
export async function importWorkflow(
	baseUrl: string,
	fetchImpl: typeof fetch,
	kind: string,
	filename: string,
	content: string,
): Promise<ImportWorkflowResult> {
	try {
		const res = await fetchImpl(comfyUrl(baseUrl, '/comfytv/workflows/import'), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ kind, filename, content }),
		});
		const body = (await res.json().catch(() => ({}))) as ImportWorkflowResult;
		if (!res.ok) {
			return { ok: false, kind, label: '', error: `HTTP ${res.status}${body.error ? `: ${body.error}` : ''}` };
		}
		return body;
	} catch (err) {
		return { ok: false, kind, label: '', error: err instanceof Error ? err.message : String(err) };
	}
}

/** GET /comfytv/workflows/native?kind= — 列出可 Link 的 ComfyUI 原生 workflow 文件。 */
export async function listNativeWorkflows(
	baseUrl: string,
	fetchImpl: typeof fetch,
	kind?: string,
): Promise<NativeWorkflow[]> {
	try {
		const q = kind ? `?kind=${encodeURIComponent(kind)}` : '';
		const res = await fetchImpl(comfyUrl(baseUrl, `/comfytv/workflows/native${q}`), { method: 'GET' });
		if (!res.ok) { return []; }
		const body = (await res.json()) as { workflows?: NativeWorkflow[] };
		return body.workflows ?? [];
	} catch {
		return [];
	}
}

/** POST /comfytv/workflows/link — 链接一个已存在的 ComfyUI 原生 workflow。 */
export async function linkWorkflow(
	baseUrl: string,
	fetchImpl: typeof fetch,
	kind: string,
	path: string,
	label?: string,
): Promise<LinkWorkflowResult> {
	try {
		const res = await fetchImpl(comfyUrl(baseUrl, '/comfytv/workflows/link'), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ kind, path, ...(label ? { label } : {}) }),
		});
		const body = (await res.json().catch(() => ({}))) as LinkWorkflowResult;
		if (!res.ok) {
			return { ok: false, error: `HTTP ${res.status}${body.error ? `: ${body.error}` : ''}` };
		}
		return body;
		} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
		}
