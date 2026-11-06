---
name: ue-material-editor
description: 操控 UE5 材质编辑器（Material Editor only）：获取/遍历/创建/连接/删除材质节点、查找未连接节点、操作材质属性输出、重新编译等。不用于非材质编辑器场景（工具栏、UI、Blueprint 等）。
displayName: "UE5 材质编辑器操控技能"
---

# UE5 材质编辑器操控技能

通过 Python 操控 Unreal Engine 5 材质编辑器（Material Editor）中的节点。本技能汇总了核心 API 和常见操作模式。

---

## 1. 获取当前打开的材质

材质的 `Expressions` 属性在 Python 端是 **protected** 的，无法直接通过 `get_editor_property()` 读取。因此遍历节点需要使用 `ObjectIterator`。

```python
import unreal

# 方式1：从 Content Browser 选中资产获取
selected = unreal.EditorUtilityLibrary.get_selected_assets()
mat = None
for a in selected:
    if isinstance(a, unreal.Material):
        mat = a
        break

# 方式2：用 EditorAssetLibrary 加载指定路径
mat = unreal.EditorAssetLibrary.load_asset("/Game/MyMaterial")
```

**⚠️ 重要：** 必须在材质编辑器已打开该材质的状态下操作某些 API（如 `get_material_property_input_node`、`get_inputs_for_material_expression` 等依赖 "active material editor"）。

---

## 2. 核心 API 速查 —— `unreal.MaterialEditingLibrary`

### 2.1 节点遍历与查询

| 方法 | 说明 |
|------|------|
| `get_num_material_expressions(mat)` → int | 节点总数 |
| `get_material_property_input_node(mat, property)` → MaterialExpression | 获取连接到某个材质属性输出（如 Base Color）的根节点。**返回 None 表示该属性没有连接节点** |
| `get_inputs_for_material_expression(mat, expr)` → Array[MaterialExpression] | 获取某个节点的所有输入节点 |
| `get_material_expression_input_names(expr)` → Array[str] | 获取某个节点的所有输入引脚名称 |
| `get_input_node_output_name_for_material_expression(expr, input_node)` → str | 获取输入节点的哪个输出引脚连接到了当前节点 |
| `get_material_selected_nodes(mat)` → Set[Object] | 获取材质编辑器中当前选中的节点 |
| `get_used_textures(mat)` → Array[Texture] | 获取材质使用的所有纹理 |
| `get_statistics(mat)` → MaterialStatistics | 获取材质统计信息 |

### 2.2 节点操作

| 方法 | 说明 |
|------|------|
| `delete_material_expression(mat, expr)` → None | 删除一个节点（自动断开连接） |
| `delete_all_material_expressions(mat)` → None | 删除所有节点 |
| `create_material_expression(mat, class, x=0, y=0)` → MaterialExpression | 创建新节点 |
| `duplicate_material_expression(mat, expr)` → MaterialExpression | 复制节点 |

### 2.3 连接操作

| 方法 | 说明 |
|------|------|
| `connect_material_expressions(from_expr, from_output, to_expr, to_input)` → bool | 连接两个节点。输出名/输入名留空表示使用第一个 |
| `connect_material_property(from_expr, from_output, property)` → bool | 将节点输出连接到材质属性 |

### 2.4 其他

| 方法 | 说明 |
|------|------|
| `layout_material_expressions(mat)` → None | 自动排列节点 |
| `recompile_material(mat)` → None | 重新编译材质 |

---

## 3. `unreal.MaterialProperty` 枚举 —— 材质输出属性

```python
MP_BASE_COLOR          # 基础色
MP_METALLIC            # 金属度
MP_SPECULAR            # 高光
MP_ROUGHNESS           # 粗糙度
MP_EMISSIVE_COLOR      # 自发光颜色
MP_OPACITY             # 不透明度
MP_OPACITY_MASK        # 不透明遮罩
MP_NORMAL              # 法线
MP_AMBIENT_OCCLUSION   # 环境光遮蔽
MP_REFRACTION          # 折射
MP_ANISOTROPY          # 各向异性
MP_TANGENT             # 切线
MP_SUBSURFACE_COLOR    # 次表面颜色
MP_FRONT_MATERIAL      # 前向材质
```

