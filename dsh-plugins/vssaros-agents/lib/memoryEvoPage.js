/*
 * 记忆演化面板（`/x/agents/memory/<agentId>`）—— 2026-10-21，参照 DeepSeekBot 的
 * `packages/client/src/client/memory-entry.tsx`（演化 / 版本两个标签）复刻。
 *
 * ⚠ 术语先对齐：DSB 的「记忆演化」**不是** LLM 提炼/衰减流水线，而是**记忆 Git 仓库的
 *   工作树 + 提交历史 + 版本**（`docs/channel-sidebar/memory-evolution.zh.md`）。我们这边
 *   数据面早就有了（`/x/agents/api/memory`：`log` / `rev` / `against` / `restore` / `versions`），
 *   缺的只是**一个看得懂的界面** —— 本文件补的就是它。
 *
 * 与详情页那个「记忆」页签的分工：
 *   · 详情页 = 管理面（换文件、改上限、启用 Git、提交快照），一屏塞得下；
 *   · 本面板 = 演化面（时间线 / 逐行 diff / 版本 / 回滚），需要宽度，所以独立成页签。
 *
 * 2026-10-21 陆续补齐：版本（tag，可给**指定提交**起名）、备份与恢复、分支（新建 / 切换 /
 * 从某次提交继续）、术语切换（记忆 ⇄ Git）、提交级操作（⋯：起名 / 从这里建分支 / 恢复到这次）。
 *
 * 仍刻意没做：Git 分道图（我们每个 agent 单线性历史，画图没有信息量）、分支合并与冲突解决。
 */

const CSS = `
:root{--mp-panel:#252526;--mp-panel2:#2d2d30;--mp-line:#3c3c3c;--mp-line2:#4a4a4a;--mp-fg:#ccc;--mp-fg2:#9d9d9d;--mp-fg3:#6f6f6f;--mp-accent:#0e639c;--mp-add:#2ea043;--mp-del:#f85149;--mp-warn:#cca700}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-foreground,#ccc);font:13px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;overflow:hidden}
button{font:inherit;color:inherit;background:transparent;border:0;cursor:pointer}
input,select{font:inherit;color:inherit;background:var(--vscode-input-background,#2a2a2a);border:1px solid var(--mp-line);border-radius:5px;padding:4px 7px;outline:none}
input:focus,select:focus{border-color:var(--mp-accent)}
.mp{display:grid;grid-template-columns:264px minmax(0,1fr);height:100vh}
.mp-side{border-right:1px solid var(--mp-line);background:var(--mp-panel);display:flex;flex-direction:column;min-width:0}
.mp-head{padding:9px 10px;border-bottom:1px solid var(--mp-line)}
.mp-title{font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:6px}
.mp-meta{font-size:10.5px;color:var(--mp-fg3);margin-top:2px;line-height:1.6;word-break:break-all}
.mp-tabs{display:flex;border-bottom:1px solid var(--mp-line);flex:none}
.mp-tab{padding:6px 11px;font-size:11.5px;color:var(--mp-fg2);border-bottom:2px solid transparent}
.mp-tab.on{color:#fff;border-bottom-color:var(--mp-accent)}
.mp-list{flex:1;overflow:auto;padding:4px 5px 8px;min-height:0}
.mp-item{padding:5px 7px;border-radius:5px;cursor:pointer;margin-bottom:2px}
.mp-item:hover{background:var(--mp-panel2)}
.mp-item.on{background:#094771}
.mp-item .s{font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp-item .h{font-size:9.5px;color:var(--mp-fg3);display:flex;gap:6px;margin-top:1px}
.mp-item .h code{font-family:ui-monospace,Consolas,monospace}
/* 提交级操作（DSB 的提交右键菜单）：⋯ 展开「起名 / 建分支 / 恢复」 */
.mp-more{position:absolute;right:4px;top:4px;width:18px;height:18px;border-radius:4px;font-size:12px;color:var(--fg3);cursor:pointer;line-height:1}
.mp-more:hover{background:var(--chip);color:#fff}
.mp-acts{display:flex;gap:6px;padding:2px 8px 8px;flex-wrap:wrap}
.mp-acts[hidden]{display:none}
.mp-item .tagline{color:#e2c08d}
.mp-sec{padding:8px 7px 3px;font-size:10px;color:var(--mp-fg3)}
.mp-main{display:flex;flex-direction:column;min-width:0}
.mp-bar{height:38px;display:flex;align-items:center;gap:8px;padding:0 11px;border-bottom:1px solid var(--mp-line);flex:none;font-size:11.5px}
.mp-bar .st{color:var(--mp-fg3);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp-diff{flex:1;overflow:auto;min-height:0;font:11.5px/1.6 ui-monospace,Consolas,monospace;padding:8px 0 40px}
.mp-hunk{display:flex;gap:8px;padding:0 10px;white-space:pre-wrap;word-break:break-word}
.mp-hunk .ln{width:34px;flex:none;text-align:right;color:var(--mp-fg3);user-select:none}
.mp-hunk .tx{flex:1;min-width:0}
.mp-hunk.add{background:rgba(46,160,67,.12)}
.mp-hunk.add .tx{color:#b7f0c4}
.mp-hunk.del{background:rgba(248,81,73,.12)}
.mp-hunk.del .tx{color:#ffc2bd}
.mp-hunk.same{color:var(--mp-fg2)}
.mp-empty{padding:22px;color:var(--mp-fg3);font-size:12px;line-height:1.8}
.mp-empty b{color:var(--vscode-foreground,#ccc)}
.mp-note{padding:6px 11px;font-size:10.5px;color:var(--mp-warn);border-bottom:1px solid var(--mp-line)}
.btn{padding:4px 10px;border-radius:5px;border:1px solid var(--mp-line2);font-size:11.5px}
.btn:hover{background:var(--mp-panel2)}
.btn.primary{background:var(--mp-accent);border-color:transparent;color:#fff}
.btn.danger{background:#a1262a;border-color:transparent;color:#fff}
.mp-newv{display:flex;gap:6px;padding:6px 7px;border-top:1px solid var(--mp-line)}
.mp-newv input{flex:1;min-width:0;font-size:11px}
`;

