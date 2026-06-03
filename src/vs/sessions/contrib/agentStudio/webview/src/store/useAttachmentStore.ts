/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Attachment Store (Zustand)
 *  Manages user-uploaded image/file attachments for the chat composer.
 *  Void-inspired: mirrors ChatAttachmentModel but simplified for webview React.
 *--------------------------------------------------------------------------------------------*/

import { create } from 'zustand';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Image MIME types supported by LLM APIs */
export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/bmp';

/** Maximum total attachment size: 30 MB (aligned with Void's limit) */
const MAX_TOTAL_SIZE = 30 * 1024 * 1024;
/** Maximum single image size: 10 MB */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
/** Maximum single file size: 30 MB */
const MAX_FILE_SIZE = 30 * 1024 * 1024;

export interface ChatAttachment {
	/** Unique ID (generated from hash or timestamp) */
	id: string;
	/** Attachment type */
	type: 'image' | 'file';
	/** Original filename */
	name: string;
	/** MIME type */
	mimeType: string;
	/**
	 * For images: base64-encoded data (without data: prefix).
	 * For text files: raw text content.
	 * For binary files: base64-encoded data.
	 */
	data: string;
	/** File size in bytes */
	size: number;
	/** Whether this image was pasted from clipboard */
	isPasted?: boolean;
	/**
	 * For images: object URL for thumbnail rendering.
	 * Must be revoked when attachment is removed.
	 */
	thumbnailUrl?: string;
}

interface AttachmentState {
	/** Current pending attachments (not yet sent) */
	attachments: ChatAttachment[];
}

