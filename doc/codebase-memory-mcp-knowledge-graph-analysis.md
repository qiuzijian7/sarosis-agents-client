# Codebase-Memory-MCP 知识图谱构建原理深度分析

> **分析日期**: 2026-06-23  
> **项目版本**: v0.8.0+  
> **作者**: AI Assistant  
> **适用场景**: 代码智能引擎架构设计参考

---

## 一、核心架构概览

### 1.1 系统设计哲学

`codebase-memory-mcp` 采用 **RAM-first 管道架构**，核心设计原则：

1. **极致性能**: 内存中完成所有索引，最后一次性 dump 到 SQLite
2. **零依赖**: 纯 C 实现，静态编译，单二进制分发
3. **两层分析**: Tree-sitter 语法分析 + Hybrid LSP 语义解析
4. **增量更新**: 基于文件哈希的智能增量索引

### 1.2 整体数据流

```
源码文件 → 文件发现 → Tree-sitter 解析 → AST 提取 → 定义注册 → 调用解析 → 图谱构建 → SQLite 持久化
    │                                                                                            │
    └────────────────────────────── 内存图缓冲区（Graph Buffer）──────────────────────────────┘
```

---

## 二、知识图谱数据模型

### 2.1 节点类型（Node Labels）

| 节点类型 | 说明 | 示例 |
|----------|------|------|
| **Project** | 项目根节点 | `my-project` |
| **Branch** | Git 分支（可选） | `main`, `feature/xxx` |
| **Folder** | 目录节点 | `src/utils` |
| **File** | 文件节点 | `src/utils/helper.ts` |
| **Module** | 模块/包节点 | `src/utils/helper` |
| **Function** | 函数节点 | `processData` |
| **Method** | 方法节点（类成员） | `User.getName` |
| **Class** | 类节点 | `UserController` |
| **Interface** | 接口节点 | `IRepository` |
| **Enum** | 枚举节点 | `UserRole` |
| **Type** | 类型别名节点 | `UserID` |
| **Route** | HTTP 路由节点 | `GET /api/users` |
| **Resource** | K8s 资源节点 | `Deployment/app` |
| **Variable** | 全局变量节点 | `MAX_RETRY` |

### 2.2 边类型（Edge Types）

| 边类型 | 说明 | 示例 |
|----------|------|------|
| **CONTAINS_FOLDER** | 项目/目录包含子目录 | `Project → Folder` |
| **CONTAINS_FILE** | 目录包含文件 | `Folder → File` |
| **DEFINES** | 文件定义模块/函数/类 | `File → Module` |
| **DEFINES_METHOD** | 类定义方法 | `Class → Method` |
| **IMPORTS** | 文件导入模块 | `File → Module` |
| **CALLS** | 函数调用 | `Function → Function` |
| **HTTP_CALLS** | HTTP 调用关系 | `Function → Route` |
| **ASYNC_CALLS** | 异步调用（消息队列） | `Function → Route` |
| **IMPLEMENTS** | 类实现接口 | `Class → Interface` |
| **INHERITS** | 类继承 | `Class → Class` |
| **HANDLES** | 路由处理函数 | `Route → Function` |
| **USAGE** | 变量/类型使用 | `Function → Variable` |
| **USES_TYPE** | 使用类型 | `Function → Type` |
| **CONFIGURES** | 配置文件关系 | `File → Resource` |
| **WRITES** | 写入操作 | `Function → Variable` |
| **TESTS** | 测试关系 | `TestFunction → Function` |
| **FILE_CHANGES_WITH** | Git 协同变更 | `File → File` |
| **SIMILAR_TO** | 代码相似度（MinHash） | `Function → Function` |
| **SEMANTICALLY_RELATED** | 语义相关性（词汇 mismatch） | `Function → Function` |
| **EMITS** | 事件发射 | `Function → Channel` |
| **LISTENS_ON** | 事件监听 | `Function → Channel` |
| **DATA_FLOWS** | 数据流（参数传递） | `Function → Variable` |
| **INFRA_MAPS** | 基础设施绑定 | `Route → Route` |

### 2.3 节点属性（Properties JSON）

```json
{
  "extension": ".ts",
  "signature": "(data: UserData) => Promise<void>",
  "return_type": "Promise<void>",
  "decorators": ["@Get('/api/users')", "@UseGuards(AuthGuard)"],
  "base_classes": ["BaseController"],
  "param_names": ["data"],
  "param_types": ["UserData"],
  "route_path": "/api/users",
  "route_method": "GET",
  "complexity": 5,
  "cognitive": 3,
  "fingerprint": "[uint32 array]",
  "structural_profile": "N:12,E:3,R:2,P:2,L:15",
  "body_tokens": "data user promise await"
}
```

