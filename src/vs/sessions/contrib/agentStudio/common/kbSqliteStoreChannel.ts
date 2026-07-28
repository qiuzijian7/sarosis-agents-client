/*---------------------------------------------------------------------------------------------
 *  renderer ↔ main 进程之间的 KB SQLite FTS5 后端 IPC 契约。
 *
 *  设计原则：
 *  - 复用 CodebaseGraph 已有的主进程 SQLite 宿主模式（channel + handler）
 *  - 只暴露 KB 必需的 FTS5 全文检索 + 文档读写接口
 *  - 阈值：> 2000 文档自动切 SQLite，小库保持纯内存
 *--------------------------------------------------------------------------------------------*/

export const KB_SQLITE_STORE_CHANNEL = 'vssaros-kb-sqlite-store';

/** 序列化后的 KB 文档（IPC 可传递）。 */
export interface IKbSqliteDoc {
	uri: string;
	name: string;
	section: string;
	mtime: number;
	size: number;
	text: string;
}

/** FTS5 搜索结果。 */
export interface IKbFts5Result {
	uri: string;
	name: string;
	section: string;
	rank: number;
	snippet: string;
}

/** renderer 侧看到的 KB SQLite 后端接口。 */
export interface IKbSqliteBackend {
	/** 打开/创建数据库文件（每个 vault 一个 db）。 */
	open(dbPath: string, opts?: { readOnly?: boolean }): Promise<void>;
	/** 关闭当前数据库。 */
	close(): Promise<void>;

	/** 批量写入文档（事务内完成）。 */
	upsertDocsBatch(docs: IKbSqliteDoc[]): Promise<void>;
	/** 删除指定 URI 文档。 */
	deleteDoc(uri: string): Promise<void>;
	/** 清空所有数据。 */
	clear(): Promise<void>;

	/** FTS5 全文搜索（返回带 rank + snippet 的结果）。 */
	search(query: string, limit?: number): Promise<IKbFts5Result[]>;
	/** 获取所有文档（小号可选，大号走 search）。 */
	getAllDocs(): Promise<IKbSqliteDoc[]>;
	/** 文档总数。 */
	getDocCount(): Promise<number>;
	/** 已索引文档的最大 mtime（用于增量同步：只重读 mtime 更大的文件）。 */
	getMaxMtime(): Promise<number>;
	/** 返回所有已索引文档的 uri + mtime + size（用于增量变更/删除检测）。 */
	getAllUris(): Promise<{ uri: string; mtime: number; size: number }[]>;
}
