// @vssaros/dsh-kb — **React 工作台 · 第一刀（只读面）**（工作台重构 P3 第 5 个；方案稿 §6.11）。
//
// 范围（用户 2026-10-22 拍板 A 方案）：**库 + 笔记文件树 + 全量检索 + 正文阅读**。
//   编辑 / 整理 / 标签管理 / 库设置**仍留在 SSR 页**（那是第二刀）⇒ 本组件不假装有那些入口 ✓。
//
// 数据来源（全部复用现成接口，不新造语义）：
//   · `GET /x/kb/api/page`  ⇒ 库 + 两个文件树（库 / 笔记）+ 标签分类 + 自诊断（**正文不在里面** ✓）
//   · `GET /x/kb/api/doc?uri=`  ⇒ 点某个文件时再取正文（库大时不重复传输 ✓）
//   · `GET /x/kb/api/search?q=` ⇒ 全量检索（与页面同一个 `runFulltextSearch` ✓）
//
// 形态：左右两档（与工作流/看板同款）—— 左列 = 库选择 + 检索 + 文件树；右列 = 正文阅读面。
window.__ModuleLoader__.load({
	id: '@vssaros/dsh-kb',
	chunk: 'client.kb.js',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const moduleRequire = require;   // 装载器：用它 require.async 拉同包 client 子块
		const react = require('react');
		const h = react.createElement;
		const { useState, useEffect, useCallback } = react;

		const API = '/x/kb/api';
		/** 「笔记」区（可写区）的目录名 —— 与后端 `NOTES_DIR` 同值（`lib/core/kb.js`）。 */
		const NOTES_NAME = '笔记';
		// ⚠ 描述符要与清单 `vssaros.workbench` **逐字段一致**：宿主快照直接取这里的 description / icon，
		//   **不回落到清单** ⇒ 漏写就是"注册表里那一项说明是空的" ✗（2026-10-22 审计发现本包就漏了 description）。
		const DESCRIPTOR = {
			title: '知识库',
			description: '本地资料库：检索、导入、整理与关系图谱。',
			repository: 'vssaros:kb',
			icon: 'codicon:book',
			customFrame: true,
		};

		async function getJson(path) {
			const res = await fetch(API + path, { cache: 'no-store', credentials: 'same-origin' });
			const body = await res.json().catch(() => ({}));
			if (!res.ok || body.ok === false) { throw new Error(body.error || ('HTTP ' + res.status)); }
			return body;
		}

		/**
		 * 写动作（第二刀）：建笔记 / 建目录 / 重命名 / 删除。
		 *
		 * ⚠ 全部走**后端现成的**那几条路由（`/api/new` `/api/rename` `/api/delete`）——
		 *   它们已经有「只在**笔记**区内动」「名字非法字符拒」「文件锁 + 派生刷新」这些围栏 ✓ ⇒
		 *   前端**不重写**一遍校验（重写就是两份围栏，迟早不一致 ✗）。
		 */
		async function postJson(path, payload) {
			const res = await fetch(API + path, {
				method: 'POST',
				headers: { 'content-type': 'application/json; charset=utf-8' },
				body: JSON.stringify(payload),
				credentials: 'same-origin',
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok || body.ok === false) { throw new Error(body.error || ('HTTP ' + res.status)); }
			return body;
		}

		/** 目录树（折叠状态由父组件持有；点文件 = 打开正文；点**笔记区**目录 = 设为新建目标）。 */
		/** 目录下的文件总数（IDE sideview 的行尾计数口径：递归数文件，不数目录）。 */
		const countIn = (node) => (node && node.isDirectory
			? (node.children || []).reduce((n, child) => n + countIn(child), 0)
			: 1);
		/** 文件大小（>10KB 只留整 KB，避免行尾太长）。 */
		const sizeText = (bytes) => {
			if (typeof bytes !== 'number' || !Number.isFinite(bytes)) { return ''; }
			if (bytes >= 10240) { return Math.round(bytes / 1024) + ' KB'; }
			if (bytes >= 1024) { return (bytes / 1024).toFixed(1) + ' KB'; }
			return bytes + ' B';
		};
		/** 按扩展名给图标（sideview 那套：md 文档 / 图片 / 其它附件）。 */
		const iconOf = (name) => {
			const n = String(name || '').toLowerCase();
			if (/\.(md|markdown|txt)$/.test(n)) { return '📄'; }
			if (/\.(png|jpe?g|gif|webp|svg|bmp)$/.test(n)) { return '🖼️'; }
			if (/\.(mp4|mov|webm|mkv)$/.test(n)) { return '🎬'; }
			if (/\.(pdf)$/.test(n)) { return '📕'; }
			if (/\.(json|ya?ml|js|ts|css|html|py)$/.test(n)) { return '📜'; }
			return '📎';
		};

		function TreeNodes({ nodes, depth, open, toggle, onOpen, current, section, onPickDir, pickedDir }) {
			return nodes.map(node => {
				if (node.isDirectory) {
					const key = section + ':' + node.rel;
					const isOpen = open.has(key);
					return h('div', { key: 'd:' + key, className: 'kbt-dir' },
						h('div', {
							className: 'kbt-row kbt-dir-row', style: { paddingLeft: 6 + depth * 12 },
							role: 'button', tabIndex: 0,
							title: node.rel + (section === 'notes' ? '（点一下：设为「新建」的目标目录）' : ''),
							onClick: () => {
								toggle(key);
								// 只有「笔记」区可写（后端围栏同口径 ✓）⇒ 点它就设成新建目标
								if (section === 'notes' && onPickDir) { onPickDir(node.rel); }
							},
							onKeyDown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(key); if (section === 'notes' && onPickDir) { onPickDir(node.rel); } } },
						}, h('span', { className: 'wb-caret' }, isOpen ? '▾' : '▸'),
							h('span', { className: 'kbt-name' + (section === 'notes' && pickedDir === node.rel ? ' is-target' : ''), 'data-kb-dir-name': String(node.rel ?? '') }, '📁 ' + node.name),
							// 行尾计数（与 IDE sideview 一致：目录里有多少个文件）⇒ 不展开也能看出哪层有货 ✓
							h('span', { className: 'wb-card-sub kbt-count', 'data-kb-dir-count': String(countIn(node)) }, String(countIn(node)))),
						isOpen ? h('div', null, TreeNodes({ nodes: node.children || [], depth: depth + 1, open, toggle, onOpen, current, section, onPickDir, pickedDir })) : null);
				}
				const active = current && current.uri === node.abs;
				return h('div', {
					key: 'f:' + node.rel,
					className: 'kbt-row kbt-file' + (active ? ' is-current' : ''), 'data-kb-file': String(node.rel ?? node.name ?? ''),
					style: { paddingLeft: 6 + depth * 12 },
					role: 'button', tabIndex: 0, title: node.abs || node.rel,
					onClick: () => onOpen(node),
					onKeyDown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onOpen(node); } },
				}, h('span', { className: 'kbt-name' }, iconOf(node.name) + ' ' + node.name),
					// 大小（sideview 也显示；`missing` 的节点没有 size ⇒ 不占位 ✓）
					sizeText(node.size) ? h('span', { className: 'wb-card-sub kbt-count' }, sizeText(node.size)) : null);
			});
		}

		function KbPanel() {
			const [view, setView] = useState({ status: 'loading', data: null, error: '' });
			const [vaultId, setVaultId] = useState('');
			const [open, setOpen] = useState(() => new Set());
			const [doc, setDoc] = useState(null);        // { uri, title, content, bytes, truncated, error, loading }
			// ── 第二刀（写动作）：新建 / 重命名 / 删除 ──
			const [busy, setBusy] = useState('');
			const [newKind, setNewKind] = useState('file');     // file | folder
			const [newName, setNewName] = useState('');
			const [newDir, setNewDir] = useState('');           // vault 内相对目录（空 = 笔记根）
			const [renaming, setRenaming] = useState(false);
			const [renameTo, setRenameTo] = useState('');
			const [confirmDel, setConfirmDel] = useState(false);
			const [moving, setMoving] = useState(false);
			const [moveTo, setMoveTo] = useState('');
			const [hits, setHits] = useState(null);      // 检索结果（null = 没在搜）
			const [q, setQ] = useState('');
			const [note, setNote] = useState('');
			const [noteError, setNoteError] = useState(false);

			const say = (t, isError) => { setNote(String(t || '')); setNoteError(!!isError); };
			const load = useCallback(async () => {
				try {
					const body = await getJson('/page');
					setView({ status: 'ready', data: body, error: '' });
					const vaults = body.vaults || [];
					// ★ 2026-10-23（用户报「内容变空」）：**优先选有内容的库**。
					//   以前只看 `activeVault` → 若它是空库（0 文件 0 索引），页面就一片空白，
					//   而旁边其实还有装满笔记的库 ⇒ 现在按「有内容」优先，并在界面上说明切换过 ✓。
					const filesOf = (v) => {
						const secs = (v && v.sections) || {};
						return ['library', 'notes'].reduce((n, k) => n + ((secs[k] && secs[k].files) || 0), 0);
					};
					const hasContent = (v) => filesOf(v) > 0 || Number(v && v.indexed) > 0;
					setVaultId(prev => {
						if (prev && vaults.some(v => v.id === prev)) { return prev; }
						const preferred = [body.activeVault, vaults[0] && vaults[0].id].filter(Boolean);
						for (const id of preferred) {
							const v = vaults.find(x => x.id === id);
							if (v && hasContent(v)) { return id; }
						}
						const fallback = vaults.find(hasContent) || vaults[0];
						const wanted = preferred.length ? vaults.find(x => x.id === preferred[0]) : null;
						if (fallback && wanted && !hasContent(wanted)) {
							say('「' + (wanted.name || wanted.id) + '」没有文件，已切到有内容的「' + (fallback.name || fallback.id) + '」', false);
						}
						return fallback ? fallback.id : '';
					});
				} catch (e) {
					setView({ status: 'error', data: null, error: String(e && e.message || e) });
				}
			}, []);
			useEffect(() => { void load(); }, [load]);

			const openDoc = useCallback(async (node) => {
				const uri = node.abs || node.rel;
				setDoc({ uri, title: node.name, loading: true });
				try {
					const body = await getJson('/doc?uri=' + encodeURIComponent(uri));
					setDoc({ uri, title: node.name, content: body.content || '', bytes: body.bytes, truncated: body.truncated, loading: false });
				} catch (e) {
					setDoc({ uri, title: node.name, loading: false, error: String(e && e.message || e) });
				}
			}, []);

			const runSearch = useCallback(async (ev) => {
				if (ev) { ev.preventDefault(); }
				const query = String(q || '').trim();
				if (!query) { setHits(null); return; }
				say('正在检索…', false);
				try {
					const body = await getJson('/search?q=' + encodeURIComponent(query) + (vaultId ? '&vault=' + encodeURIComponent(vaultId) : ''));
					const items = Array.isArray(body.items) ? body.items : [];
					setHits(items);
					say('命中 ' + String(body.count ?? items.length) + ' 条' + (Array.isArray(body.reindex) && body.reindex.length ? '（索引刚重建）' : ''), false);
				} catch (e) {
					setHits([]);
					say('检索失败：' + String(e && e.message || e), true);
				}
			}, [q, vaultId]);

			/** 绝对路径 → vault 内相对路径（`笔记/甲.md`）；不在本库下 ⇒ 空串（调用方据此拒绝写）。 */
			const vaultRelOf = (abs) => {
				const dir = String((vault && vault.dir) || '');
				const target = String(abs || '');
				if (!dir || !target || target.indexOf(dir) !== 0) { return ''; }
				return target.slice(dir.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
			};
			/** 只有「笔记」区可写（后端 `resolveOrganizePath` 同一条围栏 ✓）。 */
			const writableRel = () => {
				const rel = doc ? vaultRelOf(doc.uri) : '';
				return rel.indexOf(NOTES_NAME + '/') === 0 ? rel : '';
			};

			const doCreate = async () => {
				if (!vault || busy) { return; }
				setBusy('create');
				try {
					const dir = NOTES_NAME + (newDir ? '/' + newDir : '');
					const body = await postJson('/new', { vaultId: vault.id, kind: newKind, dir, name: newName.trim() });
					setNewName('');
					await load();
					say('已创建' + (newKind === 'folder' ? '目录' : '笔记') + '：' + String(body.rel || body.name || ''), false);
				} catch (e) {
					say('创建失败：' + String(e && e.message || e), true);
				} finally { setBusy(''); }
			};

			const doRename = async () => {
				const from = writableRel();
				if (!from || busy) { return; }
				const wanted = renameTo.trim();
				if (!wanted) { say('名字不能为空', true); return; }
				const slash = from.lastIndexOf('/');
				const dirPart = slash >= 0 ? from.slice(0, slash + 1) : '';
				const hasExt = /\.[A-Za-z0-9]+$/.test(wanted);
				const to = dirPart + (hasExt || !/\.md$/i.test(from) ? wanted : wanted + '.md');
				setBusy('rename');
				try {
					await postJson('/rename', { vaultId: vault.id, from, to, mode: 'move' });
					setRenaming(false);
					setRenameTo('');
					await load();
					say('已重命名：' + to, false);
					// 正文跟着换路径（否则右栏还是旧地址）
					const abs = String(vault.dir) + '/' + to;
					setDoc({ uri: abs, title: to.slice(to.lastIndexOf('/') + 1), loading: true });
					try {
						const body = await getJson('/doc?uri=' + encodeURIComponent(abs));
						setDoc({ uri: abs, title: to.slice(to.lastIndexOf('/') + 1), content: body.content || '', bytes: body.bytes, truncated: body.truncated, loading: false });
					} catch { /* 读不到就留在"空"态，不假装成功 ✓ */ }
				} catch (e) {
					say('重命名失败：' + String(e && e.message || e), true);
				} finally { setBusy(''); }
			};

			const doDelete = async () => {
				const from = writableRel();
				if (!from || busy) { return; }
				setBusy('delete');
				try {
					await postJson('/delete', { vaultId: vault.id, from });
					setConfirmDel(false);
					setDoc(null);
					await load();
					say('已删除：' + from + '（可在旧页的回收区恢复）', false);
				} catch (e) {
					say('删除失败：' + String(e && e.message || e), true);
				} finally { setBusy(''); }
			};

			/**
			 * 「笔记」区里所有可作目标的目录（含根 `''`）—— 整理/移动的去处。
			 * ⚠ 必须是**惰性函数**：`vault` 在下面才声明 ⇒ 立即执行的 IIFE 会撞 TDZ ⇒ 整个组件崩 ✗（实测踩到 ✓）。
			 */
			const noteDirsOf = () => {
				const out = [''];
				const walk = (nodes, prefix) => {
					(nodes || []).forEach(node => {
						if (!node.isDirectory) { return; }
						const rel = prefix ? prefix + '/' + node.rel.replace(/^.*?\//, '') : node.rel;
						out.push(rel);
						walk(node.children, rel);
					});
				};
				walk(vault && vault.sections && vault.sections.notes ? vault.sections.notes.nodes : [], '');
				return out;
			};

			/** 整理 = 移动（复用 `/api/rename` 的 `mode:'move'` ⇒ 同一把锁、同一份围栏 ✓）。 */
			const doMove = async () => {
				const from = writableRel();
				if (!from || busy) { return; }
				const name = from.slice(from.lastIndexOf('/') + 1);
				const to = NOTES_NAME + (moveTo ? '/' + moveTo : '') + '/' + name;
				if (to === from) { say('已经在那个目录里了', true); return; }
				setBusy('move');
				try {
					await postJson('/rename', { vaultId: vault.id, from, to, mode: 'move' });
					setMoving(false);
					setMoveTo('');
					await load();
					say('已移动到：' + (moveTo ? NOTES_NAME + '/' + moveTo : NOTES_NAME), false);
					setDoc(null);
				} catch (e) {
					say('移动失败：' + String(e && e.message || e), true);
				} finally { setBusy(''); }
			};

			const data = view.data;
			const vaults = (data && data.vaults) || [];
			const vault = vaults.find(v => v.id === vaultId) || null;
			const toggleDir = (key) => setOpen(prev => { const next = new Set(prev); if (next.has(key)) { next.delete(key); } else { next.add(key); } return next; });

			const treeSection = (sectionKey, label) => {
				if (!vault || !vault.sections || !vault.sections[sectionKey]) { return null; }
				const sec = vault.sections[sectionKey];
				return h('section', { className: 'kbt-section', 'data-kb-section': sectionKey },
					h('div', { className: 'wb-group-hd' },
						h('span', null, label),
						h('span', { className: 'wb-card-sub' }, sec.missing ? '（目录不存在）' : (sec.truncated ? sec.files + '+' : sec.files) + ' 个文件')),
					sec.missing
						? h('p', { className: 'wb-empty' }, '这个库还没有「' + label + '」目录。')
						: h('div', { className: 'kbt-tree' }, (sec.nodes || []).length
							? TreeNodes({ nodes: sec.nodes, depth: 0, open, toggle: toggleDir, onOpen: openDoc, current: doc, section: sectionKey, onPickDir: (rel) => setNewDir(rel), pickedDir: newDir })
							: h('p', { className: 'wb-empty' }, '（空）')));
			};

			return h('div', { className: 'wb wb-kbt', 'data-vssaros-page': 'kb', 'data-vssaros-surface': 'workbench' },
				h('header', { className: 'wb-toolbar', 'data-dsh-workbench-toolbar': '' },
					h('h1', null, '知识库'),
					h('span', { className: 'wb-sub' }, (data ? vaults.length + ' 个库 · ' + data.totalDocs + ' 条索引 · 只读' : '只读')),
					h('span', { className: 'wb-spacer' }),
					h('button', { type: 'button', onClick: () => { void load(); } }, '⟳ 刷新')),
				view.status === 'error'
					? h('p', { className: 'wb-empty', 'data-kb-state': 'error', role: 'alert' }, '读取失败：' + view.error)
					: null,
				data && data.missing ? h('p', { className: 'wb-empty' }, '知识库根目录还不存在：', h('code', null, data.missing)) : null,
				h('div', { className: 'wb-split', 'data-kb-layout': 'split' },
					// 左列：库选择 + 检索 + 树
					h('section', { className: 'wb-pane wb-pane-left', 'data-kb-pane': 'tree' },
						vaults.length > 1
							? h('select', { className: 'wb-select', value: vaultId, 'aria-label': '选择知识库', 'data-kb-vault': '', onChange: (ev) => { setVaultId(ev.target.value); setHits(null); } },
								vaults.map(v => h('option', { key: v.id, value: v.id }, v.name + '（' + (v.indexed || 0) + ' 条索引）')))
							: null,
						h('form', { className: 'kbt-search', 'data-kb-search-form': '', onSubmit: runSearch },
							h('input', { value: q, placeholder: '全量检索（回车）', 'aria-label': '全量检索', 'data-kb-search': '', onChange: (ev) => setQ(ev.target.value) }),
							h('button', { type: 'submit' }, '检索'),
							hits !== null ? h('button', { type: 'button', className: 'wb-btn is-ghost', 'data-kb-clear': '', onClick: () => { setHits(null); setQ(''); } }, '清空') : null),
						hits !== null
							? h('div', { className: 'kbt-hits', 'data-kb-hits': String(hits.length) },
								hits.length === 0
									? h('p', { className: 'wb-empty' }, '没有命中。')
									: hits.map((item, i) => h('div', {
										key: 'h' + i, className: 'kbt-hit', role: 'button', tabIndex: 0,
										title: item.uri || '',
										onClick: () => { void openDoc({ abs: item.path || item.uri, name: String(item.title || item.name || item.uri || ''), rel: '' }); },
									},
										h('div', { className: 'kbt-hit-t' }, String(item.title || item.name || item.uri || '')),
										item.snippet ? h('div', { className: 'kbt-hit-s' }, String(item.snippet).slice(0, 160)) : null)))
							: h('div', { className: 'kbt-treewrap' },
								// ★ 第二刀：新建（只写「笔记」区 —— 与后端围栏同口径 ✓）
								h('form', { className: 'kbt-new', 'data-kb-new': '', onSubmit: (ev) => { ev.preventDefault(); void doCreate(); } },
									h('select', { value: newKind, 'aria-label': '新建类型', 'data-kb-new-kind': '', onChange: (ev) => setNewKind(ev.target.value) },
										h('option', { value: 'file' }, '笔记'),
										h('option', { value: 'folder' }, '目录')),
									h('input', {
										value: newName, 'data-kb-new-name': '', placeholder: newKind === 'folder' ? '目录名' : '笔记名（缺省自动起名）',
										'aria-label': '新建名字', onChange: (ev) => setNewName(ev.target.value),
									}),
									h('button', { type: 'submit', disabled: !!busy }, busy === 'create' ? '创建中…' : '＋ 新建'),
									h('span', { className: 'kbt-target', title: '点「笔记」区里的目录可以改目标' }, NOTES_NAME + (newDir ? '/' + newDir : '')),
									newDir ? h('button', { type: 'button', className: 'wb-btn is-ghost', onClick: () => setNewDir('') }, '回笔记根') : null),
								treeSection('library', '库'),
								treeSection('notes', '笔记'),
								vault && vault.tags && vault.tags.length
									? h('section', { className: 'kbt-section' },
										h('div', { className: 'wb-group-hd' }, h('span', null, '标签分类'), h('span', { className: 'wb-card-sub' }, vault.tags.length + ' 个标签')),
										h('div', { className: 'wb-chips' }, vault.tags.slice(0, 30).map(t => h('span', { key: t.tag, className: 'wb-badge', title: t.names.map(n => n.label).slice(0, 5).join('、') }, '#' + t.tag + ' ' + t.count))))
									: null)),
					// 右列：正文
					h('section', { className: 'wb-pane wb-pane-right', 'data-kb-pane': 'doc' },
						doc
							? h('div', { className: 'kbt-doc' },
								h('div', { className: 'wb-pane-hd' },
									h('strong', { 'data-kb-doc-title': '' }, doc.title || '（未命名）'),
									h('span', { className: 'wb-spacer' }),
									typeof doc.bytes === 'number' ? h('span', { className: 'wb-card-sub' }, doc.bytes + ' B') : null,
									// ★ 第二刀：写动作 —— 只有「笔记」区里的文件可改（后端围栏同口径 ✓）
									writableRel()
										? (confirmDel
											? h('span', { className: 'wb-acts' },
												h('span', { className: 'wb-card-sub' }, '确定删除？'),
												h('button', { type: 'button', className: 'wb-btn is-danger', 'data-kb-confirm-del': '', disabled: !!busy, onClick: () => { void doDelete(); } }, busy === 'delete' ? '删除中…' : '确定删'),
												h('button', { type: 'button', onClick: () => setConfirmDel(false) }, '取消'))
											: h('span', { className: 'wb-acts' },
												h('button', { type: 'button', 'data-kb-rename': '', onClick: () => { setRenaming(true); setRenameTo(doc.title || ''); } }, '✎ 重命名'),
												h('button', { type: 'button', 'data-kb-move': '', title: '整理：移动到「笔记」区里的另一个目录', onClick: () => { setMoving(true); setMoveTo(''); } }, '⇄ 移动'),
												h('button', { type: 'button', 'data-kb-delete': '', onClick: () => setConfirmDel(true) }, '🗑 删除')))
										: null,
									h('a', { className: 'wb-btn is-ghost', href: '/x/kb/', title: '整理 / 标签管理 / 库设置仍在旧页' }, '旧页 ↗')),
								moving
									? h('form', { className: 'kbt-rename', 'data-kb-move-form': '', onSubmit: (ev) => { ev.preventDefault(); void doMove(); } },
										h('span', { className: 'wb-card-sub' }, '移动到'),
										h('select', { value: moveTo, 'data-kb-move-select': '', 'aria-label': '目标目录', onChange: (ev) => setMoveTo(ev.target.value) },
											noteDirsOf().map(dir => h('option', { key: 'd' + dir, value: dir }, dir ? NOTES_NAME + '/' + dir : NOTES_NAME + '（根）'))),
										h('button', { type: 'submit', disabled: !!busy }, busy === 'move' ? '移动中…' : '确定'),
										h('button', { type: 'button', onClick: () => { setMoving(false); setMoveTo(''); } }, '取消'))
									: null,
								renaming
									? h('form', { className: 'kbt-rename', 'data-kb-rename-form': '', onSubmit: (ev) => { ev.preventDefault(); void doRename(); } },
										h('input', { value: renameTo, 'data-kb-rename-input': '', 'aria-label': '新名字', autoFocus: true, onChange: (ev) => setRenameTo(ev.target.value) }),
										h('button', { type: 'submit', disabled: !!busy }, busy === 'rename' ? '改名中…' : '确定'),
										h('button', { type: 'button', onClick: () => { setRenaming(false); setRenameTo(''); } }, '取消'))
									: null,
								doc.loading
									? h('p', { className: 'wb-empty', 'data-kb-doc-state': 'loading' }, '正在读正文…')
									: (doc.error
										? h('p', { className: 'wb-empty', 'data-kb-doc-state': 'error', role: 'alert' }, '读不到正文：' + doc.error)
										: h('div', {},
											doc.truncated ? h('p', { className: 'wb-empty' }, '（正文很大，已截断显示）') : null,
											h('pre', { className: 'wb-pre', 'data-kb-doc-body': '' }, doc.content || '(空文件)'))))
							: h('p', { className: 'wb-empty', 'data-kb-doc-state': 'empty' }, '点左边的文件看正文（只读）。编辑 / 整理 / 标签管理仍在旧页，第二刀才搬进来。')),
				note ? h('p', { className: 'wb-diag', 'data-kb-note': '', role: noteError ? 'alert' : 'status', style: noteError ? { color: 'var(--dsw-alias-state-error-primary, #f48771)' } : null }, note) : null));
		}

		const STYLE_ID = 'vssaros-kb-workbench-layout';
		// ★ 2026-10-22（工作台 UI 统一，方案稿 §6.19）：**通用视觉交给共享层**（宿主注入的 `wb-*`），
		//   这里只留知识库特有的东西：文件树行、检索命中行、正文列、新建/重命名的输入行。
		// ⚠ 原来写的 `--dsw-alias-border-default` / `-label-link` / `-font-family-monospace` / `-state-focus-primary`
		//   **都不存在** ⇒ 一律回落硬编码兜底 ⇒ 从没跟随过主题 ✗（迁移时统一换成真实令牌 / `--wb-*`）。
		const CSS = `
.wb-kbt .wb-field-row input { flex:1 1 auto; min-width:0; }
.kbt-search { display:flex; gap:var(--wb-s1); align-items:center; }
.kbt-treewrap, .kbt-hits { flex:1 1 auto; min-height:0; overflow:auto; display:flex; flex-direction:column; gap:var(--wb-s2); }
.kbt-section { display:flex; flex-direction:column; gap:3px; }
.kbt-row { display:flex; align-items:center; gap:var(--wb-s1); font-size:var(--wb-f-sm); padding:1px var(--wb-s1); border-radius:var(--wb-r-sm); cursor:pointer; min-width:0; }
.kbt-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
.kbt-file.is-current { background: var(--dsw-alias-interactive-bg-active, rgba(0,127,212,.14)); }
.kbt-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.kbt-name.is-target { color: var(--dsw-alias-brand-primary, #007fd4); font-weight:600; }
.kbt-hit { padding:var(--wb-s1) 6px; border-radius:var(--wb-r-sm); cursor:pointer; min-width:0; }
.kbt-hit:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); }
.kbt-hit-t { font-size:var(--wb-f-sm); font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.kbt-hit-s { font-size:var(--wb-f-xs); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.65)); line-height:1.4; }
.kbt-doc { display:flex; flex-direction:column; gap:var(--wb-s2); min-width:0; }
.kbt-new { padding:var(--wb-s1) 0 3px; border-bottom:1px dashed var(--dsw-alias-border-l1, rgba(127,127,127,.2)); }
.kbt-new select, .kbt-new input, .kbt-rename input { padding:3px 8px; border-radius:var(--wb-r-sm); border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); background: var(--dsw-alias-bg-layer-1, transparent); color: inherit; font: inherit; font-size:var(--wb-f-xs); }
.kbt-new input { flex:1 1 90px; min-width:70px; }
.kbt-rename { display:flex; gap:var(--wb-s1); align-items:center; padding:var(--wb-s1) 0; }
.kbt-rename input { flex:1 1 auto; min-width:120px; border-color: var(--dsw-alias-brand-primary, rgba(0,127,212,.6)); }
.wb-kbt .wb-toolbar button, .wb-kbt .wb-field-row button, .wb-kbt .wb-acts button { padding:2px 10px; border-radius:var(--wb-r-pill); font-size:var(--wb-f-xs); font-family:inherit; cursor:pointer; border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); background: transparent; color: inherit; }
.wb-kbt .wb-toolbar button:hover, .wb-kbt .wb-field-row button:hover, .wb-kbt .wb-acts button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); }
.wb-kbt button:disabled { opacity:.5; cursor:default; }
.kbt-target { font-size:var(--wb-f-xs); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); font-family: var(--wb-mono); }
`;

		/**
		 * ★★ 2026-10-24：工作台里**直接承载新版 React 侧栏页**（`/x/kb/sideview`，与 IDE 侧栏同一份 bundle）。
		 *
		 * 根因（为什么之前怎么改 `/x/kb/` 路由都不生效）：本包满足 `hasWorkbenchClient`（清单有
		 * `vssaros.workbench` + `exports['./client']` + `dsh.client.inject` 含 `@vssaros/dsh-workbenches`）⇒
		 * IDE 编辑区打开知识库时建的是 **'workbench' 视图**（`dshPluginPageEditorPane.ts:157/171`）——
		 * 它加载 dsh 客户端根路径 `/` 并挂**本文件注册的组件**，**根本不请求 `/x/kb/`** ✗。
		 * ⇒ 换视图只能从这里换：注册的组件改成 iframe 承载 `/x/kb/sideview`。
		 *
		 * 为什么用 iframe 而不是直接执行 `kbSideview.js`：那个 bundle 在顶层读 `window.__KB_SIDEVIEW_DATA__`
		 *   并 `createRoot` 到自己的根节点 —— 直接塞进 dsh 客户端会污染全局、和宿主 React 抢根 ✗。
		 *   iframe 同源（同一个 host、同一份 cookie），天然隔离 ✓。
		 * 降级：探测 `/x/kb/sideview` 失败（老 host / 路由缺失）⇒ 回落到下面的旧版 `KbPanel`，不白屏 ✓。
		 */
		/**
		 * ★★ 2026-10-24：**工作台面板**（与小红书工作台同一路线：宿主 React 树槽位 + props 注入）。
		 *
		 * 与旧 `KbPanel` 的区别：这里不自己实现 UI，而是把 `/x/kb/web/kbSideview.js` 这份
		 * **与 IDE 侧栏完全相同的 bundle** 挂到左栏（`window.__KB_SIDEVIEW_MOUNT__`），
		 * 右栏由本组件做正文预览 —— 因为工作台面板拿不到 IDE 编辑器。
		 *
		 * 数据：`/x/kb/api/page` + `/x/kb/api/graph`（与 `sync-kb-sideview.mjs` 同一套映射）。
		 * 交互：打开（读正文）/ 搜索（BM25）。写操作暂不在此开放（面板没有宿主对话框能力）。
		 */
		function KbWorkbenchPanel() {
			const hostRef = react.useRef(null);
			const disposeRef = react.useRef(null);
			const [phase, setPhase] = useState('loading');   // loading | ready | error
			const [error, setError] = useState('');
			const [doc, setDoc] = useState(null);            // { title, text }
			const vaultRef = react.useRef({ id: '', dir: '' });   // 写操作要 vaultId + 库根（绝对→相对折算）
			const remountRef = react.useRef(null);

			const countOf = (node) => (node.children ?? []).reduce((n, c) => n + (c.isDirectory ? countOf(c) : 1), 0);
			const mapNodes = (list) => (list ?? []).map((node) => node.isDirectory
				? { name: node.name, path: node.abs || node.rel, isFolder: true, count: countOf(node), children: mapNodes(node.children) }
				: { name: String(node.name).replace(/\.md$/i, ''), path: node.abs || node.rel, isFolder: false, size: node.size, name0: node.name });

			/**
			 * 取 bundle 的顺序（2026-10-24 真机教训）：
			 *   ① 已经有了 ⇒ 直接用
			 *   ② **装载器 `require.async('./client.kbview.js')`** —— 与 `client.kb.js` 同一条通道，
			 *      已证可用；`<script src>` 拉 `/x/kb/web/kbSideview.js` 会被宿主挡掉（子资源不走插件路由）。
			 *   ③ 装载器不可用（老宿主）⇒ 退回 script 标签，失败才报错。
			 */
			const loadBundle = () => new Promise((resolve, reject) => {
				if (typeof window.__KB_SIDEVIEW_MOUNT__ === 'function') { return resolve(); }
				const viaScript = () => {
					const s = document.createElement('script');
					s.src = '/x/kb/web/kbSideview.js';
					s.onload = () => (typeof window.__KB_SIDEVIEW_MOUNT__ === 'function' ? resolve() : reject(new Error('bundle 未导出 MOUNT')));
					s.onerror = () => reject(new Error('bundle 加载失败：/x/kb/web/kbSideview.js'));
					document.head.appendChild(s);
				};
				try {
					if (moduleRequire && typeof moduleRequire.async === 'function') {
						Promise.resolve(moduleRequire.async('./client.kbview.js'))
							.then(() => (typeof window.__KB_SIDEVIEW_MOUNT__ === 'function'
								? resolve()
								: reject(new Error('client.kbview.js 已加载但未导出 MOUNT'))))
							.catch(() => viaScript());
						return;
					}
				} catch { /* 落到 script 兜底 */ }
				viaScript();
			});

			const buildData = async () => {
				const data = { vaultName: '(未连接)', vaults: [], noteCount: 0, tree: [], tags: [], indexState: 'ready' };
				try {
					const page = await fetch('/x/kb/api/page', { credentials: 'same-origin' }).then((r) => r.json());
					const vaults = page.vaults ?? [];
					const vault = vaults[0];
					if (vault) {
						vaultRef.current = { id: String(vault.id || ''), dir: String(vault.dir || '') };
						const notes = (vault.sections && vault.sections.notes) || {};
						const lib = (vault.sections && vault.sections.library) || {};
						Object.assign(data, {
							vaultName: vault.name || vault.id || '知识库',
							activeVaultId: vault.id,
							vaults: vaults.map((v) => ({ id: v.id, name: v.name || v.id, count: (v.sections && v.sections.notes) ? (v.sections.notes.files || 0) : 0 })),
							noteCount: notes.files || 0,
							tree: mapNodes(notes.nodes),
							library: mapNodes(lib.nodes),
							libraryCount: lib.files || 0,
							tags: (vault.tags ?? []).slice(0, 300).map((t) => ({ tag: t.tag ?? t.name ?? String(t), count: t.count ?? 0 })),
						});
						// 双链：节点 id 是库内相对路径，树的 path 是绝对路径 ⇒ 键必须折成绝对路径
						try {
							const g = await fetch('/x/kb/api/graph', { credentials: 'same-origin' }).then((r) => r.json());
							if (g && g.ok && Array.isArray(g.nodes) && Array.isArray(g.edges)) {
								const byId = new Map(g.nodes.map((n) => [n.id, n]));
								const base = String(vault.dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
								const absKey = (id) => (base ? base + '/' + String(id) : String(id));
								const label = (id) => {
									const n = byId.get(id);
									return n && n.label ? String(n.label) : String(id).split('/').pop().replace(/\.md$/i, '');
								};
								const links = {};
								const slot = (id) => { const k = absKey(id); return links[k] || (links[k] = { out: [], in: [] }); };
								for (const e of g.edges) {
									if (!e || !e.source || !e.target) { continue; }
									slot(e.source).out.push({ title: label(e.target), path: absKey(e.target) });
									slot(e.target).in.push({ title: label(e.source), path: absKey(e.source) });
								}
								data.links = links;
							}
						} catch { /* 图谱不可用 ⇒ 组件不显示双链节（如实降级） */ }
					}
				} catch (e) {
					data.indexState = 'stale';
					console.error('[kb-workbench] 读取 /api/page 失败', e);
				}
				return data;
			};

			const openDoc = async (path) => {
				try {
					const r = await fetch('/x/kb/api/doc?uri=' + encodeURIComponent(path), { credentials: 'same-origin' });
					const payload = await r.json();
					const text = payload && (payload.text ?? payload.content ?? payload.body);
					setDoc({ title: String(path).split('/').pop(), text: typeof text === 'string' ? text : (payload && payload.error) || '(读不到正文)' });
				} catch (e) {
					setDoc({ title: String(path).split('/').pop(), text: '读取失败：' + String((e && e.message) || e) });
				}
			};

			// ── 写操作（入参照抄 sync-kb-sideview.mjs:183-240，别自己猜字段名）──────────
			const BS = String.fromCharCode(92);
			const norm = (s) => String(s || '').split(BS).join('/');
			const relOf = (abs) => {
				const a = norm(abs);
				const root = norm(vaultRef.current.dir).replace(/\/+$/, '');
				return root && a.indexOf(root) === 0 ? a.slice(root.length).replace(/^\/+/, '') : a;
			};
			const post = (path, body) => fetch('/x/kb/api' + path, {
				method: 'POST', credentials: 'same-origin',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body || {}),
			});
			/** 写成功后**只重挂面板**（面板不像插件页那样整页 reload，否则会丢失滚动与选中）。 */
			const writeOp = (path, body) => post(path, body).then((r) => r.json()).then(async (b) => {
				if (b && b.ok === false) { window.alert('操作失败：' + (b.error || '未知错误')); return; }
				await remountRef.current?.();
			}).catch((e) => window.alert('操作失败：' + String((e && e.message) || e)));

			const actions = {
				// 视图自己弹对话框（Electron 不支持 window.prompt）
				useInlineDialogs: true,
				// 内嵌阅读：面板没有 IDE 编辑区 ⇒ 提供 loadDoc，视图据此渲染右栏正文。
				// ⚠ 2026-10-24 真机：`/api/page` 的**目录节点没有 abs**、部分叶子也可能只给 rel，
				//   直接拿 rel 去 /api/doc 会被服务端按**数据根**解析 ⇒ ENOENT（用户看到的那条错误）。
				//   ⇒ 这里做三层归一：绝对路径照用；相对路径按库根补；无扩展名再补 .md 重试。
				// 图片：交给插件的 `/api/asset`（围栏与 /api/doc 同源）
				assetUrl: (abs) => '/x/kb/api/asset?uri=' + encodeURIComponent(abs),
				loadDoc: async (p) => {
					const raw = String(p || '');
					const base = String(vaultRef.current.dir || '').replace(/\\/g, '/').replace(new RegExp('/+$'), '');
					const isAbs = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/');
					const fetchDoc = async (uri) => {
						const r = await fetch('/x/kb/api/doc?uri=' + encodeURIComponent(uri), { credentials: 'same-origin' });
						const payload = await r.json().catch(() => null);
						const t = payload && (payload.text ?? payload.content ?? payload.body);
						return { ok: typeof t === 'string', text: t, error: payload && payload.error, mtime: (payload && payload.mtime) || 0 };
					};
					const candidates = [];
					const first = isAbs ? raw : (base ? base + '/' + raw : raw);
					candidates.push(first.replace(/\\/g, '/'));
					if (!/\.[A-Za-z0-9]+$/.test(first)) { candidates.push((first + '.md').replace(/\\/g, '/')); }
					// 相对路径还可能落在「笔记/」或「库/」下 ⇒ 各补一次
					if (!isAbs) {
						candidates.push((base + '/笔记/' + raw).replace(/\\/g, '/'));
						if (!/\.[A-Za-z0-9]+$/.test(raw)) { candidates.push((base + '/笔记/' + raw + '.md').replace(/\\/g, '/')); }
					}
					let last = null;
					for (const uri of candidates) {
						last = await fetchDoc(uri);
						if (last.ok) { break; }
					}
					return {
						title: String(raw).split('/').pop().replace(/\.md$/i, ''),
						text: last && last.ok ? String(last.text) : ('读取失败：' + String((last && last.error) || '找不到该文件')),
						mtime: (last && last.mtime) || 0,
						// 文档所在目录：视图用它把 `![](相对路径)` 折成绝对路径，再走 /api/asset
						base: String(first).replace(/\\/g, '/').replace(new RegExp('/[^/]*$'), ''),
					};
				},
				// 保存正文（行内编辑 / 任务勾选）：服务端只允许写「笔记」区的 .md
				saveDoc: async (p, text, expectedMtime) => {
					const body = { uri: p, text };
					if (expectedMtime) { body.expectedMtime = expectedMtime; }
					const r = await fetch('/x/kb/api/doc', {
						method: 'POST', credentials: 'same-origin',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(body),
					});
					return r.json().catch(() => ({ ok: false, error: '保存失败（响应不是 JSON）' }));
				},
				// 附件上传：body 直接是 File（浏览器原生），服务端按 chunk 收原始字节
				uploadAsset: async (file, docPath) => {
					const q = '?doc=' + encodeURIComponent(docPath) + '&name=' + encodeURIComponent(file.name || 'pasted.png');
					const r = await fetch('/x/kb/api/asset/upload' + q, {
						method: 'POST', credentials: 'same-origin',
						headers: { 'content-type': file.type || 'application/octet-stream' },
						body: file,
					});
					return r.json().catch(() => ({ ok: false, error: '上传失败（响应不是 JSON）' }));
				},
				// 备份历史 / 恢复
				listBackups: async (p) => {
					const r = await fetch('/x/kb/api/backup?doc=' + encodeURIComponent(p), { credentials: 'same-origin' });
					return r.json().catch(() => ({ ok: false, error: '读取备份失败（响应不是 JSON）' }));
				},
				restoreBackup: async (p, name) => {
					const r = await fetch('/x/kb/api/backup/restore', {
						method: 'POST', credentials: 'same-origin',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ doc: p, name }),
					});
					return r.json().catch(() => ({ ok: false, error: '恢复失败（响应不是 JSON）' }));
				},
				openNode: (p) => { void openDoc(p); },
				openLink: (p) => { void openDoc(p); },
				refresh: () => { void remountRef.current?.(); },
				createNote: (dir, name) => {
					const n = String(name || '').trim();
					if (n) { void writeOp('/new', { vaultId: vaultRef.current.id, kind: 'note', dir: dir || '笔记', name: n }); }
				},
				newFolder: (dir, name) => {
					const n = String(name || '').trim();
					if (n) { void writeOp('/new', { vaultId: vaultRef.current.id, kind: 'folder', dir: dir || '笔记', name: n }); }
				},
				renameNode: (p, newName) => {
					const n = String(newName || '').trim();
					if (!n) { return; }
					const rel = relOf(p);
					const segs = rel.split('/');
					const base = segs.pop() || '';
					const isMd = /\.md$/i.test(base);
					if (n === base.replace(/\.md$/i, '')) { return; }
					const to = segs.concat(n + (isMd ? '.md' : '')).join('/');
					void writeOp('/rename', { vaultId: vaultRef.current.id, from: rel, to, mode: 'move' });
				},
				deleteNode: (p) => {
					const rel = relOf(p);
					if (!rel) { return; }
					void writeOp('/delete', { vaultId: vaultRef.current.id, from: rel });
				},
				// skipConfirm：视图已弹过确认框（useInlineDialogs）⇒ 这里不再二次确认
				deleteNodes: (paths, skipConfirm) => {
					const list = (paths || []).map(relOf).filter(Boolean);
					if (!list.length) { return; }
					if (!skipConfirm && !window.confirm('删除选中的 ' + list.length + ' 项？')) { return; }
					let i = 0;
					const next = () => {
						if (i >= list.length) { void remountRef.current?.(); return; }
						const rel = list[i++];
						post('/delete', { vaultId: vaultRef.current.id, from: rel })
							.then((r) => r.json())
							.then((b) => { if (b && b.ok === false) { console.warn('[kb-workbench] 删除失败：', rel, b.error); } })
							.catch((e) => console.warn('[kb-workbench] 删除失败：', rel, e))
							.then(next);
					};
					next();
				},
				moveNodes: (froms, toFolder) => {
					const list = (froms || []).map(relOf).filter(Boolean);
					if (!list.length) { return; }
					const dirRel = relOf(toFolder).replace(/\/+$/, '');
					const jobs = list.map((rel) => ({ rel, to: dirRel + '/' + (rel.split('/').pop() || '') })).filter((j) => j.to !== j.rel);
					if (!jobs.length) { return; }
					let i = 0;
					const next = () => {
						if (i >= jobs.length) { void remountRef.current?.(); return; }
						const job = jobs[i++];
						post('/rename', { vaultId: vaultRef.current.id, from: job.rel, to: job.to, mode: 'move' })
							.then((r) => r.json())
							.then((b) => { if (b && b.ok === false) { console.warn('[kb-workbench] 移动失败：', job.rel, b.error); } })
							.catch((e) => console.warn('[kb-workbench] 移动失败：', job.rel, e))
							.then(next);
					};
					next();
				},
				// 全文检索：同源 fetch，失败返回 undefined ⇒ 组件退回“按名过滤”（不显示假空结果）
				search: (q, m) => {
					if (!q || !String(q).trim()) { return Promise.resolve([]); }
					if (m !== 'fulltext') { return Promise.resolve(undefined); }
					return fetch('/x/kb/api/search?q=' + encodeURIComponent(String(q).trim()) + '&limit=20', { credentials: 'same-origin' })
						.then((r) => r.json())
						.then((b) => {
							const raw = (b && (b.hits || b.results || b.items)) || null;
							if (!Array.isArray(raw)) { return undefined; }
							return raw.map((x) => ({
								title: String(x.title || x.name || String(x.path || x.rel || '').split('/').pop() || '').replace(/\.md$/i, ''),
								path: x.abs || x.path || x.rel || '',
								snippet: String(x.snippet || x.preview || '').replace(/\s+/g, ' ').slice(0, 110),
							})).filter((x) => !!x.path);
						})
						.catch(() => undefined);
				},
				// 标签筛选：面板没有宿主侧筛选能力 ⇒ 走全文检索（按标签名当关键词），行为可解释
				pickTag: (t) => { console.warn('[kb-workbench] 标签点击暂按关键词检索处理：' + t); },
			};

			remountRef.current = async () => {
				const data = await buildData();
				disposeRef.current?.();
				disposeRef.current = window.__KB_SIDEVIEW_MOUNT__(hostRef.current, data, actions) || null;
			};
			const remount = () => remountRef.current();

			useEffect(() => {
				let alive = true;
				(async () => {
					try {
						await loadBundle();
						if (!alive) { return; }
						await remount();
						if (alive) { setPhase('ready'); }
					} catch (e) {
						if (alive) { setPhase('error'); setError(String((e && e.message) || e)); }
					}
				})();
				return () => { alive = false; disposeRef.current?.(); disposeRef.current = null; };
			}, []);

			if (phase === 'error') {
				return h('div', { 'data-kb-workbench': 'error', style: { padding: 16, fontFamily: 'inherit' } },
					h('strong', null, '知识库加载失败'), h('div', { style: { opacity: 0.75, marginTop: 6 } }, error));
			}

			// ⚠ 2026-10-24：面板**不再自己造右栏** —— 挂进来的视图本身会渲染左树 + 右正文
			//   （它拿到了 loadDoc ⇒ docMode）。此前两边各画一列 ⇒ 树栏与正文重叠。
			return h('div', { 'data-kb-workbench': 'panel', style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontFamily: 'inherit' } },
				phase === 'loading' ? h('div', { style: { padding: 12, opacity: 0.6, fontSize: 12 } }, '正在加载…') : null,
				h('div', { ref: hostRef, 'data-kb-workbench-tree': '1', style: { flex: '1 1 auto', minHeight: 0, minWidth: 0, overflow: 'hidden' } }));
		}