---

## 三、索引管道（Pipeline）详解

### 3.1 管道阶段概览

索引管道采用 **多阶段顺序执行**，每个阶段负责特定的图谱构建任务：

```
┌─────────────────────────────────────────────────────────────────────┐
│                    cbm_pipeline_run()                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────┐    ┌──────────────┐    ┌─────────────────┐  │
│  │  阶段 1      │    │  阶段 2       │    │  阶段 3          │  │
│  │  文件发现    │───→│  结构构建     │───→│  定义提取        │  │
│  │ discover()   │    │  structure    │    │  definitions     │  │
│  └─────────────┘    └──────────────┘    └─────────────────┘  │
│           │                   │                      │                     │
│           ▼                   ▼                      ▼                     │
│  ┌─────────────┐    ┌──────────────┐    ┌─────────────────┐  │
│  │  阶段 4      │    │  阶段 5       │    │  阶段 6          │  │
│  │  调用解析    │    │  语义边缘     │    │  后处理          │  │
│  │  calls        │    │  semantic     │    │  tests/git/history│
│  └─────────────┘    └──────────────┘    └─────────────────┘  │
│           │                   │                      │                     │
│           ▼                   ▼                      ▼                     │
│  ┌─────────────┐    ┌──────────────┐    ┌─────────────────┐  │
│  │  阶段 7      │    │  阶段 8       │    │  阶段 9          │  │
│  │  Route 匹配  │    │  相似度计算   │    │  Dump 到 SQLite│  │
│  │  route_match  │    │  similarity   │    │  dump_to_sqlite  │  │
│  └─────────────┘    └──────────────┘    └─────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 阶段 1：文件发现（File Discovery）

**目标**: 扫描仓库，发现所有需要索引的文件

**核心函数**: `cbm_discover_ex()`

**工作流程**:
1. 读取 `.gitignore` 和 `.cbmignore` 文件
2. 递归遍历目录树
3. 过滤掉 `.git/`、`node_modules/` 等目录
4. 根据文件扩展名映射到语言类型
5. 返回 `cbm_file_info_t` 数组

**关键代码路径**:
```
cbm_pipeline_run()
  └─→ discover_files()
       └─→ cbm_discover_ex()
            ├─→ 遍历目录（opendir/readdir）
            ├─→ 应用 .gitignore 规则
            ├─→ 应用 .cbmignore 规则
            └─→ 返回文件列表
```

### 3.3 阶段 2：结构构建（Structure Pass）

**目标**: 创建 `Project`、`Folder`、`File` 节点和包含关系边

**核心函数**: `pass_structure()`

**工作流程**:
1. 创建 `Project` 节点
2. 为每个文件创建 `File` 节点
3. 递归创建 `Folder` 节点（目录链）
4. 创建 `CONTAINS_FOLDER` 和 `CONTAINS_FILE` 边

**关键代码路径**:
```
pass_structure(p, files, file_count)
  ├─→ 创建 Project 节点
  ├─→ 创建 Branch 节点（如果有 Git 分支）
  ├─→ for each file:
  │    ├─→ 创建 File 节点
  │    ├─→ 创建 Folder 链（create_folder_chain）
  │    └─→ 创建 CONTAINS_FILE 边
  └─→ 返回
```

** qualified name（QN）生成规则**:
- Project: `project-name`
- Folder: `project-name.src.utils`
- File: `project-name.src.utils.helper.__file__`
- Function: `project-name.src.utils.helper.processData`

### 3.4 阶段 3：定义提取（Definitions Pass）

**目标**: 从源码中提取函数、类、方法等定义，注册到函数注册表和图缓冲区

**核心函数**: `cbm_pipeline_pass_definitions()`

**工作流程**:
1. 读取源代码文件
2. 调用 `cbm_extract_file()` 进行 AST 分析
3. 为每个定义创建图节点（`Function`、`Class`、`Method` 等）
4. 将可调用定义注册到函数注册表（`cbm_registry_add()`）
5. 存储导入映射和调用点供后续阶段使用

**Tree-sitter 提取核心**:
```
cbm_extract_file(source, source_len, lang, file_path, arena)
  ├─→ ts_parser_new() → 创建解析器
  ├─→ ts_parser_set_language() → 设置语言语法
  ├─→ ts_parser_parse() → 解析得到 TSTree
  ├─→ ts_tree_root_node() → 获取根节点
  ├─→ walk_defs() → 遍历 AST 提取定义
  │    ├─→ extract_func_def() → 提取函数定义
  │    ├─→ extract_class_def() → 提取类定义
  │    ├─→ extract_variables() → 提取全局变量
  │    └─→ extract_rust_impl() → 提取 Rust impl 块
  ├─→ extract_calls() → 提取调用点
  ├─→ extract_imports() → 提取导入语句
  └─→ 返回 CBMFileResult
