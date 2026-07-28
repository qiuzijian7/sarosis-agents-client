/*---------------------------------------------------------------------------------------------
 *  kbSqliteStore.ts — KB 文档全文检索存储（主进程执行，better-sqlite3 FTS5）。
 *
 *  与 CodebaseGraph 的 codebaseGraphSqliteStore 共用同一个 better-sqlite3 实例，
 *  但在同一个 db 文件中使用不同的表前缀（`kb_*`）。
 *--------------------------------------------------------------------------------------------*/

// 主进程方能加载 better-sqlite3（@vscode/sqlite3 API 不兼容，不可回退）
let Database: any;
try {
	({ default: Database } = require('better-sqlite3') as any);
} catch {
	// better-sqlite3 不可用 → KbSqliteStore.open() 会抛明确错误
}

export interface IKbStoreDoc {
	uri: string;
	name: string;
	section: string;
	mtime: number;
	size: number;
	text: string;
}

export interface IKbFts5Result {
	uri: string;
	name: string;
	section: string;
	rank: number;
	snippet: string;
}

const KB_DOCS_TABLE = 'kb_docs';
const KB_FTS_TABLE = 'kb_docs_fts';

const CREATE_DOCS = `CREATE TABLE IF NOT EXISTS ${KB_DOCS_TABLE} (
	uri TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	section TEXT NOT NULL DEFAULT 'library',
	mtime INTEGER NOT NULL DEFAULT 0,
	size INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID`;

const CREATE_FTS = `CREATE VIRTUAL TABLE IF NOT EXISTS ${KB_FTS_TABLE}
	USING fts5(uri, name, text, tokenize='unicode61 remove_diacritics 2')`;

const INSERT_DOC = `INSERT OR REPLACE INTO ${KB_DOCS_TABLE}
	(uri, name, section, mtime, size) VALUES (@uri, @name, @section, @mtime, @size)`;

const INSERT_FTS = `INSERT OR REPLACE INTO ${KB_FTS_TABLE}
	(uri, name, text) VALUES (@uri, @name, @text)`;

const DELETE_DOC = `DELETE FROM ${KB_DOCS_TABLE} WHERE uri = @uri`;
const DELETE_FTS = `DELETE FROM ${KB_FTS_TABLE} WHERE uri = @uri`;

const SEARCH_FTS = `SELECT uri, name, section, rank, snippet(${KB_FTS_TABLE}, 1, '<mark>', '</mark>', '...', 64) as snippet
	FROM ${KB_FTS_TABLE} WHERE ${KB_FTS_TABLE} MATCH @query
	ORDER BY rank LIMIT @limit`;

// FTS5 中文前缀查询（CJK unicode61 按双字切分，短语匹配可能漏结果 → 用前缀通配回退）
const SEARCH_FTS_PREFIX = `SELECT uri, name, section, rank, snippet(${KB_FTS_TABLE}, 1, '<mark>', '</mark>', '...', 64) as snippet
	FROM ${KB_FTS_TABLE} WHERE ${KB_FTS_TABLE} MATCH @query
	ORDER BY rank LIMIT @limit`;

export class KbSqliteStore {

	private _db: any = null;
	private _opened: boolean = false;

	open(dbPath: string, opts?: { readOnly?: boolean }): void {
		if (!Database) {
			throw new Error('better-sqlite3 not available — KbSqliteStore requires Electron main process');
		}
		if (this._opened) { this.close(); }

		this._db = new Database(dbPath, {
			readonly: !!opts?.readOnly,
		});

		// 启用 WAL + mmap 以降低锁竞争
		this._db.pragma('journal_mode = WAL');
		this._db.pragma('mmap_size = 268435456'); // 256MB

		// 创建表
		this._db.exec(CREATE_DOCS);
		this._db.exec(CREATE_FTS);

		this._opened = true;
	}

	close(): void {
		if (this._db) {
			try { this._db.close(); } catch { /* already closed */ }
			this._db = null;
		}
		this._opened = false;
	}

	/** 批量写入文档（事务内完成，单条损坏不可写时跳过不中断批次）。 */
	upsertDocsBatch(docs: IKbStoreDoc[]): void {
		if (!this._db) { throw new Error('DB not opened'); }
		const insertDocStmt = this._db.prepare(INSERT_DOC);
		const insertFtsStmt = this._db.prepare(INSERT_FTS);

		const tx = this._db.transaction((items: IKbStoreDoc[]) => {
			for (const d of items) {
				try {
					insertDocStmt.run({
						uri: d.uri, name: d.name, section: d.section,
						mtime: d.mtime, size: d.size,
					});
					insertFtsStmt.run({
						uri: d.uri, name: d.name, text: d.text ?? '',
					});
				} catch {
					// 单条损坏（超大文本 / 编码异常）→ 跳过，不中断批次
				}
			}
		});
		tx(docs);
	}

