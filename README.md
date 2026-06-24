# CarbonTrack Pro - 企业碳排放管理系统

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![React](https://img.shields.io/badge/react-18.2.0-blue)
![Material-UI](https://img.shields.io/badge/MUI-5.14.0-blue)

CarbonTrack Pro 是一个符合 ISO 14064 和 GB/T 32150 标准的碳排放管理系统，帮助企业轻松追踪、管理和报告其碳排放数据。

## 🌟 核心功能

### 1. 碳排放数据录入
- ✅ 手动录入界面，支持范围一、二、三排放源
- ✅ 批量导入功能（CSV/Excel）
- ✅ 自动计算排放量（活动量 × 排放因子）
- ✅ 数据验证和异常检测

### 2. 数据管理与可视化
- ✅ 交互式仪表盘，实时显示排放趋势
- ✅ 多维度分析（时间、部门、排放范围）
- ✅ 高级过滤和搜索功能
- ✅ 数据导出（PDF、Excel、CSV）

### 3. 报告生成
- ✅ 自动生成符合标准的碳排放报告
- ✅ 支持年度、月度、季度报告
- ✅ 图表可视化（柱状图、饼图、趋势图）
- ✅ 自定义报告模板

### 4. 系统管理
- ✅ 排放因子库管理
- ✅ 用户权限管理
- ✅ 数据备份与恢复
- ✅ 系统配置

## 🚀 快速开始

### 环境要求
- Node.js 16.0 或更高版本
- npm 8.0 或更高版本

### 安装步骤

1. 克隆项目
```bash
git clone https://github.com/your-org/carbon-track-pro.git
cd carbon-track-pro
```

2. 安装依赖
```bash
npm install
```

3. 启动开发服务器
```bash
npm start
```

应用将在 [http://localhost:3000](http://localhost:3000) 启动

### 生产构建

```bash
npm run build
```

构建产物将生成在 `build` 文件夹中

## 📊 使用指南

### 登录系统

使用以下演示账号登录：
- 用户名: `admin`
- 密码: 任意密码

### 数据录入

1. 导航到"数据录入"页面
2. 选择排放范围（范围一/二/三）
3. 选择排放源类型
4. 输入活动量
5. 系统自动计算排放量
6. 点击"保存记录"

### 批量导入

1. 在数据录入页面，点击"批量导入"
2. 下载 CSV 模板
3. 按照模板格式填写数据
4. 上传填好的 CSV 文件
5. 确认并导入

### 生成报告

1. 导航到"报告生成"页面
2. 选择报告类型（年度/月度/季度）
3. 选择年份
4. 点击"导出 PDF"或"导出 Excel"
5. 报告将自动下载

## 🏗️ 项目结构

```
carbon-track-pro/
├── public/
│   ├── index.html              # HTML 模板
│   └── favicon.ico            # 网站图标
├── src/
│   ├── components/             # React 组件
│   │   └── Layout.js          # 主布局组件
│   ├── context/                # Context API
│   │   ├── AuthContext.js     # 认证上下文
│   │   └── EmissionContext.js # 排放数据上下文
│   ├── pages/                  # 页面组件
│   │   ├── Dashboard.js       # 驾驶舱页面
│   │   ├── EmissionEntry.js   # 数据录入页面
│   │   ├── DataManagement.js  # 数据管理页面
│   │   ├── Reports.js         # 报告生成页面
│   │   ├── Settings.js        # 系统设置页面
│   │   └── Login.js           # 登录页面
│   ├── App.js                  # 主应用组件
│   ├── index.js                # 应用入口
│   ├── index.css               # 全局样式
│   └── reportWebVitals.js     # 性能监控
├── package.json                # 项目依赖
└── README.md                  # 项目说明
```

## 🔧 技术栈

### 前端框架
- **React 18.2.0** - UI 框架
- **React Router 6.14.0** - 路由管理
- **Material-UI 5.14.0** - UI 组件库

### 数据可视化
- **Recharts 2.10.3** - 图表库

### 文件导出
- **jsPDF 2.5.1** - PDF 生成
- **SheetJS (xlsx) 0.18.5** - Excel 导出

### 其他工具
- **Axios 1.5.0** - HTTP 客户端
- **date-fns 2.30.0** - 日期处理
- **React Scripts 5.0.1** - 构建工具

## 📝 数据模型

### 排放记录
```javascript
{
  id: "emission-123456",
  date: "2024-01-15",
  category: "scope2",           // scope1 | scope2 | scope3
  activityType: "electricity",
  activityAmount: 1000,         // 活动量
  emissionFactor: 0.5703,      // 排放因子
  emissionAmount: 570.3,        // 排放量 (kg CO2eq)
  unit: "kWh",
  department: "生产部",
  notes: "1月份用电量",
  status: "verified",           // draft | verified
  createdAt: "2024-01-15T08:00:00Z",
  updatedAt: "2024-01-15T10:00:00Z"
}
```

### 排放因子
```javascript
{
  electricity: {
    name: "外购电力",
    factor: 0.5703,           // kg CO2/kWh
    unit: "kWh",
    source: "GB/T 32150-2015",
    category: "scope2"
  }
}
```

## 🎯 路线图

### 已完成 ✅
- [x] 核心数据录入功能
- [x] 数据可视化仪表盘
- [x] 报告生成（PDF/Excel）
- [x] 用户认证系统
- [x] 排放因子管理

### 进行中 🚧
- [ ] 高级数据验证规则
- [ ] 实时协作功能
- [ ] 移动端适配

### 计划中 📋
- [ ] 与 ERP 系统对接
- [ ] 碳足迹计算器
- [ ] 多语言支持（英文、日文）
- [ ] 云部署版本
- [ ] AI 辅助数据分析

## 🤝 贡献指南

我们欢迎任何形式的贡献！

1. Fork 项目
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

## 📄 许可证

本项目采用 MIT 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情

## 🙏 致谢

- ISO 14064 标准文档
- GB/T 32150 标准文档
- IPCC 2006 排放因子数据库
- Material-UI 团队
- Recharts 团队

## 📧 联系方式

- 项目主页：[https://github.com/your-org/carbon-track-pro](https://github.com/your-org/carbon-track-pro)
- 问题反馈：[https://github.com/your-org/carbon-track-pro/issues](https://github.com/your-org/carbon-track-pro/issues)
- 邮箱：support@carbontrackpro.com

---

**Made with ❤️ for a sustainable future**