```

**定义提取详细流程**（以 TypeScript 为例）:
```
walk_defs(ctx, root, spec, depth)
  ├─→ 遍历 AST 节点
  ├─→ 匹配 node type:
  │    ├─→ "function_declaration" → extract_func_def()
  │    ├─→ "class_declaration" → extract_class_def()
  │    │    ├─→ 提取类名、基类、装饰器
  │    │    ├─→ extract_class_methods() → 提取类方法
  │    │    ├─→ extract_class_fields() → 提取类字段
  │    │    └─→ extract_enum_members() → 提取枚举成员
  │    ├─→ "method_definition" → extract_func_def()
  │    └─→ "variable_declaration" → extract_variables()
  ├─→ 计算 MinHash 指纹（用于相似度检测）
  ├─→ 计算 AST 结构轮廓（structural profile）
  └─→ 提取函数体标识符令牌
```

### 3.5 阶段 4：调用解析（Calls Pass）

**目标**: 解析函数调用关系，创建 `CALLS` 边

**核心函数**: `cbm_pipeline_pass_calls()`

**工作流程**:
1. 重新提取每个文件的调用点（或从缓存读取）
2. 构建每文件的导入映射（import map）
3. 对每个调用点进行解析：
   - **策略 1**: 导入映射解析（精确匹配）
   - **策略 2**: 同模块解析（当前文件内定义）
   - **策略 3**: 唯一定义解析（全局唯一名称）
   - **策略 4**: 后缀匹配解析（模糊匹配）
4. 创建 `CALLS` 边，附带 `confidence` 和 `strategy` 属性

**调用解析详细流程**:
```
cbm_pipeline_pass_calls(ctx, files, file_count, result_cache)
  ├─→ for each file:
  │    ├─→ 读取缓存的 CBMFileResult（包含 calls[]）
  │    ├─→ 构建 import_map（local_name → module_qn）
  │    ├─→ for each call in file:
  │    │    ├─→ cbm_registry_resolve() → 解析被调用函数
  │    │    │    ├─→ 策略 1: import_map 解析
  │    │    │    ├─→ 策略 2: 同模块解析
  │    │    │    ├─→ 策略 3: 唯一定义解析
  │    │    │    └─→ 策略 4: 后缀匹配解析
  │    │    ├─→ 如果解析成功:
  │    │    │    ├─→ 获取 caller 和 callee 的节点 ID
  │    │    │    └─→ cbm_gbuf_insert_edge() → 创建 CALLS 边
  │    │    └─→ 如果解析失败:
  │    │         └─→ 记录未解析调用（用于诊断）
  │    └─→ 返回
  └─→ 返回
```

**Hybrid LSP 增强解析**（9 种语言）:
- 在 tree-sitter 提取后，运行语言特定的 LSP 解析器
- 使用导入图和跨文件定义注册表
- 解析 tree-sitter 无法处理的类型信息（泛型、继承、命名空间等）

```
cbm_pipeline_pass_lsp_cross(ctx, files, file_count, result_cache)
  ├─→ 收集所有文件的 defs → all_defs[]
  ├─→ 构建 module_def_index（模块 → defs 索引）
  ├─→ 构建跨文件 LSP 注册表（per-language）:
  │    ├─→ cbm_go_build_cross_registry()
  │    ├─→ cbm_py_build_cross_registry()
  │    ├─→ cbm_c_build_cross_registry()
  │    ├─→ cbm_cs_build_cross_registry()
  │    └─→ cbm_ts_build_cross_registry()
  └─→ for each file:
       ├─→ 获取文件的 imports 和 defs
       ├─→ 运行跨文件 LSP 解析
       │    ├─→ 解析 CALLS（类型感知）
       │    ├─→ 解析 USAGES（变量/类型使用）
       │    └─→ 返回 resolved_calls[]
       └─→ 创建 RESOLVED_CALLS 边
