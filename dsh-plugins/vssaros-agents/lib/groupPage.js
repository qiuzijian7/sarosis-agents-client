/*
 * 群聊页（`/x/agents/group/<groupId>`）—— 2026-10-21 第四轮：**按 DeepSeekBot v3 桌面版重做布局**。
 *
 * 布局基准（DSB 源码 + 官方截图 docs/assets/readme/v3/zh/hero.jpg、group-collaboration.jpg）：
 *   ┌56 rail┬ 220 频道列表 ┬──── 中间栏 = 群聊页 ────┬ 320 右栏 ┐
 *   │       │ Agent 列表    │ ┌236(可折叠)┬ 聊天 ┐  │ 记忆/演化/│
 *   │       │ 群聊列表      │ │ Agent 列表 │      │  版本/分支/│
 *   │       │               │ │ 群聊列表   │      │  成员/工作 │
 *   └───────┴───────────────┴───────────┴──────┴──────────┘
 *   · header 是**居中岛屿胶囊**（不是实心条）：群头像 + 成员 facepile + 群名 + caret + 未读红点
 *   · 消息栈 `max-width: min(560px, calc(100% - 84px))`（不是居中大列）；气泡 radius 16、组内切角 4px
 *   · composer 是**胶囊**（radius 25 / min-height 50），发送键 34×34 圆钮绝对右下；下面一条工具条
 *   · 右栏 tab：**记忆 / 演化 / 版本 / 分支**（DSB v3）+ 我们另有的**成员 / 工作**（DSB 群聊侧栏）
 *   · 响应式：窄屏右栏变「点开才覆盖」的抽屉；再窄则左栏折叠
 *
 * 消息分组口径改成 DSB 的 `message-groups.ts`：同作者 + 同一天 + **相邻 ≤15s** + **整组跨度 ≤180s**
 * + **每组 ≤8 条**（此前用的是我自己定的 5 分钟合并，与 DSB 不一致）。
 *
 * 业务能力沿用上一轮（未删）：四档唤醒策略 / 汇总超时 / 群设置（改名·策略·阈值·头像·加入需确认·解散）/
 * 邀请·移出 / 待确认区 / 未读红点 / 已读上报 / 工作四组 / 群头像。
 */

/* ★ 2026-10-26：消息分组/分隔的**唯一真源**在 `core/groupChat.js`。
   本页是 SSR（内联字符串 JS），没法直接 import 进浏览器 ⇒ 用 `toString()` 把**同一份函数体**
   注入到内联脚本（见下方 `__chatRows` 的注入处）。
   工作台面板（client.agents.js）跑在宿主 chunk 加载器里、也 import 不了本地模块，
   那边保留一份同构实现 —— 由 `p3-190` 用**同一组夹具**比对两边结果，防漂移。 */
import { chatRows, sepLabel } from './core/groupChat.js';

