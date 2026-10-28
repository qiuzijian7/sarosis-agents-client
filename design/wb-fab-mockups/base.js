// 聊天面板 mock + 六种浮动条形态（每个方案页共用）
function el(tag, cls, text) {
	var n = document.createElement(tag);
	if (cls) { n.className = cls; }
	if (text != null) { n.textContent = text; }
	return n;
}

function buildChat(host, opt) {
	opt = opt || {};
	var chat = el('div', 'chat');
	var top = el('div', 'top');
	top.appendChild(el('span', 't', '萨罗斯管理平台'));
	top.appendChild(el('span', 'sp'));
	if (opt.topbar) { top.appendChild(opt.topbar); }
	top.appendChild(el('button', 'ghost', '+ 新会话'));
	chat.appendChild(top);
	var msgs = el('div', 'msgs');
	msgs.appendChild(el('div', 'msg bot', '描述你要构建的内容，调用指令、@ 文件或对话'));
	msgs.appendChild(el('div', 'msg me', '帮我把「探索未至之境」的知识库整理成 FAQ'));
	msgs.appendChild(el('div', 'msg bot', '好，我先读取知识库索引，再按主题归并。'));
	chat.appendChild(msgs);
	var comp = el('div', 'composer');
	comp.appendChild(el('div', 'box', '输入你的问题…'));
	var send = el('div', 'send');
	send.appendChild(el('span', 'ph'));
	send.appendChild(el('span', 'go', '↑'));
	comp.appendChild(send);
	chat.appendChild(comp);
	var fab = buildFab(opt.variant, opt.state);
	if (fab) { chat.appendChild(fab); }
	host.appendChild(chat);
	return chat;
}

function labeledBtn(cls, glyph, label) {
	var w = el('div', 'wbWrap');
	var b = el('button', 'wbAct ' + (cls || ''), glyph);
	b.type = 'button';
	w.appendChild(b);
	w.appendChild(el('span', 'wbLabel', label));
	return w;
}

function buildFab(variant, state) {
	if (!variant || variant === 'f') { return null; }
	var wrap = el('div', 'fabwrap fab-' + variant + (state === 'hover' ? ' hovered' : ''));
	if (variant === 'c') {
		wrap.appendChild(labeledBtn('assist', '▣', '收起 AI 助手'));
		wrap.appendChild(labeledBtn('open', '↗', '在浏览器打开'));
		return wrap;
	}
	if (variant === 'd') {
		var knob = el('button', 'knob', '⋯');
		knob.type = 'button';
		wrap.appendChild(knob);
		var menu = el('div', 'knobMenu');
		menu.appendChild(labeledBtn('assist', '▣', '收起 AI 助手'));
		menu.appendChild(labeledBtn('open', '↗', '在浏览器打开'));
		wrap.appendChild(menu);
		return wrap;
	}
	wrap.appendChild(labeledBtn('assist', '▣', '收起 AI 助手'));
	wrap.appendChild(el('div', 'wbDivider'));
	wrap.appendChild(labeledBtn('open', '↗', '在浏览器打开'));
	return wrap;
}

function topbarButtons() {
	var g = el('div', 'topbtns');
	g.appendChild(el('button', 'ghost', '▣ 收起 AI 助手'));
	g.appendChild(el('button', 'ghost', '↗ 外开'));
	return g;
}

window.buildChat = buildChat;
window.topbarButtons = topbarButtons;
window.el = el;
/* 页面里凡是 data-variant 的容器都会被装配成一个聊天面板 mock（省掉每个页面的内联脚本） */
document.addEventListener('DOMContentLoaded', function () {
	var hosts = document.querySelectorAll('[data-variant]');
	for (var i = 0; i < hosts.length; i++) {
		var h = hosts[i];
		var opt = { variant: h.getAttribute('data-variant'), state: h.getAttribute('data-state') };
		if (opt.variant === 'f') { opt.topbar = topbarButtons(); }
		buildChat(h, opt);
	}
});