function install(ctx) {
			ctx.effect(() => {
				if (document.getElementById(STYLE_ID)) { return undefined; }
				const el = document.createElement('style');
				el.id = STYLE_ID;
				el.textContent = CSS;
				document.head.appendChild(el);
				return () => el.remove();
			}, 'vssaros-kb: workbench styles');
			// ★★ 2026-10-24（终态）：按**小红书工作台**的路线注册面板 —— 宿主 React 树槽位 +
			//   `require('react')` 共享宿主 React + 组件 props 注入。面板内部把
			//   `/x/kb/web/kbSideview.js`（与 IDE 侧栏同一份 bundle）挂到左栏，右栏做正文预览。
			//
			//   这条路线同时解决了两件事：
			//     · 编辑器用 'workbench' 表面时（`dshPluginPageEditorPane.ts:157`）能直接看到**新版 UI**
			//     · 不再依赖 iframe（子框架拿不到宿主凭证）与页面跳转（会顶掉整个壳）
			//   ⚠ 改过子块 `client.kb.js` 必须**再动一下入口 `client.js`**（守卫查 mtime，
			//     且 chunk 的 rev 取自入口文件的 mtime/size —— 不动入口会继续命中 immutable 缓存 ✗）
			ctx.inject(['desktopWorkbenches'], (c) => {
				c.effect(() => c.desktopWorkbenches.register(DESCRIPTOR, KbWorkbenchPanel), 'vssaros-kb: workbench');
			});
			return undefined;
		}

		exports.install = install;
		exports.apply = install;
		exports.inject = [];
		return module.exports;
	},
});
