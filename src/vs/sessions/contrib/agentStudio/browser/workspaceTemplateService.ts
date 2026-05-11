// ------------------------------------------------------------------------------------------------
// workspaceTemplateService.ts - Workspace Template 服务实现
// ------------------------------------------------------------------------------------------------
//
// Phase 4.2: Workspace Template 工作区模板
// 功能关联: F2.2 (Agent 实例化), F3.3 (快照/回滚)
//
// 作用: 允许用户保存/加载工作区状态（文件、布局、环境变量、运行上下文），
//       实现"模板化启动"，支持快速恢复到特定工作状态。
//
// 实现说明:
// - 当前为 MVP 基础框架版本
// - 文件操作使用简化实现（实际应调用 VS Code FileSystem API）
// - 布局捕获使用简化实现（实际应调用 EditorGroupsService）
// - 终端状态捕获使用简化实现（实际应调用 TerminalService）
// - 后续需完善为生产级实现

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkspaceTemplateService, ITemplateMetadata, ITemplateContent, ITemplateFile, TemplateType, TemplateScope, CaptureContentType, ApplyStrategy, ITemplateSnapshot, IApplyTemplateOptions, ICaptureTemplateOptions, ITemplateExport, DEFAULT_CAPTURE_OPTIONS } from '../common/workspaceTemplate.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { VSBuffer } from '../../../../base/common/buffer.js';

// ------------------------------------------------------------------------------------------------
// 服务实现
// ------------------------------------------------------------------------------------------------

export class WorkspaceTemplateService extends Disposable implements IWorkspaceTemplateService {
  readonly _serviceBrand: undefined;

  // ------------------------------------------------------------------------------------------------
  // 事件
  // ------------------------------------------------------------------------------------------------

  private readonly _onDidCreateTemplate = new Emitter<ITemplateMetadata>();
  readonly onDidCreateTemplate: Event<ITemplateMetadata> = this._onDidCreateTemplate.event;

  private readonly _onDidUpdateTemplate = new Emitter<ITemplateMetadata>();
  readonly onDidUpdateTemplate: Event<ITemplateMetadata> = this._onDidUpdateTemplate.event;

  private readonly _onDidDeleteTemplate = new Emitter<string>();
  readonly onDidDeleteTemplate: Event<string> = this._onDidDeleteTemplate.event;

  private readonly _onDidStartApply = new Emitter<{ templateId: string; targetWorkspace: URI }>();
  readonly onDidStartApply: Event<{ templateId: string; targetWorkspace: URI }> = this._onDidStartApply.event;

  private readonly _onDidCompleteApply = new Emitter<{ templateId: string; success: boolean; error?: string }>();
  readonly onDidCompleteApply: Event<{ templateId: string; success: boolean; error?: string }> = this._onDidCompleteApply.event;

  private readonly _onDidCompleteCapture = new Emitter<{ templateId: string; snapshotId?: string }>();
  readonly onDidCompleteCapture: Event<{ templateId: string; snapshotId?: string }> = this._onDidCompleteCapture.event;

  // ------------------------------------------------------------------------------------------------
  // 内部状态
  // ------------------------------------------------------------------------------------------------

  /** 模板存储 */
  private readonly _templates = new Map<string, ITemplateMetadata>();
  private readonly _templateContents = new Map<string, ITemplateContent>();
  private readonly _snapshots = new Map<string, ITemplateSnapshot>();

  /** 存储键 */
  private static readonly STORAGE_KEY_TEMPLATES = 'agentStudio.workspaceTemplate.templates';
  private static readonly STORAGE_KEY_TEMPLATE_CONTENTS = 'agentStudio.workspaceTemplate.templateContents';
  private static readonly STORAGE_KEY_SNAPSHOTS = 'agentStudio.workspaceTemplate.snapshots';

  /** 服务引用 */
  private readonly _logService: ILogService;
  private _fileService?: IFileService;
  private _workspaceService?: IWorkspaceContextService;
  private _storageService?: IStorageService;
  
