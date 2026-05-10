// ------------------------------------------------------------------------------------------------
// workspaceTemplate.ts - Workspace Template 接口定义
// ------------------------------------------------------------------------------------------------
//
// Phase 4.2: Workspace Template 工作区模板
// 功能关联: F2.2 (Agent 实例化), F3.3 (快照/回滚)
// 
// 作用: 允许用户保存/加载工作区状态（文件、布局、环境变量、运行上下文），
//       实现"模板化启动"，支持快速恢复到特定工作状态。
//
// 核心能力:
// 1. Template 生命周期 (create, apply, update, delete, list)
// 2. 快照捕获 (capture - 文件、布局、环境变量、终端状态)
// 3. 模板应用 (apply - 恢复文件、布局、启动终端、恢复变量)
// 4. 模板版本管理 (versioning, diff)
// 5. 模板分享 (export/import)

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';

// ------------------------------------------------------------------------------------------------
// 枚举和常量
// ------------------------------------------------------------------------------------------------

/** 模板类型 */
export enum TemplateType {
  /** 空白模板 - 仅包含基础结构 */
  Blank = 'blank',
  /** 项目模板 - 包含完整项目结构 */
  Project = 'project',
  /** 任务模板 - 针对特定任务优化 */
  Task = 'task',
  /** 快照模板 - 完整工作区快照 */
  Snapshot = 'snapshot',
  /** 自定义模板 */
  Custom = 'custom',
}

/** 模板范围 */
export enum TemplateScope {
  /** 个人模板 - 仅当前用户可见 */
  Private = 'private',
  /** 团队模板 - 团队内共享 */
  Team = 'team',
  /** 公开模板 - 所有人可见 */
  Public = 'public',
}

/** 捕获内容类型 */
export enum CaptureContentType {
  /** 文件内容 */
  Files = 'files',
  /** 编辑器布局 */
  Layout = 'layout',
  /** 环境变量 */
  Environment = 'environment',
  /** 终端状态 */
  Terminal = 'terminal',
  /** 调试状态 */
  Debug = 'debug',
  /** Git 状态 */
  Git = 'git',
  /** 扩展状态 */
  Extensions = 'extensions',
}

/** 应用策略 */
export enum ApplyStrategy {
  /** 合并 - 保留现有内容，合并模板内容 */
  Merge = 'merge',
  /** 覆盖 - 完全使用模板内容，删除现有内容 */
  Overwrite = 'overwrite',
  /** 跳过 - 如果目标存在则跳过 */
  Skip = 'skip',
  /** 提示 - 冲突时提示用户 */
  Prompt = 'prompt',
}

// ------------------------------------------------------------------------------------------------
// 核心接口
// ------------------------------------------------------------------------------------------------

/** 模板元数据 */
export interface ITemplateMetadata {
  /** 模板ID */
  id: string;
  /** 模板名称 */
  name: string;
  /** 模板描述 */
  description: string;
  /** 模板类型 */
  type: TemplateType;
  /** 模板范围 */
  scope: TemplateScope;
  /** 作者 */
  author: string;
  /** 标签 */
  tags: string[];
  /** 版本号 */
  version: string;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
  /** 应用次数 */
  applyCount: number;
  /** 评分 (1-5) */
  rating: number;
  /** 模板大小 (bytes) */
  size: number;
  /** 预览图URI */
  previewURI?: URI;
  /** 是否官方模板 */
  isOfficial: boolean;
}

/** 模板内容 */
export interface ITemplateContent {
  /** 文件列表 */
  files: ITemplateFile[];
  /** 编辑器布局 */
  layout?: IEditorLayout;
  /** 环境变量 */
  environment: Record<string, string>;
  /** 终端状态 */
  terminalState?: ITerminalState;
  /** 调试配置 */
  debugConfig?: any;
  /** Git 状态 */
  gitState?: IGitState;
  /** 扩展列表 */
  extensions: string[];
  /** 自定义数据 */
  customData?: Record<string, any>;
}

/** 模板文件 */
export interface ITemplateFile {
  /** 文件路径 (相对路径) */
  path: string;
  /** 文件内容 */
  content: string;
  /** 文件类型 */
  type: 'file' | 'directory';
  /** 是否可执行 */
  executable?: boolean;
  /** 文件权限 */
  permissions?: number;
}

