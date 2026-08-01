# 商城服务端版本管理补丁清单

> 日期：2026-07-31 ｜ 来源：`doc/marketplace-version-management-design.md` §5
> 适用仓库：VsSaros 商城服务端（Node + Express + SQLite，独立仓库，本清单供其落地）
> 客户端侧已全部就绪：版本递增强制预检、版本下架入口、指定版本安装均已在客户端实现（见设计文档 §4）。

---

## P2-1（必做）发布版本号强制递增

**位置**：`POST /api/v1/packages/:id/versions`（处理 raw 上传与 multipart 两个入口都要加）

**现状**：仅 `UNIQUE(package_id, version)` 约束，允许回退版本号发布（如 latest=1.2.0 时传 1.0.5 成功）。

**改为**：
```js
// 伪代码：发布前校验
const latest = getLatestVersion(packageId);   // 忽略 is_latest 标记，直接取 versions 表 semver 最大者
if (latest && semver.lte(newVersion, latest) && req.query.force !== '1') {
  return res.status(409).json({
    error: `新版本号必须大于当前最新版本 v${latest}（管理员可用 ?force=1 覆盖）`
  });
}
```

要点：
- 比较用 semver 数值比较（`1.10.0 > 1.9.0`），不要字符串比较。
- `?force=1` 仅管理员可用（校验 admin token），用于修复错误发布。
- 与 UNIQUE 约束形成双保险：同号 409、回退号 409。

---

## P2-2（必做）删除版本后 latest 重算

**位置**：`DELETE /api/v1/packages/:id/versions/:version`

**现状**：删除 `is_latest=1` 的版本后，`packages.latest_version` 悬空（指向已删除版本或残留）。

**改为（事务内）**：
```sql
BEGIN;
DELETE FROM package_versions WHERE package_id = ? AND version = ?;
-- 重算：剩余版本中 semver 最大者置 is_latest=1，同步 packages 表
UPDATE package_versions SET is_latest = 0 WHERE package_id = ?;
UPDATE package_versions SET is_latest = 1
 WHERE package_id = ? AND version = (
   SELECT version FROM package_versions
    WHERE package_id = ?
    ORDER BY
      CAST(split_part(version, '.', 1) AS INTEGER) DESC,
      CAST(split_part(version, '.', 2) AS INTEGER) DESC,
      CAST(split_part(version, '.', 3) AS INTEGER) DESC
    LIMIT 1
 );
UPDATE packages SET latest_version = (
   SELECT version FROM package_versions WHERE package_id = ? AND is_latest = 1
 ) WHERE id = ?;
COMMIT;
```

要点：
- SQLite 无 `split_part`，用应用层 semver 排序后在事务里更新更稳妥（Express 层做）。
- 删除最后一个版本：包保留，`latest_version = NULL`，列表页显示"暂无版本"（**不要**级联删包，保留元数据与下载统计）。
- 响应体返回新的 `latest_version`，便于客户端刷新。

---

## P2-3（建议）单版本详情接口

**现状**：客户端只能 `GET /packages/:slug` 拉全量 versions 再筛选。

**新增**：
```
GET /api/v1/packages/:slug/versions/:version
→ 200 {
    "id": 102, "version": "1.1.0", "changelog": "...",
    "sha256": "...", "size": 12480, "isLatest": true,
    "manifest": {...}, "createdAt": 1753785600000
  }
→ 404 { "error": "版本不存在" }
```

用途：版本视图单条刷新、下载前展示确认信息。优先级低于 P2-1/P2-2。

---

## P3（可选）yank 软下架

- `package_versions` 加列 `yanked INTEGER DEFAULT 0`。
- `POST /packages/:id/versions/:version/yank`（作者）：置 `yanked=1`。
- 语义：yanked 版本仍可被**指定版本号**下载（`GET .../versions/:version/download` 放行），但不参与 `upgrade/check` 与 latest 计算；列表接口默认过滤，加 `?includeYanked=1` 可见。
- 对标 npm unpublish 政策：已发布 72h 外的版本建议只允许 yank 不允许 DELETE。

---

## 验收用例（Postman 可跑）

| # | 操作 | 期望 |
|---|------|------|
| 1 | latest=1.2.0 时 POST 版本 1.2.0 | 409 版本已存在 |
| 2 | latest=1.2.0 时 POST 版本 1.1.0 | 409 必须大于最新版本 |
| 3 | latest=1.2.0 时 POST 版本 1.10.0（注意非字符串比较） | 200，is_latest 移到 1.10.0 |
| 4 | DELETE is_latest=1 的版本 | 200，latest 回退到次新版本，响应含新 latest_version |
| 5 | DELETE 唯一剩余版本 | 200，latest_version=null，包元数据保留 |
| 6 | GET /packages/:slug/versions/9.9.9 | 404 版本不存在 |

---

## 客户端配套（已落地，无需服务端配合）

- `publishVersioning.ts`：发布前格式/查重/递增预检（服务端校验是兜底，防旧客户端/脚本绕过）。
- `MarketplaceVersionsPanel`：商城版本列表 + 安装指定版本 + 下架按钮（调 `DELETE /versions/:version`）。
- 发布锚点：发布成功本地 git 打 `v{version}` tag。