```

### 3.6 阶段 5：使用关系（Usages Pass）

**目标**: 提取变量使用、类型引用等关系

**核心函数**: `cbm_pipeline_pass_usages()`

**工作流程**:
1. 提取变量读写操作
2. 提取类型引用
3. 创建 `USAGE`、`USES_TYPE`、`WRITES` 边

### 3.7 阶段 6：语义边缘（Semantic Edges Pass）

**目标**: 创建高级语义关系边

**核心函数**: `cbm_pipeline_pass_semantic_edges()`

**工作流程**:
1. 提取 `IMPLEMENTS`、`INHERITS` 关系
2. 提取装饰器关系
3. 创建语义边缘

### 3.8 阶段 7：Route 匹配（Route Matching Pass）

**目标**: 从 HTTP 框架装饰器提取路由，匹配调用点

**核心函数**: `cbm_pipeline_create_route_nodes()`

**工作流程**:
1. 扫描 `Function` 节点的 `route_path` 和 `route_method` 属性
2. 创建 `Route` 节点
3. 创建 `HANDLES` 边（函数 → 路由）
4. 匹配调用点中的 HTTP 请求（如 `axios.get('/api/users')`）
5. 创建 `HTTP_CALLS` 边

### 3.9 阶段 8：相似度计算（Similarity Pass）

**目标**: 计算函数相似度，创建 `SIMILAR_TO` 边

**核心函数**: `cbm_pipeline_pass_similarity()`

**工作流程**:
1. 遍历所有 `Function` 节点
2. 读取 MinHash 指纹
3. 计算 Jaccard 相似度
4. 如果相似度 ≥ 阈值，创建 `SIMILAR_TO` 边

**MinHash 原理**:
- 将函数体转换为令牌集合（标识符）
- 计算 MinHash 签名（k=128 个哈希值）
- 比较 MinHash 签名的相似度 ≈ 原始集合的 Jaccard 相似度

### 3.10 阶段 9：Dump 到 SQLite

**目标**: 将内存中的图缓冲区持久化到 SQLite 数据库

**核心函数**: `cbm_gbuf_dump_to_sqlite()`

**工作流程**:
1. 创建 SQLite 数据库文件
2. 创建表结构（`nodes`、`edges`、`nodes_fts` 等）
3. 批量插入节点和边
4. 创建索引
5. 执行 `VACUUM INTO`（压缩）
6. 可选：导出 `.codebase-memory/graph.db.zst` 压缩快照

---

## 四、核心函数调用图

### 4.1 主索引流程调用图

```
cbm_pipeline_run(p)
  │
  ├─→ 1. try_incremental_or_delete_db()
  │    ├─→ 检查是否存在旧数据库
  │    ├─→ 如果存在且文件数变化 < 50%:
  │    │    └─→ cbm_pipeline_run_incremental() → 增量索引
  │    └─→ 否则:
  │         └─→ 删除旧数据库 → 全量索引
  │
  ├─→ 2. discover_files() → 文件发现
  │
  ├─→ 3. run_extraction_phase()
  │    │
  │    ├─→ pass_structure() → 结构构建
  │    │
  │    ├─→ [并行路径] run_parallel_pipeline()
  │    │    ├─→ cbm_parallel_extract() → 并行提取
  │    │    │    └─→ worker_thread_fn()
  │    │    │         └─→ cbm_extract_file() → AST 提取
  │    │    ├─→ cbm_build_registry_from_cache() → 构建注册表
  │    │    ├─→ cbm_pxc_collect_all_defs() → 收集跨文件 defs
  │    │    ├─→ cbm_xx_build_cross_registry() → 构建跨文件 LSP 注册表
  │    │    └─→ cbm_parallel_resolve() → 并行解析
  │    │         └─→ worker_thread_fn()
  │    │              └─→ cbm_pxc_run_one() → 跨文件 LSP 解析
  │    │
  │    └─→ [顺序路径] run_sequential_pipeline()
  │         ├─→ cbm_pipeline_pass_definitions() → 定义提取
  │         ├─→ cbm_pipeline_pass_k8s() → K8s 资源提取
  │         ├─→ seq_pass_lsp_cross_dispatch() → 跨文件 LSP
  │         ├─→ cbm_pipeline_pass_calls() → 调用解析
  │         ├─→ cbm_pipeline_pass_usages() → 使用关系
  │         └─→ cbm_pipeline_pass_semantic() → 语义边缘
  │
  ├─→ 4. run_post_extraction()
  │    ├─→ cbm_pipeline_pass_tests() → 测试文件识别
  │    ├─→ run_githistory() → Git 历史分析
  │    ├─→ run_predump_passes()
  │    │    ├─→ cbm_pipeline_pass_decorator_tags() → 装饰器标签
  │    │    ├─→ cbm_pipeline_pass_configlink() → 配置文件链接
  │    │    ├─→ cbm_pipeline_create_route_nodes() → Route 匹配
  │    │    ├─→ cbm_pipeline_pass_similarity() → 相似度计算
  │    │    ├─→ cbm_pipeline_pass_semantic_edges() → 语义边缘
  │    │    └─→ cbm_pipeline_pass_complexity() → 复杂度计算
  │    └─→ dump_and_persist_hashes()
  │         ├─→ cbm_gbuf_dump_to_sqlite() → Dump 到 SQLite
  │         ├─→ cbm_store_upsert_file_hash() → 持久化文件哈希
  │         └─→ cbm_artifact_export() → 导出压缩快照
  │
  └─→ 5. 返回结果
