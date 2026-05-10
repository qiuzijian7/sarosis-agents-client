// ------------------------------------------------------------------------------------------------
// crewTeamService.ts - Crew/Team 编排服务实现
// ------------------------------------------------------------------------------------------------
//
// Phase 4.5: Crew/Team 编排
// 功能关联: F1.2 (Crew 创建), F1.3 (多 Agent 协作)
//
// 作用: 支持创建和管理 Crew (团队)，实现多个 Agent 之间的协作编排，
//       包括角色分配、任务分配、通信机制、工作流编排等。
//
// 实现说明:
// - 当前为 MVP 基础框架版本
// - 任务执行使用简化实现（实际应调用 AgentDriverService）
// - 工作流编排使用简化实现（实际应实现完整的工作流引擎）
// - 通信机制使用简化实现（实际应实现消息队列）
// - 后续需完善为生产级实现

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ICrewTeamService, ICrew, ICrewMember, ITask, IWorkflow, IWorkflowStep, IMessage, ICrewReport, ICrewConfig, CrewType, AgentRole, TaskStatus, TaskPriority, CommunicationType, DEFAULT_CREW_CONFIG } from '../common/crewTeam.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IAgentDriverService } from '../common/agentDriver.js';

// ------------------------------------------------------------------------------------------------
// 服务实现
// ------------------------------------------------------------------------------------------------

export class CrewTeamService extends Disposable implements ICrewTeamService {
  readonly _serviceBrand: undefined;

  // ------------------------------------------------------------------------------------------------
  // 事件
  // ------------------------------------------------------------------------------------------------

  private readonly _onDidCreateCrew = new Emitter<ICrew>();
  readonly onDidCreateCrew: Event<ICrew> = this._onDidCreateCrew.event;

  private readonly _onDidUpdateCrew = new Emitter<ICrew>();
  readonly onDidUpdateCrew: Event<ICrew> = this._onDidUpdateCrew.event;

  private readonly _onDidDeleteCrew = new Emitter<string>();
  readonly onDidDeleteCrew: Event<string> = this._onDidDeleteCrew.event;

  private readonly _onDidJoinCrew = new Emitter<{ crewId: string; member: ICrewMember }>();
  readonly onDidJoinCrew: Event<{ crewId: string; member: ICrewMember }> = this._onDidJoinCrew.event;

  private readonly _onDidLeaveCrew = new Emitter<{ crewId: string; agentId: string }>();
  readonly onDidLeaveCrew: Event<{ crewId: string; agentId: string }> = this._onDidLeaveCrew.event;

  private readonly _onDidCreateTask = new Emitter<ITask>();
  readonly onDidCreateTask: Event<ITask> = this._onDidCreateTask.event;

  private readonly _onDidUpdateTask = new Emitter<ITask>();
  readonly onDidUpdateTask: Event<ITask> = this._onDidUpdateTask.event;

  private readonly _onDidCompleteTask = new Emitter<ITask>();
  readonly onDidCompleteTask: Event<ITask> = this._onDidCompleteTask.event;

  private readonly _onDidReceiveMessage = new Emitter<IMessage>();
  readonly onDidReceiveMessage: Event<IMessage> = this._onDidReceiveMessage.event;

  private readonly _onDidStartWorkflow = new Emitter<{ crewId: string; workflowId: string }>();
  readonly onDidStartWorkflow: Event<{ crewId: string; workflowId: string }> = this._onDidStartWorkflow.event;

  private readonly _onDidCompleteWorkflow = new Emitter<{ crewId: string; workflowId: string; success: boolean }>();
  readonly onDidCompleteWorkflow: Event<{ crewId: string; workflowId: string; success: boolean }> = this._onDidCompleteWorkflow.event;

	// ------------------------------------------------------------------------------------------------
	// 内部状态
	// ------------------------------------------------------------------------------------------------
	
  /** Crew 存储 */
  private readonly _crews = new Map<string, ICrew>();
  private readonly _tasks = new Map<string, ITask>();
  private readonly _workflows = new Map<string, IWorkflow>();
  private readonly _messages = new Map<string, IMessage[]>();

  /** 存储键 */
  private static readonly STORAGE_KEY_CREWS = 'agentStudio.crewTeam.crews';
  private static readonly STORAGE_KEY_TASKS = 'agentStudio.crewTeam.tasks';
  private static readonly STORAGE_KEY_WORKFLOWS = 'agentStudio.crewTeam.workflows';
  private static readonly STORAGE_KEY_MESSAGES = 'agentStudio.crewTeam.messages';