---

## 4. `MaterialExpression` 基类属性

```python
expr.get_editor_property('material_expression_editor_x')  # int → X 坐标
expr.get_editor_property('material_expression_editor_y')  # int → Y 坐标
expr.get_editor_property('desc')                          # str → 描述
expr.set_editor_property('material_expression_editor_x', 200)
expr.set_editor_property('material_expression_editor_y', 300)
expr.set_editor_property('desc', 'My comment')
```

常见节点子类（共 ~400 种）：`MaterialExpressionAdd`, `MaterialExpressionMultiply`, `MaterialExpressionTextureSample`, `MaterialExpressionConstant3Vector`, `MaterialExpressionCustom`, `MaterialExpressionTextureCoordinate`, `MaterialExpressionTime`, `MaterialExpressionScalarParameter`, `MaterialExpressionVectorParameter` 等。

用 `isinstance(expr, unreal.MaterialExpressionAdd)` 判断节点类型。

---

## 5. 常见业务模式（Recipes）

### 5.1 获取材质中所有节点

```python
import unreal
mat = ...  # 获取材质对象

expressions = {}
for obj in unreal.ObjectIterator():
    if isinstance(obj, unreal.MaterialExpression) and obj.get_outer() == mat:
        expressions[obj.get_name()] = obj
```

### 5.2 稳健重写已有材质

**`delete_all_material_expressions` 会静默失败**：不报错但 ObjectIterator 仍能找到旧节点。

不要试图原地改造已有材质。正确做法：

```python
# 1. 创建全新材质（用新名字避免旧 package 未释放）
new_mat = unreal.AssetToolsHelpers.get_asset_tools().create_asset(
    'M_Temp', '/Game/Materials/', unreal.Material, unreal.MaterialFactoryNew()
)

# 2. 在新材质上构建完整节点图
# ... (create_material_expression + connect)

# 3. 把引用者全部指向新材质
for comp in all_components:
    comp.set_material(0, new_mat)

# 4. 删除旧材质
unreal.EditorAssetLibrary.delete_asset('/Game/Materials/M_Old')

# 5. 重命名新材质为原名
unreal.EditorAssetLibrary.rename_loaded_asset(new_mat, '/Game/Materials/M_Old')
```

> 注意：步骤 4 和 5 之间不需要「等一帧」—— 只要旧材质没有被其他对象引用，`delete_asset` 后就能立即 `rename_loaded_asset`。

### 5.3 找出所有未连接的节点（BFS 从输出端反向遍历）

```python
material_properties = [
    unreal.MaterialProperty.MP_BASE_COLOR,
    unreal.MaterialProperty.MP_METALLIC,
    unreal.MaterialProperty.MP_SPECULAR,
    unreal.MaterialProperty.MP_ROUGHNESS,
    unreal.MaterialProperty.MP_EMISSIVE_COLOR,
    unreal.MaterialProperty.MP_OPACITY,
    unreal.MaterialProperty.MP_OPACITY_MASK,
    unreal.MaterialProperty.MP_NORMAL,
    unreal.MaterialProperty.MP_AMBIENT_OCCLUSION,
    unreal.MaterialProperty.MP_REFRACTION,
    unreal.MaterialProperty.MP_ANISOTROPY,
    unreal.MaterialProperty.MP_TANGENT,
    unreal.MaterialProperty.MP_SUBSURFACE_COLOR,
    unreal.MaterialProperty.MP_FRONT_MATERIAL,
]

connected = set()
queue = []

# 从输出端收集根节点
for mp in material_properties:
    node = unreal.MaterialEditingLibrary.get_material_property_input_node(mat, mp)
    if node and node.get_name() not in connected:
        connected.add(node.get_name())
        queue.append(node)

# BFS 反向遍历
while queue:
    current = queue.pop(0)
    for inp in unreal.MaterialEditingLibrary.get_inputs_for_material_expression(mat, current):
        if inp and inp.get_name() not in connected:
            connected.add(inp.get_name())
            queue.append(inp)

# 未连接 = 全部 - 已连接
unconnected = set(expressions.keys()) - connected
```