  /** 防抖保存定时器 */
  private _saveTimer: any = null;
  private readonly SAVE_DEBOUNCE_DELAY = 5000; // 5秒防抖

  // ------------------------------------------------------------------------------------------------
  // 构造/销毁
  // ------------------------------------------------------------------------------------------------

  constructor(
    @ILogService logService: ILogService,
    @IInstantiationService _instantiationService: IInstantiationService,
    @IStorageService storage: IStorageService,
  ) {
    super();
    
    this._logService = logService;
    this._storageService = storage;
    
    // 从持久化存储加载数据
    this._loadFromStorage();
    
    this._logService.info('[WorkspaceTemplate] Service initialized');
  }

  override dispose(): void {
    this._templates.clear();
    this._templateContents.clear();
    this._snapshots.clear();
    super.dispose();
  }

  // ------------------------------------------------------------------------------------------------
  // 模板生命周期
  // ------------------------------------------------------------------------------------------------

  async createTemplate(
    name: string,
    description: string,
    type: TemplateType,
    options?: ICaptureTemplateOptions
  ): Promise<ITemplateMetadata> {
    try {
      this._logService.info(`[WorkspaceTemplate] Creating template: ${name}`);

      const templateId = this._generateId();
      const now = Date.now();

      const metadata: ITemplateMetadata = {
        id: templateId,
        name,
        description,
        type,
        scope: TemplateScope.Private,
        author: 'current-user', // TODO: 获取当前用户
        tags: [],
        version: '1.0.0',
        createdAt: now,
        updatedAt: now,
        applyCount: 0,
        rating: 0,
        size: 0,
        isOfficial: false,
      };

      // 捕获当前工作区内容
      const content = await this.captureCurrentWorkspace(options);

      // 保存
      this._templates.set(templateId, metadata);
      this._templateContents.set(templateId, content);

      // 更新大小
      metadata.size = this._calculateContentSize(content);
      this._templates.set(templateId, metadata);

      this._onDidCreateTemplate.fire(metadata);
      this._logService.info(`[WorkspaceTemplate] Template created: ${templateId}`);

      // 防抖保存
      this._scheduleSave();

      return metadata;
    } catch (error) {
      this._logService.error('[WorkspaceTemplate] Failed to create template:', error);
      throw error;
    }
  }

  async applyTemplate(templateId: string, options: IApplyTemplateOptions): Promise<boolean> {
    try {
      this._logService.info(`[WorkspaceTemplate] Applying template: ${templateId}`);

      this._onDidStartApply.fire({ templateId, targetWorkspace: options.targetWorkspace });

      const metadata = this._templates.get(templateId);
      if (!metadata) {
        throw new Error(`Template not found: ${templateId}`);
      }

      const content = this._templateContents.get(templateId);
      if (!content) {
        throw new Error(`Template content not found: ${templateId}`);
      }

      // TODO: 应用模板内容到目标工作区
      await this._applyContent(content, options);

      // 更新应用次数
      metadata.applyCount++;
      this._templates.set(templateId, metadata);

      this._onDidCompleteApply.fire({ templateId, success: true });
      this._logService.info(`[WorkspaceTemplate] Template applied: ${templateId}`);

      return true;
    } catch (error) {
      this._logService.error('[WorkspaceTemplate] Failed to apply template:', error);
      this._onDidCompleteApply.fire({ templateId, success: false, error: String(error) });
      return false;
    }
  }

  async updateTemplate(templateId: string, updates: Partial<ITemplateMetadata>): Promise<ITemplateMetadata> {
    try {
      this._logService.info(`[WorkspaceTemplate] Updating template: ${templateId}`);

      const metadata = this._templates.get(templateId);
      if (!metadata) {
        throw new Error(`Template not found: ${templateId}`);
      }

      // 更新字段
      Object.assign(metadata, updates, { updatedAt: Date.now() });

      this._templates.set(templateId, metadata);
      this._onDidUpdateTemplate.fire(metadata);

      this._logService.info(`[WorkspaceTemplate] Template updated: ${templateId}`);
      
      // 防抖保存
      this._scheduleSave();
      
      return metadata;
    } catch (error) {
      this._logService.error('[WorkspaceTemplate] Failed to update template:', error);
      throw error;
    }
  }