  /** 服务引用 */
  private _logService: ILogService = console as unknown as ILogService;
  
  /** 防抖保存定时器 */
  private _saveTimer: any = null;
  private readonly SAVE_DEBOUNCE_DELAY = 5000; // 5秒防抖

  // ------------------------------------------------------------------------------------------------
  // 构造/销毁
  // ------------------------------------------------------------------------------------------------

  constructor(
    @IStorageService private readonly _storageService: IStorageService,
    @IAgentDriverService private readonly _driverService: IAgentDriverService,
  ) {
    super();
    
    // 从持久化存储加载数据
    this._loadFromStorage();
    
    this._logService.info('[CrewTeam] Service initialized');
  }

  override dispose(): void {
    this._crews.clear();
    this._tasks.clear();
    this._workflows.clear();
    this._messages.clear();
    super.dispose();
  }

  // ------------------------------------------------------------------------------------------------
  // Crew 生命周期
  // ------------------------------------------------------------------------------------------------

  async createCrew(
    name: string,
    description: string,
    type: CrewType,
    config?: Partial<ICrewConfig>
  ): Promise<ICrew> {
    try {
      this._logService.info(`[CrewTeam] Creating crew: ${name}`);

      const crewId = this._generateId();
      const now = Date.now();

      const crew: ICrew = {
        id: crewId,
        name,
        description,
        type,
        createdAt: now,
        updatedAt: now,
        owner: 'current-user', // TODO: 获取当前用户
        isActive: true,
        members: [],
        tasks: [],
        config: { ...DEFAULT_CREW_CONFIG, ...config },
      };

      this._crews.set(crewId, crew);
      this._messages.set(crewId, []);

      this._onDidCreateCrew.fire(crew);
      this._logService.info(`[CrewTeam] Crew created: ${crewId}`);

      // 防抖保存
      this._scheduleSave();

      return crew;
    } catch (error) {
      this._logService.error('[CrewTeam] Failed to create crew:', error);
      throw error;
    }
  }

  async updateCrew(crewId: string, updates: Partial<ICrew>): Promise<ICrew> {
    try {
      this._logService.info(`[CrewTeam] Updating crew: ${crewId}`);

      const crew = this._crews.get(crewId);
      if (!crew) {
        throw new Error(`Crew not found: ${crewId}`);
      }

      // 更新字段
      Object.assign(crew, updates, { updatedAt: Date.now() });

      this._crews.set(crewId, crew);
      this._onDidUpdateCrew.fire(crew);

      this._logService.info(`[CrewTeam] Crew updated: ${crewId}`);
      
      // 防抖保存
      this._scheduleSave();
      
      return crew;
    } catch (error) {
      this._logService.error('[CrewTeam] Failed to update crew:', error);
      throw error;
    }
  }

  async deleteCrew(crewId: string): Promise<boolean> {
    try {
      this._logService.info(`[CrewTeam] Deleting crew: ${crewId}`);

      const result = this._crews.delete(crewId);
      
      // 删除关联的任务
      for (const [taskId, task] of this._tasks) {
        if (task.assignedTo && this._isMemberOfCrew(task.assignedTo, crewId)) {
          this._tasks.delete(taskId);
        }
      }

      // 删除关联的消息
      this._messages.delete(crewId);

      // 删除关联的工作流
      for (const [workflowId, workflow] of this._workflows) {
        if (workflow.id.includes(crewId)) {
          this._workflows.delete(workflowId);
        }
      }

      if (result) {
        this._onDidDeleteCrew.fire(crewId);
        this._logService.info(`[CrewTeam] Crew deleted: ${crewId}`);
        
        // 防抖保存
        this._scheduleSave();
      }

      return result;
    } catch (error) {
      this._logService.error('[CrewTeam] Failed to delete crew:', error);
      return false;
    }
  }

  async getCrew(crewId: string): Promise<ICrew | undefined> {
    return this._crews.get(crewId);
  }

  async listCrews(filter?: {
    type?: CrewType;
    owner?: string;
    isActive?: boolean;
    search?: string;
  }): Promise<ICrew[]> {
    let crews = Array.from(this._crews.values());

    if (filter) {
      if (filter.type) {
        crews = crews.filter(c => c.type === filter.type);
      }
      if (filter.owner) {
        crews = crews.filter(c => c.owner === filter.owner);
      }
      if (filter.isActive !== undefined) {
        crews = crews.filter(c => c.isActive === filter.isActive);
      }
      if (filter.search) {
        const searchLower = filter.search.toLowerCase();
        crews = crews.filter(c =>
          c.name.toLowerCase().includes(searchLower) ||
          c.description.toLowerCase().includes(searchLower)
        );
      }
    }

    return crews;
  }