	/** 删除指定文档。 */
	deleteDoc(uri: string): void {
		if (!this._db) { return; }
		this._db.prepare(DELETE_DOC).run({ uri });
		this._db.prepare(DELETE_FTS).run({ uri });
	}

	/** FTS5 全文搜索（CJK 友好：双字切分对齐 unicode61 bigram tokenizer）。 */
	search(query: string, limit: number = 20): IKbFts5Result[] {
		if (!this._db) { return []; }
		// 转义 FTS5 特殊字符（保留 * 用于通配回退）
		const escaped = query.replace(/[\"\-\(\)\:\^]/g, ' ').replace(/\*/, ' ').trim();
		if (!escaped) { return []; }

		// CJK 预处理：将中文字符段切为双字 bigram（unicode61 tokenizer 用 2-gram）
		const processed = this._preprocessCJK(escaped);

		const unique = (rows: IKbFts5Result[]) => {
			const seen = new Set<string>();
			return rows.filter(r => {
				if (seen.has(r.uri)) { return false; }
				seen.add(r.uri); return true;
			});
		};

		try {
			// 1) 先尝试短语/单词匹配（CJK 已预切分为 bigram 序列）
			const phraseQuery = processed.includes(' ') ? `"${processed}"` : processed;
			let rows = this._db.prepare(SEARCH_FTS).all({ query: phraseQuery, limit }) as any[];
			if (rows.length > 0) {
				return unique(rows.map((r: any) => this._mapRow(r)));
			}

			// 2) 前缀通配回退（每个 token 加 * 后缀）
			rows = this._db.prepare(SEARCH_FTS_PREFIX).all({
				query: processed.split(/\s+/).filter(Boolean).map(t => `"${t}"*`).join(' '),
				limit,
			}) as any[];
			return unique(rows.map((r: any) => this._mapRow(r)));
		} catch {
			return [];
		}
	}

	/** 将 CJK 字符段切为双字 bigram（对齐 unicode61 tokenizer 2-gram）。 */
	private _preprocessCJK(input: string): string {
		const out: string[] = [];
		let cjkBuf = '';
		const flushCJK = () => {
			if (cjkBuf.length === 0) { return; }
			if (cjkBuf.length <= 2) {
				out.push(cjkBuf);
			} else {
				// 滑动窗口双字切分：机器学习 → 机器 器学 学习
				for (let i = 0; i < cjkBuf.length - 1; i++) {
					out.push(cjkBuf[i] + cjkBuf[i + 1]);
				}
			}
			cjkBuf = '';
		};

		for (let i = 0; i < input.length; i++) {
			const ch = input[i];
			if (/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(ch)) {
				// CJK 字符 → 缓冲
				cjkBuf += ch;
			} else if (/\s/.test(ch)) {
				// 空白 → flush CJK buffer + 保留分隔
				flushCJK();
				out.push(' ');
			} else {
				// 非 CJK 非空白 → flush CJK buffer + 直接输出原字
				flushCJK();
				out.push(ch);
			}
		}
		flushCJK();
		return out.join('').replace(/\s+/g, ' ').trim();
	}

	private _mapRow(r: any): IKbFts5Result {
		return {
			uri: r.uri,
			name: r.name,
			section: r.section,
			rank: r.rank,
			snippet: r.snippet || '',
		};
	}

	/** 获取所有文档（不含 text——text 在 FTS5 中，高频场景走 search）。 */
	getAllDocs(): IKbStoreDoc[] {
		if (!this._db) { return []; }
		const rows = this._db.prepare(
			`SELECT d.uri, d.name, d.section, d.mtime, d.size, f.text
			 FROM ${KB_DOCS_TABLE} d LEFT JOIN ${KB_FTS_TABLE} f ON d.uri = f.uri`
		).all();
		return rows as IKbStoreDoc[];
	}

	getDocCount(): number {
		if (!this._db) { return 0; }
		const row = this._db.prepare(`SELECT COUNT(*) as cnt FROM ${KB_DOCS_TABLE}`).get() as any;
		return row?.cnt ?? 0;
	}

	/** 已索引文档的最大 mtime（增量同步用：只重读比它新的文件）。 */
	getMaxMtime(): number {
		if (!this._db) { return 0; }
		const row = this._db.prepare(`SELECT MAX(mtime) as mx FROM ${KB_DOCS_TABLE}`).get() as any;
		return typeof row?.mx === 'number' ? row.mx : 0;
	}

	/** 返回所有已索引文档的 uri + mtime + size（增量变更/删除检测用）。 */
	getAllUris(): { uri: string; mtime: number; size: number }[] {
		if (!this._db) { return []; }
		return this._db.prepare(`SELECT uri, mtime, size FROM ${KB_DOCS_TABLE}`).all() as any[];
	}

	clear(): void {
		if (!this._db) { return; }
		this._db.exec(`DELETE FROM ${KB_DOCS_TABLE}`);
		this._db.exec(`DELETE FROM ${KB_FTS_TABLE}`);
	}
}
