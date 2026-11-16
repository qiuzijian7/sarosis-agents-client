(function () {
	'use strict';
	var React = window.React, h = React.createElement;
	function btn(text, onClick, extra) { return h('button', Object.assign({ type: 'button', className: 'vs-mp-btn', onClick: onClick }, extra), text); }
	function Icon(props) {
		var paths = { star: 'M12 3l3 6 6 1-4.5 4.5 1 6-5.5-3-5.5 3 1-6L3 10l6-1z', box: 'M3 7l9-5 9 5-9 5-9-5z M3 7v10l9 5 9-5V7 M12 12v10', search: 'M20 20l-5-5 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0' };
		return h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true }, h('path', { d: paths[props.name] || paths.box }));
	}
	function Drawer(props) {
		var node = React.useRef(null), onClose = React.useRef(props.onClose);
		onClose.current = props.onClose;
		React.useEffect(function () {
			var previous = document.activeElement, dialog = node.current;
			if (!dialog) { return; }
			function keys(event) {
				if (event.key === 'Escape') { event.stopPropagation(); onClose.current(); return; }
				if (event.key !== 'Tab') { return; }
				var controls = Array.from(dialog.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')).filter(function (el) { return el.getClientRects().length; });
				if (!controls.length) { event.preventDefault(); dialog.focus(); return; }
				var first = controls[0], last = controls[controls.length - 1];
				if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
				else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
			}
			var parent = document.getElementById('vs-mp-main');
			if (parent) { parent.inert = true; }
			dialog.focus(); dialog.addEventListener('keydown', keys);
			return function () { dialog.removeEventListener('keydown', keys); if (parent) { parent.inert = false; } if (previous && previous.isConnected) { previous.focus(); } };
		}, []);
		var overlay = h('div', { className: 'vs-mp-overlay' + (props.wide ? ' wide' : ''), onMouseDown: function (e) { if (e.target === e.currentTarget) { props.onClose(); } } },
			h('section', { className: props.wide ? 'vs-mp-dialog' : 'vs-mp-drawer', ref: node, role: 'dialog', 'aria-modal': true, 'aria-label': props.title, tabIndex: -1 },
				h('div', { className: 'vs-mp-drawer-head' }, props.icon || null,
					h('div', { className: 'vs-mp-title-copy' }, h('div', { className: 'vs-mp-drawer-title' }, props.title), props.subtitle ? h('div', { className: 'vs-mp-drawer-meta' }, props.subtitle) : null),
					btn('×', props.onClose, { className: 'vs-mp-x', 'aria-label': '关闭' })), props.children));
		var target = document.getElementById('vs-mp-overlays');
		return target ? window.ReactDOM.createPortal(overlay, target) : overlay;
	}
	function Discovery(props) {
		return h('div', { className: 'vs-mp-discovery' },
			h('section', { className: 'vs-mp-discovery-featured' },
				h('div', { className: 'vs-mp-hero' }, h('span', { className: 'vs-mp-eyebrow' }, '发现资源 · 扩展工作方式'), h('h2', null, '从理解项目，到完成创作'), h('p', null, '真实资源与原始图像。先了解内容，再决定安装。')),
				h('div', { className: 'vs-mp-section-head' }, h('h2', null, '最近更新'), h('span', null, '手动横向浏览')),
				h('div', { className: 'vs-mp-rail', tabIndex: 0, 'aria-label': '最近更新商品' }, props.items.slice(0, 8).map(props.renderCard))),
			h('section', { className: 'vs-mp-ranking' }, h('div', { className: 'vs-mp-section-head' }, h('h2', null, '下载最多'), btn('刷新', props.onRetry, { className: 'vs-mp-link' })),
				props.error ? h('div', { role: 'alert', className: 'vs-mp-error' }, props.error) : props.busy ? h('p', { role: 'status' }, '读取下载榜…') : props.ranking.length ? props.ranking.map(function (pkg, i) {
					return h('div', { key: pkg.kind + ':' + pkg.slug, className: 'vs-mp-rank-row' }, h('span', { className: 'vs-mp-rank-no' }, String(i + 1).padStart(2, '0')), h(props.PkgIcon, { pkg: pkg }),
						h('div', { className: 'vs-mp-rank-copy' }, btn(pkg.name || pkg.slug, function () { props.onDetail(pkg.slug, pkg.kind); }, { className: 'vs-mp-title-btn', title: pkg.name }), h('small', null, pkg.category || pkg.kind)),
						h('span', null, Number.isFinite(pkg.downloads) ? pkg.downloads.toLocaleString() : '—'));
				}) : h('p', { className: 'vs-mp-empty small' }, '暂无下载数据')));
	}
	function Favorites(props) {
		var prefs = props.preferences, selected = props.group, groups = prefs.groups || [];
		var draft = React.useState(null), edit = draft[0], setEdit = draft[1];
		var ids = selected === 'all' ? Array.from(new Set(groups.flatMap(function (g) { return g.items; }))) : (groups.find(function (g) { return g.id === selected; }) || { items: [] }).items;
		var count = new Set(groups.flatMap(function (g) { return g.items; })).size;
		ids = ids.filter(function (id) { var p = (props.records[id] || {}).pkg; return (!props.kind || id.split(':')[0] === props.kind) && (!props.query || [id, p && p.name, p && p.description].join(' ').toLowerCase().includes(props.query.toLowerCase())); });
		var selectedGroup = groups.find(function (g) { return g.id === selected; });
		function saveEdit() {
			if (edit.mode === 'import') {
				var parsed;
				try { parsed = JSON.parse(edit.text); } catch { setEdit(Object.assign({}, edit, { error: 'JSON 格式错误，未保存' })); return; }
				if (!parsed || !Array.isArray(parsed.groups)) { setEdit(Object.assign({}, edit, { error: '需要收藏分组清单' })); return; }
				props.onChange({ type: 'import', groups: parsed.groups }).then(function (ok) { if (ok) { setEdit(null); } });
			} else {
				props.onChange({ type: edit.mode === 'rename' ? 'renameGroup' : 'createGroup', id: edit.id, name: edit.text.trim() }).then(function (ok) { if (ok) { setEdit(null); } });
			}
		}
		return h('section', { className: 'vs-mp-favorites' },
			h('div', { className: 'vs-mp-section-head' }, h('div', null, h('h2', null, '收藏的资源'), h('p', null, '按用途整理；收藏和安装互不影响')), h('div', { className: 'vs-mp-tools' },
				btn('导入 / 导出', function () { setEdit({ mode: 'import', text: JSON.stringify({ schema: 1, groups: groups }, null, 2) }); }),
				btn('新建分组', function () { setEdit({ mode: 'create', id: 'g-' + Date.now().toString(36), text: '' }); }, { disabled: props.saving }))),
			h('div', { className: 'vs-mp-group-tabs' }, [{ id: 'all', name: '全部收藏', items: { length: count } }].concat(groups).map(function (g) { return btn(g.name + ' · ' + g.items.length, function () { props.onGroup(g.id); }, { key: g.id, 'aria-pressed': selected === g.id }); })),
			selectedGroup ? h('div', { className: 'vs-mp-tools' }, btn('重命名', function () { setEdit({ mode: 'rename', id: selectedGroup.id, text: selectedGroup.name }); }),
				btn('删除分组', function () { setEdit({ mode: 'delete', id: selectedGroup.id, text: selectedGroup.name }); }, { disabled: selectedGroup.id === 'default' || props.saving })) : null,
			ids.length ? h('div', { className: 'vs-mp-grid' }, ids.map(function (id) {
				var record = props.records[id];
				if (record && record.pkg) { return props.renderCard(record.pkg); }
				return h('div', { key: id, className: 'vs-mp-card' }, h('strong', null, id), h('p', null, record && record.error ? record.error : '正在读取真实商品…'), btn('移出收藏', function () { props.onRemove(id); }, { disabled: props.saving }));
			})) : h('p', { className: 'vs-mp-empty' }, '收藏夹还没有资源。在商品卡片上点收藏开始整理。'),
			h('p', { role: 'status', className: 'vs-mp-preferences-status' }, props.status),
			edit ? h(Drawer, { title: edit.mode === 'delete' ? '删除分组' : edit.mode === 'import' ? '收藏清单' : '分组名称', onClose: function () { setEdit(null); } },
				edit.mode === 'delete' ? h('p', null, '仅删除分组关系，不卸载任何资源。') : h('label', { className: 'vs-mp-field' }, edit.mode === 'import' ? '可复制导出，或粘贴清单导入；不执行安装。' : '名称（最多 40 字）',
					h(edit.mode === 'import' ? 'textarea' : 'input', { className: 'vs-mp-input', value: edit.text, maxLength: edit.mode === 'import' ? 65536 : 40, onChange: function (e) { setEdit(Object.assign({}, edit, { text: e.target.value, error: '' })); } })),
				edit.error ? h('p', { role: 'alert' }, edit.error) : null,
				btn(edit.mode === 'delete' ? '确认删除' : '保存', function () { if (edit.mode === 'delete') { props.onChange({ type: 'deleteGroup', id: edit.id }).then(function (ok) { if (ok) { props.onGroup('all'); setEdit(null); } }); } else { saveEdit(); } }, { disabled: props.saving })) : null);
	}
	var resourceLabels = { agent: 'Agent', skill: 'Skill', mcp: 'MCP', workbench: '工作台', knowledge: '知识库', plugin: '插件' };
	function resourceKey(p) { return p.kind + ':' + p.slug; }
	function installedStatus(p, server, serversKnown) {
		if (p.isLocal) { return { id: 'local', name: '本机未发布', note: '本机副本不在商城安装台账内。发布前检查目录和隐私，不提供商城卸载。' }; }
		if (p.kind === 'mcp' && server && server.disabled === true) { return { id: 'disabled', name: '已停用', note: '此 MCP 的本地配置为停用。启用不代表连接成功。' }; }
		if (p.upgradable === true) { return { id: 'update', name: '可升级', warn: true, note: '商城提供新版本。先查看变更、依赖与安装预览，确认后升级。' }; }
		if (p.restartRequired === true) { return { id: 'restart', name: '待重启', warn: true, note: '安装回执要求重启。请在任务结束后手动重启 Harness，再验证能力生效。' }; }
		if (p.kind === 'mcp') {
			if (!server) { return { id: serversKnown ? 'config' : 'unknown', name: serversKnown ? '未注册' : '状态未读取', warn: serversKnown, note: serversKnown ? '未在当前 MCP 配置找到对应注册项，请检查配置。' : 'MCP 状态尚未读取，不能当作启用或连接成功。' }; }
			if (server.type === 'stdio' && server.approved === false) { return { id: 'approval', name: '待批准', warn: true, note: '本地 stdio MCP 尚未批准。配置启用不代表能力可用。' }; }
			return { id: 'record', name: '已注册', note: '本机注册项存在；运行与连接状态未验证。' };
		}
		return { id: 'record', name: '已记录', note: '本机安装清单存在此资源。已安装不等于已加载或运行正常。' };
	}
	function InstalledManager(props) {
		var selection = React.useState(''), selected = selection[0], setSelected = selection[1];
		var opened = React.useState(false), open = opened[0], setOpen = opened[1];
		var filtering = React.useState('all'), filter = filtering[0];
		var panels = React.useState('overview'), panel = panels[0];
		var ordering = React.useState('attention'), order = ordering[0];
		var confirming = React.useState(null), confirm = confirming[0];
		var metadata = React.useState({}), records = metadata[0];
		var rowRefs = React.useRef({}), backRef = React.useRef(null), focus = React.useRef('');
		var sources = props.items || [], servers = props.servers || {};
		function status(p) { return installedStatus(p, servers[p.slug], props.serversKnown); }
		function match(p, id) { var s = status(p).id; return id === 'all' || id === 'update' && s === 'update' || id === 'attention' && ['config', 'approval', 'restart', 'unknown'].includes(s) || id === 'local' && s === 'local' || id === 'disabled' && s === 'disabled'; }
		var items = sources.filter(function (p) { return match(p, filter); }).slice().sort(function (a, b) {
			if (order === 'name') { return String(a.name || a.slug).localeCompare(String(b.name || b.slug), 'zh-CN'); }
			if (order === 'type') { return String(a.kind).localeCompare(String(b.kind)); }
			function priority(p) { return status(p).id === 'update' ? 0 : match(p, 'attention') ? 1 : p.isLocal ? 3 : 2; }
			return priority(a) - priority(b);
		});
		var item = items.find(function (p) { return resourceKey(p) === selected; }) || items[0];
		var key = item ? resourceKey(item) : '';
		function enriched(p) {
			var display = Object.assign({}, (props.metadata || {})[resourceKey(p)], records[resourceKey(p)]);
			return Object.assign({}, p, { name: p.isLocal ? p.name : display.name || p.name, description: p.description || display.description || '', icon: p.icon || display.icon || '', cover: p.cover || display.cover || '' });
		}
		React.useEffect(function () {
			var target = focus.current === 'back' ? backRef.current : rowRefs.current[focus.current];
			if (target && target.getClientRects().length) { target.focus(); }
			else if (backRef.current && focus.current) { backRef.current.focus(); }
			focus.current = '';
		}, [key, open]);
		React.useEffect(function () {
			if (!item || item.isLocal || records[key] || !props.loadMetadata) { return; }
			var active = true, controller = new AbortController();
			void props.loadMetadata(item, controller.signal).then(function (r) {
				if (active && r && r.ok && resourceKey(r) === key) { metadata[1](function (old) { var next = Object.assign({}, old); if (Object.keys(next).length >= 30) { delete next[Object.keys(next)[0]]; } next[key] = { name: r.name, icon: r.icon, cover: r.cover, description: r.description }; return next; }); }
			});
			return function () { active = false; controller.abort(); };
		}, [key, props.loadMetadata]);
		function select(p) { var id = resourceKey(p); focus.current = id; setSelected(id); setOpen(true); }
		function back() { focus.current = key; setOpen(false); }
		function badge(p) { var s = status(p); return h('span', { className: 'vs-mp-inventory-badge' + (s.warn ? ' warn' : '') }, h('i'), s.name); }
		function fact(label, value) { return h('div', null, h('small', null, label), h('strong', null, value || '未提供')); }
		function configBody(p) {
			var server = servers[p.slug], pending = props.operations && props.operations.get(resourceKey(p)).pending;
			return h('div', { className: 'vs-mp-inspector-section' }, h('h3', null, p.kind === 'mcp' ? 'MCP 配置与启停' : '资源设置'),
				p.kind === 'mcp' ? h('div', { className: 'vs-mp-setting-row' }, h('div', null, h('strong', null, '启用此 MCP'), h('small', null, '启用不代表连接成功；仅按真实配置状态显示')),
					server ? btn(h('i'), function () { props.onToggleMcp(p.slug, server.disabled === true); }, { className: 'vs-mp-inventory-switch', role: 'switch', 'aria-label': '启停 ' + (p.name || p.slug), 'aria-checked': server.disabled !== true, disabled: Boolean(pending) }) : h('span', { className: 'vs-mp-muted' }, '状态未知')) : null,
				h('div', { className: 'vs-mp-inspector-callout' }, h('strong', null, '配置边界'), h('p', null, p.kind === 'mcp' ? '凭据不显示在列表或概要中。配置入口沿用原有 JSON 校验、Host 保存及回执。' : '资源并无通用启停 API，不提供虚构开关。完整设置以对应工作台或插件入口为准。')),
				p.kind === 'mcp' ? btn('MCP 配置', props.onMcpConfig, { disabled: Boolean(pending) }) : btn('查看资源详情', function () { props.onDetail(p.slug, p.kind); }));
		}
		function detailBody(p) {
			var view = enriched(p), s = status(p), full = records[resourceKey(p)] || (props.metadata || {})[resourceKey(p)] || p;
			if (panel === 'config') { return configBody(p); }
			if (panel === 'version') { return h('div', { className: 'vs-mp-inspector-section' }, h('h3', null, '版本与更新'),
				h('div', { className: 'vs-mp-version-compare' }, fact('本机版本', p.installedVersion || p.version), h(Icon, { name: 'arrow' }), fact('商城更新版本', p.latestVersion || '尚未检出新版本')),
				h('p', { className: 'vs-mp-muted' }, '未检出更新不等于兼容性验证通过。未知状态不宣称已是最新。'),
				h('ol', { className: 'vs-mp-upgrade-steps' }, ['查看变更与依赖', '安装预览与明确确认', '验证落盘与实际生效'].map(function (text, i) { return h('li', { key: text }, h('span', null, i + 1), text); })),
				btn('查看版本记录', function () { props.onDetail(p.slug, p.kind); })); }
			return h('div', { className: 'vs-mp-inspector-section' }, h('div', { className: 'vs-mp-resource-facts' }, fact('资源类型', resourceLabels[p.kind] || p.kind), fact('来源', p.isLocal ? '本机未发布' : '商城安装记录'), fact('本机版本', p.installedVersion || p.version), fact('运行状态', '未验证')),
				h('div', { className: 'vs-mp-inspector-callout' }, h('strong', null, s.name), h('p', null, s.note)),
				h('h3', null, '资源介绍'), h('p', { className: 'vs-mp-inventory-description' }, full.description || p.description || '未提供介绍，可查看完整资源详情。'),
				view.cover && props.PkgCover ? h('div', { className: 'vs-mp-inspector-preview' }, h('small', null, '商城原始缩略图'), h(props.PkgCover, { pkg: view })) : null,
				btn('查看完整商品与原图', function () { props.onDetail(p.slug, p.kind); }, { className: 'vs-mp-link' }));
		}
		function actions(p) {
			var op = props.operations ? props.operations.get(resourceKey(p)) : {}, buttons = [];
			if (p.isLocal) { buttons.push(btn('发布前检查', function () { props.onPublishLocal(p); }, { key: 'publish', className: 'vs-mp-btn primary', disabled: op.pending })); }
			else if (p.upgradable) { buttons.push(btn('升级前检查', function () { props.onUpgrade(p); }, { key: 'upgrade', className: 'vs-mp-btn primary', disabled: op.pending })); }
			else if (p.kind === 'mcp') { buttons.push(btn('MCP 配置', props.onMcpConfig, { key: 'config', className: 'vs-mp-btn primary', disabled: op.pending })); }
			else { buttons.push(btn('查看商品详情', function () { props.onDetail(p.slug, p.kind); }, { key: 'detail', className: 'vs-mp-btn primary', disabled: op.pending })); }
			if (!p.isLocal) { buttons.push(btn('卸载…', function () { confirming[1](p); }, { key: 'uninstall', className: 'vs-mp-btn danger', disabled: op.pending })); }
			return h('footer', { className: 'vs-mp-inspector-actions' }, h('div', { className: 'vs-mp-tools', 'aria-busy': Boolean(op.pending) }, buttons), op.pending ? h('p', { role: 'status' }, '资源操作进行中…') : null,
				op.error ? h('p', { role: 'alert', className: 'vs-mp-error' }, op.error) : null, h('small', null, '保留预检与确认；安装不代表全部能力已就绪。'));
		}
		return h('section', { className: 'vs-mp-inventory', 'data-installed-manager': true },
			h('div', { className: 'vs-mp-inventory-heading' }, h('div', null, h('div', { className: 'vs-mp-eyebrow' }, 'LOCAL RESOURCES / 管理，不是推荐'), h('h2', null, '已安装资源'), h('p', null, '资源去向、版本与下一步操作，在一处看清。')),
				h('div', { className: 'vs-mp-tools' }, btn('检查更新', props.onRefresh, { disabled: props.busy }), btn('刷新清单', props.onRefresh, { disabled: props.busy }))),
			h('div', { className: 'vs-mp-inventory-controls' }, h('nav', { className: 'vs-mp-inventory-filters', 'aria-label': '安装资源状态筛选' }, [['all', '全部资源'], ['update', '可升级'], ['attention', '待处理'], ['local', '本机未发布'], ['disabled', '已停用']].map(function (entry) {
				return btn(entry[1] + ' · ' + sources.filter(function (p) { return match(p, entry[0]); }).length, function () { filtering[1](entry[0]); setOpen(false); }, { key: entry[0], 'aria-pressed': filter === entry[0], 'data-installed-filter': entry[0] });
			})), h('label', { className: 'vs-mp-inventory-sort' }, '排序 ', h('select', { className: 'vs-mp-input', value: order, 'aria-label': '安装资源排序', onChange: function (e) { ordering[1](e.target.value); } }, [['attention', '待处理优先'], ['name', '名称'], ['type', '资源类型']].map(function (entry) { return h('option', { key: entry[0], value: entry[0] }, entry[1]); })))),
			h('div', { className: 'vs-mp-inventory-workspace', 'data-open': open }, h('section', { className: 'vs-mp-inventory-list-panel', 'aria-label': '已安装资源列表' },
				h('header', { className: 'vs-mp-inventory-list-head' }, h('strong', null, '资源 ' + items.length + ' / ' + sources.length), h('span', null, '状态 / 本机版本')),
				items.length ? h('ul', { className: 'vs-mp-inventory-list' }, items.map(function (p) { var id = resourceKey(p), view = enriched(p); return h('li', { key: id },
					btn(h(React.Fragment, null, props.PkgIcon ? h(props.PkgIcon, { pkg: view }) : null,
						h('span', { className: 'vs-mp-inventory-copy' }, h('strong', null, view.name || p.slug), h('span', { className: 'vs-mp-inventory-row-desc' }, view.description || '查看资源详情'), h('span', { className: 'vs-mp-inventory-row-meta' }, (resourceLabels[p.kind] || p.kind) + ' · ' + (p.isLocal ? '本机副本' : '商城安装记录'))),
						h('span', { className: 'vs-mp-inventory-state' }, badge(p), h('small', null, p.isLocal ? '未上架副本' : 'v' + (p.installedVersion || p.version || '?'))), h('span', { className: 'vs-mp-inventory-chevron' }, '›')),
					function () { select(p); }, { className: 'vs-mp-inventory-row', ref: function (node) { if (node) rowRefs.current[id] = node; else delete rowRefs.current[id]; }, 'aria-current': resourceKey(p) === key, 'data-installed-select': id, title: (p.name || p.slug) + ' · ' + status(p).name })); }))
					: h('div', { className: 'vs-mp-inventory-empty', role: 'status' }, h(Icon, { name: 'search' }), h('h3', null, props.busy ? '读取本机清单…' : '没有匹配的资源'), h('p', null, props.busy ? '只显示真实返回状态。' : '调整搜索、品类或状态筛选，或刷新本机清单。')),
				h('footer', { className: 'vs-mp-inventory-list-foot' }, '单击资源查看详情', h('span', null, '状态不等于能力就绪'))),
				item ? h('aside', { className: 'vs-mp-inventory-inspector', 'aria-label': '选中资源详情' }, btn('← 返回资源列表', back, { ref: backRef, className: 'vs-mp-btn vs-mp-inventory-back' }),
					h('div', { className: 'vs-mp-inspector-title' }, h('div', { className: 'vs-mp-inspector-title-row' }, props.PkgIcon ? h(props.PkgIcon, { pkg: enriched(item), large: true }) : null, h('h2', null, enriched(item).name || item.slug)), h('p', { className: 'vs-mp-inspector-id' }, key), badge(item)),
					h('nav', { className: 'vs-mp-inspector-tabs', 'aria-label': '资源详情页签' }, [['overview', '概要'], ['version', '版本'], ['config', '配置']].map(function (entry) { return btn(entry[1], function () { panels[1](entry[0]); }, { key: entry[0], 'aria-pressed': panel === entry[0], 'data-installed-panel': entry[0] }); })), detailBody(item), actions(item))
					: h('aside', { className: 'vs-mp-inventory-inspector vs-mp-inventory-unselected' }, h('h3', null, '选择一项资源'), h('p', null, '这里展示详情、版本和配置。'))),
			confirm ? h(Drawer, { title: '卸载资源', onClose: function () { confirming[1](null); } }, h('p', null, '确认卸载 ' + (confirm.name || confirm.slug) + '？将按本机安装记录清理资源，失败时保留清单。'),
				btn('保留资源', function () { confirming[1](null); }), btn('确认卸载', function () { var target = sources.find(function (p) { return resourceKey(p) === resourceKey(confirm); }); confirming[1](null); if (target && !target.isLocal) { void props.onUninstall(target); } }, { disabled: Boolean(props.operations && props.operations.get(resourceKey(confirm)).pending), className: 'vs-mp-btn danger' })) : null);
	}
	window.MarketplaceUI = { Drawer: Drawer, Discovery: Discovery, Favorites: Favorites, InstalledManager: InstalledManager, Icon: Icon, installedStatus: installedStatus };
})();