### 5.4 删除所有未连接节点

```python
for name in unconnected:
    unreal.MaterialEditingLibrary.delete_material_expression(mat, expressions[name])
unreal.MaterialEditingLibrary.recompile_material(mat)
```

### 5.5 创建节点并连接

```python
# 创建 Multiply 节点
mult = unreal.MaterialEditingLibrary.create_material_expression(
    mat, unreal.MaterialExpressionMultiply, 0, 0
)

# 创建 Constant3Vector 节点
const = unreal.MaterialEditingLibrary.create_material_expression(
    mat, unreal.MaterialExpressionConstant3Vector, -300, 0
)
const.set_editor_property('constant', unreal.LinearColor(1.0, 0.0, 0.0, 1.0))

# 连接 const → mult 的 A 输入
unreal.MaterialEditingLibrary.connect_material_expressions(const, '', mult, 'A')

# 将 mult 输出连接到 Base Color
unreal.MaterialEditingLibrary.connect_material_property(mult, '', unreal.MaterialProperty.MP_BASE_COLOR)

unreal.MaterialEditingLibrary.recompile_material(mat)
```

### 5.6 打印节点连接关系

```python
for name, expr in expressions.items():
    inputs = unreal.MaterialEditingLibrary.get_inputs_for_material_expression(mat, expr)
    input_names = unreal.MaterialEditingLibrary.get_material_expression_input_names(expr)
    for i, inp in enumerate(inputs):
        if inp:
            pin = input_names[i] if i < len(input_names) else f"Pin{i}"
            output_name = unreal.MaterialEditingLibrary.get_input_node_output_name_for_material_expression(expr, inp)
            print(f"  [{name}].{pin} <- {inp.get_name()}.{output_name}")
```

### 5.7 找出所有参数名

```python
scalars = unreal.MaterialEditingLibrary.get_scalar_parameter_names(mat)
vectors = unreal.MaterialEditingLibrary.get_vector_parameter_names(mat)
textures = unreal.MaterialEditingLibrary.get_texture_parameter_names(mat)
statics  = unreal.MaterialEditingLibrary.get_static_switch_parameter_names(mat)
```

### 5.8 创建 Custom HLSL 节点

```python
cu = unreal.MaterialEditingLibrary.create_material_expression(
    mat, unreal.MaterialExpressionCustom, x, y
)
cu.set_editor_property('output_type', unreal.CustomMaterialOutputType.CMOT_FLOAT1)
cu.set_editor_property('code', hlsl_string)
cu.set_editor_property('description', 'Short name shown on node')

# 添加输入引脚（必须在 set_editor_property('code') 之后）
in1 = unreal.CustomInput()
in1.set_editor_property('input_name', 'LocalDir')    # 必须是 Name 类型；HLSL 中用小写
in2 = unreal.CustomInput()
in2.set_editor_property('input_name', 'EdgeWidth')
cu.set_editor_property('inputs', [in1, in2])

# 然后像普通节点一样连接
mel.connect_material_expressions(some_node, '', cu, 'LocalDir')
```

**Custom 节点关键约束：**
- `input_name` 必须在 HLSL 代码中**大小写完全一致**地引用
- `output_type` 枚举：

| 值 | 输出维度 |
|----|---------|
| `CMOT_FLOAT1` | 标量（mask、alpha 等） |
| `CMOT_FLOAT2` | 二维向量 |
| `CMOT_FLOAT3` | 三维向量（颜色、法线方向等） |
| `CMOT_FLOAT4` | 四维向量 |

- `code` 中声明的输入引脚变量名（如 `LocalDir`）**不用加类型**——引擎把每个输入作为已声明变量注入；直接写 `normalize(LocalDir)` 而非 `float3 LocalDir`
- `input_name` 接受 `Name` 类型和 `str`（自动转换），但要和 HLSL 代码里的变量名完全一致

### 5.9 `Constant` vs `Constant3Vector` 颜色陷阱与类型速查