```

### 4.2 AST 提取核心调用图

```
cbm_extract_file(source, source_len, lang, file_path, arena)
  │
  ├─→ 1. 预处理（C/C++ 宏展开）
  │    └─→ cbm_preprocess()
  │
  ├─→ 2. Tree-sitter 解析
  │    ├─→ get_thread_parser() → 获取线程局部解析器
  │    ├─→ ts_parser_parse() → 解析源码
  │    └─→ ts_tree_root_node() → 获取 AST 根节点
  │
  ├─→ 3. 遍历 AST 提取定义
  │    └─→ walk_defs()
  │         ├─→ extract_func_def() → 函数定义
  │         │    ├─→ 提取函数名、参数、返回类型
  │         │    ├─→ 提取装饰器
  │         │    ├─→ compute_fingerprint() → 计算 MinHash 指纹
  │         │    └─→ extract_body_ident_tokens() → 提取体标识符
  │         ├─→ extract_class_def() → 类定义
  │         │    ├─→ 提取类名、基类
  │         │    ├─→ extract_class_methods() → 类方法
  │         │    ├─→ extract_class_fields() → 类字段
  │         │    └─→ extract_enum_members() → 枚举成员
  │         ├─→ extract_variables() → 全局变量
  │         └─→ extract_rust_impl() → Rust impl 块
  │
  ├─→ 4. 提取调用点
  │    └─→ extract_calls()
  │         └─→ walk_calls() → 遍历 AST 查找调用表达式
  │
  ├─→ 5. 提取导入语句
  │    └─→ extract_imports()
  │         └─→ walk_imports() → 遍历 AST 查找 import/require/use
  │
  ├─→ 6. 提取使用关系
  │    └─→ extract_usages()
  │
  ├─→ 7. 提取类型引用
  │    └─→ extract_type_refs()
  │
  ├─→ 8. 提取环境变量访问
  │    └─→ extract_env_accesses()
  │
  ├─→ 9. Hybrid LSP 解析（9 种语言）
  │    ├─→ cbm_go_lsp_resolve() → Go
  │    ├─→ cbm_py_lsp_resolve() → Python
  │    ├─→ cbm_ts_lsp_resolve() → TypeScript/JavaScript
  │    ├─→ cbm_php_lsp_resolve() → PHP
  │    ├─→ cbm_c_lsp_resolve() → C
  │    ├─→ cbm_cpp_lsp_resolve() → C++
  │    ├─→ cbm_cs_lsp_resolve() → C#
  │    ├─→ cbm_java_lsp_resolve() → Java
  │    ├─→ cbm_kotlin_lsp_resolve() → Kotlin
  │    └─→ cbm_rust_lsp_resolve() → Rust
  │
  └─→ 10. 返回 CBMFileResult
```

### 4.3 调用解析详细调用图

```
cbm_registry_resolve(r, callee_name, module_qn, import_map)
  │
  ├─→ 策略 1: Import Map 解析（精确匹配）
  │    ├─→ 查找 import_map 中的 local_name
  │    ├─→ 如果找到:
  │    │    ├─→ 构造 target_qn = module_qn + "." + export_name
  │    │    └─→ 返回 {qualified_name, strategy="import_map", confidence=1.0}
  │    └─→ 否则: 继续策略 2
  │
  ├─→ 策略 2: 同模块解析（当前文件内定义）
  │    ├─→ 构造 target_qn = module_qn + "." + callee_name
  │    ├─→ cbm_registry_lookup() → 查找注册表
  │    ├─→ 如果找到:
  │    │    └─→ 返回 {qualified_name, strategy="same_module", confidence=0.9}
  │    └─→ 否则: 继续策略 3
  │
  ├─→ 策略 3: 唯一定义解析（全局唯一名称）
  │    ├─→ cbm_registry_lookup_all() → 查找所有匹配
  │    ├─→ 如果恰好 1 个匹配:
  │    │    └─→ 返回 {qualified_name, strategy="unique", confidence=0.8}
  │    └─→ 否则: 继续策略 4
  │
  ├─→ 策略 4: 后缀匹配解析（模糊匹配）
  │    ├─→ 遍历注册表中的所有定义
  │    ├─→ 检查 callee_name 是否是指缀
  │    ├─→ 如果恰好 1 个匹配:
  │    │    └─→ 返回 {qualified_name, strategy="suffix", confidence=0.6}
  │    └─→ 否则:
  │         └─→ 返回 {qualified_name="", strategy="unresolved", confidence=0.0}
  │
  └─→ 返回 cbm_resolution_t