  async deleteTemplate(templateId: string): Promise<boolean> {
    try {
      this._logService.info(`[WorkspaceTemplate] Deleting template: ${templateId}`);

      const result = this._templates.delete(templateId);
      this._templateContents.delete(templateId);

      // 删除关联的快照
      for (const [snapshotId, snapshot] of this._snapshots) {
        if (snapshot.templateId === templateId) {
          this._snapshots.delete(snapshotId);
        }
      }

      if (result) {
        this._onDidDeleteTemplate.fire(templateId);
        this._logService.info(`[WorkspaceTemplate] Template deleted: ${templateId}`);
        
        // 防抖保存
        this._scheduleSave();
      }

      return result;
    } catch (error) {
      this._logService.error('[WorkspaceTemplate] Failed to delete template:', error);
      return false;
    }
  }

  async getTemplate(templateId: string): Promise<ITemplateMetadata | undefined> {
    return this._templates.get(templateId);
  }

  async listTemplates(filter?: {
    type?: TemplateType;
    scope?: TemplateScope;
    author?: string;
    tags?: string[];
    search?: string;
  }): Promise<ITemplateMetadata[]> {
    let templates = Array.from(this._templates.values());

    if (filter) {
      if (filter.type) {
        templates = templates.filter(t => t.type === filter.type);
      }
      if (filter.scope) {
        templates = templates.filter(t => t.scope === filter.scope);
      }
      if (filter.author) {
        templates = templates.filter(t => t.author === filter.author);
      }
      if (filter.tags && filter.tags.length > 0) {
        templates = templates.filter(t => filter.tags!.some(tag => t.tags.includes(tag)));
      }
      if (filter.search) {
        const searchLower = filter.search.toLowerCase();
        templates = templates.filter(t =>
          t.name.toLowerCase().includes(searchLower) ||
          t.description.toLowerCase().includes(searchLower)
        );
      }
    }

    return templates;
  }

  // ------------------------------------------------------------------------------------------------
  // 快照管理
  // ------------------------------------------------------------------------------------------------

  async createSnapshot(
    templateId: string,
    name: string,
    description?: string,
    options?: ICaptureTemplateOptions
  ): Promise<ITemplateSnapshot> {
    try {
      this._logService.info(`[WorkspaceTemplate] Creating snapshot for template: ${templateId}`);

      const snapshotId = this._generateId();
      const now = Date.now();

      const content = await this.captureCurrentWorkspace(options);

      const snapshot: ITemplateSnapshot = {
        id: snapshotId,
        templateId,
        name,
        description,
        createdAt: now,
        content,
        size: this._calculateContentSize(content),
        tags: [],
      };

      this._snapshots.set(snapshotId, snapshot);

      this._onDidCompleteCapture.fire({ templateId, snapshotId });
      this._logService.info(`[WorkspaceTemplate] Snapshot created: ${snapshotId}`);

      // 防抖保存
      this._scheduleSave();

      return snapshot;
    } catch (error) {
      this._logService.error('[WorkspaceTemplate] Failed to create snapshot:', error);
      throw error;
    }
  }

  async restoreSnapshot(snapshotId: string, targetWorkspace: URI): Promise<boolean> {
    try {
      this._logService.info(`[WorkspaceTemplate] Restoring snapshot: ${snapshotId}`);

      const snapshot = this._snapshots.get(snapshotId);
      if (!snapshot) {
        throw new Error(`Snapshot not found: ${snapshotId}`);
      }

      const options: IApplyTemplateOptions = {
        targetWorkspace,
        strategy: ApplyStrategy.Overwrite,
        contentTypes: Object.values(CaptureContentType),
        applyEnvironment: true,
        restoreTerminal: true,
        restoreLayout: true,
      };

      await this._applyContent(snapshot.content, options);

      this._logService.info(`[WorkspaceTemplate] Snapshot restored: ${snapshotId}`);
      return true;
    } catch (error) {
      this._logService.error('[WorkspaceTemplate] Failed to restore snapshot:', error);
      return false;
    }
  }