const CSS = `
/* ★ 主题：跟随宿主（VS Code 主题变量）—— 不再自带一套写死的浅色皮。
   之前是 --gp-bg:#f7f7f8 那套固定浅色 ⇒ 塞进 IDE 的深色外壳里就是一块白底 ✗。
   现在每个 --gp-* 都指向 --vscode-*（IDE webview 里由 VS Code 注入 ✓）；
   不在 IDE 里（浏览器直开 / dsh 全窗）⇒ 落到 fallback（默认深色，浅色系统用媒体查询覆盖）✓。
   iframe 场景：iframe 是独立文档拿不到父页面的变量 ⇒ 父页面（detail.js）会把变量灌进来 ✓。 */
:root{
  /* fallback 值（不在 IDE 里时才用）：媒体查询只改这一层 ⇒ 主链永远优先取 --vscode-* ✓
     ⚠ 别在媒体查询里直接写 --gp-bg:…（那会**盖掉**主题变量 ⇒ 有主题也变浅色）✗ */
  --gp-fb-bg:#1e1e1e; --gp-fb-panel:#252526; --gp-fb-panel2:#2a2d2e; --gp-fb-panel3:#04395e;
  --gp-fb-line:#3c3c3c; --gp-fb-line2:#4a4a4a; --gp-fb-fg:#cccccc; --gp-fb-fg2:#9d9d9d; --gp-fb-fg3:#7a7a7a;
  --gp-fb-accent:#0078d4; --gp-fb-accent2:#026ec1; --gp-fb-blue:#4daafc; --gp-fb-ok:#89d185; --gp-fb-warn:#cca700;
  --gp-fb-shadow:rgba(0,0,0,.35); --gp-fb-scrim:rgba(0,0,0,.45);
  --gp-bg:var(--vscode-editor-background,var(--gp-fb-bg));
  --gp-panel:var(--vscode-sideBar-background,var(--gp-fb-panel));
  --gp-panel2:var(--vscode-list-hoverBackground,var(--gp-fb-panel2));
  --gp-panel3:var(--vscode-list-activeSelectionBackground,var(--gp-fb-panel3));
  --gp-line:var(--vscode-panel-border,var(--vscode-editorWidget-border,var(--gp-fb-line)));
  --gp-line2:var(--vscode-input-border,var(--vscode-widget-border,var(--gp-fb-line2)));
  --gp-fg:var(--vscode-foreground,var(--gp-fb-fg));
  --gp-fg2:var(--vscode-descriptionForeground,var(--gp-fb-fg2));
  --gp-fg3:var(--vscode-disabledForeground,var(--gp-fb-fg3));
  --gp-accent:var(--vscode-button-background,var(--gp-fb-accent));
  --gp-accent2:var(--vscode-button-hoverBackground,var(--gp-fb-accent2));
  --gp-blue:var(--vscode-textLink-foreground,var(--gp-fb-blue));
  --gp-ok:var(--vscode-charts-green,var(--gp-fb-ok));
  --gp-warn:var(--vscode-editorWarning-foreground,var(--vscode-charts-yellow,var(--gp-fb-warn)));
  --gp-shadow:var(--vscode-widget-shadow,var(--gp-fb-shadow));
  --gp-scrim:var(--vscode-editorOverlay-background,var(--gp-fb-scrim));
}
@media (prefers-color-scheme: light){
  :root{
    --gp-fb-bg:#ffffff; --gp-fb-panel:#f8f8f8; --gp-fb-panel2:#f0f0f0; --gp-fb-panel3:#e4e6f1;
    --gp-fb-line:#e2e2e6; --gp-fb-line2:#cecece; --gp-fb-fg:#1f1f24; --gp-fb-fg2:#6b6b76; --gp-fb-fg3:#9a9aa4;
    --gp-fb-accent:#005fb8; --gp-fb-accent2:#0258a8; --gp-fb-blue:#005fb8; --gp-fb-ok:#3a9d5c; --gp-fb-warn:#8a6100;
    --gp-fb-shadow:rgba(0,0,0,.16); --gp-fb-scrim:rgba(0,0,0,.32);
  }
}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
/* ★ ?embed=1（2026-10-23）：被父页面（agents 工作台中间栏）以 iframe 内嵌时，
   父页面已经提供了左栏（名册+群聊）与右栏（记忆/演化/版本/分支）⇒ 这里只留中间聊天列，
   否则会出现"两套左栏 + 两套右栏"。客户端脚本启动时按 location.search 加 .embed。 */
body.embed .gp-left,body.embed .gp-right,body.embed .gp-ovl{display:none!important}
body.embed .gp-page{padding-left:0}
/* embed 下「‹ 展开左栏」「面板」两个按钮指向的栏已经没了 ⇒ 一并隐藏（否则点了没反应 ✗） */
body.embed #gpLeftBtn,body.embed #gpRightBtn{display:none!important}
body{background:var(--gp-bg);color:var(--gp-fg);font-family:var(--vscode-font-family,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif);font-size:var(--vscode-font-size,13px);line-height:1.55;overflow:hidden}
button{font:inherit;color:inherit;background:transparent;border:0;cursor:pointer}
input,textarea,select{font:inherit;color:var(--vscode-input-foreground,inherit);background:var(--vscode-input-background,#3c3c3c);border:1px solid var(--gp-line2);border-radius:4px;padding:5px 8px;outline:none}
input:focus,textarea:focus,select:focus{border-color:var(--vscode-focusBorder,#0078d4);outline:1px solid var(--vscode-focusBorder,#0078d4);outline-offset:-1px}
code{font-family:var(--vscode-editor-font-family,ui-monospace,Consolas,monospace)}

.gp-app{display:flex;height:100vh;min-width:0}
/* ── 左栏（群聊页内）：Agent 列表 + 群聊列表，可折叠 ── */
.gp-left{width:236px;flex:none;background:var(--gp-panel);border-right:1px solid var(--gp-line);display:flex;flex-direction:column;min-width:0;transition:width .18s ease,opacity .18s ease}
.gp-left.collapsed{width:0;opacity:0;overflow:hidden;border:0}
.gp-left .hd{height:38px;flex:none;display:flex;align-items:center;gap:6px;padding:0 6px 0 10px;border-bottom:1px solid var(--gp-line)}
.gp-left .hd b{font-size:12.5px}
.gp-left .hd .sp{flex:1}
.gp-left .ib{width:24px;height:24px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;color:var(--gp-fg2);font-size:13px}
.gp-left .ib:hover{background:var(--gp-panel3);color:var(--gp-fg)}
.gp-left .rows{flex:1;overflow:auto;padding:2px 5px 8px}
.gp-sec{font-size:10.5px;color:var(--gp-fg3);padding:9px 8px 3px;display:flex;align-items:center;gap:6px}
.gp-sec .sp{flex:1}
.gp-lrow{display:flex;align-items:center;gap:7px;min-height:34px;padding:4px 7px;border-radius:8px;cursor:pointer}
.gp-lrow:hover{background:var(--gp-panel2)}
.gp-lrow.on{background:var(--gp-panel3);color:var(--vscode-list-activeSelectionForeground,var(--gp-fg))}
.gp-lrow .av{width:22px;height:22px;border-radius:7px;flex:none;display:flex;align-items:center;justify-content:center;color:#fff;font-size:10.5px;font-weight:600;position:relative;overflow:hidden}
.gp-lrow .av img{width:100%;height:100%;object-fit:cover}
.gp-lrow .n{font-size:12.5px;min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gp-lrow .bdg{font-size:10px;color:var(--gp-fg3);border:1px solid var(--gp-line2);border-radius:3px;padding:0 4px;flex:none}
.gp-lrow .bdg.un{color:var(--gp-accent);border-color:var(--gp-line2)}
.gp-lrow .bdg.mode{color:var(--gp-fg3)}
.gp-lrow .unread{position:absolute;top:-4px;right:-4px;min-width:15px;height:15px;padding:0 4px;border-radius:4px;background:var(--gp-accent);color:#fff;font-size:10px;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 2px var(--gp-panel)}

/* ── 中间栏 ── */
.gp-mid{flex:1;min-width:0;display:flex;flex-direction:column;background:var(--gp-bg)}
.gp-top{height:44px;flex:none;display:flex;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid var(--gp-line);background:var(--gp-panel)}
.gp-crumb{font-size:13px;color:var(--gp-fg2);display:flex;align-items:center;gap:6px;min-width:0}
.gp-crumb b{color:var(--gp-fg);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gp-top .sp{flex:1}
.gp-tb{width:28px;height:28px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;color:var(--gp-fg2);font-size:13.5px}
.gp-tb:hover{background:var(--gp-panel2);color:var(--gp-fg)}
/* 文字型工具按钮（不用 emoji：该字体缺 🧠 字形 ⇒ 静默空白 ✗） */
.gp-tb-txt{width:auto;padding:0 9px;font-size:12px}
.gp-page{flex:1;min-width:0;display:flex;min-height:0;position:relative}

/* ── 聊天 ── */
.gp-chat{flex:1;min-width:0;display:flex;flex-direction:column;position:relative;background:var(--gp-bg)}
.gp-island{position:absolute;top:10px;left:0;right:0;display:flex;justify-content:center;pointer-events:none;z-index:4}
.gp-pill{display:inline-flex;align-items:center;gap:8px;max-width:min(100%,440px);min-height:34px;padding:4px 12px;border-radius:999px;background:var(--gp-panel);border:1px solid var(--gp-line);box-shadow:0 3px 12px var(--gp-shadow);pointer-events:auto}
.gp-pill .gav{width:22px;height:22px;border-radius:8px;flex:none;display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;overflow:hidden}
.gp-pill .gav img{width:100%;height:100%;object-fit:cover}
.gp-pile{display:flex;align-items:center}
.gp-pile .pv{width:22px;height:22px;border-radius:50%;margin-left:-8px;border:1px solid var(--gp-panel);display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff}
.gp-pile .pv:first-child{margin-left:0}
.gp-pile .more{margin-left:-8px;background:var(--gp-panel3);color:var(--gp-fg2)}
.gp-pill .nm{font-size:14px;font-weight:500;min-width:56px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gp-pill .caret{color:var(--gp-fg3);font-size:11px}
.gp-pill .rsp{width:6px;height:6px;border-radius:50%;background:var(--gp-accent)}
.gp-pill .ib{width:24px;height:24px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;color:var(--gp-fg2);font-size:13px}
.gp-pill .ib:hover{background:var(--gp-panel2)}

.gp-body{flex:1;overflow:auto;display:flex;flex-direction:column;padding:70px 16px 8px;position:relative}
.gp-stack{width:min(560px,calc(100% - 84px));margin:0 auto;display:flex;flex-direction:column;gap:12px}
.gp-day{text-align:center;font-size:12px;color:var(--gp-fg3);margin:2px 0 4px}
.gp-msg{display:flex;gap:10px;align-items:flex-start}
.gp-msg .av{width:28px;height:28px;border-radius:8px;flex:0 0 28px;display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;overflow:hidden}
.gp-msg .av img{width:100%;height:100%;object-fit:cover}
.gp-msg .av.hid{visibility:hidden}
.gp-msg .col{min-width:0;flex:1}
.gp-msg .who{font-size:12px;color:var(--gp-accent);font-weight:600;margin-bottom:3px}
.gp-bub,.gp-msg.me .bub{border-radius:16px;padding:8px 12px;background:var(--vscode-editorWidget-background,var(--gp-panel));border:1px solid var(--gp-line);white-space:pre-wrap;word-break:break-word}
.gp-msg.me{flex-direction:row;justify-content:flex-end}
.gp-msg.me .bub{background:var(--gp-accent);border-color:transparent;color:var(--vscode-button-foreground,#fff);border-bottom-right-radius:4px;max-width:78%}
.gp-msg:not(.me) .bub{border-bottom-left-radius:4px}
/* 组内续接（同作者 + 5 分钟内，每组成员 ≤8 条）：头像留白占位、上方切角收紧 —— DSB 的成组观感 */
.gp-msg.grp:not(.me) .gp-bub{border-top-left-radius:4px}
.gp-msg.grp.me .bub{border-top-right-radius:4px}
.gp-msg.grp{margin-top:-9px}
/* 发送失败（2026-10-26 复刻 DeepSeekBot 的 failed 气泡）：标红 + 重试/删除。
   失败的发送**留在列表底部**，而不是只弹一行系统提示 —— 用户能看见是哪条没发出去。 */
.gp-msg.fail .gp-failhd{font-size:11.5px;color:var(--vscode-errorForeground,#e05252);margin-bottom:3px;text-align:right}
.gp-msg.fail .bub{opacity:.72;border-color:var(--vscode-errorForeground,#e05252)}
.gp-failacts{display:flex;gap:6px;justify-content:flex-end;margin-top:4px}
.gp-failacts button{font:inherit;font-size:11.5px;padding:1px 8px;border-radius:5px;cursor:pointer;
  border:1px solid var(--gp-line);background:var(--gp-panel);color:var(--gp-fg)}
.gp-failacts button:hover{background:var(--gp-panel2)}
.gp-bub b{font-weight:600}
.gp-bub code{background:var(--gp-panel2);border:1px solid var(--gp-line);border-radius:4px;padding:0 4px;font-size:11.5px}
.gp-bub .men{background:var(--vscode-editorHighlightBackground,rgba(77,170,252,.22));border-radius:3px;padding:0 2px;color:var(--gp-blue)}
.gp-quote{margin-top:6px;font-size:12px;color:var(--gp-fg2);display:flex;gap:6px;align-items:center}
.gp-quote .ic{width:18px;height:18px;border-radius:5px;flex:none;display:flex;align-items:center;justify-content:center;color:#fff;font-size:10px}
.gp-sys{width:fit-content;max-width:560px;margin:0 auto 12px;padding:2px 10px;border-radius:999px;background:transparent;border:1px solid var(--gp-line);color:var(--gp-fg3);font-size:12px}
.gp-sys.warn{color:var(--gp-warn);border-color:var(--gp-line2)}

/* composer（DSB 胶囊） */
.gp-comp{width:min(560px,calc(100% - 84px));margin:0 auto 8px;position:relative}
.gp-box{min-height:50px;border-radius:25px;border:1px solid var(--gp-line2);background:var(--vscode-editorWidget-background,var(--gp-panel));box-shadow:0 6px 20px var(--gp-shadow);padding:10px 54px 10px 42px}
.gp-box textarea{width:100%;border:0;background:transparent;resize:none;height:30px;padding:0;font-size:13px}
.gp-clip{position:absolute;left:12px;bottom:11px;width:24px;height:24px;border-radius:6px;display:flex;align-items:center;justify-content:center;color:var(--gp-fg2);font-size:14px}
.gp-send{position:absolute;right:10px;bottom:8px;width:34px;height:34px;border-radius:50%;background:var(--gp-accent);color:var(--vscode-button-foreground,#fff);display:flex;align-items:center;justify-content:center;font-size:15px}
.gp-send:hover{background:var(--gp-accent2)}
/* @ 候选浮层（2026-10-26）：贴输入框上方；320px 宽也能放下 */
.gp-atpop{position:absolute;left:8px;right:8px;bottom:calc(100% - 4px);z-index:40;display:flex;flex-direction:column;gap:1px;padding:4px;max-height:232px;overflow:auto;border-radius:12px;background:var(--vscode-editorWidget-background,var(--gp-panel));border:1px solid var(--gp-line2);box-shadow:0 8px 24px var(--gp-shadow)}
.gp-atpop[hidden]{display:none}
.gp-atitem{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:var(--gp-fg);font-size:12px;text-align:left;cursor:pointer}
.gp-atitem:hover,.gp-atitem.is-on{background:var(--gp-hover,rgba(127,127,127,.18))}
.gp-atitem .m{flex:none;color:var(--gp-accent);font-weight:600}
.gp-atitem .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--gp-fg2)}
/* 气泡里的 @token（与工作台 .ag3-gat 同视觉口径） */
.gp-at{color:var(--gp-accent);font-weight:600}
.gp-msg.me .gp-at{color:inherit;text-decoration:underline;text-underline-offset:2px}
.gp-send:disabled{opacity:.4;cursor:not-allowed}
.gp-foot{max-width:min(560px,calc(100% - 84px));margin:0 auto 10px;display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--gp-fg2)}
.gp-chip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--gp-line2);border-radius:999px;padding:2px 9px;background:var(--gp-panel)}
.gp-foot .sp{flex:1}
.gp-foot .tok{font-variant-numeric:tabular-nums}

/* ── 右栏：记忆 / 演化 / 版本 / 分支 / 成员 / 工作 ── */
.gp-right{width:320px;flex:0 0 320px;border-left:1px solid var(--gp-line);background:var(--gp-panel);display:flex;flex-direction:column;min-width:0;position:relative}
.gp-right .grip{position:absolute;left:-3px;top:0;bottom:0;width:6px;cursor:col-resize}
.gp-right .grip:hover{background:var(--gp-accent2)}
.gp-rhead{height:44px;flex:none;display:flex;align-items:center;gap:2px;padding:0 8px;border-bottom:1px solid var(--gp-line)}
.gp-rtab{padding:4px 7px;border-radius:6px;font-size:12.5px;color:var(--gp-fg2);cursor:pointer;white-space:nowrap}
.gp-rtab:hover{background:var(--gp-panel2)}
.gp-rtab.on{color:var(--gp-fg);font-weight:600;background:var(--gp-panel2)}
.gp-rhead .sp{flex:1}
.gp-gear{width:26px;height:26px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;color:var(--gp-fg2)}
.gp-gear:hover{background:var(--gp-panel2)}
.gp-rbody{flex:1;overflow:auto;padding:8px 10px 20px;font-size:12.5px}
.gp-rgrp{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--gp-fg2);margin:2px 0 8px}
.gp-rgrp .sp{flex:1}
.gp-rfile{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--gp-line);border-radius:6px;padding:2px 8px;background:var(--gp-panel2);margin:4px 0 6px;font-size:12px}
.gp-rfile .st{color:var(--gp-fg3)}
.gp-rlist{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px dashed var(--gp-line);cursor:pointer}
.gp-rlist:hover{background:var(--gp-panel2)}
.gp-rlist .n{font-size:12.5px;min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gp-rlist .m{font-size:11px;color:var(--gp-fg3);font-family:ui-monospace,Consolas,monospace}
.gp-rlist .cur{font-size:11px;color:var(--gp-blue);border:1px solid var(--gp-line2);background:var(--gp-panel2);border-radius:4px;padding:0 5px}
.gp-rlist .gp-pin{font-size:10px;color:var(--gp-accent);border:1px solid var(--gp-line2);border-radius:3px;padding:0 4px;margin-left:4px}
.gp-rhint{font-size:11.5px;color:var(--gp-fg3);line-height:1.7;padding:6px 0}
/* Git 时间线 */
.gp-tl{position:relative;padding-left:16px}
.gp-tl::before{content:"";position:absolute;left:4px;top:4px;bottom:4px;width:1.5px;background:var(--gp-line2)}
.gp-tl .it{position:relative;padding:5px 0 9px;cursor:pointer}
.gp-tl .it:hover .t{color:var(--gp-blue)}
.gp-tl .it::before{content:"";position:absolute;left:-14px;top:9px;width:9px;height:9px;border-radius:50%;background:var(--gp-blue);border:2px solid var(--gp-panel)}
.gp-tl .it.y::before{background:var(--gp-warn)}
.gp-tl .it.g::before{background:var(--gp-ok)}
.gp-tl .it.on::before{box-shadow:0 0 0 3px var(--vscode-editorHighlightBackground,rgba(77,170,252,.3))}
.gp-tl .it .t{font-size:12.5px;line-height:1.5}
.gp-tl .it .m{font-size:11px;color:var(--gp-fg3);font-family:ui-monospace,Consolas,monospace}
.gp-tl .it .tag{float:right;font-size:11px;color:var(--gp-fg3);border:1px solid var(--gp-line2);border-radius:4px;padding:0 5px;margin-left:6px}
.gp-tl .it .tag.blue{color:var(--gp-blue);border-color:var(--gp-line2);background:var(--gp-panel2)}
/* 右栏里的 diff */
.gp-diff{margin-top:8px;border:1px solid var(--gp-line);border-radius:8px;overflow:hidden;background:var(--gp-panel2)}
.gp-diff .hd{padding:5px 9px;font-size:11.5px;color:var(--gp-fg2);border-bottom:1px solid var(--gp-line);display:flex;gap:6px;align-items:center}
.gp-diff .hd .sp{flex:1}
.gp-diff pre{margin:0;padding:7px 9px;font:11.5px/1.6 ui-monospace,Consolas,monospace;max-height:260px;overflow:auto;white-space:pre-wrap}
.gp-dl{display:block}
.gp-dl.add{background:var(--vscode-diffEditor-insertedTextBackground,rgba(58,157,92,.18));color:var(--vscode-diffEditor-insertedTextForeground,#3a9d5c)}
.gp-dl.del{background:var(--vscode-diffEditor-removedTextBackground,rgba(217,79,69,.18));color:var(--vscode-diffEditor-removedTextForeground,#e06c75)}
/* 成员 / 工作 */
.gp-mrow{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:8px}
.gp-mrow:hover{background:var(--gp-panel2)}
.gp-mrow .av{width:24px;height:24px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff}
.gp-mrow .n{font-size:12.5px;min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gp-mrow .r{font-size:11px;color:var(--gp-fg3)}
.gp-mrow .a{width:20px;height:20px;border-radius:4px;color:var(--gp-fg3);font-size:12px;flex:none}
.gp-mrow .a:hover{background:var(--gp-panel3);color:var(--gp-fg)}
.gp-wrow{display:flex;gap:8px;padding:8px;border-radius:8px;align-items:flex-start;cursor:pointer}
.gp-wrow:hover{background:var(--gp-panel2)}
.gp-wrow .i{min-width:0;flex:1}
.gp-wrow .p{font-size:13px;font-weight:500;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.gp-wrow .m{font-size:11.5px;color:var(--gp-fg3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gp-wrow .bd{font-size:11px;border:1px solid var(--gp-line2);border-radius:3px;padding:0 4px;color:var(--gp-fg3);flex:none}
.gp-wrow .bd.waiting{color:var(--gp-warn);border-color:var(--gp-line2)}
.gp-wrow .bd.working{color:var(--gp-blue);border-color:var(--gp-line2)}

/* 抽屉（窄屏）：右栏自己变成覆盖层，.gp-ovl 只是背后的遮罩 */
.gp-right.off{display:none}
.gp-ovl{position:absolute;inset:0;z-index:9;display:none;background:var(--gp-scrim)}
.gp-ovl.on{display:block}
/* 响应式（2026-10-21 调整）：**优先牺牲左栏、保住右栏** ——
   之前是 ≤1080 直接把右栏收成抽屉 ⇒ 嵌在 IDE 中栏（宽 ~840px）时「记忆/演化/版本/分支」
   永远看不见（用户报"缺少记忆"）✗。现在：
     ≤1080：左栏收起（点顶栏 ‹ 以覆盖式展开），右栏仍在（收窄到 280）
     ≤760 ：再窄才把右栏也收成抽屉（顶栏「面板」按钮打开）
   ⚠ 抽屉入口用**文字**不用 emoji —— 该字体缺 🧠 字形 ⇒ 按钮静默空白 ✗。 */
@media (max-width:1080px){
  .gp-left{width:0;opacity:0;overflow:hidden;border:0}
  .gp-left.open{width:236px;opacity:1;position:absolute;left:0;top:0;bottom:0;z-index:11;box-shadow:6px 0 18px var(--gp-shadow)}
  .gp-right{width:280px;flex:0 0 280px}
}
@media (max-width:760px){
  .gp-right{display:none}
  .gp-right.on{display:flex;position:absolute;right:0;top:0;bottom:0;z-index:10;max-width:86%;box-shadow:-8px 0 24px var(--gp-shadow)}
}

/* 弹层 */
.gp-mask{position:fixed;inset:0;background:var(--gp-scrim);display:none;align-items:center;justify-content:center;z-index:50}
.gp-mask.on{display:flex}
.gp-dlg{width:440px;max-width:92vw;background:var(--gp-panel);border:1px solid var(--gp-line);border-radius:10px;box-shadow:0 14px 40px var(--gp-shadow)}
.gp-dlg h3{margin:0;padding:11px 13px;font-size:13px;border-bottom:1px solid var(--gp-line);display:flex;align-items:center}
.gp-dlg .c{padding:11px 13px;max-height:58vh;overflow:auto}
.gp-dlg .f{padding:9px 13px;border-top:1px solid var(--gp-line);display:flex;gap:8px;justify-content:flex-end;align-items:center}
.gp-fld{margin-bottom:10px}
.gp-fld label{display:block;font-size:11.5px;color:var(--gp-fg2);margin-bottom:4px}
.gp-fld input,.gp-fld select{width:100%}
.gp-mode{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:8px}
.gp-opt{border:1px solid var(--gp-line);border-radius:8px;padding:7px 9px;cursor:pointer;font-size:12px}
.gp-opt.on{border-color:var(--gp-accent);background:var(--gp-panel2)}
.gp-opt .d{font-size:10.5px;color:var(--gp-fg3);margin-top:2px;line-height:1.45}
.gp-num{display:flex;gap:8px}
.gp-num>div{flex:1}
.gp-num input{width:100%}
.gp-chk{display:flex;align-items:center;gap:6px;padding:5px 7px;border:1px solid var(--gp-line);border-radius:6px;font-size:12px;cursor:pointer;margin-bottom:4px}
.gp-chk.on{border-color:var(--gp-accent);background:var(--gp-panel2)}
.gp-chk .bx{width:12px;height:12px;border:1px solid var(--gp-line2);border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:9px;color:transparent}
.gp-chk.on .bx{color:var(--vscode-button-foreground,#fff);background:var(--gp-accent);border-color:var(--gp-accent)}
.gp-btn{padding:5px 12px;border-radius:4px;border:1px solid var(--vscode-button-border,transparent);font-size:12px;background:var(--vscode-button-secondaryBackground,var(--gp-panel2));color:var(--vscode-button-secondaryForeground,var(--gp-fg))}
.gp-btn:hover{background:var(--vscode-button-secondaryHoverBackground,var(--gp-panel3))}
.gp-btn.primary{background:var(--gp-accent);border-color:transparent;color:var(--vscode-button-foreground,#fff)}
.gp-btn.primary:hover{background:var(--gp-accent2)}
.gp-btn.danger{background:var(--vscode-errorForeground,#f14c4c);border-color:transparent;color:#fff}
.gp-diag{font-size:11px;color:var(--gp-fg3);margin-top:5px;line-height:1.6}
.gp-av-big{width:36px;height:36px;border-radius:9px;flex:none;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;overflow:hidden}
.gp-av-big img{width:100%;height:100%;object-fit:cover}

/* ── 附件（2026-10-26）：气泡内图片缩略图 / 文件卡片；composer 上方的待发 chip 行 ── */
.gp-files-in { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
.gp-fimg-a { display:block; line-height:0; border-radius:8px; overflow:hidden;
  border:1px solid var(--gp-line); }
.gp-fimg { display:block; max-width:200px; max-height:150px; object-fit:cover; }
.gp-ffile { display:inline-flex; align-items:center; gap:6px; padding:4px 8px; border-radius:8px;
  font-size:11.5px; text-decoration:none; color:inherit;
  border:1px solid var(--gp-line); background:var(--gp-panel2); }
.gp-ffile:hover { background:var(--gp-panel3); }
.gp-ffile .n { max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.gp-ffile .s { opacity:.6; }
.gp-files { display:flex; flex-wrap:wrap; gap:6px; width:min(560px,calc(100% - 84px));
  margin:0 auto 4px; }
.gp-files:empty { display:none; }
.gp-fchip { display:inline-flex; align-items:center; gap:5px; padding:2px 5px 2px 8px;
  border-radius:999px; font-size:11px; border:1px solid var(--gp-line); background:var(--gp-panel2); }
.gp-fchip.is-busy { opacity:.7; }
.gp-fx { border:0; background:transparent; color:inherit; cursor:pointer; font-size:11px;
  line-height:1; padding:0 2px; opacity:.6; }
.gp-fx:hover { opacity:1; }
`;