```

---

## 五、图缓冲区（Graph Buffer）架构

### 5.1 设计原理

图缓冲区是索引管道的核心数据结构，采用 **RAM-first 设计**：

1. **内存存储**: 所有节点和边存储在内存中（使用 arena allocator）
2. **快速查找**: 通过 qualified name 哈希表实现 O(1) 节点查找
3. **边去重**: 通过 `(source_id, target_id, type)` 键去重
4. **批量 dump**: 索引完成后一次性 dump 到 SQLite

### 5.2 核心数据结构

```c
struct cbm_gbuf {
    const char *project;        // 项目名称
    const char *root_path;      // 仓库根路径
    
    // 节点存储
    cbm_gbuf_node_t *nodes;    // 节点数组
    int node_cap;                // 节点容量
    int node_count;              // 节点数量
    
    // 边存储
    cbm_gbuf_edge_t *edges;    // 边数组
    int edge_cap;                // 边容量
    int edge_count;              // 边数量
    
    // 快速查找索引
    CBMHashTable *qn_to_id;    // qualified_name → node_id
    CBMHashTable *edge_dedup;  // (source, target, type) → edge_id
    
    // 向量存储（用于语义搜索）
    cbm_vector_store_t *vectors;
    
    // 共享 ID 源（用于并行提取）
    _Atomic int64_t *id_source;
};
```

### 5.3 关键操作

| 操作 | 函数 | 时间复杂度 |
|------|------|-------------|
| 插入节点 | `cbm_gbuf_upsert_node()` | O(1) 平均 |
| 查找节点（by QN） | `cbm_gbuf_find_by_qn()` | O(1) 平均 |
| 插入边 | `cbm_gbuf_insert_edge()` | O(1) 平均 |
| 查找边（by source） | `cbm_gbuf_find_edges_by_source_type()` | O(E) 最坏 |
| Dump 到 SQLite | `cbm_gbuf_dump_to_sqlite()` | O(N + E) |

---

## 六、性能优化技术

### 6.1 RAM-first 管道

**原理**: 所有索引操作在内存中完成，最后一次性写入磁盘

**优势**:
- 避免频繁 I/O 操作
- 内存释放后不占用资源
- LZ4 压缩减少内存占用

**实现**:
```c
// 1. 使用 arena allocator 批量分配内存
CBMArena arena;
cbm_arena_init(&arena);

// 2. 所有节点和边分配到 arena
CBMDefinition def;
def.name = cbm_arena_strdup(&arena, "processData");

// 3. 索引完成后一次性 dump
cbm_gbuf_dump_to_sqlite(gbuf, db_path);

// 4. 释放 arena（所有内存一次性释放）
cbm_arena_destroy(&arena);
```

### 6.2 并行提取

**原理**: 使用线程池并行提取多个文件

**实现**:
```c
cbm_parallel_extract(ctx, files, file_count, cache, &shared_ids, worker_count)
  ├─→ 创建 worker_count 个线程
  ├─→ 每个线程:
  │    ├─→ 获取线程局部 TSParse（避免锁）
  │    ├─→ 处理分配给自己的文件
  │    ├─→ 调用 cbm_extract_file()
  │    └─→ 将结果写入 cache[i]
  └─→ 等待所有线程完成
```

**优化点**:
- 每个线程独立的 `TSParser`（tree-sitter 不是线程安全的）
- 使用原子变量 `shared_ids` 分配唯一节点 ID
- 使用 LZ4 HC 压缩源码（减少内存带宽占用）

### 6.3 增量索引

**原理**: 只重新索引修改过的文件

**实现**:
```c
try_incremental_or_delete_db(p, files, file_count)
  ├─→ 读取旧数据库的 file_hashes 表
  ├─→ 计算每个文件的当前 mtime_ns 和 size
  ├─→ 比较:
  │    ├─→ 如果文件内容未变: 跳过
  │    ├─→ 如果文件被删除: 从图缓冲区删除节点和边
  │    └─→ 如果文件被修改: 重新提取
  └─→ 只处理变化的文件
```

### 6.4 LZ4 压缩

**原理**: 在内存中存储源码时使用 LZ4 HC 压缩

**优势**:
- 减少内存占用（典型压缩比 2:1）
- 减少内存带宽占用
- 解压速度快（~5 GB/s）

**实现**:
```c
// 压缩源码
char *compressed = cbm_lz4_compress(source, source_len, &compressed_len);