/** 编辑器布局 */
export interface IEditorLayout {
  /** 活动编辑器组 */
  activeGroup: number;
  /** 编辑器组列表 */
  groups: IEditorGroup[];
  /** 编辑器视图状态 */
  viewState?: any;
}

/** 编辑器组 */
export interface IEditorGroup {
  /** 组ID */
  id: number;
  /** 打开的编辑器列表 */
  editors: IEditorInput[];
  /** 布局权重 */
  weight: number;
}

/** 编辑器输入 */
export interface IEditorInput {
  /** 资源URI */
  resource: string;
  /** 编辑器类型 */
  type: string;
  /** 视图状态 */
  viewState?: any;
}

/** 终端状态 */
export interface ITerminalState {
  /** 终端实例列表 */
  terminals: ITerminalInstance[];
  /** 活动终端ID */
  activeTerminalId?: string;
}

/** 终端实例 */
export interface ITerminalInstance {
  /** 终端ID */
  id: string;
  /** 终端名称 */
  name: string;
  /** 当前工作目录 */
  cwd: string;
  /** 环境变量 */
  env: Record<string, string>;
  /** 命令历史 */
  history: string[];
  /** 是否活动 */
  isActive: boolean;
}

/** Git 状态 */
export interface IGitState {
  /** 当前分支 */
  branch: string;
  /** 远程URL */
  remoteUrl?: string;
  /** 暂存文件列表 */
  stagedFiles: string[];
  /** 未暂存文件列表 */
  unstagedFiles: string[];
  /** 未跟踪文件列表 */
  untrackedFiles: string[];
  /** 最近提交 */
  lastCommit?: string;
}

/** 模板快照 */
export interface ITemplateSnapshot {
  /** 快照ID */
  id: string;
  /** 模板ID */
  templateId: string;
  /** 快照名称 */
  name: string;
  /** 快照描述 */
  description?: string;
  /** 创建时间 */
  createdAt: number;
  /** 快照内容 */
  content: ITemplateContent;
  /** 快照大小 */
  size: number;
  /** 快照标签 */
  tags: string[];
}

/** 模板应用选项 */
export interface IApplyTemplateOptions {
  /** 目标工作区URI */
  targetWorkspace: URI;
  /** 应用策略 */
  strategy: ApplyStrategy;
  /** 要应用的内容类型 */
  contentTypes: CaptureContentType[];
  /** 是否应用环境变量 */
  applyEnvironment: boolean;
  /** 是否恢复终端状态 */
  restoreTerminal: boolean;
  /** 是否恢复编辑器布局 */
  restoreLayout: boolean;
  /** 变量替换映射 */
  variables?: Record<string, string>;
  /** 超时时间 (ms) */
  timeoutMs?: number;
}

/** 模板捕获选项 */
export interface ICaptureTemplateOptions {
  /** 要捕获的内容类型 */
  contentTypes: CaptureContentType[];
  /** 要排除的文件/目录 (glob模式) */
  excludePatterns?: string[];
  /** 要包含的文件/目录 (glob模式) */
  includePatterns?: string[];
  /** 是否包含Git忽略的文件 */
  includeGitIgnored: boolean;
  /** 最大文件大小 (bytes) */
  maxFileSize?: number;
  /** 是否捕获终端历史 */
  captureTerminalHistory: boolean;
}

/** 模板导出格式 */
export interface ITemplateExport {
  /** 格式版本 */
  formatVersion: string;
  /** 模板元数据 */
  metadata: ITemplateMetadata;
  /** 模板内容 */
  content: ITemplateContent;
  /** 导出时间 */
  exportedAt: number;
  /** 导出者 */
  exportedBy: string;
  /** 校验和 */
  checksum: string;
}

/** 模板差异 */
export interface ITemplateDiff {
  /** 模板ID */
  templateId: string;
  /** 差异类型 */
  diffType: 'added' | 'modified' | 'deleted';
  /** 差异文件列表 */
  files: ITemplateFileDiff[];
  /** 差异统计 */
  stats: {
    added: number;
    modified: number;
    deleted: number;
  };
}