  async deleteSnapshot(snapshotId: string): Promise<boolean> {
    this._logService.info(`[WorkspaceTemplate] Deleting snapshot: ${snapshotId}`);
    return this._snapshots.delete(snapshotId);
  }

  async listSnapshots(templateId: string): Promise<ITemplateSnapshot[]> {
    return Array.from(this._snapshots.values()).filter(s => s.templateId === templateId);
  }

  // ------------------------------------------------------------------------------------------------
  // 模板内容管理
  // ------------------------------------------------------------------------------------------------

  async getTemplateContent(templateId: string): Promise<ITemplateContent | undefined> {
    return this._templateContents.get(templateId);
  }

  async updateTemplateContent(templateId: string, content: ITemplateContent): Promise<boolean> {
    try {
      this._logService.info(`[WorkspaceTemplate] Updating content for template: ${templateId}`);

      this._templateContents.set(templateId, content);

      // 更新大小
      const metadata = this._templates.get(templateId);
      if (metadata) {
        metadata.size = this._calculateContentSize(content);
        metadata.updatedAt = Date.now();
        this._templates.set(templateId, metadata);
      }

      // 防抖保存
      this._scheduleSave();

      return true;
    } catch (error) {
      this._logService.error('[WorkspaceTemplate] Failed to update template content:', error);
      return false;
    }
  }

  async captureCurrentWorkspace(options?: ICaptureTemplateOptions): Promise<ITemplateContent> {
    try {
      this._logService.info('[WorkspaceTemplate] Capturing current workspace');

      const captureOptions = options || DEFAULT_CAPTURE_OPTIONS;
      const content: ITemplateContent = {
        files: [],
        environment: {},
        extensions: [],
      };

      // 捕获文件
      if (captureOptions.contentTypes.includes(CaptureContentType.Files)) {
        content.files = await this._captureFiles(captureOptions);
      }

      // 捕获布局
      if (captureOptions.contentTypes.includes(CaptureContentType.Layout)) {
        content.layout = await this._captureLayout();
      }

      // 捕获环境变量
      if (captureOptions.contentTypes.includes(CaptureContentType.Environment)) {
        content.environment = await this._captureEnvironment();
      }

      // 捕获终端状态
      if (captureOptions.contentTypes.includes(CaptureContentType.Terminal)) {
        content.terminalState = await this._captureTerminalState(captureOptions);
      }

      // 捕获调试状态
      if (captureOptions.contentTypes.includes(CaptureContentType.Debug)) {
        content.debugConfig = await this._captureDebugConfig();
      }

      // 捕获Git状态
      if (captureOptions.contentTypes.includes(CaptureContentType.Git)) {
        content.gitState = await this._captureGitState();
      }

      // 捕获扩展状态
      if (captureOptions.contentTypes.includes(CaptureContentType.Extensions)) {
        content.extensions = await this._captureExtensions();
      }

      this._logService.info('[WorkspaceTemplate] Workspace captured successfully');
      return content;
    } catch (error) {
      this._logService.error('[WorkspaceTemplate] Failed to capture workspace:', error);
      throw error;
    }
  }

  // ------------------------------------------------------------------------------------------------
  // 模板分享
  // ------------------------------------------------------------------------------------------------

  async exportTemplate(templateId: string): Promise<ITemplateExport> {
    try {
      this._logService.info(`[WorkspaceTemplate] Exporting template: ${templateId}`);

      const metadata = this._templates.get(templateId);
      if (!metadata) {
        throw new Error(`Template not found: ${templateId}`);
      }

      const content = this._templateContents.get(templateId);
      if (!content) {
        throw new Error(`Template content not found: ${templateId}`);
      }

      const templateExport: ITemplateExport = {
        formatVersion: '1.0.0',
        metadata,
        content,
        exportedAt: Date.now(),
        exportedBy: 'current-user', // TODO: 获取当前用户
        checksum: this._calculateChecksum(content),
      };

      this._logService.info(`[WorkspaceTemplate] Template exported: ${templateId}`);
      return templateExport;
    } catch (error) {
      this._logService.error('[WorkspaceTemplate] Failed to export template:', error);
      throw error;
    }
  }