// 解压源码（传递给 tree-sitter 前）
char *decompressed = cbm_lz4_decompress(compressed, compressed_len, source_len);
```

### 6.5 MinHash 相似度

**原理**: 使用 MinHash 算法快速计算代码相似度

**优势**:
- 时间复杂度 O(k)（k=128，远小于集合大小）
- 近似 Jaccard 相似度
- 支持批量计算

**实现**:
```c
// 计算 MinHash 签名
cbm_minhash_compute(func_node, source, language, &result)
  ├─→ 提取函数体标识符令牌
  ├─→ 计算 k 个哈希函数的最小值
  └─→ 返回 MinHash 签名（uint32_t[k]）

// 比较相似度
similarity = cbm_minhash_similarity(fp1, fp2, k)
  └─→ 计数匹配的哈希值 / k
```

---

## 七、与 Sarosis Agents Client 的集成建议

### 7.1 集成架构

```
┌─────────────────────────────────────────────────────────────────────┐
│            Sarosis Agents Client (前端工作区)                       │
│  - Agent Studio (多 Agent 编排)                                 │
│  - Skill System (技能管理)                                      │
│  - Memory Framework (记忆管理)                                    │
│  - Chat Interface (用户交互)                                      │
└────────────────────┬──────────────────────────────────────────────┘
                     │ MCP Protocol
┌────────────────────▼──────────────────────────────────────────────┐
│         Codebase-Memory-MCP (代码智能后端)                        │
│  - 知识图谱构建                                                  │
│  - 14 个 MCP 工具                                               │
│  - Hybrid LSP 语义解析                                           │
│  - 调用链/影响分析                                               │
└───────────────────────────────────────────────────────────────────┘
```

### 7.2 集成步骤

#### 步骤 1：添加 MCP Server 配置

在 Sarosis 工作区中添加 `codebase-memory-mcp` 作为 MCP Server：

```json
// .sarosworkspace/mcp.json
{
  "mcpServers": {
    "codebase-memory": {
      "command": "G:/CustomWorkspaces/AIProjects/codebase-memory-mcp/build/c/codebase-memory-mcp.exe",
      "args": []
    }
  }
}
```

#### 步骤 2：自动索引工作区

在 Agent 启动时自动索引当前工作区：

```typescript
// agentChatService.ts
async function onAgentStart(agentId: string) {
    const workspacePath = this.workspaceService.getCurrentWorkspacePath();
    
    // 调用 index_repository 工具
    await this.mcpToolCaller.callTool('codebase-memory', 'index_repository', {
        repo_path: workspacePath
    });
    
    console.log(`Indexed workspace: ${workspacePath}`);
}
```

#### 步骤 3：增强代码查询

在 Agent 推理前，自动调用 `search_graph` 获取相关代码上下文：

```typescript
// agentChatService.ts
async function enhancePrompt(userQuery: string) {
    // 1. 从用户查询中提取关键实体名
    const entities = extractEntities(userQuery);
    
    // 2. 调用 search_graph 获取相关代码
    const graphContext = await this.mcpToolCaller.callTool('codebase-memory', 'search_graph', {
        name_pattern: `.*${entities.join('|')}.*`,
        limit: 10
    });
    
    // 3. 将图谱上下文注入到系统提示
    const enhancedPrompt = `
# Code Graph Context
${graphContext.results.map(r => `- ${r.label}: ${r.qualified_name} (${r.file_path})`).join('\n')}

# User Query
${userQuery}
`;
    
    return enhancedPrompt;
}
```

#### 步骤 4：实现调用链可视化

添加调用链可视化面板：

```typescript
// views/callChainView.ts
class CallChainView extends ViewPane {
    async showCallChain(functionName: string) {
        // 调用 trace_path 工具
        const result = await this.mcpToolCaller.callTool('codebase-memory', 'trace_path', {
            function_name: functionName,
            direction: 'both',
            depth: 5
        });
        
        // 渲染调用链图（使用 D3.js 或 Cytoscape.js）
        this.renderCallGraph(result.visited, result.edges);
    }
}
```

### 7.3 优化建议

#### 建议 1：缓存 MCP 工具结果

**问题**: 每次调用 MCP 工具都有进程间通信开销

**解决方案**: 在 Sarosis 中添加 MCP 工具结果缓存

```typescript
class CachedMCPToolCaller {
    private cache: Map<string, any> = new Map();
    
    async callTool(server: string, tool: string, args: any) {
        const cacheKey = `${server}:${tool}:${JSON.stringify(args)}`;
        
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }
        
