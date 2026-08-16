# ComfyTV 节点绘制架构拆解

## 核心洞察

ComfyTV 的节点绘制**不是"两层 UI"**——LiteGraph 原生绘制标题栏和端口，DOM widget 只占内容区域。这是 `addDOMWidget` 的设计精髓。

## `addDOMWidget` 实现原理（ComfyUI 前端）

### 关键代码（ComfyUI `app.js`）

```javascript
// 核心：DOMMatrix 变换让 DOM 元素与 canvas 像素完美对齐
function get_position_style(ctx, widget_width, y, node_height) {
    const MARGIN = 4;  // widget 边缘留白
    
    // 1. 获取 canvas 元素的实际显示尺寸（考虑 DPR）
    const elRect = ctx.canvas.getBoundingClientRect();
    
    // 2. 构建变换矩阵：canvas 坐标 → 屏幕坐标
    const transform = new DOMMatrix()
        .scaleSelf(elRect.width / ctx.canvas.width, elRect.height / ctx.canvas.height)
        .multiplySelf(ctx.getTransform())  // 应用 LiteGraph 的缩放/平移
        .translateSelf(MARGIN, MARGIN + y); // 平移到 widget 位置
    
    return {
        transformOrigin: '0 0',
        transform: transform,
        left: '0px',
        top: '0px',
        position: 'absolute',
        maxWidth: `${widget_width - MARGIN * 2}px`,
        maxHeight: `${node_height - MARGIN * 2}px`,
        width: 'auto',
        height: 'auto',
    };
}

// 使用方式
const widget = {
    type: "HTML",
    name: "flying",
    draw(ctx, node, widget_width, y, widget_height) {
        // 每次绘制时同步 DOM 位置
        Object.assign(this.inputEl.style, 
            get_position_style(ctx, widget_width, y, node.size[1]));
    },
};
widget.inputEl = $el("img", { src: "..." });
document.body.appendChild(widget.inputEl);
this.addCustomWidget(widget);
```

### 核心机制

1. **LiteGraph 管理 widget 布局**
   - `computeSize()` 计算 widget 占据的空间
   - `drawWidgets()` 遍历所有 widget，调用 `draw()` 回调
   - **widget 位置由 LiteGraph 决定**（`y` 参数）

2. **DOM 元素随 LiteGraph 缩放**
   - `ctx.getTransform()` 获取当前 canvas 变换（缩放 + 平移）
   - `DOMMatrix.multiplySelf(ctx.getTransform())` 应用到 DOM
   - **DOM 元素与 canvas 像素 1:1 对齐**

3. **端口/标题栏不被覆盖**
   - `BaseWidget.margin = 15` —— widget 距离节点边缘 15px
   - 端口在 x=5..15，widget 从 x=15 开始
   - 标题栏在顶部 30px，widget 从 y=30 开始

## 我们的问题

### 当前实现（错误）

```typescript
// widgetBridge.ts —— 我们绕过了 LiteGraph 的 widget 系统
el.style.left = `${rect.left + insetL * scale}px`;
el.style.top = `${rect.top + insetT * scale}px`;
el.style.width = `${designW - insetL - insetR}px`;
el.style.height = `${designH - insetT - insetB}px`;
el.style.transform = `scale(${scale})`;
```

**问题**：
1. 我们**自己计算** overlay 位置，而不是让 LiteGraph 决定
2. `rect.left + insetL * scale` 是**屏幕像素**，但 LiteGraph 用 `ctx.getTransform()` 获取**canvas 变换**
3. 缩放时，`scale` 变化，但 `insetL` 不变——**inset 没有随缩放同步**

### 为什么"参数面板被重复绘制"

用户截图显示：
- 标题栏显示 `t`（LiteGraph 绘制）
- 下方还有另一个标题栏（DOM card 绘制）

**原因**：我们没有删除 LiteGraph 的标题栏绘制，同时 DOM card 也绘制了标题。

## 根本性解决方案

### 方案 A：完全对齐 ComfyTV（推荐）

**核心**：让 LiteGraph 管理 widget 布局，DOM 只负责内容。

```typescript
// 1. 注册 DOM widget（不是 overlay）
const widget = node.addCustomWidget({
    type: 'dom',
    name: 'sarosis_card',
    element: container,  // DOM 元素
    draw(ctx, node, widget_width, y, widget_height) {
        // LiteGraph 每次绘制时调用，同步 DOM 位置
        syncDOMPosition(this.element, ctx, widget_width, y);
    },
    computeSize(width) {
        return [width, desiredHeight];
    },
});

// 2. 位置同步（关键！）
function syncDOMPosition(el, ctx, widget_width, y) {
    const elRect = ctx.canvas.getBoundingClientRect();
    const transform = new DOMMatrix()
        .scaleSelf(elRect.width / ctx.canvas.width, elRect.height / ctx.canvas.height)
        .multiplySelf(ctx.getTransform())
        .translateSelf(0, y);  // y 由 LiteGraph 提供
    
    Object.assign(el.style, {
        transformOrigin: '0 0',
        transform: transform,
        position: 'absolute',
        left: '0px',
        top: '0px',
        width: `${widget_width}px`,
        height: 'auto',
    });
}
```

**优点**：
- LiteGraph 完全管理布局（包括端口、标题、widget）
- DOM 随缩放/平移自动同步
- 端口/标题永不遮挡

### 方案 B：保持现有 overlay，但修正缩放

如果坚持用 overlay，必须修正缩放同步：

```typescript
// 错误：inset 不随缩放变化
el.style.left = `${rect.left + insetL * scale}px`;

// 正确：inset 是设计单位，随缩放同步
const designInset = 15;  // 设计单位（graph units）
el.style.left = `${rect.left + designInset * scale}px`;  // ✓ 随缩放同步
```

## 具体修复

### 1. 删除 LiteGraph 标题栏重复绘制

当前：`comfyNodeStyle.ts` 的 `comfyTitleText` 绘制标题，但 schema 节点同时有 DOM card 标题。

修复：schema 节点**不绘制** LiteGraph 标题栏（title_mode = NO_TITLE），DOM card 全权负责。

### 2. 修正 inset 缩放同步

当前：`SIDE_INSET = 15` 是**屏幕像素**，不随缩放变化。

修复：`SIDE_INSET` 应该是**设计单位**（graph units），乘以 `scale` 得到屏幕像素。

### 3. 统一端口布局

当前：我们自己计算端口位置（`getInputSlotPos` 覆写）。

修复：使用 LiteGraph 默认端口布局（垂直堆叠），DOM card 只占内容区域。

## 结论

**根本问题**：我们绕过了 LiteGraph 的 widget 系统，自己管理 overlay 位置，导致：
1. 两层 UI 分离（canvas 绘制 vs DOM overlay）
2. 对齐问题（位置、缩放、遮挡）

**解决方案**：
1. **短期**：修正 inset 缩放同步（设计单位 × scale）
2. **长期**：迁移到 `addDOMWidget` 架构，让 LiteGraph 全权管理布局