/** 客户端脚本（无外部依赖）。 */
function clientJs(keep) {
	const L = [];
	const add = (...p) => L.push(p.join(''));
	add('(function(){');
	// 内嵌模式：父页面（agents 工作台）已经给了左栏与右栏 ⇒ 这里只保留中间聊天列
	add(' if(location.search.indexOf("embed=1")>=0){document.body.classList.add("embed");}');
	add('var KEEP=', String(keep), ';');
	// 状态：groups / agents / active / 右栏 tab / 右栏 agent / 工作列表 / 未读签名
	/* `failed`：**发送失败但还没放弃**的消息（2026-10-26 复刻 DeepSeekBot 的三态）。
	   为什么不直接塞进 transcript：transcript 会被 `poll()` 用服务端数据覆盖，
	   本地失败消息一刷就没；独立数组才能"一直挂在那儿等人重试"。
	   `draft`：当前草稿的镜像（写 localStorage，切群不丢）。 */
	/* ★ 注入唯一真源：`core/groupChat.js` 的**函数体**（toString ⇒ 浏览器里就是同一份实现）。
	   ⚠ 那两个函数是自包含的（不引用模块级变量），所以 toString 后仍能跑。 */
	// ⚠ 显式挂到 window：这段被注入在 IIFE 内部，`var` 不会成为全局
	//   （p3-190 断言 `typeof window.__chatRows === 'function'` 就是防这个）。
	add('window.__chatRows = ' + chatRows.toString() + ';');
	add('window.__sepLabel = ' + sepLabel.toString() + ';');
	add('var __chatRows = window.__chatRows, __sepLabel = window.__sepLabel;');
	/* `files`：**待发送附件**（2026-10-26）。切群时清空 —— 附件在上传时就绑定了 group，
	   带到别的群里去是错的。 */
	add('var S={groups:[],agents:[],active:"",tab:"mem",memAgent:"",work:[],busy:{},readSig:{},rightOpen:true,leftOpen:true,drawer:false,failed:[],draft:"",files:[]};');
	add('function $(id){return document.getElementById(id);}');
	add('function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}');
	add('function colorOf(id){return "hsl("+([...String(id)].reduce(function(h,c){return (h*31+c.charCodeAt(0))>>>0;},0)%360)+" 40% 45%)";}');
	add('function nameOf(id){for(var i=0;i<S.agents.length;i++){if(S.agents[i].id===id)return S.agents[i].name;}return id;}');
	add('function agentOf(id){for(var i=0;i<S.agents.length;i++){if(S.agents[i].id===id)return S.agents[i];}return {id:id,name:id};}');
	add('function activeGroup(){for(var i=0;i<S.groups.length;i++){if(S.groups[i].id===S.active)return S.groups[i];}return null;}');
	add('function p2(n){return (n<10?"0":"")+n;}');
	add('function fmtT(at){var d=new Date(at||Date.now());return p2(d.getHours())+":"+p2(d.getMinutes());}');
	add('function dayKey(at){var d=new Date(at||Date.now());return d.getFullYear()+"-"+p2(d.getMonth()+1)+"-"+p2(d.getDate());}');
	/* 分隔条文案已收敛到 `core/groupChat.js` 的 sepLabel（注入为 `__sepLabel`）。
	   ⚠ 这里**不要再写一份** —— 2026-10-26 就是因为两份实现不同步导致"改了没生效"。 */
	add('function dayLabel(at){var d=new Date(at||Date.now());var n=new Date();if(dayKey(at)===dayKey(n.getTime()))return "今天";var y=new Date(n.getTime()-86400000);if(dayKey(at)===dayKey(y.getTime()))return "昨天";return (d.getMonth()+1)+"月"+d.getDate()+"日";}');
	add('function md(text){return esc(text).replace(/\\*\\*(.+?)\\*\\*/g,"<b>$1</b>").replace(/`([^`]+)`/g,"<code>$1</code>").replace(/@([^\\s@，。、]+)/g,"<span class=\\"men\\">@$1</span>").replace(/\\n/g,"<br>");}');
	/* 附件渲染（2026-10-26）：图片给缩略图（点开原图），其它给文件卡片。
	   href 直接指向 `GET /api/group-file?id=` —— 服务端按 mime 设 content-type，
	   `<img>` 和下载都能直接用，不需要前端转 base64。 */
	add('function attachHtml(files){');
	add(' if(!files||!files.length)return "";');
	add(' var out="<div class=\\"gp-files-in\\">";');
	add(' for(var i=0;i<files.length;i++){');
	add('  var f=files[i]||{};var url="/x/agents/api/group-file?id="+encodeURIComponent(String(f.id||""));');
	add('  var b=Number(f.size)||0;var sz=b>=1048576?((b/1048576).toFixed(1)+"MB"):(Math.max(1,Math.round(b/1024))+"KB");');
	add('  var nm=esc(String(f.name||"附件"));');
	add('  if(/^image\\//.test(String(f.mime||""))){');
	add('   out+="<a class=\\"gp-fimg-a\\" href=\\""+url+"\\" target=\\"_blank\\" rel=\\"noreferrer\\" title=\\""+nm+" · "+sz+"\\"><img class=\\"gp-fimg\\" src=\\""+url+"\\" alt=\\""+nm+"\\" loading=\\"lazy\\"></a>";');
	add('  }else{');
	add('   out+="<a class=\\"gp-ffile\\" href=\\""+url+"\\" target=\\"_blank\\" rel=\\"noreferrer\\" title=\\""+nm+" · "+sz+"\\"><span>📄</span><span class=\\"n\\">"+nm+"</span><span class=\\"s\\">"+sz+"</span></a>";');
	add('  }');
	add(' }');
	add(' return out+"</div>";');
	add('}');
	add('var MODE_LABEL={all:"全员派发",mentions:"仅 @ 派发",digest:"汇总派发",silent:"静默收件"};');
	add('var MODE_SHORT={all:"全员",mentions:"仅 @",digest:"汇总",silent:"静默"};');
	add('function normMode(m){var v=String(m||"").toLowerCase();if(v==="open")return "all";if(v==="admin")return "mentions";return MODE_LABEL[v]?v:"mentions";}');
	// ── 群头像 ──
	add('function gavOf(g,size){');
	add(' var st=size?("width:"+size+"px;height:"+size+"px;"):"";');
	add(' var ini=esc(String(g.name||"?").slice(0,1));');
	add(' return "<span class=\\"gav\\" style=\\""+st+"background:"+colorOf(g.id)+"\\">"+(g.avatar?"<img src=\\""+esc(g.avatar)+"\\" alt=\\"\\">":ini)+"</span>";');
	add('}');
	// ── 群列表（左栏）──
	add('function renderLeft(){');
	add(' $("gpAgents").innerHTML=S.agents.length?S.agents.map(function(a){');
	add('  return "<div class=\\"gp-lrow"+(a.id===S.memAgent?" on":"")+"\\" data-agent=\\""+esc(a.id)+"\\">"');
	add('   +"<span class=\\"av\\" style=\\"background:"+colorOf(a.id)+"\\">"+esc(String(a.name||"?").slice(0,1))+"</span>"');
	add('   +"<span class=\\"n\\">"+esc(a.name||a.id)+"</span><span class=\\"bdg\\">agent</span></div>";');
	add(' }).join(""):"<div class=\\"gp-rhint\\">没有可用的 agent。</div>";');
	add(' $("gpGroups").innerHTML=S.groups.length?S.groups.map(function(g){');
	add('  return "<div class=\\"gp-lrow"+(g.id===S.active?" on":"")+"\\" data-g=\\""+esc(g.id)+"\\">"');
	add('   +gavOf(g)+"<span class=\\"n\\">"+esc(g.name)+"</span>"');
	add('   +(Number(g.unread||0)>0?"<span class=\\"bdg un\\">"+Number(g.unread)+"</span>":"")');
	add('   +"<span class=\\"bdg mode\\">"+MODE_SHORT[normMode(g.mode)]+"</span></div>";');
	add(' }).join(""):"<div class=\\"gp-rhint\\">还没有群聊。点 ＋ 建一个。</div>";');
	add('}');
	// ── 岛屿 header ──
	add('function renderPill(){');
	add(' var g=activeGroup();if(!g){$("gpPill").innerHTML="";return;}');
	add(' var mem=g.members||[];');
	add(' var pile=mem.slice(0,3).map(function(id){var a=agentOf(id);return "<span class=\\"pv\\" style=\\"background:"+colorOf(id)+"\\">"+esc(String(a.name||"?").slice(0,1))+"</span>";}).join("")');
	add(' if(mem.length>3){pile+="<span class=\\"pv more\\">+"+(mem.length-3)+"</span>";}');
	add(' $("gpPill").innerHTML=gavOf(g,22)+"<span class=\\"pile\\">"+pile+"</span>"');
	add('  +"<span class=\\"nm\\">"+esc(g.name)+"</span><span class=\\"caret\\">▾</span>"');
	add('  +(Number(g.unread||0)>0?"<span class=\\"rsp\\"></span>":"")');
	add('  +"<span class=\\"ib\\" title=\\"邀请成员\\" onclick=\\"openInviteDialog()\\">👤</span><span class=\\"ib\\" title=\\"群设置\\" onclick=\\"openSettings()\\">⚙</span>";');
	add('}');
	// ── 消息（DSB 分组口径：同作者+同天+相邻≤15s+组跨度≤180s+每组≤8 条）──
	add('function renderStack(){');
	add(' var g=activeGroup();if(!g){$("gpStack").innerHTML="<div class=gpGone>这个群不在了 —— 从左侧另选一个群，或点右上角刷新。</div>";return;}');
	add(' var T=(g.transcript||[]).slice(-KEEP);');
	// ★★ 2026-10-26 收敛：分组/分隔**不再本地算一份**，一律走唯一真源 `__chatRows`
	//    （= `core/groupChat.js` 的 `chatRows`，用 toString 注入到本页；工作台面板用同构的一份，
	//      由 p3-190 用同一组夹具比对，防两边再漂移）。
	add(' var rows=__chatRows(T);');
	// `@` 高亮用的成员表：整轮只算一次（每条消息都算一遍没必要）
	add(' var AT_MEM=atMembers();');
	add(' var out="";');
	add(' for(var r=0;r<rows.length;r++){');
	add('  var row=rows[r];');
	add('  if(row.kind==="sep"){out+="<div class=\\"gp-day\\">"+__sepLabel(row.at)+"</div>";continue;}');
	add('  var e=T[row.index];if(!e)continue;');
	add('  if(row.kind==="sys"){out+="<div class=\\"gp-sys"+((/未派发|失败/.test(e.text||""))?" warn":"")+"\\">"+esc(e.text)+"</div>";continue;}');
	add('  var cls=row.grp?" grp":"";');
	add('  var nxt=rows[r+1];');
	add('  var tail=!(nxt&&nxt.kind==="msg"&&nxt.grp);');
	add('  if(row.isMe){');
	add('   out+="<div class=\\"gp-msg me"+cls+"\\"><div class=\\"bub\\">"+atMarkHtml(md(e.text),AT_MEM)+attachHtml(e.files)+"</div>"');
	add('    +"<div class=\\"av"+(row.grp?" hid":"")+"\\" style=\\"background:var(--gp-fg3)\\">你</div></div>";');
	add('  } else {');
	add('   var a=agentOf(row.who);');
	add('   var ini=esc(String(a.name||"?").slice(0,1));');
	add('   var bg=colorOf(row.who);');
	add('   out+="<div class=\\"gp-msg"+cls+"\\"><div class=\\"av"+(row.grp?" hid":"")+"\\" style=\\"background:"+bg+"\\">"+ini+"</div>"');
	add('    +"<div class=\\"col\\">"+(row.grp?"":"<div class=\\"who\\">"+esc(a.name||row.who)+"</div>")');
	add('    +"<div class=\\"gp-bub\\">"+atMarkHtml(md(e.text),AT_MEM)+attachHtml(e.files)+"</div>"');
	add('    +((e.sessionId&&tail)?"<div class=\\"gp-quote\\"><span class=\\"ic\\" style=\\"background:"+bg+"\\">"+ini+"</span>回合结束自动回收进群记录</div>":"")');
	add('    +"</div></div>";');
	add('  }');
	add(' }');
	/* ★ 复刻 DeepSeekBot 的 failed 气泡（`message-bubble.tsx` 的"未发送 · 重试"）：
	   失败的发送**留在列表底部**、标红、可点重试或删除 —— 而不是只弹一行系统提示
	   （用户根本不知道是哪条没发出去）。 */
	add(' if(S.failed.length){');
	add('  out+="<div class=\\"gp-day\\">未发送 · "+S.failed.length+" 条</div>";');
	add('  for(var k=0;k<S.failed.length;k++){');
	add('   var f=S.failed[k];');
	add('   out+="<div class=\\"gp-msg me fail\\"><div class=\\"col\\"><div class=\\"gp-failhd\\">未发送 · "+esc(f.err||"网络错误")+"</div>"');
	add('    +"<div class=\\"bub\\">"+md(f.text)+"</div>"');
	add('    +"<div class=\\"gp-failacts\\"><button type=\\"button\\" data-retry=\\""+esc(f.cid)+"\\">重试</button>"');
	add('    +"<button type=\\"button\\" data-drop=\\""+esc(f.cid)+"\\">删除</button></div></div>"');
	add('    +"<div class=\\"av hid\\"></div></div>";');
	add('  }');
	add(' }');
	add(' $("gpStack").innerHTML=out;');
	add('}');
	// ── 右栏 ──
	add('var R={files:[],log:[],versions:[],branches:[],branch:"",sel:null,diff:null};');
	add('function renderRight(){');
	add(' var box=$("gpRBody");if(!box)return;');
	add(' var t=S.tab;');
	add(' if(t==="mem"){');
	add('  var h="";');
	add('  if(!S.memAgent){box.innerHTML="<div class=\\"gp-rhint\\">选一个 agent 看它的记忆（左边点 agent，或点成员）。<br>记忆 = 每次会话进 prompt 的 SOUL.md / MEMORY.md。</div>";return;}');
	add('  h+="<div class=\\"gp-rgrp\\">记忆文件<span class=\\"sp\\"></span><span>"+(R.files||[]).length+"</span></div>";');
	// ★ mockup 款 A：记忆面板 = 文件清单（常驻的 SOUL/MEMORY 带「常驻」标记）**+ Git 历史**
	//   —— 历史不必切到「演化」签才看得到 ✗（之前只有「演化」签有时间线）。
	add('  h+=(R.files||[]).map(function(f){');
	add('    var pin=/^(SOUL|MEMORY)\\.md$/i.test(f.name);');
	add('    return "<div class=\\"gp-rlist\\"><span>"+(pin?"📌":"📄")+"</span><span class=\\"n\\">"+esc(f.name)+(pin?" <span class=\\"gp-pin\\">常驻</span>":"")+"</span><span class=\\"m\\">"+Math.round((f.size||0)/1024*10)/10+" KB</span></div>";');
	add('  }).join("");');
	add('  h+="<div class=\\"gp-rgrp\\" style=\\"margin-top:10px\\">Git 历史<span class=\\"sp\\"></span><span>"+(R.log||[]).length+"</span></div>";');
	add('  h+=(R.log||[]).slice(0,8).map(function(c){');
	add('    return "<div class=\\"gp-rlist\\" data-log=\\""+esc(c.hash)+"\\"><span>⎇</span><span class=\\"n\\">"+esc(c.subject)+"</span><span class=\\"m\\">"+esc(String(c.hash).slice(0,7))+"</span></div>";');
	add('  }).join("");');
	add('  if(!(R.log||[]).length){h+="<div class=\\"gp-rhint\\">还没有记忆提交（每次会话沉淀进记忆就会有一条）。</div>";}');
	add('  h+="<div class=\\"gp-rhint\\">SOUL.md / MEMORY.md 每次会话开始时进 system prompt（会话内冻结），其余文件按需读取。</div>";');
	add('  box.innerHTML=h;');
	add('  Array.prototype.forEach.call(box.querySelectorAll("[data-log]"),function(el){el.onclick=function(){S.tab="evo";renderRight();showCommit(el.getAttribute("data-log"));};});');
	add('  return;');
	add(' }');
	add(' if(t==="evo"){');
	add('  var h="<div class=\\"gp-rgrp\\">提交时间线<span class=\\"sp\\"></span><span>"+(R.log||[]).length+"</span></div>";');
	add('  h+="<div class=\\"gp-tl\\">"+(R.log||[]).map(function(c){');
	add('    var on=(R.sel&&R.sel.hash===c.hash)?" on":"";');
	add('    return "<div class=\\"it"+on+"\\" data-log=\\""+esc(c.hash)+"\\"><div class=\\"t\\">"+esc(c.subject)+"</div><div class=\\"m\\">"+esc(c.hash)+" · "+esc(c.date)+"</div></div>";');
	add('  }).join("")+"</div>";');
	add('  if(R.diff){');
	add('   h+="<div class=\\"gp-diff\\"><div class=\\"hd\\">"+esc(R.diff.file||"")+"<span class=\\"sp\\"></span><span>+"+R.diff.added+" / -"+R.diff.removed+"</span></div><pre>"+(R.diff.rows||[]).map(function(r){');
	add('    var cls=r.type==="add"?"add":(r.type==="del"?"del":"");');
	add('    return "<span class=\\"gp-dl "+cls+"\\">"+esc(r.text)+"\\n</span>";');
	add('   }).join("")+"</pre></div>";');
	add('  }');
	add('  box.innerHTML=h;');
	add('  Array.prototype.forEach.call(box.querySelectorAll("[data-log]"),function(el){el.onclick=function(){showCommit(el.getAttribute("data-log"));};});');
	add('  return;');
	add(' }');
	add(' if(t==="ver"){');
	add('  box.innerHTML="<div class=\\"gp-rgrp\\">版本（tag）<span class=\\"sp\\"></span><span>"+(R.versions||[]).length+"</span></div>"');
	add('   +(R.versions||[]).map(function(v){return "<div class=\\"gp-rlist\\"><span>🏷</span><span class=\\"n\\">"+esc(v.tag)+"</span><span class=\\"m\\">"+esc(v.hash||"")+"</span></div>";}).join("")');
	add('   +"<div class=\\"gp-rhint\\">版本 = 记忆仓库里的 tag：给某次提交起名，便于回看「当时的我怎么想的」。</div>";');
	add('  return;');
	add(' }');
	add(' if(t==="br"){');
	add('  box.innerHTML="<div class=\\"gp-rgrp\\">分支<span class=\\"sp\\"></span><span>"+(R.branches||[]).length+"</span></div>"');
	add('   +(R.branches||[]).map(function(b){return "<div class=\\"gp-rlist\\" data-branch=\\""+esc(b.name)+"\\"><span>⑂</span><span class=\\"n\\">"+esc(b.name)+"</span>"+(b.current?"<span class=\\"cur\\">当前</span>":"")+"<span class=\\"m\\">"+esc(b.hash||"")+"</span></div>";}).join("")');
	add('   +"<div class=\\"gp-rhint\\">切分支前工作树必须干净（先提交快照）—— 否则未提交的改动会被带到另一条分支上。</div>";');
	add('  Array.prototype.forEach.call(box.querySelectorAll("[data-branch]"),function(el){el.onclick=function(){switchBranch(el.getAttribute("data-branch"));};});');
	add('  return;');
	add(' }');
	add(' if(t==="mem-members"){');
	add('  var g=activeGroup();');
	add('  var pend=(g&&g.pending)||[];');
	add('  var h="";');
	add('  if(pend.length){');
	add('   h+="<div class=\\"gp-rgrp\\">待确认<span class=\\"sp\\"></span><span>"+pend.length+"</span></div>";');
	add('   h+=pend.map(function(p){var a=agentOf(p.agentId);return "<div class=\\"gp-mrow\\"><span class=\\"av\\" style=\\"background:"+colorOf(p.agentId)+"\\">"+esc(String(a.name||"?").slice(0,1))+"</span><span class=\\"n\\">"+esc(a.name||p.agentId)+(p.by&&p.by!=="human"?("（被"+esc(agentOf(p.by).name||p.by)+"邀请）"):"")+"</span><button class=\\"a\\" data-ok=\\""+esc(p.agentId)+"\\" title=\\"确认加入\\">✓</button><button class=\\"a\\" data-no=\\""+esc(p.agentId)+"\\" title=\\"拒绝\\">✕</button></div>";}).join("");');
	add('  }');
	add('  h+="<div class=\\"gp-rgrp\\">成员<span class=\\"sp\\"></span><span>"+((g&&g.members)||[]).length+"</span></div>";');
	add('  h+=((g&&g.members)||[]).map(function(id){var a=agentOf(id);return "<div class=\\"gp-mrow\\"><span class=\\"av\\" style=\\"background:"+colorOf(id)+"\\">"+esc(String(a.name||"?").slice(0,1))+"</span><span class=\\"n\\">"+esc(a.name||id)+"</span><button class=\\"a\\" data-at=\\""+esc(id)+"\\" title=\\"@ 它\\">@</button><button class=\\"a\\" data-rm=\\""+esc(id)+"\\" title=\\"移出群聊\\">✕</button></div>";}).join("");');
	add('  box.innerHTML=h;');
	add('  Array.prototype.forEach.call(box.querySelectorAll("[data-at]"),function(b){b.onclick=function(){mention(b.getAttribute("data-at"));};});');
	add('  Array.prototype.forEach.call(box.querySelectorAll("[data-rm]"),function(b){b.onclick=function(){removeMember(b.getAttribute("data-rm"));};});');
	add('  Array.prototype.forEach.call(box.querySelectorAll("[data-ok]"),function(b){b.onclick=function(){decideJoin(b.getAttribute("data-ok"),true);};});');
	add('  Array.prototype.forEach.call(box.querySelectorAll("[data-no]"),function(b){b.onclick=function(){decideJoin(b.getAttribute("data-no"),false);};});');
	add('  return;');
	add(' }');
	add(' // 工作四组');
	add(' var by={waiting:[],working:[],idle:[],done:[]};');
	add(' (S.work||[]).forEach(function(a){var st=String(a.status||"").toLowerCase();');
	add('  if(st==="waiting")by.waiting.push(a);else if(st==="running"||st==="working")by.working.push(a);');
	add('  else if(st==="done"||st==="failed"||st==="cancelled")by.done.push(a);else by.idle.push(a);});');
	add(' var SEC=[{k:"waiting",t:"等你处理"},{k:"working",t:"进行中"},{k:"idle",t:"空闲"},{k:"done",t:"已结束"}];');
	add(' var h="";');
	add(' SEC.forEach(function(sec){');
	add('  var list=by[sec.k];if(!list.length)return;');
	add('  h+="<div class=\\"gp-rgrp\\">"+sec.t+"<span class=\\"sp\\"></span><span>"+list.length+"</span></div>";');
	add('  h+=list.slice(0,20).map(function(a){');
	add('   return "<div class=\\"gp-wrow\\" data-session=\\""+esc(a.sessionId||"")+"\\"><span class=\\"av\\" style=\\"background:"+colorOf(a.agentId||"x")+";width:24px;height:24px;border-radius:6px;font-size:11px\\">"+esc(String(nameOf(a.agentId)||"?").slice(0,1))+"</span>"');
	add('    +"<span class=\\"i\\"><span class=\\"p\\">"+esc(a.purpose||"(无目的)")+"</span><span class=\\"m\\">"+esc(nameOf(a.agentId))+" · "+esc(((a.report||{}).summary)||"")+"</span></span>"');
	add('    +"<span class=\\"bd "+sec.k+"\\">"+sec.k+"</span></div>";');
	add('  }).join("");');
	add(' });');
	add(' box.innerHTML=h||"<div class=\\"gp-rhint\\">这个群还没有派过活。<br>@成员 发一条消息就会开始。</div>";');
	add(' Array.prototype.forEach.call(box.querySelectorAll("[data-session]"),function(el){el.onclick=function(){var sid=el.getAttribute("data-session");if(!sid)return;var b=window.vssarosDsh;if(b&&typeof b.openSession==="function"){try{b.openSession(sid);return;}catch(e){}}note("这次工作的会话："+sid);};});');
	add('}');
	// ── 右栏数据加载 ──
	add('function loadRight(){');
	add(' if(!S.memAgent)return;');
	add(' fetch("/x/agents/api/memory?agent="+encodeURIComponent(S.memAgent)+"&versions=1&branches=1&limit=30",{headers:{"cache-control":"no-cache"}})');
	add('  .then(function(r){return r.json();})');
	add('  .then(function(d){');
	add('   R.files=d.files||[];R.log=d.log||[];R.versions=d.versions||[];R.branches=d.branches||[];R.branch=d.branch||"";');
	add('   renderRight();');
	add('  }).catch(function(){});');
	add('}');
	add('function showCommit(hash){');
	add(' if(!S.memAgent)return;');
	add(' R.sel={hash:hash};');
	add(' fetch("/x/agents/api/memory?agent="+encodeURIComponent(S.memAgent)+"&rev="+encodeURIComponent(hash)+"&against="+encodeURIComponent(hash+"~1")+"&file=MEMORY.md")');
	add('  .then(function(r){return r.json();})');
	add('  .then(function(d){R.diff=d.diff?{added:d.diff.added,removed:d.diff.removed,rows:d.diff.rows,file:"MEMORY.md"}:null;renderRight();})');
	add('  .catch(function(){R.diff=null;renderRight();});');
	add('}');
	add('function switchBranch(name){');
	add(' if(!S.memAgent)return;');
	add(' postMem({action:"branch-switch",agent:S.memAgent,name:name}).then(function(){loadRight();}).catch(function(e){alert("切分支失败："+e.message);});');
	add('}');
	add('function postMem(body){');
	add(' return fetch("/x/agents/api/memory",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)})');
	add('  .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||("HTTP "+r.status));return j;});});');
	add('}');
	// ── 群设置 / 邀请 / 成员操作 ──
	add('function openSettings(){');
	add(' var g=activeGroup();if(!g)return;');
	add(' $("gpSetName").value=g.name;');
	add(' pickMode(normMode(g.mode));');
	add(' $("gpWakeCount").value=(g.wake&&g.wake.count)||5;$("gpWakeInt").value=(g.wake&&g.wake.intervalSeconds)||30;');
	add(' var ap=$("gpApproval");if(ap)ap.checked=(g.requireApproval===true); var ba=$("gpBotAutoAccept");if(ba)ba.checked=(g.botAutoAccept!==false);');
	add(' var sav=$("gpSetAv");');
	add(' var pend=window.__avatar;');
	add(' if(sav){');
	add('  if(pend===undefined){sav.style.background=colorOf(g.id);sav.innerHTML=g.avatar?("<img src=\\""+esc(g.avatar)+"\\" alt=\\"\\">"):esc(String(g.name||"?").slice(0,1));}');
	add('  else if(pend===null){sav.style.background=colorOf(g.id);sav.innerHTML=esc(String(g.name||"?").slice(0,1));}');
	add('  else{sav.style.background="transparent";sav.innerHTML="<img src=\\""+esc(pend)+"\\" alt=\\"\\">";}');
	add(' }');
	add(' var avh=$("gpAvHint");if(avh)avh.textContent="";');
	add(' openMask("maskSettings");');
	add('}');
	add('function pickMode(m){');
	add(' window.__mode=m;');
	add(' document.querySelectorAll("#maskSettings .gp-opt").forEach(function(o){o.classList.toggle("on",o.dataset.mode===m);});');
	add(' var wb=$("gpWakeBox");if(wb)wb.style.display=(m==="digest")?"":"none";');
	add('}');
	add('function saveSettings(){');
	add(' var g=activeGroup();if(!g)return;');
	add(' var body={action:"mode",id:g.id,mode:window.__mode||g.mode};');
	add(' var ap=$("gpApproval");if(ap)body.requireApproval=ap.checked; var ba=$("gpBotAutoAccept");if(ba)body.botAutoAccept=ba.checked;');
	add(' if((window.__mode||"")==="digest"){body.wake={count:Math.min(100,Math.max(1,Number($("gpWakeCount").value)||5)),intervalSeconds:Math.min(3600,Math.max(1,Number($("gpWakeInt").value)||30))};}');
	add(' var name=$("gpSetName").value.trim();if(name&&name!==g.name)body.name=name;');
	add(' var av=window.__avatar;');
	add(' var p=postGroups(body);');
	add(' if(av!==undefined){p=p.then(function(){return postGroups({action:"avatar",id:g.id,avatar:av});});}');
	add(' p.then(function(){closeAll();window.__avatar=undefined;poll(true);}).catch(function(e){alert("保存失败："+e.message);});');
	add('}');
	add('function postGroups(body){');
	add(' return fetch("/x/agents/api/groups",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)})');
	add('  .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||("HTTP "+r.status));return j;});});');
	add('}');
	// ── 弹层 ──
	add('function closeAll(){document.querySelectorAll(".gp-mask").forEach(function(m){m.classList.remove("on");});}');
	add('function openMask(id){closeAll();var m=$(id);if(m)m.classList.add("on");}');
	// ── 成员勾选（建群 / 邀请共用一套）──
	add('var PICK={};');
	add('function pickList(elId,exclude){');
	add(' var host=$(elId);if(!host)return;');
	add(' var ex=exclude||[];');
	add(' var rows=S.agents.filter(function(a){return ex.indexOf(a.id)<0;});');
	add(' if(!rows.length){host.innerHTML="<div class=\\"gp-rhint\\">没有可选的 agent。</div>";return;}');
	add(' host.innerHTML=rows.map(function(a){');
	add('  return "<label class=\\"gp-chk"+(PICK[a.id]?" on":"")+"\\" data-pick=\\""+esc(a.id)+"\\"><span class=\\"bx\\">✓</span><span>"+esc(a.name||a.id)+"</span></label>";');
	add(' }).join("");');
	add('}');
	// ── 新建群 ──
	add('function openNewDialog(){');
	add(' PICK={};');
	add(' pickList("gpPick",[]);');
	add(' var n=$("gpNewName");if(n)n.value="";');
	add(' openMask("maskNew");');
	add('}');
	add('function createGroup(){');
	add(' var n=$("gpNewName");var name=n?n.value.trim():"";');
	add(' if(!name){alert("群名不能为空。");return;}');
	add(' var members=Object.keys(PICK).filter(function(k){return PICK[k];});');
	add(' if(!members.length){alert("至少勾一个成员。");return;}');
	add(' postGroups({action:"create",name:name,members:members,mode:"mentions"}).then(function(r){');
	add('  closeAll();');
	add('  if(r&&r.id)S.active=r.id;');
	add('  poll(true);');
	add(' }).catch(function(e){alert("建群失败："+e.message);});');
	add('}');
	// ── 邀请成员 ──
	add('function openInviteDialog(){');
	add(' var g=activeGroup();if(!g)return;');
	add(' PICK={};');
	add(' var ex=(g.members||[]).concat((g.pending||[]).map(function(p){return p.agentId;}));');
	add(' pickList("gpInvitePick",ex);');
	add(' openMask("maskInvite");');
	add('}');
	add('function doInvite(){');
	add(' var g=activeGroup();if(!g)return;');
	add(' var members=Object.keys(PICK).filter(function(k){return PICK[k];});');
	add(' if(!members.length){alert("至少选一个 agent。");return;}');
	add(' postGroups({action:"invite",id:g.id,members:members}).then(function(){closeAll();poll(true);}).catch(function(e){alert("邀请失败："+e.message);});');
	add('}');
	// ── 解散 ──
	add('function deleteGroup(){');
	add(' var g=activeGroup();if(!g)return;');
	add(' if(!confirm("解散群聊「"+g.name+"」？\\n\\n群记录会一并删除；成员的会话与记忆不受影响。"))return;');
	add(' postGroups({action:"delete",id:g.id}).then(function(){closeAll();S.active="";poll(true);}).catch(function(e){alert("解散失败："+e.message);});');
	add('}');
	// ── 群头像：居中裁方 → 256×256 → 压到 96KB 以内（与服务端 setGroupAvatar 同一上限）──
	add('function avBytes(u){var s=String(u||"");var b=s.slice(s.indexOf(",")+1);var pad=b.endsWith("==")?2:(b.endsWith("=")?1:0);return Math.floor(b.length*3/4)-pad;}');
	add('function avPreview(data){');
	add(' var sav=$("gpSetAv");if(!sav)return;');
	add(' var g=activeGroup();');
	add(' if(data){sav.style.background="transparent";sav.innerHTML="<img src=\\""+esc(data)+"\\" alt=\\"\\">";return;}');
	add(' sav.style.background=g?colorOf(g.id):"var(--gp-fg3)";');
	add(' sav.innerHTML=g?esc(String(g.name||"?").slice(0,1)):"";');
	add('}');
	add('function pickAvatar(file){');
	add(' var hint=$("gpAvHint");');
	add(' if(!file)return;');
	add(' if(!/^image\\/(png|jpeg|webp)$/.test(file.type||"")){if(hint)hint.textContent="只支持 PNG / JPEG / WebP。";return;}');
	add(' var fr=new FileReader();');
	add(' fr.onerror=function(){if(hint)hint.textContent="图片读不出来。";};');
	add(' fr.onload=function(){');
	add('  var img=new Image();');
	add('  img.onerror=function(){if(hint)hint.textContent="图片解码失败。";};');
	add('  img.onload=function(){');
	add('   var size=256;');
	add('   var cv=document.createElement("canvas");cv.width=size;cv.height=size;');
	add('   var ctx=cv.getContext("2d");');
	add('   var w=img.width||size,h=img.height||size;');
	add('   var side=Math.min(w,h);');
	add('   ctx.drawImage(img,(w-side)/2,(h-side)/2,side,side,0,0,size,size);');
	add('   var data=cv.toDataURL("image/png");');
	add('   if(avBytes(data)>96*1024){var q=0.9;data=cv.toDataURL("image/jpeg",q);while(avBytes(data)>96*1024&&q>0.3){q-=0.1;data=cv.toDataURL("image/jpeg",q);}}');
	add('   if(avBytes(data)>96*1024){if(hint)hint.textContent="压到 96KB 以内失败，换一张小一点的图。";return;}');
	add('   window.__avatar=data;');
	add('   avPreview(data);');
	add('   if(hint)hint.textContent="已就绪，保存后生效。";');
	add('  };');
	add('  img.src=fr.result;');
	add(' };');
	add(' fr.readAsDataURL(file);');
	add('}');
	add('function clearAvatar(){');
	add(' window.__avatar=null;');
	add(' avPreview(null);');
	add(' var hint=$("gpAvHint");if(hint)hint.textContent="保存后移除头像。";');
	add('}');
	add('function removeMember(id){');
	add(' var g=activeGroup();if(!g)return;');
	add(' if(!confirm("把「"+nameOf(id)+"」移出群聊？\\n\\n它已有的会话与记忆不受影响，只是不再收到本群消息。"))return;');
	add(' postGroups({action:"remove",id:g.id,member:id}).then(function(){poll(true);}).catch(function(e){alert("移出失败："+e.message);});');
	add('}');
	add('function decideJoin(agentId,accept){');
	add(' var g=activeGroup();if(!g)return;');
	add(' postGroups({action:"join-decide",id:g.id,agentId:agentId,accept:accept}).then(function(){poll(true);}).catch(function(e){alert("处理失败："+e.message);});');
	add('}');
	/* ⚠ 2026-10-26：token 统一改成 `@<id>`（原来插 `@<name>`）—— bot 名含空格
	   （`Code Architect`）会让 token 在空格处断开，后端边界判断与 offset 校验全失效。 */
	/* ★ 2026-10-26：点成员行插入的是**显示名**（`@Code Architect`），不再是 slug。
	   token 里可以带空格了 —— 因为消息会带 `mentions[]` offset，后端不靠分词。 */
	add('function mention(id){var el=$("gpIn");el.value=(el.value.replace(/\\s+$/,"")+(el.value.trim()?" ":"")+"@"+atLabelOf(agentOf(id))+" ").replace(/^\\s+/,"");el.focus();syncSend();atClose();}');
	add('function atRender(){var box=$("gpAtPop");if(!box)return;'
		+ 'if(!AT.open||!AT.items.length){box.hidden=true;box.innerHTML="";return;}'
		+ 'box.innerHTML="";AT.items.forEach(function(it,i){'
		+ 'var b=document.createElement("button");b.type="button";b.className="gp-atitem"+(i===AT.active?" is-on":"");b.setAttribute("data-ati",String(i));'
		/* ★ 2026-10-26：只显示**可读名字**（`@Code Architect`）。
		   slug 不再显示在列表里（用户要求「不要显示 slug」），只在 tooltip 里留作排查线索。 */
		+ 'var m=document.createElement("span");m.className="m";m.textContent="@"+(it.display||it.label);'
		+ 'b.title=(it.kind==="all"?"@所有人（唤醒全部成员）":("@"+it.label+"  ·  id: "+String(it.id||"")));'
		+ 'b.appendChild(m);'
		/* ⚠ 必须 mousedown+preventDefault：否则点候选时 textarea 先失焦，caret 丢失、插入位置错 */
		+ 'b.addEventListener("mousedown",function(ev){ev.preventDefault();});'
		+ 'b.addEventListener("click",function(){atChoose(i);});box.appendChild(b);});box.hidden=false;}');
	add('function atClose(){AT.open=false;AT.items=[];AT.active=0;atRender();}');
	add('function atScan(){var el=$("gpIn");if(!el)return;var q=atQ(el.value,el.selectionStart);'
		+ 'if(!q){atClose();return;}var items=atItems(q.query);if(!items.length){atClose();return;}'
		+ 'AT.open=true;AT.start=q.start;AT.end=q.end;AT.query=q.query;if(AT.active>=items.length)AT.active=0;AT.items=items;atRender();}');
	add('function atChoose(i){var it=AT.items[i];var el=$("gpIn");if(!it||!el)return;var v=el.value;'
		/* ★ 2026-10-26：插入**显示名**（`@Code Architect`），不是 slug —— `it.label` 就是名字 */
		+ 'var token="@"+it.label;var skip=(v.charAt(AT.end)===" ")?1:0;'
		+ 'var pos=AT.start+token.length+1;el.value=v.slice(0,AT.start)+token+" "+v.slice(AT.end+skip);'
		+ 'atClose();el.focus();try{el.setSelectionRange(pos,pos);}catch(e){}syncSend();'
		+ 'var g=activeGroup();if(g){try{localStorage.setItem("gpDraft:"+g.id,el.value);}catch(e){}}}');
	/** 返回 true = 已消费（调用方不要再当成 Enter 发送） */
	add('function atKey(ev){if(!ev)return false;if(ev.isComposing||ev.keyCode===229)return false;'
		+ 'if(!AT.open||!AT.items.length)return false;var n=AT.items.length;'
		+ 'if(ev.key==="ArrowDown"){AT.active=(AT.active+1)%n;atRender();ev.preventDefault();return true;}'
		+ 'if(ev.key==="ArrowUp"){AT.active=(AT.active-1+n)%n;atRender();ev.preventDefault();return true;}'
		+ 'if(ev.key==="Enter"||ev.key==="Tab"){atChoose(AT.active);ev.preventDefault();return true;}'
		+ 'if(ev.key==="Escape"){atClose();ev.preventDefault();return true;}return false;}');
	/** Backspace/Delete 落在 token 上 ⇒ 整块删（与工作台 `atDelete` 同口径） */
	add('function atDelKey(ev){if(!ev||(ev.key!=="Backspace"&&ev.key!=="Delete"))return false;var el=$("gpIn");if(!el)return false;'
		+ 'var v=el.value;var s=el.selectionStart,e=el.selectionEnd;var ms=atCollect(v);if(!ms.length)return false;var t=null;'
		+ 'for(var i=0;i<ms.length;i++){var m=ms[i];var te=(v.charAt(m.end)===" ")?m.end+1:m.end;'
		+ 'if(s!==e){if(s<te&&e>m.start){t=m;break;}}'
		+ 'else if(ev.key==="Backspace"){if(s>m.start&&s<=te){t=m;break;}}'
		+ 'else{if(s>=m.start&&s<m.end){t=m;break;}}}'
		+ 'if(!t)return false;var end=(v.charAt(t.end)===" ")?t.end+1:t.end;'
		+ 'var start=(s===e)?t.start:Math.min(s,t.start);var finish=(s===e)?end:Math.max(e,end);'
		+ 'el.value=v.slice(0,start)+v.slice(finish);try{el.setSelectionRange(start,start);}catch(x){}syncSend();'
		+ 'var g=activeGroup();if(g){try{localStorage.setItem("gpDraft:"+g.id,el.value);}catch(x){}}'
		+ 'atClose();ev.preventDefault();return true;}');
	/* 气泡里把 `@名字`（或旧的 `@id`）标成高亮。
	   ★ 2026-10-26：同时认显示名与 id，**长串优先 + 丢弃重叠**（`@Code Architect` 不能被 `@Code` 先吃掉），
	   与 `atCollect` 同一套规则 —— 两处口径必须一致，否则会出现"高亮切一半"的怪状。 */
	add('function atMarkHtml(html,members){var out=String(html==null?"":html);var needles=[];'
		+ '(members||[]).forEach(function(a){var id=String((a&&a.id)||"");if(!id)return;var lb=atLabelOf(a);'
		+ 'if(lb)needles.push("@"+lb);if(lb!==id)needles.push("@"+id);});'
		+ 'needles.sort(function(x,y){return y.length-x.length;});'
		+ 'var hits=[];needles.forEach(function(nd){var i=out.indexOf(nd);while(i>=0){'
		+ 'if(!/[A-Za-z0-9._-]/.test(out.charAt(i+nd.length)))hits.push({s:i,e:i+nd.length});'
		+ 'i=out.indexOf(nd,i+1);}});'
		+ 'hits.sort(function(x,y){return (y.e-y.s)-(x.e-x.s)||x.s-y.s;});'
		+ 'var keep=[];hits.forEach(function(h){'
		+ 'if(!keep.some(function(k){return h.s<k.e&&h.e>k.s;}))keep.push(h);});'
		/* 从后往前插，避免前面的插入把后面的下标顶偏 */
		+ 'keep.sort(function(x,y){return y.s-x.s;});'
		+ 'keep.forEach(function(h){out=out.slice(0,h.s)+"<span class=\\"gp-at\\">"+out.slice(h.s,h.e)+"</span>"+out.slice(h.e);});'
		+ 'return out;}');
	/* 显示名：token 里写它（`@Code Architect`），id 走 agentId 单独带 */
	add('function atLabelOf(a){var n=String((a&&a.name)||"").trim();return n||String((a&&a.id)||"");}');
	/* 反扫：同时认名字与 id，**长串优先 + 丢弃重叠**（`@Code Architect` 不能被 `@Code` 先吃掉） */
	add('function atCollect(text){var t=String(text==null?"":text);var out=[];var taken=[];var needles=[];'
		+ 'atMembers().forEach(function(a){var id=String((a&&a.id)||"");if(!id)return;var lb=atLabelOf(a);'
		+ 'if(lb)needles.push({n:"@"+lb,label:lb,agentId:id});'
		+ 'if(lb!==id)needles.push({n:"@"+id,label:id,agentId:id});});'
		+ 'needles.sort(function(x,y){return y.n.length-x.n.length;});'
		+ 'needles.forEach(function(nd){atHits(t,nd.n).forEach(function(i){var s=i,e=i+nd.n.length;'
		+ 'if(taken.some(function(x){return s<x.end&&e>x.start;}))return;'
		+ 'taken.push({start:s,end:e});out.push({start:s,end:e,label:nd.label,agentId:nd.agentId});});});'
		+ 'atHits(t,"@"+AT_ALL).forEach(function(i){var s=i,e=i+1+AT_ALL.length;'
		+ 'if(taken.some(function(x){return s<x.end&&e>x.start;}))return;'
		+ 'out.push({start:s,end:e,label:AT_ALL,kind:"all"});});'
		+ 'out.sort(function(x,y){return x.start-y.start;});return out;}');
	add('function note(t){var g=activeGroup();if(!g)return;g.transcript=(g.transcript||[]).concat([{role:"system",at:Date.now(),text:t}]);renderStack();}');
	add('function syncSend(){$("gpSend").disabled=!$("gpIn").value.trim();}');
	// ── `@` 提及（2026-10-26）────────────────────────────────────────────
	/* 独立页是**手写 DOM**（没有 React），所以这里是 `lib/mentions.js` 的紧凑移植版。
	   规则与工作台完全同口径（词边界 / 34 字上限 / token 用 @id），
	   一致性由 `p3-197` 的向量 + `p3-198` 的页面断言一起守。
	   ⚠ 页面脚本里一律用**双引号**，避免与外层 `add('…')` 的单引号打架。 */
	add('var AT_ALL="所有人";');
	add('var AT={open:false,start:0,end:0,query:"",items:[],active:0};');
	add('function atMembers(){var g=activeGroup();if(!g)return [];return (g.members||[]).map(function(id){return agentOf(id);});}');
	add('function atQ(v,caret){var t=String(v==null?"":v);var pos=(caret==null||caret<0)?t.length:caret;var s=t.lastIndexOf("@",pos-1);'
		+ 'if(s<0||pos-s>34)return null;if(pos<=s)return null;'
		+ 'if(s>0&&/[A-Za-z0-9._%+-]/.test(t.charAt(s-1)))return null;'
		/* ③ 2026-10-26：query 里出现**任何空白**就不再是 token —— 打 `@ ` 立刻关浮层。
		   （id 不含空格，所以"名字带空格"的 bot 不会被 @ 到一半就锁住；要 @ 它请用 id。） */
		+ 'var q=t.slice(s+1,pos);if(/[\\s@#]/.test(q))return null;return {start:s,end:pos,query:q};}');
	/* 不用 RegExp 做 id 匹配（转义在 `add('…')` 里极易出错）：手扫 + 词尾边界 */
	add('function atHits(t,needle){var out=[];var i=t.indexOf(needle);while(i>=0){'
		+ 'var after=t.charAt(i+needle.length);if(!/[A-Za-z0-9._-]/.test(after))out.push(i);i=t.indexOf(needle,i+1);}return out;}');
	/* 显示名去歧义：名字唯一 ⇒ 名字；同名冲突 ⇒ `名字 · id`（只影响显示，不改 token、不删数据） */
	add('function atDisplayLabels(ms){var counts={};ms.forEach(function(a){var k=atLabelOf(a).toLowerCase();counts[k]=(counts[k]||0)+1;});'
		+ 'var out={};ms.forEach(function(a){var nm=atLabelOf(a);out[String(a.id)]=counts[nm.toLowerCase()]>1?(nm+" · "+String(a.id)):nm;});return out;}');
	add('function atItems(q){var ms=atMembers();var n=String(q==null?"":q).toLowerCase();var out=[];'
		+ 'var DL=atDisplayLabels(ms);'
		+ 'var allHit=["所有人","all","everyone"].some(function(x){return x.toLowerCase().indexOf(n)>=0;});'
		+ 'if(ms.length&&allHit)out.push({kind:"all",id:"",label:AT_ALL,display:AT_ALL});'
		+ 'ms.forEach(function(a){if(!a||out.length>=9)return;'
		+ 'var hit=(String(a.name||"").toLowerCase().indexOf(n)>=0)||(String(a.id||"").toLowerCase().indexOf(n)>=0);'
		+ 'if(hit)out.push({kind:"bot",id:String(a.id),label:atLabelOf(a),display:(DL[String(a.id)]||atLabelOf(a))});});return out;}');
	// ── 附件（2026-10-26）────────────────────────────────────────────────
	/* 上传走 `POST /api/group-file?group=&name=`（body = 原始字节）⇒ 拿 { id,name,size,mime }。
	   和「工作台群聊面板」用**同一套接口**（`client.agents.js` 的 uploadGroupFile）——
	   两处 UI 不一样，但附件协议只有一份。 */
	add('var MAX_ATT=20971520;');
	add('function pickFile(){var el=$("gpFile");if(el)el.click();}');
	add('function renderFiles(){');
	add(' var box=$("gpFiles");if(!box)return;');
	add(' box.innerHTML=S.files.length?S.files.map(function(f,i){');
	add('  if(f.pending)return "<span class=\\"gp-fchip is-busy\\">⏳ "+esc(f.name)+"</span>";');
	add('  return "<span class=\\"gp-fchip\\">"+(/^image\\//.test(String(f.mime||""))?"🖼 ":"📄 ")+esc(f.name)');
	add('   +"<button type=\\"button\\" class=\\"gp-fx\\" data-fx=\\""+i+"\\" title=\\"移除\\">✕</button></span>";');
	add(' }).join(""):"";');
	add('}');
	add('function uploadFile(file){');
	add(' var g=activeGroup();if(!g||!file)return;');
	add(' if(file.size>MAX_ATT){note("「"+file.name+"」太大："+(file.size/1048576).toFixed(1)+"MB，上限 20MB");return;}');
	add(' var key="p"+Date.now().toString(36)+Math.random().toString(36).slice(2,6);');
	add(' S.files=S.files.concat([{key:key,name:file.name,size:file.size,mime:file.type||"",pending:true}]);');
	add(' renderFiles();');
	add(' fetch("/x/agents/api/group-file?group="+encodeURIComponent(g.id)+"&name="+encodeURIComponent(file.name||"file"),');
	add('  {method:"POST",headers:{"content-type":file.type||"application/octet-stream"},body:file})');
	add('  .then(function(r){return r.json().catch(function(){return {};}).then(function(j){return {ok:r.ok,j:j};});})');
	add('  .then(function(x){');
	add('   if(!x.ok||x.j.ok===false)throw new Error(x.j.error||("HTTP "+x.ok));');
	add('   S.files=S.files.filter(function(f){return f.key!==key;}).concat(x.j.file?[x.j.file]:[]);');
	add('   renderFiles();syncSend();');
	add('  })');
	add('  .catch(function(e){');
	add('   S.files=S.files.filter(function(f){return f.key!==key;});');
	add('   renderFiles();note("附件上传失败："+(e&&e.message||e));');
	add('  });');
	add('}');
	// ── 发送 ──
	add('function send(){');
	// ★ 2026-10-26 附件：允许「只有附件、没有文字」（后端也放开了这条）
	add(' var g=activeGroup();var el=$("gpIn");var text=el.value.trim();if(!g)return;');
	add(' var files=S.files.slice();if(!text&&!files.length)return;');
	add(' el.value="";syncSend();');
	// 发出去了 ⇒ 草稿作废（否则下次进这个群又填回来一条重复内容）
	add(' try{localStorage.removeItem("gpDraft:"+g.id);}catch(x){}');
	add(' var mode=normMode(g.mode);');
	add(' var hits=(g.members||[]).filter(function(id){return text.indexOf("@"+nameOf(id))>=0||text.indexOf("@"+id)>=0;});');
	add(' var ids=mode==="all"?(g.members||[]).slice():(mode==="mentions"?hits:[]);');
	add(' if(mode==="silent"){note("silent 模式：只进群记录，不唤醒成员。");}');
	add(' else if(mode==="mentions"&&!ids.length){note("仅 @ 派发模式：没有 @ 到成员，未派发。");}');
	add(' else if(mode==="digest"){note("digest 模式：这条先攒着；攒满条数或等满秒数就汇总派发。");}');
	add(' g.transcript=(g.transcript||[]).concat([{role:"user",at:Date.now(),text:text,files:files}]);renderStack();');
	add(' S.files=[];renderFiles();');
	add(' var body={action:"message",id:g.id,text:text};if(files.length)body.files=files;'
		// `@` 提及：把 offset 一起发（后端优先用它派发 ⇒ 修掉子串误判）
		+ 'var _ats=atCollect(text);if(_ats.length)body.mentions=_ats;'
		+ 'atClose();');
	add(' postGroups(body).then(function(){ids.forEach(function(id){delete S.busy[id];});poll(true);pollWork();})');
	add('  .catch(function(e){');
	add('   ids.forEach(function(id){delete S.busy[id];});');
	/* 失败时把附件**放回**待发列表：否则重试时附件没了，得重新传一遍。 */
	add('   S.files=files.concat(S.files);renderFiles();');
	/* ★ 2026-10-26 复刻 DeepSeekBot：失败**不是**一句 note 就完事，而是把它挂到
	   `S.failed` 里常驻（poll 覆盖不掉），在列表底部标红 + 可重试/删除。 */
	add('   S.failed=S.failed.concat([{cid:"f"+Date.now().toString(36),text:text,at:Date.now(),err:String((e&&e.message)||e)}]);');
	add('   renderStack();');
	add('  });');
	add('}');
	/* 重试：从 failed 里摘掉 → 重新发；再失败就**放回去**（cid 不变，不会越点越多） */
	add('function retrySend(cid){');
	add(' var f=null,i;for(i=0;i<S.failed.length;i++){if(S.failed[i].cid===cid){f=S.failed[i];break;}}');
	add(' var g=activeGroup();if(!f||!g)return;');
	add(' S.failed=S.failed.filter(function(x){return x.cid!==cid;});renderStack();');
	add(' postGroups({action:"message",id:g.id,text:f.text}).then(function(){poll(true);})');
	add('  .catch(function(e){S.failed=S.failed.concat([{cid:cid,text:f.text,at:f.at,err:String((e&&e.message)||e)}]);renderStack();});');
	add('}');
	add('function dropFailed(cid){S.failed=S.failed.filter(function(x){return x.cid!==cid;});renderStack();}');
	// ── 工作 ──
	add('function pollWork(){');
	add(' fetch("/x/agents/api/assignments").then(function(r){return r.json();}).then(function(d){S.work=(d&&d.items)||[];if(S.tab==="work")renderRight();}).catch(function(){});');
	add('}');
	/* ⚠ 2026-10-26：全局兜底 —— 之前未捕获的异常在真机上**完全无声**（页面直接空白），
	   排查只能靠用户描述。现在一律写进状态条，截图就能看出原因。 */
	add('window.addEventListener("error",function(e){try{note("脚本错误："+((e&&e.message)||e));}catch(x){}});');
	add('window.addEventListener("unhandledrejection",function(e){try{var r=e&&e.reason;note("未处理的异常："+((r&&r.message)||r));}catch(x){}});');
	// ── 轮询 ──
	add('function poll(force){');
	add(' fetch("/x/agents/api/groups",{headers:{"cache-control":"no-cache"}}).then(function(r){return r.json();}).then(function(d){');
	add('  if(!d||d.ok===false||!Array.isArray(d.groups)){note("群聊数据读取异常，已保留当前画面");return;}');
	add('  var gs=d.groups;var sig=JSON.stringify(gs);');
	add('  if(!force&&sig===S.last)return;S.last=sig;');
	/* ⚠⚠ 2026-10-26 真机报障「群聊发 test 后黑屏」：
	   原代码是无条件 `S.groups=gs`。发消息会写 agent-groups.json，
	   若那一刻读到**空列表/坏数据**，`activeGroup()` 就返回 null ⇒
	   `renderStack()` 的 `if(!g){…清空…}` 会把消息区清空 ⇒ 看着像黑屏。
	   ⇒ 空列表不许覆盖已有画面（除非本来就没有群）。
	   ⚠ 注意：保护分支 `return` 之后**仍然必须** `S.groups=gs` —— 少了它 `S.groups` 永远是空，
	     整页消息区/弹层全空（这个错我第一版就犯了，p3-166 八条红抓出来的）。 */
	add('  if(!gs.length&&S.groups&&S.groups.length){note("群聊列表暂时读不到，已保留当前画面（稍后自动重试）");return;}');
	add('  S.groups=gs;');
	add('  if(!S.active&&gs.length)S.active=gs[0].id;');
	/* ⚠ 切群清空待发附件：附件上传时就绑定了 group，带到别的群里是错的。 */
	add('  if(S.filesGroup!==S.active){S.filesGroup=S.active;S.files=[];renderFiles();atClose();}');
	add('  var g=activeGroup();');
	add('  if(g&&!S.memAgent){S.memAgent=(g.members&&g.members[0])||(S.agents[0]&&S.agents[0].id)||"";}');
	add('  if(S.memAgent&&S.loadedAgent!==S.memAgent){S.loadedAgent=S.memAgent;R.sel=null;R.diff=null;loadRight();}');
	add('  render();');
	add('  var n=g?Number(g.unread||0):0;');
	add('  if(n&&!S.readSig[g.id]){S.readSig[g.id]=n;postGroups({action:"read",id:g.id}).catch(function(){});}');
	add(' }).catch(function(){});');
	add('}');
	add('function applyRight(){');
	add(' var p=$("gpRight");if(!p)return;');
	add(' var narrow=(window.innerWidth||1200)<=760;');
	add(' if(narrow){');
	add('  p.classList.remove("off");');
	add('  p.classList.toggle("on",!!S.drawer);');
	add('  $("gpOvl").classList.toggle("on",!!S.drawer);');
	add(' }else{');
	add('  p.classList.remove("on");');
	add('  p.classList.toggle("off",!S.rightOpen);');
	add('  $("gpOvl").classList.remove("on");');
	add(' }');
	add('}');
	/* 切群时把该群的草稿填回输入框（同一个群不被覆盖，否则用户正打字会被回滚） */
	add('function applyDraft(){');
	add(' var g=activeGroup();if(!g)return;var el=$("gpIn");if(!el)return;');
	add(' if(S.draftGroup===g.id)return;');
	add(' S.draftGroup=g.id;');
	add(' try{el.value=localStorage.getItem("gpDraft:"+g.id)||"";}catch(x){el.value="";}');
	add(' syncSend();');
	add('}');
	add('function render(){');
	add(' try{applyDraft();}catch(x){}');
	/* ⚠ 2026-10-26：渲染整体包一层 try/catch —— 之前任何一步抛错都会让 DOM 停在
	   "清空后没填"的中间态（= 黑屏），而 `poll()` 的 `.catch(()=>{})` 又把异常吞了，
	   真机上完全看不到原因。现在改成：出错时在状态条上明说。 */
	add(' try{renderLeft();renderPill();renderStack();renderRight();applyRight();}catch(err){note("渲染出错："+((err&&err.message)||err));return;}');
	add(' var g=activeGroup();');
	add(' $("gpCrumb").innerHTML=g?("<span>群聊</span><span>›</span><b>"+esc(g.name)+"</b>"):"<span>群聊</span>";');
	add(' $("gpStatus").textContent=g?((g.members||[]).length+" 位成员 · "+MODE_LABEL[normMode(g.mode)]):"";');
	add('}');
	// ── 事件绑定 ──
	add('document.addEventListener("click",function(e){');
	add(' var g=e.target.closest("[data-g]");');
	add(' if(g){S.active=g.getAttribute("data-g");render();return;}');
	add(' var a=e.target.closest("[data-agent]");');
	add(' if(a){S.memAgent=a.getAttribute("data-agent");S.tab="mem";S.loadedAgent=S.memAgent;R.sel=null;R.diff=null;loadRight();renderLeft();return;}');
	add(' var t=e.target.closest(".gp-rtab");');
	add(' if(t){S.tab=t.getAttribute("data-t");document.querySelectorAll(".gp-rtab").forEach(function(x){x.classList.toggle("on",x===t);});renderRight();return;}');
	add(' var o=e.target.closest(".gp-opt");');
	add(' if(o){pickMode(o.getAttribute("data-mode"));return;}');
	add(' var pk=e.target.closest("[data-pick]");');
	add(' if(pk){var pid=pk.getAttribute("data-pick");PICK[pid]=!PICK[pid];pk.classList.toggle("on",!!PICK[pid]);return;}');
	add('});');
	/* 输入：同步按钮状态 **+ 存草稿**（复刻 DeepSeekBot 的草稿持久化 —— 切群/刷新不丢） */
	add('$("gpIn").addEventListener("input",function(){syncSend();');
	add(' var g=activeGroup();if(!g)return;try{localStorage.setItem("gpDraft:"+g.id,$("gpIn").value);}catch(x){}');
	add('});');
	/* `@` 候选要**先于**「Enter 发送」处理：返回 true 表示已消费（选候选/关浮层） */
	add('$("gpIn").addEventListener("keydown",function(ev){if(atKey(ev))return;if(atDelKey(ev))return;if(ev.key==="Enter"&&!ev.shiftKey){ev.preventDefault();send();}});');
	add('$("gpIn").addEventListener("input",function(){atScan();});');
	add('$("gpIn").addEventListener("click",function(){atScan();});');
	add('$("gpSend").onclick=send;');
	/* 附件入口（2026-10-26）：📎 选文件 → 立刻上传 → chip 出现；chip 上的 ✕ 移除 */
	add('var _clip=$("gpClip");if(_clip)_clip.onclick=pickFile;');
	add('var _file=$("gpFile");if(_file)_file.onchange=function(ev){');
	add(' var list=ev.target.files?Array.prototype.slice.call(ev.target.files):[];');
	add(' ev.target.value="";');
	add(' for(var i=0;i<list.length;i++)uploadFile(list[i]);');
	add('};');
	add('var _fbox=$("gpFiles");if(_fbox)_fbox.addEventListener("click",function(ev){');
	add(' var t=ev.target;if(!t||!t.getAttribute)return;');
	add(' var i=t.getAttribute("data-fx");if(i===null)return;');
	add(' S.files=S.files.filter(function(f,k){return String(k)!==String(i);});renderFiles();syncSend();');
	add('});');
	/* 失败气泡上的「重试 / 删除」——事件委托（气泡是 innerHTML 重建的，直接绑会丢） */
	add('$("gpStack").addEventListener("click",function(e){');
	add(' var t=e.target;if(!t||!t.closest)return;');
	add(' var r=t.closest("[data-retry]");if(r){retrySend(r.getAttribute("data-retry"));return;}');
	add(' var d=t.closest("[data-drop]");if(d){dropFailed(d.getAttribute("data-drop"));return;}');
	add('});');
	add('$("gpLeftBtn").onclick=function(){');
	add(' var l=$("gpLeft");');
	add(' if((window.innerWidth||1200)<=1080){S.leftOpen=!l.classList.contains("open");l.classList.toggle("open",S.leftOpen);}');
	add(' else{S.leftOpen=!l.classList.contains("collapsed");l.classList.toggle("collapsed",!S.leftOpen);}');
	add('};');
	add('$("gpRightBtn").onclick=function(){');
	add(' if((window.innerWidth||1200)<=760){S.drawer=!S.drawer;}else{S.rightOpen=!S.rightOpen;}');
	add(' applyRight();');
	add('};');
	add('$("gpOvl").addEventListener("click",function(e){if(e.target===$("gpOvl")){S.drawer=false;applyRight();}});');
	add('$("gpSetSave").onclick=saveSettings;');
	add('$("gpSetDelete").onclick=deleteGroup;');
	add('$("gpNewOk").onclick=createGroup;');
	add('$("gpInviteOk").onclick=doInvite;');
	add('$("gpAvClear").onclick=clearAvatar;');
	add('$("gpAvFile").onchange=function(ev){pickAvatar(ev.target.files&&ev.target.files[0]);ev.target.value="";};');
	add('window.addEventListener("resize",applyRight);');
	add('document.addEventListener("visibilitychange",function(){if(!document.hidden){poll(true);pollWork();}});');
	add('setInterval(function(){if(!document.hidden)poll(false);},3000);');
	add('setInterval(function(){if(!document.hidden)pollWork();},6000);');
	// ⚠ 内联 onclick 引用的函数必须挂到 window —— 它们定义在 IIFE 里，
	//   不挂出来的话 HTML 里的 onclick="openNewDialog()" 会静默报
	//   "openNewDialog is not defined"（按钮点了没反应，且不报在页面上 ⇒ 极难发现）。
	add('window.openNewDialog=openNewDialog;');
	add('window.openSettings=openSettings;');
	add('window.openInviteDialog=openInviteDialog;');
	add('window.closeAll=closeAll;');
	add('window.saveSettings=saveSettings;');
	add('window.deleteGroup=deleteGroup;');
	add('window.pickMode=pickMode;');
	add('window.note=note;');
	add('window.__gpBoot=function(agents,activeId,openNew){');
	add(' S.agents=agents||[];S.active=activeId||"";');
	add(' poll(true);');
	add(' if(openNew)setTimeout(openNewDialog,120);');
	add('};');
	add('})();');
	return L.join('\n');
}