```python
# ❌ 这样做会把 float → float2，连到 BaseColor(float3) 时补 0，变成黄色！
black = mel.create_material_expression(mat, unreal.MaterialExpressionConstant, 0, 0)
black.set_editor_property('r', 0.04)
append = mel.create_material_expression(mat, unreal.MaterialExpressionAppendVector, 0, 0)
mel.connect_material_expressions(black, '', append, 'A')
mel.connect_material_expressions(black, '', append, 'B')
mel.connect_material_property(append, '', unreal.MaterialProperty.MP_BASE_COLOR)
# → AppendVector 输出 float2(r, r)，连到 BaseColor(float3) 时 → (r, r, 0) = 黄色！

# ✅ 正确：用 Constant3Vector 输出完整 RGB 颜色
bk = mel.create_material_expression(mat, unreal.MaterialExpressionConstant3Vector, 0, 0)
bk.set_editor_property('constant', unreal.LinearColor(0.04, 0.04, 0.04, 1.0))
wh = mel.create_material_expression(mat, unreal.MaterialExpressionConstant3Vector, 0, 0)
wh.set_editor_property('constant', unreal.LinearColor(0.90, 0.90, 0.90, 1.0))
# → Lerp 直接输出 float3，可直接连 BaseColor，无需 AppendVector
```

**常见节点与输出类型速查：**

| 节点 | set_editor_property 关键属性 | 输出类型 | 注意 |
|------|---------------------------|---------|------|
| `Constant` | `r` (float) | float1 | 单通道标量 |
| `Constant3Vector` | `constant` (LinearColor) | float3 | RGB 颜色；A 分量被忽略 |
| `Constant4Vector` | `constant` (LinearColor) | float4 | RGBA |
| `SmoothStep` | `const_min`, `const_max`, `const_value` | float1 | **不是** `min`/`max`！ |
| `Lerp` (LinearInterpolate) | — | 与 A/B 输入同类型 | A/B 是 float3 → 输出 float3，可直连 BaseColor |
| `AppendVector` | — | float2~float4 | 拼合低维到高维 |
| `Noise` | `scale`, `noise_function`, `quality`, `levels` | float1 | `NoiseFunction.NOISEFUNCTION_VORONOI_ALU` 等 |

---

## 6. 常见陷阱

1. **`Expressions` 属性是 protected** — 不能用 `get_editor_property('expressions')`，必须用 `ObjectIterator` 遍历
2. **`get_inputs_for_material_expression` 可能返回 None 元素** — 未连接的引脚对应的数组元素是 None，遍历时必须判空
3. **材质编辑器必须打开** — 许多 API（如 `get_inputs_for_material_expression`）依赖 "active material editor"，如果材质未在编辑器中打开则会失败
4. **操作后记得 `recompile_material`** — 否则修改不会生效
5. **`create_material_expression` 的 class 参数是类型本身**（如 `unreal.MaterialExpressionMultiply`），不是字符串
6. **`delete_all_material_expressions` 静默失败** — 不报错但节点仍然存在。**不要原地改造已有材质**（见 Recipe 5.2）
7. **`Constant` (float1) → `AppendVector` → `BaseColor` 产生黄色** — float2 连 float3 时补 0，`(R, G, 0)` = 黄色。用 `Constant3Vector` 输出 RGB 颜色（见 Recipe 5.9）
8. **`SmoothStep` 属性名是 `const_min`/`const_max`** — 不是 `min`/`max`。许多节点属性名与直觉不同，先调 `unreal_help('MaterialExpressionXxx')` 确认（见下条）
9. **永远用 `unreal_help('MaterialExpressionXxx')` 查属性名再设值** — 不同节点规律不同（`SmoothStep: const_min`, `Noise: scale`, `Constant: r`, `Constant3Vector: constant`），不要臆测
10. **`Constant3Vector` 的 `constant` 是 `LinearColor(R,G,B,A)`** — 不是 `Vector` 也不是 tuple，必须传 `unreal.LinearColor`
11. **同名资产删了立刻建会失败** — package 未释放。用新名字创建 → 引向新材质 → 删旧 → rename（见 Recipe 5.2）
12. **`Custom` 节点的 `inputs` 列表顺序必须和 HLSL 引用一致** — `input_name` 和 HLSL 变量名大小写必须完全匹配