function clientJs(agentId) {
	const L = [];
	const add = (...p) => L.push(p.join(''));
	add('(function(){');
	add('var AGENT=', JSON.stringify(agentId), ';');
	add('var S={files:[],log:[],versions:[],backups:[],branches:[],branch:"",git:null,tab:"evo",sel:null,diff:null,coarse:false,term:"memory"};');
	add('function $(id){return document.getElementById(id);}');
	add('function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}');
	add('function api(q){return fetch("/x/agents/api/memory?"+q+"&agent="+encodeURIComponent(AGENT),{headers:{"cache-control":"no-cache"}}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||("HTTP "+r.status));return j;});});}');
	add('function post(body){return fetch("/x/agents/api/memory",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(Object.assign({agent:AGENT},body))}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||("HTTP "+r.status));return j;});});}');
	add('');

	/* 载入：文件 + log + 版本 */
	add('function load(){');
	add(' api("limit=50&versions=1&backups=1&branches=1").then(function(d){');
	add('  S.files=d.files||[];S.log=d.log||[];S.versions=d.versions||[];S.backups=d.backups||[];S.git=d.git||null;');
	add('  S.branches=d.branches||[];S.branch=d.branch||"";renderBranch();');
	add('  $("mpMeta").innerHTML=(S.git&&S.git.enabled)');
	add('   ?("分支 <code>"+esc(S.git.branch||"main")+"</code> · "+S.git.total+" 个提交"+(S.git.dirty?(" · <b style=\\"color:var(--mp-warn)\\">"+S.git.dirty+" 个未提交</b>"):"")+"")');
	add('   :"<b>还没启用 Git 版本化</b><br>去「Agents → 记忆」页签点「启用」后，这里才有历史。";');
	add('  $("mpFile").innerHTML=(S.files||[]).map(function(f){return "<option value=\\""+esc(f.name)+"\\">"+esc(f.name)+"</option>";}).join("")||"<option>MEMORY.md</option>";');
	add('  renderList();');
	add('  if(!S.sel){pick("working");}else{renderDiff();}');
	add(' }).catch(function(e){$("mpDiff").innerHTML="<div class=\\"mp-empty\\">载入失败："+esc(e.message)+"</div>";});');
	add('}');
	add('');

	/* 左列表：演化（未提交 + 提交）/ 版本 */
	add('function renderList(){');
	add(' $("mpTabEvo").className="mp-tab"+(S.tab==="evo"?" on":"");');
	add(' $("mpTabVer").className="mp-tab"+(S.tab==="ver"?" on":"");');
	add(' $("mpTabBak").className="mp-tab"+(S.tab==="bak"?" on":"");');
	add(' $("mpNewVersion").style.display=(S.tab==="ver"&&S.git&&S.git.enabled)?"":"none";');
	add(' $("mpNewBackup").style.display=(S.tab==="bak")?"":"none";');
	add(' applyTerm();');
	// 备份标签：点一条 = 恢复到那次（先自动给当前状态再备一份）
	add(' if(S.tab==="bak"){');
	add('  $("mpList").innerHTML=(S.backups.length?S.backups.map(function(b){');
	add('   return "<div class=\\"mp-item\\" data-bak=\\""+esc(b.id)+"\\"><div class=\\"s\\">"+esc(b.reason||"手动备份")+"</div>"');
	add('    +"<div class=\\"h\\"><span>"+fmtTime(b.at)+"</span><span>"+(b.files||[]).length+" 个文件</span></div></div>";');
	add('  }).join(""):"<div class=\\"mp-empty\\">还没有备份。<br>提交快照 / 回滚 / 恢复前会自动备一份；也可以点下面「立即备份」。</div>");');
	add('  Array.prototype.forEach.call($("mpList").querySelectorAll("[data-bak]"),function(el){');
	add('   el.onclick=function(){restoreBackup(el.getAttribute("data-bak"));};');
	add('  });');
	add('  return;');
	add(' }');
	add(' if(S.tab==="ver"){');
	add('  $("mpList").innerHTML=(S.versions.length?S.versions.map(function(v){');
	add('   return "<div class=\\"mp-item\\" data-ver=\\""+esc(v.tag)+"\\" data-hash=\\""+esc(v.hash)+"\\"><div class=\\"s\\">"+esc(v.tag)+"</div>"');
	add('    +"<div class=\\"h\\"><code>"+esc(v.hash)+"</code><span>"+esc(v.date||"")+"</span><span class=\\"tagline\\">版本</span></div></div>";');
	add('  }).join(""):"<div class=\\"mp-empty\\">还没有版本。<br>在下方输入名字给当前提交打个版本。</div>");');
	add('  Array.prototype.forEach.call($("mpList").querySelectorAll("[data-ver]"),function(el){');
	add('   el.onclick=function(){pick(el.getAttribute("data-hash"),"版本 "+el.getAttribute("data-ver"));};');
	add('  });');
	add('  return;');
	add(' }');
	add(' var html="";');
	add(' if(S.git&&S.git.enabled&&S.git.dirty){html+="<div class=\\"mp-item"+(S.sel&&S.sel.kind==="working"?" on":"")+"\\" data-working=\\"1\\"><div class=\\"s\\">未提交改动</div><div class=\\"h\\"><span>"+S.git.dirty+" 个文件</span><span>对比 HEAD</span></div></div>";}');
	add(' html+="<div class=\\"mp-sec\\">提交历史（"+S.log.length+"）</div>";');
	add(' html+=(S.log.length?S.log.map(function(c){');
	add('  var on=(S.sel&&S.sel.rev===c.hash)?" on":"";');
	add('  return "<div class=\\"mp-item"+on+"\\" data-rev=\\""+esc(c.hash)+"\\"><div class=\\"s\\">"+esc(c.subject)+"</div>"');
	add('   +"<div class=\\"h\\"><code>"+esc(c.hash)+"</code><span>"+esc(c.date)+"</span>"');
	// 提交级操作（DSB 的「提交右键菜单」）：起名 / 从这里新建并切换分支 / 恢复到这次提交
	add('   +"<button class=\\"mp-more\\" data-more=\\""+esc(c.hash)+"\\" title=\\"这次提交的操作\\">⋯</button></div></div>"');
	add('   +"<div class=\\"mp-acts\\" id=\\"acts-"+esc(c.hash)+"\\" hidden>"');
	add('     +"<button class=\\"btn\\" data-tag=\\""+esc(c.hash)+"\\">给这次起名</button>"');
	add('     +"<button class=\\"btn\\" data-branch=\\""+esc(c.hash)+"\\">从这里建分支</button>"');
	add('     +"<button class=\\"btn danger\\" data-restore=\\""+esc(c.hash)+"\\">恢复到这次</button></div>";');
	add(' }).join(""):"<div class=\\"mp-empty\\">还没有提交。<br>记忆文件改动后，在详情页点「提交快照」。</div>");');
	add(' $("mpList").innerHTML=html;');
	add(' var w=$("mpList").querySelector("[data-working]");if(w)w.onclick=function(){pick("working");};');
	add(' Array.prototype.forEach.call($("mpList").querySelectorAll("[data-rev]"),function(el){el.onclick=function(){pick(el.getAttribute("data-rev"));};});');
	// 提交级操作（DSB 的提交右键菜单）：⋯ 展开 / 起名 / 从这里建分支 / 恢复到这次
	add(' Array.prototype.forEach.call($("mpList").querySelectorAll("[data-more]"),function(b){');
	add('  b.onclick=function(e){e.stopPropagation();var row=document.getElementById("acts-"+b.getAttribute("data-more"));if(row)row.hidden=!row.hidden;};');
	add(' });');
	add(' Array.prototype.forEach.call($("mpList").querySelectorAll("[data-tag]"),function(b){b.onclick=function(e){e.stopPropagation();tagRev(b.getAttribute("data-tag"));};});');
	add(' Array.prototype.forEach.call($("mpList").querySelectorAll("[data-branch]"),function(b){b.onclick=function(e){e.stopPropagation();branchFrom(b.getAttribute("data-branch"));};});');
	add(' Array.prototype.forEach.call($("mpList").querySelectorAll("[data-restore]"),function(b){b.onclick=function(e){e.stopPropagation();restoreRev(b.getAttribute("data-restore"));};});');
	add('function tagRev(rev){');
	add(' var name=prompt("给这次提交起个版本名：","v1");if(!name)return;');
	add(' post({action:"version-add",tag:name,rev:rev}).then(function(){load();}).catch(function(e){alert("起名失败："+e.message);});');
	add('}');
	add('function branchFrom(rev){');
	add(' var name=prompt("从这次提交新建并切换分支：","exp");if(!name)return;');
	add(' post({action:"branch-create",name:name,from:rev}).then(function(){load();}).catch(function(e){alert("建分支失败："+e.message);});');
	add('}');
	add('function restoreRev(rev){');
	add(' var f=curFile();');
	add(' if(!confirm("把「"+f+"」恢复到这次提交？\\n\\n会写回文件并自动提交一条快照（历史不会丢）。"))return;');
	add(' post({action:"restore",rev:rev,file:f}).then(function(){alert("已恢复，并提交了快照");load();}).catch(function(e){alert("恢复失败："+e.message);});');
	add('}');
	add('}');
	add('$("mpTabEvo").onclick=function(){S.tab="evo";renderList();};');
	add('$("mpTabVer").onclick=function(){S.tab="ver";renderList();};');
	add('$("mpTabBak").onclick=function(){S.tab="bak";renderList();};');
	add('function fmtTime(t){try{return new Date(t).toLocaleString();}catch(e){return String(t);}}');
	add('$("mpDoBackup").onclick=function(){');
	add(' post({action:"backup",reason:"手动备份"}).then(function(){load();}).catch(function(e){alert("备份失败："+e.message);});');
	add('};');
	add('function restoreBackup(id){');
	add(' var b=null;for(var i=0;i<S.backups.length;i++){if(S.backups[i].id===id)b=S.backups[i];}');
	add(' var when=b?fmtTime(b.at):id;');
	add(' if(!confirm("把记忆恢复到备份「"+when+"」？\\n\\n会先给当前状态再备一份，然后写回文件并自动提交快照。"))return;');
	add(' post({action:"restore-backup",backup:id}).then(function(){alert("已恢复，并提交了快照");load();}).catch(function(e){alert("恢复失败："+e.message);});');
	add('}');
	// 术语切换（DSB 的 memory-view-prefs）：记忆 / Git —— 只换标签，数据不变
	add('function applyTerm(){');
	add(' var git=S.term==="git";');
	add(' $("mpTabEvo").textContent=git?"Git 历史":"演化";');
	add(' $("mpTabVer").textContent=git?"标签":"版本";');
	add(' $("mpTabBak").textContent="备份";');
	add(' var rb=$("mpRestore");if(rb)rb.textContent=git?"恢复到这次提交":"回滚到这一版";');
	add(' var bb=$("mpDoBackup");if(bb)bb.textContent=git?"立即备份当前工作树":"立即备份当前记忆";');
	add('}');
	add('$("mpTerm").onchange=function(){S.term=$("mpTerm").value||"memory";try{localStorage.setItem("vssaros.memory.term",S.term);}catch(e){}renderList();};');
	add('try{S.term=localStorage.getItem("vssaros.memory.term")||"memory";}catch(e){}');
	add('$("mpTerm").value=S.term;');
	add('');

	/* 选一个版本 → 拉 diff */
	add('function pick(rev,label){');
	add(' S.sel={kind:rev==="working"?"working":"commit",rev:rev,label:label||rev};');
	add(' renderList();renderDiff();');
	add('}');
	add('function curFile(){var el=$("mpFile");return el&&el.value?el.value:"MEMORY.md";}');
	add('$("mpFile").onchange=function(){renderDiff();};');
	add('function renderDiff(){');
	add(' $("mpBarTitle").textContent=S.sel?((S.sel.kind==="working"?"未提交改动":S.sel.label)+" · "+curFile()):"选一个提交";');
	add(' $("mpRestore").style.display=(S.sel&&S.sel.kind==="commit")?"":"none";');
	add(' if(!S.sel){$("mpDiff").innerHTML="<div class=\\"mp-empty\\">左边选一个提交或版本，这里显示它相对上一版的逐行改动。</div>";return;}');
	add(' var rev=S.sel.kind==="working"?"HEAD":S.sel.rev;');
	add(' var against=S.sel.kind==="working"?"working":(S.sel.rev+"~1");');
	add(' $("mpDiff").innerHTML="<div class=\\"mp-empty\\">载入 diff…</div>";');
	add(' api("rev="+encodeURIComponent(rev)+"&against="+encodeURIComponent(against)+"&file="+encodeURIComponent(curFile())).then(function(d){');
	add('  var diff=d.diff||null;S.diff=diff;');
	add('  if(!diff){$("mpDiff").innerHTML="<div class=\\"mp-empty\\">这一版没有这个文件。</div>";return;}');
	add('  if(!diff.rows||!diff.rows.length){$("mpDiff").innerHTML="<div class=\\"mp-empty\\">这一版相对上一版<b>没有改动</b>（或该文件是新增/删除）。</div>";return;}');
	add('  var html="";if(diff.coarse)html+="<div class=\\"mp-note\\">改动太大，已退化为整块对比（不做逐行匹配）。</div>";');
	add('  diff.rows.forEach(function(r){');
	add('   var cls=r.type==="add"?"add":(r.type==="del"?"del":"same");');
	add('   var ln=r.type==="add"?(r.b||""):(r.a||"");');
	add('   html+="<div class=\\"mp-hunk "+cls+"\\"><span class=\\"ln\\">"+ln+"</span><span class=\\"tx\\">"+esc(r.text)+"</span></div>";');
	add('  });');
	add('  html+="<div class=\\"mp-sec\\">+"+diff.added+" / -"+diff.removed+"</div>";');
	add('  $("mpDiff").innerHTML=html;');
	add(' }).catch(function(e){$("mpDiff").innerHTML="<div class=\\"mp-empty\\">diff 失败："+esc(e.message)+"</div>";});');
	add('}');
	add('');

	/* 回滚 / 版本 */
	// 分支（2026-10-21）：下拉 = 现有分支（当前分支置顶）；「＋ 分支」从选中提交/HEAD 拉一条
	add('function renderBranch(){');
	add(' var sel=$("mpBranch");if(!sel)return;');
	add(' var list=S.branches||[];');
	add(' sel.innerHTML=list.length?list.map(function(b){return "<option value=\\""+esc(b.name)+"\\""+(b.name===S.branch?" selected":"")+">"+esc(b.name)+"</option>";}).join(""):"<option value=\\"\\">（未启用）</option>";');
	add(' sel.disabled=!list.length;');
	add('}');
	add('$("mpBranch").onchange=function(){');
	add(' var name=this.value;if(!name||name===S.branch)return;');
	add(' post({action:"branch-switch",name:name}).then(function(){load();}).catch(function(e){alert("切分支失败："+e.message);renderBranch();});');
	add('};');
	add('$("mpNewBranch").onclick=function(){');
	add(' var name=prompt("新分支名（字母/数字/. _ -）：","exp");if(!name)return;');
	add(' var from=(S.sel&&S.sel.kind==="commit")?S.sel.rev:"";');
	add(' post({action:"branch-create",name:name,from:from}).then(function(){load();}).catch(function(e){alert("建分支失败："+e.message);});');
	add('};');
	add('$("mpRefresh").onclick=load;');
	add('$("mpRestore").onclick=function(){');
	add(' if(!S.sel||S.sel.kind!=="commit")return;');
	add(' var f=curFile();');
	add(' if(!confirm("把「"+f+"」回滚到 "+S.sel.rev+"？\\n\\n会写回文件并自动提交一个快照（历史不会丢）。"))return;');
	add(' post({action:"restore",rev:S.sel.rev,file:f}).then(function(j){');
	add('  alert("已回滚 "+j.name+" 到 "+j.rev+(j.snapshot&&j.snapshot.committed?"（已提交快照）":""));');
	add('  load();');
	add(' }).catch(function(e){alert("回滚失败："+e.message);});');
	add('};');
	add('$("mpAddVer").onclick=function(){');
	add(' var name=$("mpVerName").value.trim();if(!name){alert("先起个版本名（字母/数字/. _ -）");return;}');
	add(' post({action:"version-add",tag:name}).then(function(){ $("mpVerName").value="";load(); }).catch(function(e){alert("打版本失败："+e.message);});');
	add('};');
	add('');

	add('load();');
	add('setInterval(function(){if(!document.hidden)load();},15000);');
	add('})();');
	return L.join('\n');
}