        const result = await this.mcpCaller.callTool(server, tool, args);
        this.cache.set(cacheKey, result);
        return result;
    }
}
```

#### 建议 2：预加载常用查询

**问题**: Agent 启动时首次查询慢

**解决方案**: 预加载常用查询（如项目架构概览）

```typescript
async function preloadCommonQueries() {
    await this.mcpToolCaller.callTool('codebase-memory', 'get_architecture', {
        project: this.currentProject
    });
}
```

#### 建议 3：实现智能工具选择

**问题**: Agent 不知道何时使用代码图谱工具

**解决方案**: 添加工具选择提示

```typescript
const TOOL_SELECTION_PROMPT = `
When the user asks about code, ALWAYS use the codebase-memory tools first:
- Use search_graph to find relevant functions/classes
- Use trace_path to understand call chains
- Use get_architecture to understand project structure

Only read files directly if the tools don't return enough information.
`;
```

---

## 八、总结

### 8.1 核心优势

| 优势 | 说明 |
|------|------|
| **极致性能** | Linux 内核索引 3 分钟，查询 <1ms |
| **零依赖** | 单个静态二进制文件，支持 3 大平台 |
| **158 种语言** | 使用 tree-sitter 语法分析 |
| **Hybrid LSP** | 9 种语言的语义类型解析 |
| **增量索引** | 只重新索引修改过的文件 |
| **团队共享** | 支持压缩快照，新成员无需全量重新索引 |

### 8.2 技术亮点

1. **RAM-first 管道设计**: 内存中完成所有索引，最后一次性 dump
2. **Arena Allocator**: 批量内存分配，减少 malloc/free 开销
3. **MinHash 相似度**: 快速计算代码相似度
4. **LZ4 压缩**: 减少内存占用
5. **并行提取**: 使用线程池加速
6. **跨文件 LSP**: 类型感知的调用解析

### 8.3 与 Sarosis 集成的收益

| 收益 | 说明 |
|------|------|
| **性能提升** | 代码查询从 LLM 推理改为图查询，速度提升 100x |
| **成本降低** | Token 消耗降低 120x |
| **能力增强** | 获得企业级代码分析能力（调用链、影响分析、死代码检测） |
| **用户体验** | Agent 可以即时回答代码结构相关问题 |

---

## 九、附录：关键代码结构

### 9.1 目录结构

```
codebase-memory-mcp/
├── src/
│   ├── main.c                    # 入口（MCP server + CLI）
│   ├── mcp/                     # MCP 协议实现（14 个工具）
│   ├── pipeline/                 # 索引管道（多阶段）
│   │   ├── pipeline.c           # 管道编排器
│   │   ├── pass_definitions.c  # 定义提取
│   │   ├── pass_calls.c       # 调用解析
│   │   ├── pass_usages.c      # 使用关系
│   │   ├── pass_semantic.c    # 语义边缘
│   │   ├── pass_similarity.c  # 相似度计算
│   │   └── ...
│   ├── store/                   # SQLite 图存储
│   ├── graph_buffer/            # 内存图缓冲区
│   ├── cypher/                 # Cypher 查询引擎
│   ├── discover/               # 文件发现
│   ├── watcher/                # 后台自动同步
│   └── foundation/             # 基础库（arena、hash table、string utils）
├── internal/cbm/               # Tree-sitter 提取引擎
│   ├── cbm.c                 # 主提取器
│   ├── extract_defs.c         # 定义提取
│   ├── extract_calls.c       # 调用提取
│   ├── extract_imports.c     # 导入提取
│   ├── lsp/                 # Hybrid LSP 实现
│   │   ├── go_lsp.c
│   │   ├── py_lsp.c
│   │   ├── ts_lsp.c
│   │   └── ...
│   └── lang_specs.c         # 158 种语言配置
├── vendored/                   # 第三方库（sqlite3、yyjson、mimalloc）
└── graph-ui/                  # 图可视化 UI（React + Three.js）
```

### 9.2 关键文件说明

| 文件 | 说明 |
|------|------|
| `src/pipeline/pipeline.c` | 索引管道主编排器 |
| `src/pipeline/pass_definitions.c` | 定义提取阶段 |
| `src/pipeline/pass_calls.c` | 调用解析阶段 |
| `internal/cbm/cbm.c` | Tree-sitter AST 提取核心 |
| `internal/cbm/extract_defs.c` | 定义提取实现 |
| `internal/cbm/extract_calls.c` | 调用提取实现 |
| `src/graph_buffer/graph_buffer.c` | 内存图缓冲区 |
| `src/store/store.c` | SQLite 图存储 |
| `src/mcp/mcp.c` | MCP 协议实现（14 个工具） |
| `internal/cbm/lsp/go_lsp.c` | Go 语言 Hybrid LSP |

---

**文档结束**

> 本文档深入分析了 `codebase-memory-mcp` 的知识图谱构建原理，包括数据模型、索引管道、核心函数调用图、性能优化技术等。希望对您的项目优化提供参考价值。