  // ------------------------------------------------------------------------------------------------
  // 成员管理
  // ------------------------------------------------------------------------------------------------

  async addMember(crewId: string, agentId: string, role: AgentRole): Promise<boolean> {
    try {
      this._logService.info(`[CrewTeam] Adding member ${agentId} to crew ${crewId}`);

      const crew = this._crews.get(crewId);
      if (!crew) {
        throw new Error(`Crew not found: ${crewId}`);
      }

      // 检查是否已经是成员
      if (crew.members.some(m => m.agentId === agentId)) {
        throw new Error(`Agent ${agentId} is already a member of crew ${crewId}`);
      }

      const member: ICrewMember = {
        agentId,
        agentName: `Agent-${agentId}`, // TODO: 从 Agent 服务获取名称
        role,
        isActive: true,
        joinedAt: Date.now(),
        permissions: this._getDefaultPermissions(role),
      };

      crew.members.push(member);
      crew.updatedAt = Date.now();
      this._crews.set(crewId, crew);

      this._onDidJoinCrew.fire({ crewId, member });
      this._logService.info(`[CrewTeam] Member added: ${agentId}`);

      // 防抖保存
      this._scheduleSave();

      return true;
    } catch (error) {
      this._logService.error('[CrewTeam] Failed to add member:', error);
      return false;
    }
  }

  async removeMember(crewId: string, agentId: string): Promise<boolean> {
    try {
      this._logService.info(`[CrewTeam] Removing member ${agentId} from crew ${crewId}`);

      const crew = this._crews.get(crewId);
      if (!crew) {
        throw new Error(`Crew not found: ${crewId}`);
      }

      const index = crew.members.findIndex(m => m.agentId === agentId);
      if (index === -1) {
        throw new Error(`Agent ${agentId} is not a member of crew ${crewId}`);
      }

      crew.members.splice(index, 1);
      crew.updatedAt = Date.now();
      this._crews.set(crewId, crew);

      this._onDidLeaveCrew.fire({ crewId, agentId });
      this._logService.info(`[CrewTeam] Member removed: ${agentId}`);

      // 防抖保存
      this._scheduleSave();

      return true;
    } catch (error) {
      this._logService.error('[CrewTeam] Failed to remove member:', error);
      return false;
    }
  }

  async updateMemberRole(crewId: string, agentId: string, role: AgentRole): Promise<boolean> {
    try {
      this._logService.info(`[CrewTeam] Updating role for member ${agentId} in crew ${crewId}`);

      const crew = this._crews.get(crewId);
      if (!crew) {
        throw new Error(`Crew not found: ${crewId}`);
      }

      const member = crew.members.find(m => m.agentId === agentId);
      if (!member) {
        throw new Error(`Agent ${agentId} is not a member of crew ${crewId}`);
      }

      member.role = role;
      member.permissions = this._getDefaultPermissions(role);
      crew.updatedAt = Date.now();
      this._crews.set(crewId, crew);

      this._logService.info(`[CrewTeam] Member role updated: ${agentId} -> ${role}`);
      
      // 防抖保存
      this._scheduleSave();
      
      return true;
    } catch (error) {
      this._logService.error('[CrewTeam] Failed to update member role:', error);
      return false;
    }
  }

  async getMembers(crewId: string): Promise<ICrewMember[]> {
    const crew = this._crews.get(crewId);
    return crew ? crew.members : [];
  }

  // ------------------------------------------------------------------------------------------------
  // 任务编排
  // ------------------------------------------------------------------------------------------------

  async createTask(
    crewId: string,
    name: string,
    description: string,
    priority: TaskPriority,
    input: any,
    assignedTo?: string,
    dependencies?: string[]
  ): Promise<ITask> {
    try {
      this._logService.info(`[CrewTeam] Creating task: ${name}`);

      const taskId = this._generateId();
      const now = Date.now();

      const task: ITask = {
        id: taskId,
        name,
        description,
        status: TaskStatus.Pending,
        priority,
        assignedTo,
        createdBy: 'current-user', // TODO: 获取当前用户
        createdAt: now,
        updatedAt: now,
        dependencies: dependencies || [],
        input,
      };

      this._tasks.set(taskId, task);

      // 添加到 Crew
      const crew = this._crews.get(crewId);
      if (crew) {
        crew.tasks.push(task);
        crew.updatedAt = now;
        this._crews.set(crewId, crew);
      }

      this._onDidCreateTask.fire(task);
      this._logService.info(`[CrewTeam] Task created: ${taskId}`);

      // 防抖保存
      this._scheduleSave();

      return task;
    } catch (error) {
      this._logService.error('[CrewTeam] Failed to create task:', error);
      throw error;
    }
  }