interface AttachmentActions {
	/** Add an image attachment from a File object */
	addImage: (file: File) => Promise<void>;
	/** Add an image from a paste event (clipboard DataTransfer) */
	addPastedImage: (dataTransfer: DataTransfer) => Promise<void>;
	/** Add a file attachment */
	addFile: (file: File) => Promise<void>;
	/** Remove an attachment by ID */
	removeAttachment: (id: string) => void;
	/** Clear all pending attachments */
	clearAttachments: () => void;
	/**
	 * Convert pending attachments to the payload format for chat.send.
	 * Returns attachment data without thumbnailUrl (not needed on host side).
	 */
	toPayload: () => Array<{
		id: string;
		type: 'image' | 'file';
		name: string;
		mimeType: string;
		data: string;
		size: number;
		isPasted?: boolean;
	}>;
	/** Check if the model supports images (vision capability) */
	getImageSupportWarning: (modelSupportsImages?: boolean) => string | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Check if a filename has an image extension */
function isImageFile(name: string): boolean {
	return /\.(png|jpe?g|gif|bmp|webp)$/i.test(name);
}

/** Get MIME type from file extension */
function getImageMimeType(fileName: string): ImageMimeType {
	const ext = fileName.split('.').pop()?.toLowerCase();
	switch (ext) {
		case 'png': return 'image/png';
		case 'jpg': case 'jpeg': return 'image/jpeg';
		case 'gif': return 'image/gif';
		case 'webp': return 'image/webp';
		case 'bmp': return 'image/bmp';
		default: return 'image/png'; // fallback
	}
}

/** Generate a simple unique ID */
function generateId(): string {
	return `att_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

/** Read a File as base64 string */
function fileToBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const result = reader.result as string;
			// Strip data URL prefix (e.g., "data:image/png;base64,")
			const base64 = result.split(',')[1] || result;
			resolve(base64);
		};
		reader.onerror = () => reject(new Error('Failed to read file'));
		reader.readAsDataURL(file);
	});
}

/** Read a File as text string */
function fileToText(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(new Error('Failed to read file'));
		reader.readAsText(file);
	});
}

/**
 * Resize an image to fit within LLM token budget constraints.
 * Based on Void's resizeImage: max 2048px long side, 768px short side.
 * Returns base64-encoded PNG data.
 */
function resizeImage(base64Data: string, originalMimeType: string): Promise<string> {
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () => {
			const MAX_LONG = 2048;
			const MAX_SHORT = 768;

			let { width, height } = img;

			// Step 1: Scale down if any side > MAX_LONG
			if (width > MAX_LONG || height > MAX_LONG) {
				const scale = MAX_LONG / Math.max(width, height);
				width = Math.round(width * scale);
				height = Math.round(height * scale);
			}

			// Step 2: Scale short side to MAX_SHORT if it exceeds
			const shortSide = Math.min(width, height);
			if (shortSide > MAX_SHORT) {
				const scale = MAX_SHORT / shortSide;
				width = Math.round(width * scale);
				height = Math.round(height * scale);
			}

			// Draw to canvas and export as PNG
			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext('2d');
			if (!ctx) {
				resolve(base64Data);
				return;
			}
			ctx.drawImage(img, 0, 0, width, height);

			// Export as PNG base64 (strip prefix)
			const dataUrl = canvas.toDataURL('image/png');
			resolve(dataUrl.split(',')[1] || dataUrl);
		};
		img.onerror = () => {
			// If image fails to load, return original data
			resolve(base64Data);
		};
		img.src = `data:${originalMimeType};base64,${base64Data}`;
	});
}

/** Check if a MIME type is a text file */
function isTextMimeType(mimeType: string): boolean {
	return mimeType.startsWith('text/')
		|| mimeType === 'application/json'
		|| mimeType === 'application/xml'
		|| mimeType === 'application/javascript'
		|| mimeType === 'application/typescript'
		|| mimeType === 'application/x-yaml'
		|| mimeType === 'application/markdown'
		|| mimeType === 'application/x-python';
}

// ─── Store ──────────────────────────────────────────────────────────────────

export const useAttachmentStore = create<AttachmentState & AttachmentActions>((set, get) => ({
	attachments: [],

	addImage: async (file: File) => {
		// Size check
		if (file.size > MAX_IMAGE_SIZE) {
			throw new Error(`图片大小 ${formatSize(file.size)} 超过限制 ${formatSize(MAX_IMAGE_SIZE)}`);
		}

		// Total size check
		const totalSize = get().attachments.reduce((sum, a) => sum + a.size, 0) + file.size;
		if (totalSize > MAX_TOTAL_SIZE) {
			throw new Error(`附件总大小超过限制 ${formatSize(MAX_TOTAL_SIZE)}`);
		}

		const mimeType = getImageMimeType(file.name);
		const base64Data = await fileToBase64(file);

		// Resize image to reduce token usage
		const resizedData = await resizeImage(base64Data, mimeType);

		// Create thumbnail object URL
		const thumbnailUrl = `data:${mimeType};base64,${resizedData}`;

		const attachment: ChatAttachment = {
			id: generateId(),
			type: 'image',
			name: file.name,
			mimeType,
			data: resizedData,
			size: resizedData.length, // approximate size after resize
			thumbnailUrl,
		};

		set(state => ({ attachments: [...state.attachments, attachment] }));
	},

	addPastedImage: async (dataTransfer: DataTransfer) => {
		// Find image in data transfer
		const imageFile = Array.from(dataTransfer.files).find(f => f.type.startsWith('image/'));
		if (!imageFile) {
			throw new Error('剪贴板中没有图片');
		}

		const mimeType = getImageMimeType(imageFile.name || 'pasted.png');
		const base64Data = await fileToBase64(imageFile);
		const resizedData = await resizeImage(base64Data, mimeType);
		const thumbnailUrl = `data:${mimeType};base64,${resizedData}`;

		const attachment: ChatAttachment = {
			id: generateId(),
			type: 'image',
			name: imageFile.name || `粘贴图片_${new Date().toLocaleTimeString('zh-CN')}.png`,
			mimeType,
			data: resizedData,
			size: resizedData.length,
			isPasted: true,
			thumbnailUrl,
		};

		set(state => ({ attachments: [...state.attachments, attachment] }));
	},

	addFile: async (file: File) => {
		// If it's an image, use addImage instead
		if (isImageFile(file.name) || file.type.startsWith('image/')) {
			return get().addImage(file);
		}

		// Size check
		if (file.size > MAX_FILE_SIZE) {
			throw new Error(`文件大小 ${formatSize(file.size)} 超过限制 ${formatSize(MAX_FILE_SIZE)}`);
		}

		// Total size check
		const totalSize = get().attachments.reduce((sum, a) => sum + a.size, 0) + file.size;
		if (totalSize > MAX_TOTAL_SIZE) {
			throw new Error(`附件总大小超过限制 ${formatSize(MAX_TOTAL_SIZE)}`);
		}

		// Read file content
		let data: string;
		if (isTextMimeType(file.type)) {
			data = await fileToText(file);
		} else {
			data = await fileToBase64(file);
		}

		const attachment: ChatAttachment = {
			id: generateId(),
			type: 'file',
			name: file.name,
			mimeType: file.type || 'application/octet-stream',
			data,
			size: file.size,
		};

		set(state => ({ attachments: [...state.attachments, attachment] }));
	},

	removeAttachment: (id: string) => {
		set(state => ({ attachments: state.attachments.filter(a => a.id !== id) }));
	},

	clearAttachments: () => {
		set({ attachments: [] });
	},

	toPayload: () => {
		return get().attachments.map(a => ({
			id: a.id,
			type: a.type,
			name: a.name,
			mimeType: a.mimeType,
			data: a.data,
			size: a.size,
			isPasted: a.isPasted,
		}));
	},

	getImageSupportWarning: (modelSupportsImages?: boolean) => {
		const { attachments } = get();
		const hasImage = attachments.some(a => a.type === 'image');
		if (hasImage && !modelSupportsImages) {
			return '当前模型不支持图片输入，图片附件将被忽略';
		}
		return null;
	},
}));

// ─── Utility ────────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
	if (bytes >= 1024 * 1024) {
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
	if (bytes >= 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${bytes} B`;
}