  async importTemplate(templateExport: ITemplateExport): Promise<ITemplateMetadata> {
    try {
      this._logService.info(`[WorkspaceTemplate] Importing template: ${templateExport.metadata.name}`);

      // 验证校验和
      const expectedChecksum = this._calculateChecksum(templateExport.content);
      if (expectedChecksum !== templateExport.checksum) {
        throw new Error('Checksum mismatch: template may be corrupted');
      }

      const templateId = this._generateId();
      const now = Date.now();

      const metadata: ITemplateMetadata = {
        ...templateExport.metadata,
        id: templateId,
        createdAt: now,
        updatedAt: now,
        applyCount: 0,
      };

      this._templates.set(templateId, metadata);
      this._templateContents.set(templateId, templateExport.content);

      this._onDidCreateTemplate.fire(metadata);
      this._logService.info(`[WorkspaceTemplate] Template imported: ${templateId}`);

      // 防抖保存
      this._scheduleSave();

      return metadata;
    } catch (error) {
      this._logService.error('[WorkspaceTemplate] Failed to import template:', error);
      throw error;
    }
  }

  async shareTemplate(templateId: string, scope: TemplateScope): Promise<string> {
    try {
      this._logService.info(`[WorkspaceTemplate] Sharing template: ${templateId} with scope: ${scope}`);

      const metadata = this._templates.get(templateId);
      if (!metadata) {
        throw new Error(`Template not found: ${templateId}`);
      }

      // 更新范围
      metadata.scope = scope;
      this._templates.set(templateId, metadata);

      // TODO: 生成分享URL
      const shareUrl = `https://openclaw.app/templates/${templateId}`;

      this._logService.info(`[WorkspaceTemplate] Template shared: ${shareUrl}`);
      return shareUrl;
    } catch (error) {
      this._logService.error('[WorkspaceTemplate] Failed to share template:', error);
      throw error;
    }
  }

  // ------------------------------------------------------------------------------------------------
  // 模板版本管理
  // ------------------------------------------------------------------------------------------------

  async getTemplateDiff(templateId: string, snapshotId1?: string, snapshotId2?: string): Promise<any> {
    // TODO: 实现模板差异比较
    this._logService.info(`[WorkspaceTemplate] Getting diff for template: ${templateId}`);
    return {
      templateId,
      diffType: 'modified',
      files: [],
      stats: { added: 0, modified: 0, deleted: 0 },
    };
  }

  async rollbackToSnapshot(snapshotId: string, targetWorkspace: URI): Promise<boolean> {
    return this.restoreSnapshot(snapshotId, targetWorkspace);
  }

  // ------------------------------------------------------------------------------------------------
  // 工具方法
  // ------------------------------------------------------------------------------------------------

  async validateTemplate(templateId: string): Promise<{ valid: boolean; errors: string[] }> {
    try {
      const metadata = this._templates.get(templateId);
      if (!metadata) {
        return { valid: false, errors: ['Template not found'] };
      }

      const content = this._templateContents.get(templateId);
      if (!content) {
        return { valid: false, errors: ['Template content not found'] };
      }

      // TODO: 实现更详细的验证
      const errors: string[] = [];

      if (!metadata.name) {
        errors.push('Template name is required');
      }

      if (content.files.length === 0) {
        errors.push('Template contains no files');
      }

      return { valid: errors.length === 0, errors };
    } catch (error) {
      return { valid: false, errors: [String(error)] };
    }
  }

  async searchTemplates(query: string): Promise<ITemplateMetadata[]> {
    return this.listTemplates({ search: query });
  }

  async getRecommendedTemplates(workspaceType?: string): Promise<ITemplateMetadata[]> {
    // TODO: 实现推荐逻辑
    return this.listTemplates({ scope: TemplateScope.Public });
  }