/**
 * 渲染群聊整页（DSB v3 桌面版布局）。
 * @param groups `listGroups()` 的结果
 * @param agents 可见 agent 列表（左栏 Agent 列表 + 右栏记忆的查看对象）
 * @param activeId 路径段指定的群
 * @param openNew 是否直接弹「新建群聊」
 */
export function renderGroupPage({ groups, agents, activeId, openNew, keep } = {}) {
	const list = Array.isArray(groups?.groups) ? groups.groups : [];
	const active = activeId && list.some(g => g.id === activeId) ? activeId : (list[0]?.id ?? '');
	const candidates = (Array.isArray(agents) ? agents : []).map(a => ({ id: a.id, name: a.name || a.id }));
	const safeJson = (v) => JSON.stringify(v ?? null).replace(/</g, '\\u003c');

	return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
		+ '<meta name="viewport" content="width=device-width, initial-scale=1">'
		+ '<title>群聊 · Agents</title>'
		+ `<style>${CSS}</style></head><body>`
		+ '<div class="gp-app">'
		// 左栏：Agent 列表 + 群聊列表（可折叠）
		+ '<aside class="gp-left" id="gpLeft">'
		+ '<div class="hd"><b>群聊</b><span class="sp"></span>'
		+ '<button class="ib" title="新建群聊" onclick="openNewDialog()">＋</button></div>'
		+ '<div class="rows">'
		+ '<div class="gp-sec">Agent<span class="sp"></span></div><div id="gpAgents"></div>'
		+ '<div class="gp-sec">群聊<span class="sp"></span></div><div id="gpGroups"></div>'
		+ '</div></aside>'
		// 中间栏
		+ '<main class="gp-mid" id="gpMid">'
		+ '<div class="gp-top"><button class="gp-tb" id="gpLeftBtn" title="折叠/展开左栏">‹</button>'
		+ '<span class="gp-crumb" id="gpCrumb"></span><span class="sp"></span>'
		+ '<span class="gp-st" id="gpStatus" style="font-size:11.5px;color:var(--gp-fg3)"></span>'
		+ '<button class="gp-tb gp-tb-txt" id="gpRightBtn" title="右侧面板：记忆 / 演化 / 版本 / 分支 / 成员 / 工作（窄屏时为抽屉）">面板</button></div>'
		+ '<div class="gp-page">'
		// 聊天
		+ '<section class="gp-chat">'
		+ '<div class="gp-island"><div class="gp-pill" id="gpPill"></div></div>'
		+ '<div class="gp-body"><div class="gp-stack" id="gpStack"></div></div>'
		// 待发附件条（2026-10-26）：上传成功后显示 chip，可单个移除
		+ '<div class="gp-files" id="gpFiles"></div>'
		// `@` 候选浮层（2026-10-26）：贴在看板输入框上方（`.gp-comp` 已是 position:relative）
		+ '<div class="gp-comp"><div class="gp-atpop" id="gpAtPop" hidden></div>'
		+ '<div class="gp-box"><textarea id="gpIn" placeholder="发消息…（Enter 发送，@ 选成员）"></textarea></div>'
		// ★ 2026-10-26 附件真的接上了（原来这行是「附件还没接上：先把文件路径贴进输入框」的占位提示）
		+ '<input type="file" id="gpFile" multiple hidden>'
		+ '<button class="gp-clip" id="gpClip" title="添加附件（图片/文件，单个 ≤20MB）">📎</button>'
		+ '<button class="gp-send" id="gpSend" disabled title="发送">↑</button></div>'
		+ '<div class="gp-foot"><span class="gp-chip">◈ 默认模型</span><span class="gp-chip">▢ 0 个工作区</span>'
		+ '<span class="sp"></span><span class="tok" id="gpTok">—</span></div>'
		+ '</section>'
		// 右栏：记忆 / 演化 / 版本 / 分支 / 成员 / 工作
		+ '<aside class="gp-right" id="gpRight">'
		+ '<div class="grip"></div>'
		+ '<div class="gp-rhead">'
		+ '<button class="gp-rtab on" data-t="mem">记忆</button>'
		+ '<button class="gp-rtab" data-t="evo">演化</button>'
		+ '<button class="gp-rtab" data-t="ver">版本</button>'
		+ '<button class="gp-rtab" data-t="br">分支</button>'
		+ '<button class="gp-rtab" data-t="mem-members">成员</button>'
		+ '<button class="gp-rtab" data-t="work">工作</button>'
		+ '<span class="sp"></span><span class="gp-gear" title="设置">⚙</span></div>'
		+ '<div class="gp-rbody" id="gpRBody"></div></aside>'
		+ '<div class="gp-ovl" id="gpOvl"></div>'
		+ '</div></main></div>'
		// 群设置
		+ '<div class="gp-mask" id="maskSettings"><div class="gp-dlg">'
		+ '<h3>群设置 <span style="flex:1"></span><button class="gp-tb" onclick="closeAll()">✕</button></h3>'
		+ '<div class="c">'
		+ '<div class="gp-fld"><label>群名（最多 120 字）</label><input id="gpSetName"></div>'
		+ '<div class="gp-fld"><label style="display:flex;align-items:center;gap:7px;cursor:pointer">'
		+ '<input type="checkbox" id="gpApproval" style="width:auto;margin:0"><span>加入需确认</span></label>'
		+ '<div class="gp-diag">打开后：被邀请的成员先进「待确认」区，你点 ✓ 才真正进群。</div></div>'
		+ '<div class="gp-fld"><label style="display:flex;align-items:center;gap:7px;cursor:pointer">'
		+ '<input type="checkbox" id="gpBotAutoAccept" style="width:auto;margin:0"><span>Bot 自动接受邀请</span></label>'
		+ '<div class="gp-diag">默认开（邀请即进群）。关掉后：被邀请的 Bot 要<b>自己</b>回应才进群'
		+ '（agent_group_invite_respond）；在那之前它不进群、也不收群消息。</div></div>'
		+ '<div class="gp-fld"><label>群头像（方形 · ≤96KB）</label>'
		+ '<div style="display:flex;gap:8px;align-items:center">'
		+ '<span class="gp-av-big" id="gpSetAv"></span>'
		+ '<input type="file" id="gpAvFile" accept="image/png,image/jpeg,image/webp" style="display:none">'
		+ '<button class="gp-btn" onclick="document.getElementById(\'gpAvFile\').click()">选择图片…</button>'
		+ '<button class="gp-btn" id="gpAvClear">移除</button>'
		+ '<span class="gp-diag" id="gpAvHint" style="margin:0"></span></div>'
		+ '<div class="gp-diag">自动居中裁剪并缩放；超过 96KB 会先降质量重压。</div></div>'
		+ '<label style="display:block;font-size:11.5px;color:var(--gp-fg2);margin:10px 0 6px">唤醒策略</label>'
		+ '<div class="gp-mode" id="gpModePick">'
		+ '<div class="gp-opt" data-mode="all">全员派发<div class="d">每条都派给所有成员</div></div>'
		+ '<div class="gp-opt" data-mode="mentions">仅 @ 派发<div class="d">只发被 @ 的；没 @ 就只进记录</div></div>'
		+ '<div class="gp-opt" data-mode="digest">汇总派发<div class="d">满条数或等满秒数，汇总派发一次</div></div>'
		+ '<div class="gp-opt" data-mode="silent">静默收件<div class="d">只进群记录，不唤醒成员</div></div>'
		+ '</div>'
		+ '<div id="gpWakeBox" style="display:none"><div class="gp-num">'
		+ '<div class="gp-fld"><label>条数（1–100）</label><input id="gpWakeCount" type="number" min="1" max="100" value="5"></div>'
		+ '<div class="gp-fld"><label>最长等待（秒）</label><input id="gpWakeInt" type="number" min="1" max="3600" value="30"></div></div>'
		+ '<div class="gp-diag">满 <b>条数</b>立刻汇总派发；攒不满则等满 <b>秒数</b>后由后台冲刷（每 5 秒检查一次）。</div></div>'
		+ '</div>'
		+ '<div class="f"><button class="gp-btn danger" id="gpSetDelete">解散群聊</button><span style="flex:1"></span>'
		+ '<button class="gp-btn" onclick="closeAll()">取消</button>'
		+ '<button class="gp-btn primary" id="gpSetSave">保存</button></div></div></div>'
		// 新建群
		+ '<div class="gp-mask" id="maskNew"><div class="gp-dlg">'
		+ '<h3>新建群聊 <span style="flex:1"></span><button class="gp-tb" onclick="closeAll()">✕</button></h3>'
		+ '<div class="c"><div class="gp-fld"><label>群名</label><input id="gpNewName" placeholder="比如：发布前评审"></div>'
		+ '<label style="display:block;font-size:11.5px;color:#6b6b76;margin:8px 0 6px">选择成员（可后补）</label>'
		+ '<div id="gpPick"></div></div>'
		+ '<div class="f"><button class="gp-btn" onclick="closeAll()">取消</button>'
		+ '<button class="gp-btn primary" id="gpNewOk">创建</button></div></div></div>'
		// 邀请
		+ '<div class="gp-mask" id="maskInvite"><div class="gp-dlg">'
		+ '<h3>邀请成员 <span style="flex:1"></span><button class="gp-tb" onclick="closeAll()">✕</button></h3>'
		+ '<div class="c"><div id="gpInvitePick"></div><div class="gp-diag">已在群内的不在候选里。</div></div>'
		+ '<div class="f"><button class="gp-btn" onclick="closeAll()">取消</button>'
		+ '<button class="gp-btn primary" id="gpInviteOk">加入</button></div></div></div>'
		+ `<script>${clientJs(keep ?? 200)}</script>`
		+ `<script>window.__gpBoot(${safeJson(candidates)}, ${safeJson(active)}, ${openNew === true});</script>`
		+ '</body></html>';
}