/** 模板文件差异 */
export interface ITemplateFileDiff {
  /** 文件路径 */
  path: string;
  /** 差异类型 */
  type: 'added' | 'modified' | 'deleted';
  /** 旧内容 */
  oldContent?: string;
  /** 新内容 */
  newContent?: string;
  /** 是否二进制文件 */
  isBinary: boolean;
}

// ------------------------------------------------------------------------------------------------
// 服务接口
// ------------------------------------------------------------------------------------------------

/** Workspace Template Service 接口 */
export interface IWorkspaceTemplateService {
  /** 服务标识 */
  readonly _serviceBrand: undefined;

  // ------------------------------------------------------------------------------------------------
  // 事件
  // ------------------------------------------------------------------------------------------------
  
  /** 模板创建事件 */
  readonly onDidCreateTemplate: Event<ITemplateMetadata>;
  
  /** 模板更新事件 */
  readonly onDidUpdateTemplate: Event<ITemplateMetadata>;
  
  /** 模板删除事件 */
  readonly onDidDeleteTemplate: Event<string>;
  
  /** 模板应用开始事件 */
  readonly onDidStartApply: Event<{ templateId: string; targetWorkspace: URI }>;
  
  /** 模板应用完成事件 */
  readonly onDidCompleteApply: Event<{ templateId: string; success: boolean; error?: string }>;
  
  /** 模板捕获完成事件 */
  readonly onDidCompleteCapture: Event<{ templateId: string; snapshotId?: string }>;

  // ------------------------------------------------------------------------------------------------
  // 模板生命周期
  // ------------------------------------------------------------------------------------------------

  /**
   * 创建模板
   * @param name 模板名称
   * @param description 模板描述
   * @param type 模板类型
   * @param options 捕获选项
   * @returns 模板元数据
   */
  createTemplate(
    name: string,
    description: string,
    type: TemplateType,
    options?: ICaptureTemplateOptions
  ): Promise<ITemplateMetadata>;

  /**
   * 应用模板
   * @param templateId 模板ID
   * @param options 应用选项
   * @returns 是否成功
   */
  applyTemplate(templateId: string, options: IApplyTemplateOptions): Promise<boolean>;

  /**
   * 更新模板
   * @param templateId 模板ID
   * @param updates 要更新的字段
   * @returns 更新后的模板元数据
   */
  updateTemplate(templateId: string, updates: Partial<ITemplateMetadata>): Promise<ITemplateMetadata>;

  /**
   * 删除模板
   * @param templateId 模板ID
   * @returns 是否成功
   */
  deleteTemplate(templateId: string): Promise<boolean>;

  /**
   * 获取模板
   * @param templateId 模板ID
   * @returns 模板元数据
   */
  getTemplate(templateId: string): Promise<ITemplateMetadata | undefined>;

  /**
   * 列出模板
   * @param filter 过滤条件
   * @returns 模板列表
   */
  listTemplates(filter?: {
    type?: TemplateType;
    scope?: TemplateScope;
    author?: string;
    tags?: string[];
    search?: string;
  }): Promise<ITemplateMetadata[]>;

  // ------------------------------------------------------------------------------------------------
  // 快照管理
  // ------------------------------------------------------------------------------------------------

  /**
   * 创建快照
   * @param templateId 模板ID
   * @param name 快照名称
   * @param description 快照描述
   * @param options 捕获选项
   * @returns 快照
   */
  createSnapshot(
    templateId: string,
    name: string,
    description?: string,
    options?: ICaptureTemplateOptions
  ): Promise<ITemplateSnapshot>;

  /**
   * 恢复快照
   * @param snapshotId 快照ID
   * @param targetWorkspace 目标工作区
   * @returns 是否成功
   */
  restoreSnapshot(snapshotId: string, targetWorkspace: URI): Promise<boolean>;

  /**
   * 删除快照
   * @param snapshotId 快照ID
   * @returns 是否成功
   */
  deleteSnapshot(snapshotId: string): Promise<boolean>;

  /**
   * 列出快照
   * @param templateId 模板ID
   * @returns 快照列表
   */
  listSnapshots(templateId: string): Promise<ITemplateSnapshot[]>;

  // ------------------------------------------------------------------------------------------------
  // 模板内容管理
  // ------------------------------------------------------------------------------------------------