  // ------------------------------------------------------------------------------------------------
  // 持久化存储
  // ------------------------------------------------------------------------------------------------

  private _loadFromStorage(): void {
    if (!this._storageService) {
      return;
    }
    
    try {
      // 加载模板元数据
      const templatesJson = this._storageService.get(
        WorkspaceTemplateService.STORAGE_KEY_TEMPLATES,
        StorageScope.WORKSPACE,
        '[]'
      );
      const templatesData: Array<[string, ITemplateMetadata]> = JSON.parse(templatesJson);
      this._templates.clear();
      for (const [key, value] of templatesData) {
        this._templates.set(key, value);
      }
      this._logService.info(`[WorkspaceTemplate] Loaded ${this._templates.size} templates from storage`);
      
      // 加载模板内容
      const contentsJson = this._storageService.get(
        WorkspaceTemplateService.STORAGE_KEY_TEMPLATE_CONTENTS,
        StorageScope.WORKSPACE,
        '[]'
      );
      const contentsData: Array<[string, ITemplateContent]> = JSON.parse(contentsJson);
      this._templateContents.clear();
      for (const [key, value] of contentsData) {
        this._templateContents.set(key, value);
      }
      this._logService.info(`[WorkspaceTemplate] Loaded ${this._templateContents.size} template contents from storage`);
      
      // 加载快照
      const snapshotsJson = this._storageService.get(
        WorkspaceTemplateService.STORAGE_KEY_SNAPSHOTS,
        StorageScope.WORKSPACE,
        '[]'
      );
      const snapshotsData: Array<[string, ITemplateSnapshot]> = JSON.parse(snapshotsJson);
      this._snapshots.clear();
      for (const [key, value] of snapshotsData) {
        this._snapshots.set(key, value);
      }
      this._logService.info(`[WorkspaceTemplate] Loaded ${this._snapshots.size} snapshots from storage`);
    } catch (error) {
      this._logService.error('[WorkspaceTemplate] Failed to load from storage:', error);
    }
  }

  private _saveToStorage(): void {
    if (!this._storageService) {
      return;
    }
    
    try {
      // 保存模板元数据
      const templatesArray = Array.from(this._templates.entries());
      this._storageService.store(
        WorkspaceTemplateService.STORAGE_KEY_TEMPLATES,
        JSON.stringify(templatesArray),
        StorageScope.WORKSPACE,
        StorageTarget.MACHINE
      );
      
      // 保存模板内容
      const contentsArray = Array.from(this._templateContents.entries());
      this._storageService.store(
        WorkspaceTemplateService.STORAGE_KEY_TEMPLATE_CONTENTS,
        JSON.stringify(contentsArray),
        StorageScope.WORKSPACE,
        StorageTarget.MACHINE
      );
      
      // 保存快照
      const snapshotsArray = Array.from(this._snapshots.entries());
      this._storageService.store(
        WorkspaceTemplateService.STORAGE_KEY_SNAPSHOTS,
        JSON.stringify(snapshotsArray),
        StorageScope.WORKSPACE,
        StorageTarget.MACHINE
      );
      
      this._logService.debug('[WorkspaceTemplate] Saved to storage');
    } catch (error) {
      this._logService.error('[WorkspaceTemplate] Failed to save to storage:', error);
    }
  }

  /**
   * 防抖保存 - 避免在频繁更新时反复写入存储
   */
  private _scheduleSave(): void {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
    }
    
