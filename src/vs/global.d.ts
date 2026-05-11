/*---------------------------------------------------------------------------------------------
 *  Global type declarations for browser APIs not in TypeScript lib
 *--------------------------------------------------------------------------------------------*/

// Trusted Types API - using any to avoid complex type matching
declare var TrustedHTML: any;
declare var TrustedScript: any;
declare var TrustedScriptURL: any;

declare interface TrustedTypePolicyOptions {
	createHTML?: (input: string) => string;
	createScript?: (input: string) => string;
	createScriptURL?: (input: string) => string;
}

declare interface TrustedTypePolicy {
	createHTML(input: string): any;
	createScript(input: string): any;
	createScriptURL(input: string): any;
}

// WebGPU API - using const enums
declare const GPUBufferUsage: {
	MAP_READ: number;
	MAP_WRITE: number;
	COPY_SRC: number;
	COPY_DST: number;
	INDEX: number;
	VERTEX: number;
	UNIFORM: number;
	STORAGE: number;
	INDIRECT: number;
	QUERY_RESOLVE: number;
};

declare const GPUTextureUsage: {
	COPY_SRC: number;
	COPY_DST: number;
	TEXTURE_BINDING: number;
	STORAGE_BINDING: number;
	RENDER_ATTACHMENT: number;
};

declare interface GPUCanvasContext {
	configure(configuration: any): void;
	getConfiguration(): any;
	getCurrentTexture(): any;
	unconfigure(): void;
}

// File System Access API
declare interface FilePickerAcceptType {
	description?: string;
	accept: Record<string, string[]>;
}

declare interface FileSystemHandle {
	kind: 'file' | 'directory';
	name: string;
	queryPermission(descriptor?: any): Promise<any>;
	requestPermission(descriptor?: any): Promise<any>;
}

declare type MIMEType = string;
declare type FileExtension = string;
declare type PermissionState = 'granted' | 'denied' | 'prompt';

declare interface Window {
	showOpenFilePicker?(options?: any): Promise<any[]>;
	showSaveFilePicker?(options?: any): Promise<any>;
	showDirectoryPicker?(options?: any): Promise<any>;
	trustedTypes?: {
		createPolicy(name: string, policyOptions: TrustedTypePolicyOptions): TrustedTypePolicy;
	};
}

declare interface CodeWindow extends Window {
	showOpenFilePicker?(options?: any): Promise<any[]>;
	showSaveFilePicker?(options?: any): Promise<any>;
	showDirectoryPicker?(options?: any): Promise<any>;
}