  /**
   * 获取模板内容
   * @param templateId 模板ID
   * @returns 模板内容
   */
  getTemplateContent(templateId: string): Promise<ITemplateContent | undefined>;

  /**
   * 更新模板内容
   * @param templateId 模板ID
   * @param content 新内容
   * @returns 是否成功
   */
  updateTemplateContent(templateId: string, content: ITemplateContent): Promise<boolean>;

  /**
   * 捕获当前工作区
   * @param options 捕获选项
   * @returns 模板内容
   */
  captureCurrentWorkspace(options?: ICaptureTemplateOptions): Promise<ITemplateContent>;

  // ------------------------------------------------------------------------------------------------
  // 模板分享
  // ------------------------------------------------------------------------------------------------

  /**
   * 导出模板
   * @param templateId 模板ID
   * @returns 导出数据
   */
  exportTemplate(templateId: string): Promise<ITemplateExport>;

  /**
   * 导入模板
   * @param templateExport 导出数据
   * @returns 导入的模板元数据
   */
  importTemplate(templateExport: ITemplateExport): Promise<ITemplateMetadata>;

  /**
   * 分享模板
   * @param templateId 模板ID
   * @param scope 分享范围
   * @returns 分享URL
   */
  shareTemplate(templateId: string, scope: TemplateScope): Promise<string>;

  // ------------------------------------------------------------------------------------------------
  // 模板版本管理
  // ------------------------------------------------------------------------------------------------

  /**
   * 获取模板差异
   * @param templateId 模板ID
   * @param snapshotId1 快照1 ID (可选，默认为当前版本)
   * @param snapshotId2 快照2 ID (可选，默认为当前版本)
   * @returns 差异
   */
  getTemplateDiff(templateId: string, snapshotId1?: string, snapshotId2?: string): Promise<ITemplateDiff>;

  /**
   * 回滚到指定快照
   * @param snapshotId 快照ID
   * @param targetWorkspace 目标工作区
   * @returns 是否成功
   */
  rollbackToSnapshot(snapshotId: string, targetWorkspace: URI): Promise<boolean>;

  // ------------------------------------------------------------------------------------------------
  // 工具方法
  // ------------------------------------------------------------------------------------------------

  /**
   * 验证模板
   * @param templateId 模板ID
   * @returns 是否有效
   */
  validateTemplate(templateId: string): Promise<{ valid: boolean; errors: string[] }>;

  /**
   * 搜索模板
   * @param query 搜索查询
   * @returns 模板列表
   */
  searchTemplates(query: string): Promise<ITemplateMetadata[]>;

  /**
   * 获取推荐模板
   * @param workspaceType 工作区类型
   * @returns 推荐模板列表
   */
  getRecommendedTemplates(workspaceType?: string): Promise<ITemplateMetadata[]>;
}

// ------------------------------------------------------------------------------------------------
// 装饰器标识符 (用于依赖注入)
// ------------------------------------------------------------------------------------------------

export const IWorkspaceTemplateService = createDecorator<IWorkspaceTemplateService>('workspaceTemplateService');

// ------------------------------------------------------------------------------------------------
// 常量
// ------------------------------------------------------------------------------------------------

/** 服务标识 */
export const WORKSPACE_TEMPLATE_SERVICE_ID = 'workspaceTemplateService';

/** 默认捕获选项 */
export const DEFAULT_CAPTURE_OPTIONS: ICaptureTemplateOptions = {
  contentTypes: [
    CaptureContentType.Files,
    CaptureContentType.Layout,
    CaptureContentType.Environment,
    CaptureContentType.Terminal,
  ],
  excludePatterns: [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/out/**',
    '**/*.log',
  ],
  includeGitIgnored: false,
  maxFileSize: 10 * 1024 * 1024, // 10MB
  captureTerminalHistory: true,
};

/** 默认应用选项 */
export const DEFAULT_APPLY_OPTIONS: IApplyTemplateOptions = {
  targetWorkspace: URI.file(''),
  strategy: ApplyStrategy.Merge,
  contentTypes: [
    CaptureContentType.Files,
    CaptureContentType.Layout,
    CaptureContentType.Environment,
  ],
  applyEnvironment: true,
  restoreTerminal: false,
  restoreLayout: true,
};