  async assignTask(taskId: string, agentId: string): Promise<boolean> {
    try {
      this._logService.info(`[CrewTeam] Assigning task ${taskId} to agent ${agentId}`);

      const task = this._tasks.get(taskId);
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }

      task.assignedTo = agentId;
      task.updatedAt = Date.now();
      this._tasks.set(taskId, task);

      this._onDidUpdateTask.fire(task);
      this._logService.info(`[CrewTeam] Task assigned: ${taskId} -> ${agentId}`);

      // 防抖保存
      this._scheduleSave();

      return true;
    } catch (error) {
      this._logService.error('[CrewTeam] Failed to assign task:', error);
      return false;
    }
  }

	async executeTask(taskId: string): Promise<boolean> {
		try {
			this._logService.info(`[CrewTeam] Executing task: ${taskId}`);
			
			const task = this._tasks.get(taskId);
			if (!task) {
				throw new Error(`Task not found: ${taskId}`);
			}
			
			// 检查依赖
			for (const depId of task.dependencies) {
				const depTask = this._tasks.get(depId);
				if (depTask && depTask.status !== TaskStatus.Completed) {
					throw new Error(`Dependency not completed: ${depId}`);
				}
			}
			
			// 更新状态
			task.status = TaskStatus.InProgress;
			task.startedAt = Date.now();
			task.updatedAt = Date.now();
			this._tasks.set(taskId, task);
			
			// 防抖保存
			this._scheduleSave();
			
			// 实际执行任务 (使用 AgentDriverService)
			if (this._driverService && task.assignedTo) {
				try {
					// 通过 AgentDriver 执行任务
					// 注意: IAgentDriverService 没有 executeTask 方法，使用 executeFromChatOptions
					const result = await this._driverService.executeFromChatOptions(
						task.assignedTo,
						typeof task.input === 'string' ? task.input : JSON.stringify(task.input),
						{}
					);
					
					task.status = TaskStatus.Completed;
					task.completedAt = Date.now();
					task.output = { result };
					task.updatedAt = Date.now();
					this._tasks.set(taskId, task);
					
					this._onDidCompleteTask.fire(task);
					this._logService.info(`[CrewTeam] Task completed: ${taskId}`);
					
					// 防抖保存
					this._scheduleSave();
				} catch (error) {
					task.status = TaskStatus.Failed;
					task.error = String(error);
					task.updatedAt = Date.now();
					this._tasks.set(taskId, task);
					
					// 防抖保存
					this._scheduleSave();
					
					throw error;
				}
			} else {
				// 模拟执行 (简化实现)
				await new Promise(resolve => setTimeout(resolve, 1000));
				
				task.status = TaskStatus.Completed;
				task.completedAt = Date.now();
				task.output = { result: 'Task completed successfully (simulated)' };
				task.updatedAt = Date.now();
				this._tasks.set(taskId, task);
				
				this._onDidCompleteTask.fire(task);
				this._logService.info(`[CrewTeam] Task completed (simulated): ${taskId}`);
			}
			
			return true;
		} catch (error) {
			this._logService.error('[CrewTeam] Failed to execute task:', error);
			
			// 更新任务状态为失败
			const task = this._tasks.get(taskId);
			if (task) {
				task.status = TaskStatus.Failed;
				task.error = String(error);
				task.updatedAt = Date.now();
				this._tasks.set(taskId, task);
			}
			
			return false;
		}
	}

  async cancelTask(taskId: string): Promise<boolean> {
    try {
      this._logService.info(`[CrewTeam] Cancelling task: ${taskId}`);

      const task = this._tasks.get(taskId);
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }

      task.status = TaskStatus.Cancelled;
      task.updatedAt = Date.now();
      this._tasks.set(taskId, task);

      this._onDidUpdateTask.fire(task);
      this._logService.info(`[CrewTeam] Task cancelled: ${taskId}`);

      // 防抖保存
      this._scheduleSave();

      return true;
    } catch (error) {
      this._logService.error('[CrewTeam] Failed to cancel task:', error);
      return false;
    }
  }

  async getTask(taskId: string): Promise<ITask | undefined> {
    return this._tasks.get(taskId);
  }

  async listTasks(crewId: string, filter?: {
    status?: TaskStatus;
    assignedTo?: string;
    priority?: TaskPriority;
  }): Promise<ITask[]> {
    const crew = this._crews.get(crewId);
    if (!crew) {
      return [];
    }

    let tasks = crew.tasks;

    if (filter) {
      if (filter.status) {
        tasks = tasks.filter(t => t.status === filter.status);
      }
      if (filter.assignedTo) {
        tasks = tasks.filter(t => t.assignedTo === filter.assignedTo);
      }
      if (filter.priority) {
        tasks = tasks.filter(t => t.priority === filter.priority);
      }
    }

    return tasks;
  }

  // ------------------------------------------------------------------------------------------------
  // 通信机制
  // ------------------------------------------------------------------------------------------------

  async sendMessage(fromAgentId: string, toAgentId: string, content: string): Promise<IMessage> {
    try {
      this._logService.info(`[CrewTeam] Sending message from ${fromAgentId} to ${toAgentId}`);

      const message: IMessage = {
        id: this._generateId(),
        fromAgentId,
        toAgentId,
        type: CommunicationType.Direct,
        content,
        sentAt: Date.now(),
        isRead: false,
      };

      // 找到消息接收者所在的 Crew
      // TODO: 优化查找逻辑
      for (const [crewId, messages] of this._messages) {
        const crew = this._crews.get(crewId);
        if (crew && crew.members.some(m => m.agentId === toAgentId)) {
          messages.push(message);
          this._messages.set(crewId, messages);
          break;
        }
      }

      this._onDidReceiveMessage.fire(message);
      this._logService.info(`[CrewTeam] Message sent: ${message.id}`);

      // 防抖保存
      this._scheduleSave();

      return message;
    } catch (error) {
      this._logService.error('[CrewTeam] Failed to send message:', error);
      throw error;
    }
  }

  async broadcastMessage(fromAgentId: string, toCrewId: string, content: string): Promise<IMessage> {
    try {
      this._logService.info(`[CrewTeam] Broadcasting message from ${fromAgentId} to crew ${toCrewId}`);

      const message: IMessage = {
        id: this._generateId(),
        fromAgentId,
        toCrewId,
        type: CommunicationType.Broadcast,
        content,
        sentAt: Date.now(),
        isRead: false,
      };

      const messages = this._messages.get(toCrewId) || [];
      messages.push(message);
      this._messages.set(toCrewId, messages);

      this._onDidReceiveMessage.fire(message);
      this._logService.info(`[CrewTeam] Message broadcasted: ${message.id}`);

      // 防抖保存
      this._scheduleSave();

      return message;
    } catch (error) {
      this._logService.error('[CrewTeam] Failed to broadcast message:', error);
      throw error;
    }
  }

  async delegateTask(fromAgentId: string, toAgentId: string, taskId: string, message?: string): Promise<boolean> {
    try {
      this._logService.info(`[CrewTeam] Delegating task ${taskId} from ${fromAgentId} to ${toAgentId}`);

      // 分配任务
      const result = await this.assignTask(taskId, toAgentId);

      if (result && message) {
        // 发送委托消息
        await this.sendMessage(fromAgentId, toAgentId, `Task delegated: ${taskId}\n${message}`);
      }

      this._logService.info(`[CrewTeam] Task delegated: ${taskId}`);
      return result;
    } catch (error) {
      this._logService.error('[CrewTeam] Failed to delegate task:', error);
      return false;
    }
  }

  async getMessages(agentId: string, options?: {
    unreadOnly?: boolean;
    fromAgentId?: string;
    type?: CommunicationType;
  }): Promise<IMessage[]> {
    // 找到 Agent 所在的 Crew
    // TODO: 优化查找逻辑
    for (const [crewId, messages] of this._messages) {
      const crew = this._crews.get(crewId);
      if (crew && crew.members.some(m => m.agentId === agentId)) {
        let filteredMessages = messages.filter(m => m.toAgentId === agentId || m.toCrewId === crewId);

        if (options) {
          if (options.unreadOnly) {
            filteredMessages = filteredMessages.filter(m => !m.isRead);
          }
          if (options.fromAgentId) {
            filteredMessages = filteredMessages.filter(m => m.fromAgentId === options.fromAgentId);
          }
          if (options.type) {
            filteredMessages = filteredMessages.filter(m => m.type === options.type);
          }
        }

        return filteredMessages;
      }
    }

    return [];
  }

  async markMessageRead(messageId: string): Promise<boolean> {
    try {
      this._logService.info(`[CrewTeam] Marking message as read: ${messageId}`);

      // 查找消息
      // TODO: 优化查找逻辑
      for (const [crewId, messages] of this._messages) {
        const index = messages.findIndex(m => m.id === messageId);
        if (index !== -1) {
          messages[index].isRead = true;
          this._messages.set(crewId, messages);
          this._logService.info(`[CrewTeam] Message marked as read: ${messageId}`);
          
          // 防抖保存
          this._scheduleSave();
          
          return true;
        }
      }

      return false;
    } catch (error) {
      this._logService.error('[CrewTeam] Failed to mark message as read:', error);
      return false;
    }
  }

  // ------------------------------------------------------------------------------------------------
  // 工作流编排
  // ------------------------------------------------------------------------------------------------

  async defineWorkflow(
    crewId: string,
    name: string,
    description: string,
    steps: IWorkflowStep[]
  ): Promise<IWorkflow> {
    try {
      this._logService.info(`[CrewTeam] Defining workflow: ${name}`);

      const workflowId = this._generateId();
      const now = Date.now();

      const workflow: IWorkflow = {
        id: workflowId,
        name,
        description,
        steps,
        isActive: false,
        createdAt: now,
        updatedAt: now,
      };

      this._workflows.set(workflowId, workflow);

      // 更新 Crew
      const crew = this._crews.get(crewId);
      if (crew) {
        crew.workflow = workflow;
        crew.updatedAt = now;
        this._crews.set(crewId, crew);
      }

      this._logService.info(`[CrewTeam] Workflow defined: ${workflowId}`);
      
      // 防抖保存
      this._scheduleSave();
      
      return workflow;
    } catch (error) {
      this._logService.error('[CrewTeam] Failed to define workflow:', error);
      throw error;
    }
  }

  async executeWorkflow(workflowId: string): Promise<boolean> {
    try {
      this._logService.info(`[CrewTeam] Executing workflow: ${workflowId}`);

      const workflow = this._workflows.get(workflowId);
      if (!workflow) {
        throw new Error(`Workflow not found: ${workflowId}`);
      }

      workflow.isActive = true;
      workflow.updatedAt = Date.now();
      this._workflows.set(workflowId, workflow);

      // 防抖保存
      this._scheduleSave();

      // 找到关联的 Crew
      let crewId = '';
      for (const [id, crew] of this._crews) {
        if (crew.workflow && crew.workflow.id === workflowId) {
          crewId = id;
          break;
        }
      }

      this._onDidStartWorkflow.fire({ crewId, workflowId });

      // TODO: 实际执行工作流 (按步骤执行)
      this._logService.info(`[CrewTeam] Workflow execution started: ${workflowId}`);

      // 模拟执行 (简化实现)
      setTimeout(() => {
        workflow.isActive = false;
        workflow.updatedAt = Date.now();
        this._workflows.set(workflowId, workflow);

        this._onDidCompleteWorkflow.fire({ crewId, workflowId, success: true });
        this._logService.info(`[CrewTeam] Workflow completed: ${workflowId}`);
        
        // 防抖保存
        this._scheduleSave();
      }, 2000);

      return true;
    } catch (error) {
      this._logService.error('[CrewTeam] Failed to execute workflow:', error);
      return false;
    }
  }

  async stopWorkflow(workflowId: string): Promise<boolean> {
    try {
      this._logService.info(`[CrewTeam] Stopping workflow: ${workflowId}`);

      const workflow = this._workflows.get(workflowId);
      if (!workflow) {
        throw new Error(`Workflow not found: ${workflowId}`);
      }

      workflow.isActive = false;
      workflow.updatedAt = Date.now();
      this._workflows.set(workflowId, workflow);

      this._logService.info(`[CrewTeam] Workflow stopped: ${workflowId}`);
      
      // 防抖保存
      this._scheduleSave();
      
      return true;
    } catch (error) {
      this._logService.error('[CrewTeam] Failed to stop workflow:', error);
      return false;
    }
  }

  async getWorkflow(workflowId: string): Promise<IWorkflow | undefined> {
    return this._workflows.get(workflowId);
  }

  async listWorkflows(crewId: string): Promise<IWorkflow[]> {
    const crew = this._crews.get(crewId);
    if (!crew) {
      return [];
    }

    // 返回与 Crew 关联的工作流
    // TODO: 优化关联逻辑
    const workflows: IWorkflow[] = [];
    for (const [id, workflow] of this._workflows) {
      if (id.includes(crewId)) {
        workflows.push(workflow);
      }
    }

    return workflows;
  }

  // ------------------------------------------------------------------------------------------------
  // 监控和报告
  // ------------------------------------------------------------------------------------------------

  async getCrewStatus(crewId: string): Promise<{
    isActive: boolean;
    totalMembers: number;
    totalTasks: number;
    completedTasks: number;
    failedTasks: number;
    inProgressTasks: number;
  }> {
    const crew = this._crews.get(crewId);
    if (!crew) {
      throw new Error(`Crew not found: ${crewId}`);
    }

    const tasks = crew.tasks;
    const completedTasks = tasks.filter(t => t.status === TaskStatus.Completed).length;
    const failedTasks = tasks.filter(t => t.status === TaskStatus.Failed).length;
    const inProgressTasks = tasks.filter(t => t.status === TaskStatus.InProgress).length;

    return {
      isActive: crew.isActive,
      totalMembers: crew.members.length,
      totalTasks: tasks.length,
      completedTasks,
      failedTasks,
      inProgressTasks,
    };
  }

  async generateReport(crewId: string): Promise<ICrewReport> {
    try {
      this._logService.info(`[CrewTeam] Generating report for crew: ${crewId}`);

      const crew = this._crews.get(crewId);
      if (!crew) {
        throw new Error(`Crew not found: ${crewId}`);
      }

      const tasks = crew.tasks;
      const completedTasks = tasks.filter(t => t.status === TaskStatus.Completed).length;
      const failedTasks = tasks.filter(t => t.status === TaskStatus.Failed).length;
      const inProgressTasks = tasks.filter(t => t.status === TaskStatus.InProgress).length;
      const waitingTasks = tasks.filter(t => t.status === TaskStatus.Waiting).length;

      // 计算成员统计
      const memberStats = crew.members.map(member => {
        const memberTasks = tasks.filter(t => t.assignedTo === member.agentId);
        const memberCompletedTasks = memberTasks.filter(t => t.status === TaskStatus.Completed).length;
        const memberFailedTasks = memberTasks.filter(t => t.status === TaskStatus.Failed).length;
        const memberTotalExecutionTimeMs = memberTasks
          .filter(t => t.startedAt && t.completedAt)
          .reduce((sum, t) => sum + (t.completedAt! - t.startedAt!), 0);

        return {
          agentId: member.agentId,
          agentName: member.agentName,
          completedTasks: memberCompletedTasks,
          failedTasks: memberFailedTasks,
          totalExecutionTimeMs: memberTotalExecutionTimeMs,
        };
      });

      // 收集错误
      const errors = tasks
        .filter(t => t.error)
        .map(t => `Task ${t.id}: ${t.error}`);

      const report: ICrewReport = {
        crewId,
        generatedAt: Date.now(),
        totalTasks: tasks.length,
        completedTasks,
        failedTasks,
        inProgressTasks,
        waitingTasks,
        totalExecutionTimeMs: tasks
          .filter(t => t.startedAt && t.completedAt)
          .reduce((sum, t) => sum + (t.completedAt! - t.startedAt!), 0),
        memberStats,
        tasks,
        errors,
      };

      this._logService.info(`[CrewTeam] Report generated for crew: ${crewId}`);
      return report;
    } catch (error) {
      this._logService.error('[CrewTeam] Failed to generate report:', error);
      throw error;
    }
  }

  async getExecutionHistory(crewId: string, options?: {
    startTime?: number;
    endTime?: number;
    limit?: number;
  }): Promise<Array<{
    taskId: string;
    taskName: string;
    agentId: string;
    agentName: string;
    status: TaskStatus;
    startTime: number;
    endTime?: number;
    error?: string;
  }>> {
    const crew = this._crews.get(crewId);
    if (!crew) {
      return [];
    }

    let tasks = crew.tasks;

    // 过滤时间范围
    if (options) {
      if (options.startTime) {
        tasks = tasks.filter(t => t.createdAt >= options.startTime!);
      }
      if (options.endTime) {
        tasks = tasks.filter(t => t.createdAt <= options.endTime!);
      }
    }

    // 限制数量
    if (options && options.limit) {
      tasks = tasks.slice(-options.limit);
    }

    // 转换为执行历史格式
    return tasks.map(task => ({
      taskId: task.id,
      taskName: task.name,
      agentId: task.assignedTo || 'unassigned',
      agentName: task.assignedTo ? `Agent-${task.assignedTo}` : 'Unassigned', // TODO: 从 Agent 服务获取名称
      status: task.status,
      startTime: task.startedAt || task.createdAt,
      endTime: task.completedAt,
      error: task.error,
    }));
  }

  // ------------------------------------------------------------------------------------------------
  // 持久化存储
  // ------------------------------------------------------------------------------------------------

  private _loadFromStorage(): void {
    if (!this._storageService) {
      return;
    }
    
    try {
      // 加载Crews
      const crewsJson = this._storageService.get(
        CrewTeamService.STORAGE_KEY_CREWS,
        StorageScope.WORKSPACE,
        '[]'
      );
      const crewsData: Array<[string, ICrew]> = JSON.parse(crewsJson);
      this._crews.clear();
      for (const [key, value] of crewsData) {
        this._crews.set(key, value);
      }
      this._logService.info(`[CrewTeam] Loaded ${this._crews.size} crews from storage`);
      
      // 加载任务
      const tasksJson = this._storageService.get(
        CrewTeamService.STORAGE_KEY_TASKS,
        StorageScope.WORKSPACE,
        '[]'
      );
      const tasksData: Array<[string, ITask]> = JSON.parse(tasksJson);
      this._tasks.clear();
      for (const [key, value] of tasksData) {
        this._tasks.set(key, value);
      }
      this._logService.info(`[CrewTeam] Loaded ${this._tasks.size} tasks from storage`);
      
      // 加载工作流
      const workflowsJson = this._storageService.get(
        CrewTeamService.STORAGE_KEY_WORKFLOWS,
        StorageScope.WORKSPACE,
        '[]'
      );
      const workflowsData: Array<[string, IWorkflow]> = JSON.parse(workflowsJson);
      this._workflows.clear();
      for (const [key, value] of workflowsData) {
        this._workflows.set(key, value);
      }
      this._logService.info(`[CrewTeam] Loaded ${this._workflows.size} workflows from storage`);
      
      // 加载消息
      const messagesJson = this._storageService.get(
        CrewTeamService.STORAGE_KEY_MESSAGES,
        StorageScope.WORKSPACE,
        '[]'
      );
      const messagesData: Array<[string, IMessage[]]> = JSON.parse(messagesJson);
      this._messages.clear();
      for (const [key, value] of messagesData) {
        this._messages.set(key, value);
      }
      this._logService.info(`[CrewTeam] Loaded ${this._messages.size} message threads from storage`);
    } catch (error) {
      this._logService.error('[CrewTeam] Failed to load from storage:', error);
    }
  }

  private _saveToStorage(): void {
    if (!this._storageService) {
      return;
    }
    
    try {
      // 保存Crews
      const crewsArray = Array.from(this._crews.entries());
      this._storageService.store(
        CrewTeamService.STORAGE_KEY_CREWS,
        JSON.stringify(crewsArray),
        StorageScope.WORKSPACE,
        StorageTarget.MACHINE
      );
      
      // 保存任务
      const tasksArray = Array.from(this._tasks.entries());
      this._storageService.store(
        CrewTeamService.STORAGE_KEY_TASKS,
        JSON.stringify(tasksArray),
        StorageScope.WORKSPACE,
        StorageTarget.MACHINE
      );
      
      // 保存工作流
      const workflowsArray = Array.from(this._workflows.entries());
      this._storageService.store(
        CrewTeamService.STORAGE_KEY_WORKFLOWS,
        JSON.stringify(workflowsArray),
        StorageScope.WORKSPACE,
        StorageTarget.MACHINE
      );
      
      // 保存消息
      const messagesArray = Array.from(this._messages.entries());
      this._storageService.store(
        CrewTeamService.STORAGE_KEY_MESSAGES,
        JSON.stringify(messagesArray),
        StorageScope.WORKSPACE,
        StorageTarget.MACHINE
      );
      
      this._logService.debug('[CrewTeam] Saved to storage');
    } catch (error) {
      this._logService.error('[CrewTeam] Failed to save to storage:', error);
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
    return `crew_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  private _isMemberOfCrew(agentId: string, crewId: string): boolean {
    const crew = this._crews.get(crewId);
    return crew ? crew.members.some(m => m.agentId === agentId) : false;
  }

  private _getDefaultPermissions(role: AgentRole): string[] {
    switch (role) {
      case AgentRole.Leader:
        return ['create_task', 'assign_task', 'execute_task', 'review_result', 'manage_members'];
      case AgentRole.Worker:
        return ['execute_task', 'send_message'];
      case AgentRole.Reviewer:
        return ['review_result', 'send_message'];
      case AgentRole.Expert:
        return ['provide_advice', 'send_message'];
      case AgentRole.Coordinator:
        return ['coordinate', 'send_message', 'broadcast'];
      default:
        return ['send_message'];
    }
  }
}

// ------------------------------------------------------------------------------------------------
// 注册为单例
// ------------------------------------------------------------------------------------------------

import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
registerSingleton(ICrewTeamService, CrewTeamService, InstantiationType.Delayed);
