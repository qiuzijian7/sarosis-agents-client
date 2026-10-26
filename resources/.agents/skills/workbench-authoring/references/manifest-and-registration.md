# 清单与注册（结构契约）

## package.json（照抄字段，只改名字）

```json
{
  "name": "@vssaros/dsh-tasks",
  "version": "0.1.0",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./package.json": "./package.json",
    "./client": "./lib/client.js"
  },
  "files": [
    "lib/index.js",
    "lib/client.js",
    "lib/client.tasks.js",
    "cordis.patch.yml"
  ],
  "dsh": {
    "bundle": { "patch": ["./cordis.patch.yml"] },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-slots"]
    }
  }
}
```

要点：

- `main` 与 `exports['.']` 都指向 Host 半（`lib/index.js`）。
- **`exports['./client']` 必须存在** —— 客户端加载靠它定位入口。
- `dsh.client.inject` 声明客户端依赖的宿主模块（插槽服务），漏了会出现"样式/插槽拿不到"。
- `dsh.bundle.patch` 指向 `cordis.patch.yml`；**没有它，插件不进运行时且宿主不报错**（最隐蔽的一个坑）。
- `files` 要**逐项列全**（含 `lib/client.<name>.js`）；`check-plugin-files.mjs` 会比对「清单声明 ↔ 目录实际」，多一个少一个都会红。

## cordis.patch.yml

```yaml
# @vssaros/dsh-tasks bundle patch: insert the tasks row.
- insert:
    - id: vssaros-tasks
      # 需要数据根时（读 <DSH 数据根>/vssaros-tasks）：
      #   config:
      #     dataRoot: ${DSH_DATA_ROOT}/vssaros-tasks
```

- 只做一件事：把插件行插进 cordis 组合。
- 需要落盘时，`dataRoot` 由 IDE 的「数据根覆盖层」（`dshCli.ts` 的 `renderDataRootOverlay`）注入；**IDE 未重建时名单里没有新插件** ⇒ `config.dataRoot` 缺失。此时要让 `self-check` 显式报错，不要静默降级。

## 客户端入口与子块（chunk 规则）

`lib/client.js`（入口）：

```js
export default function apply(ctx) {
	// 只声明 id + factory —— **绝不能有 chunk 字段**
	ctx.client.register({
		id: 'vssaros-tasks',
		factory: () => ({}),
	});
}
```

子块 `lib/client.tasks.js`：

```js
__ModuleLoader__.load({
	id: 'vssaros-tasks',
	chunk: 'client.tasks.js',   // ← chunk 只出现在子块
	factory: () => ({}),
});
```

- **入口写 `chunk:` ⇒ 整个 web boot 失败**（`invalid package-local chunk`），不是单页坏。
- 改子块后：升 `version` + 更新入口 mtime（否则 `check-chat-surface-chunks.mjs` 报「入口比子块旧」，浏览器也会吃旧缓存）。
- 子块被整段并进入口后，**旧子块文件会变成死文件** —— 体检/守卫要挑"活"文件（见 `verification.md`）。

## DESCRIPTOR 与注册

```js
const DESCRIPTOR = {
	title: '任务台',
	description: '一句话说清它替用户做什么',
	repository: 'vssaros:tasks',        // 必填；缺失 ⇒ Invalid workbench repository
	icon: 'codicon:checklist',          // 渲染时须经 wbIconEmoji() 映射，否则是 🧩
	customFrame: true,                  // 需要 props.conversation 时必开
	layout: { businessSide: 'left' },   // 可选：业务区在左
	order: 41,                          // 可选：启动器排序
	// headerLayout: '...'              // 可选：宿主头部布局
};

function apply(ctx) {
	ctx.inject(['desktopWorkbenches'], (c) => {
		c.effect(
			() => c.desktopWorkbenches.register(DESCRIPTOR, TasksPanel),
			'vssaros-tasks: workbench',
		);
	});
}
```

- 注册后宿主负责渲染，**不要再自己挂 DOM 到 body**。
- `c.effect(...)` 保证插件卸载时组件一起摘掉（否则切走工作台会残留）。
- 描述符里的 `title` / `icon` / `order` 若同时登记在 IDE 活动栏，两边必须逐字一致（`run-all-common-tests.mjs` 会查）。

## 两种宿主服务名（并存，别混）

| 场景 | 注入名 |
|---|---|
| 本仓自有宿主插件 `@vssaros/dsh-workbenches` | `desktopWorkbenches` |
| 市场第三方包契约 | `dsh-desktop-workbenches` |

在自己的工作台里统一用 `desktopWorkbenches`；写"能上架的通用包"时两个都要探测（先 `ctx.inject`，没有再试另一个）。