/** 渲染演化面板整页（服务端只给壳；数据全走 `/x/agents/api/memory`）。 */
export function renderMemoryEvoPage({ agentId, agentName, missing } = {}) {
	const safeJson = (v) => JSON.stringify(v ?? null).replace(/</g, '\\u003c');
	if (missing) {
		return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>记忆演化</title></head>'
			+ '<body style="background:#1e1e1e;color:#ccc;font:13px/1.6 sans-serif;padding:24px">'
			+ `<h3>没有这个 agent：${escapeText(String(agentId ?? ''))}</h3>`
			+ '<p style="color:#9d9d9d">它可能已被删除，或者 id 写错了。</p></body></html>';
	}
	return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
		+ '<meta name="viewport" content="width=device-width, initial-scale=1">'
		+ `<title>记忆演化 · ${escapeText(agentName || agentId)}</title>`
		+ `<style>${CSS}</style></head><body>`
		+ '<div class="mp">'
		+ '<aside class="mp-side">'
		+ `<div class="mp-head"><div class="mp-title">记忆演化 <span style="flex:1"></span>`
		+ '<select id="mpTerm" title="术语：记忆 / Git" style="font-size:10px;padding:1px 4px">'
		+ '<option value="memory">记忆</option><option value="git">Git</option></select>'
		+ `<code style="font-size:10px;color:#9d9d9d;margin-left:6px">${escapeText(agentId)}</code></div>`
		+ '<div class="mp-meta" id="mpMeta">…</div></div>'
		+ '<div class="mp-tabs"><button class="mp-tab on" id="mpTabEvo">演化</button>'
		+ '<button class="mp-tab" id="mpTabVer">版本</button>'
		+ '<button class="mp-tab" id="mpTabBak">备份</button></div>'
		+ '<div class="mp-list" id="mpList"></div>'
		+ '<div class="mp-newv" id="mpNewVersion" style="display:none">'
		+ '<input id="mpVerName" placeholder="版本名，如 v1-初版" maxlength="64">'
		+ '<button class="btn" id="mpAddVer">打版本</button></div>'
		// 备份（2026-10-21）：提交/回滚前会自动备份，这里也能手动备一份
		+ '<div class="mp-newv" id="mpNewBackup" style="display:none">'
		+ '<button class="btn" id="mpDoBackup" style="width:100%">立即备份当前记忆</button></div>'
		+ '</aside>'
		+ '<main class="mp-main">'
		+ '<div class="mp-bar"><span id="mpBarTitle" class="st">选一个提交</span><span style="flex:1"></span>'
		// 分支（2026-10-21）：切分支 / 从选中提交拉新分支（工作树脏时后端会拒，并给可读原因）
		+ '<span class="st">分支</span><select id="mpBranch" title="记忆仓库分支"></select>'
		+ '<button class="btn" id="mpNewBranch" title="从当前选中提交（没选就从 HEAD）拉一条新分支">＋ 分支</button>'
		+ '<span class="st">文件</span><select id="mpFile"></select>'
		+ '<button class="btn" id="mpRefresh">刷新</button>'
		+ '<button class="btn danger" id="mpRestore" style="display:none">回滚到这一版</button></div>'
		+ '<div class="mp-diff" id="mpDiff"><div class="mp-empty">左边选一个提交或版本，这里显示它相对上一版的逐行改动。</div></div>'
		+ '</main></div>'
		+ `<script>${clientJs(agentId)}</script>`
		+ '</body></html>';
}

function escapeText(s) {
	return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
