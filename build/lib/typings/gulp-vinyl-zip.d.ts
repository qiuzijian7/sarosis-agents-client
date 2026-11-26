
declare module 'gulp-vinyl-zip' {
	export function src(): NodeJS.ReadWriteStream;
	export function zip(zipPath: string, options?: { compress?: boolean; unlessEmpty?: boolean }): NodeJS.ReadWriteStream;
}