    this._saveTimer = setTimeout(() => {
      this._saveToStorage();
      this._saveTimer = null;
    }, this.SAVE_DEBOUNCE_DELAY);
  }

  // ------------------------------------------------------------------------------------------------
  // 私有辅助方法
  // ------------------------------------------------------------------------------------------------

  private _generateId(): string {
    return `template_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  private _calculateContentSize(content: ITemplateContent): number {
    let size = 0;
    for (const file of content.files) {
      size += file.content.length;
    }
    return size;
  }

  private _calculateChecksum(content: ITemplateContent): string {
    // TODO: 实现真正的校验和计算 (e.g., SHA-256)
    return `${Date.now()}`;
  }

	private async _captureFiles(options: ICaptureTemplateOptions): Promise<ITemplateFile[]> {
		this._logService.info('[WorkspaceTemplate] Capturing files...');
		
		if (!this._fileService || !this._workspaceService) {
			this._logService.warn('[WorkspaceTemplate] FileService or WorkspaceService not available');
			return [];
		}
		
		const files: ITemplateFile[] = [];
		const workspace = this._workspaceService.getWorkspace();
		
		if (!workspace || !workspace.folders.length) {
			this._logService.warn('[WorkspaceTemplate] No workspace folders found');
			return [];
		}
		
		// 从每个工作区文件夹捕获文件
		for (const folder of workspace.folders) {
			await this._captureFolder(folder.uri, folder.uri, files, options);
		}
		
		this._logService.info(`[WorkspaceTemplate] Captured ${files.length} files`);
		return files;
	}
	
	private async _captureFolder(baseUri: URI, currentUri: URI, files: ITemplateFile[], options: ICaptureTemplateOptions): Promise<void> {
		try {
			// 读取目录内容
			if (!this._fileService) {
				return;
			}
			const stat = await this._fileService.resolve(currentUri);
			
			if (!stat.children) {
				return;
			}
			
			for (const child of stat.children) {
				const name = child.name;
				const isDirectory = !child.isFile;
				
				// 检查是否应该排除
				if (this._shouldExclude(name, options)) {
					continue;
				}
				
				const childUri = currentUri.with({ path: currentUri.path + '/' + name });
				
				if (child.isFile) { // 文件
					await this._captureFile(baseUri, childUri, files);
				} else if (isDirectory) { // 目录
					// 添加目录条目
					files.push({
						path: this._getRelativePath(baseUri, childUri),
						content: '',
						type: 'directory',
					});
					
					// 递归捕获子目录
					await this._captureFolder(baseUri, childUri, files, options);
				}
			}
		} catch (error) {
			this._logService.error(`[WorkspaceTemplate] Failed to capture folder: ${currentUri.toString()}`, error);
		}
	}
	
	private async _captureFile(baseUri: URI, fileUri: URI, files: ITemplateFile[]): Promise<void> {
		try {
			if (!this._fileService) {
				return;
			}
			const content = await this._fileService.readFile(fileUri);
			files.push({
				path: this._getRelativePath(baseUri, fileUri),
				content: content.value.toString(),
				type: 'file',
			});
		} catch (error) {
			this._logService.error(`[WorkspaceTemplate] Failed to capture file: ${fileUri.toString()}`, error);
		}
	}
	
	private _getRelativePath(baseUri: URI, targetUri: URI): string {
		const basePath = baseUri.path;
		const targetPath = targetUri.path;
		
		if (targetPath.startsWith(basePath)) {
			return targetPath.substring(basePath.length + 1); // +1 for the trailing slash
		}
		
		return targetPath;
	}
	
	private _shouldExclude(name: string, options: ICaptureTemplateOptions): boolean {
		// 默认排除列表
		const defaultExcludes = ['node_modules', '.git', '.DS_Store', 'dist', 'out', 'build'];
		
		if (defaultExcludes.includes(name)) {
			return true;
		}
		
		// 检查自定义排除列表
		if (options.excludePatterns) {
			if (options.excludePatterns.includes(name)) {
				return true;
			}
		}
		
		return false;
	}

  private async _captureLayout(): Promise<any> {
    // TODO: 实现布局捕获逻辑
    // 应使用 IEditorGroupsService 获取编辑器布局
    this._logService.info('[WorkspaceTemplate] Capturing layout...');
    return undefined;
  }

  private async _captureEnvironment(): Promise<Record<string, string>> {
    // TODO: 实现环境变量捕获
    this._logService.info('[WorkspaceTemplate] Capturing environment...');
    return {};
  }

  private async _captureTerminalState(options: ICaptureTemplateOptions): Promise<any> {
    // TODO: 实现终端状态捕获
    // 应使用 ITerminalService 获取终端状态
    this._logService.info('[WorkspaceTemplate] Capturing terminal state...');
    return undefined;
  }

  private async _captureDebugConfig(): Promise<any> {
    // TODO: 实现调试配置捕获
    this._logService.info('[WorkspaceTemplate] Capturing debug config...');
    return undefined;
  }

  private async _captureGitState(): Promise<any> {
    // TODO: 实现 Git 状态捕获
    this._logService.info('[WorkspaceTemplate] Capturing git state...');
    return undefined;
  }

  private async _captureExtensions(): Promise<string[]> {
    // TODO: 实现扩展捕获
    this._logService.info('[WorkspaceTemplate] Capturing extensions...');
    return [];
  }

  private async _applyContent(content: ITemplateContent, options: IApplyTemplateOptions): Promise<void> {
    // TODO: 实现内容应用逻辑
    this._logService.info(`[WorkspaceTemplate] Applying content with strategy: ${options.strategy}`);
    
    // 应用文件
    if (options.contentTypes.includes(CaptureContentType.Files)) {
      await this._applyFiles(content.files, options);
    }

    // 应用布局
    if (options.restoreLayout && content.layout) {
      await this._applyLayout(content.layout);
    }

    // 应用环境变量
    if (options.applyEnvironment && content.environment) {
      await this._applyEnvironment(content.environment);
    }

    // 恢复终端状态
    if (options.restoreTerminal && content.terminalState) {
      await this._applyTerminalState(content.terminalState);
    }
  }

	private async _applyFiles(files: ITemplateFile[], options: IApplyTemplateOptions): Promise<void> {
		this._logService.info(`[WorkspaceTemplate] Applying ${files.length} files...`);
		
		if (!this._fileService || !this._workspaceService) {
			this._logService.warn('[WorkspaceTemplate] FileService or WorkspaceService not available');
			return;
		}
		
		const workspace = this._workspaceService.getWorkspace();
		if (!workspace || !workspace.folders.length) {
			this._logService.warn('[WorkspaceTemplate] No workspace folders found');
			return;
		}
		
		// 使用第一个工作区文件夹作为目标
		const targetFolder = workspace.folders[0].uri;
		
		for (const file of files) {
			try {
				const fileUri = targetFolder.with({ path: targetFolder.path + '/' + file.path });
				
				if (file.type === 'directory') {
					// 创建目录
					await this._fileService.createFolder(fileUri);
				} else {
					// 检查文件是否存在
					const exists = await this._fileService.exists(fileUri);
					
					if (exists && options.strategy === ApplyStrategy.Skip) {
						this._logService.info(`[WorkspaceTemplate] Skipping existing file: ${file.path}`);
						continue;
					}
					
					if (exists && options.strategy === ApplyStrategy.Prompt) {
						// TODO: 提示用户
						this._logService.info(`[WorkspaceTemplate] Prompting user for file: ${file.path}`);
					}
					
					// 写入文件内容
					await this._fileService.writeFile(fileUri, VSBuffer.wrap(new TextEncoder().encode(file.content)));
				}
			} catch (error) {
				this._logService.error(`[WorkspaceTemplate] Failed to apply file: ${file.path}`, error);
			}
		}
		
		this._logService.info(`[WorkspaceTemplate] Applied ${files.length} files successfully`);
	}

  private async _applyLayout(layout: any): Promise<void> {
    // TODO: 实现布局应用逻辑
    this._logService.info('[WorkspaceTemplate] Applying layout...');
  }

  private async _applyEnvironment(environment: Record<string, string>): Promise<void> {
    // TODO: 实现环境变量应用逻辑
    this._logService.info('[WorkspaceTemplate] Applying environment...');
  }

  private async _applyTerminalState(terminalState: any): Promise<void> {
    // TODO: 实现终端状态恢复逻辑
    this._logService.info('[WorkspaceTemplate] Applying terminal state...');
  }
}

// ------------------------------------------------------------------------------------------------
// 注册为单例
// ------------------------------------------------------------------------------------------------

import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
registerSingleton(IWorkspaceTemplateService, new SyncDescriptor(WorkspaceTemplateService));

