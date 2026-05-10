// ------------------------------------------------------------------------------------------------
// crewTeam.ts - Crew/Team 编排接口定义
// ------------------------------------------------------------------------------------------------
//
// Phase 4.5: Crew/Team 编排
// 功能关联: F1.2 (Crew 创建), F1.3 (多 Agent 协作)
//
// 作用: 支持创建和管理 Crew (团队)，实现多个 Agent 之间的协作编排，
//       包括角色分配、任务分配、通信机制、工作流编排等。
//
// 核心能力:
// 1. Crew 生命周期 (create, update, delete, list)
// 2. Agent 成员管理 (addMember, removeMember, updateRole)
// 3. 任务编排 (createTask, assignTask, executeTask)
// 4. 通信机制 (sendMessage, broadcast, delegate)
// 5. 工作流编排 (defineWorkflow, executeWorkflow)
// 6. 监控和报告 (getStatus, getReport)

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';

// ------------------------------------------------------------------------------------------------
// 前向声明 (用于装饰器)
// ------------------------------------------------------------------------------------------------

// 接口将在文件后面定义，这里先声明
export interface ICrewTeamService { readonly _serviceBrand: undefined; }

// ------------------------------------------------------------------------------------------------
// 装饰器标识符 (用于依赖注入)
// ------------------------------------------------------------------------------------------------

export const ICrewTeamService = createDecorator<ICrewTeamService>('crewTeamService');

// ------------------------------------------------------------------------------------------------
// 枚举和常量
// ------------------------------------------------------------------------------------------------

/** Crew 类型 */
export enum CrewType {
  /** 顺序执行 - Agents 按顺序执行任务 */
  Sequential = 'sequential',
  /** 并行执行 - Agents 并行执行任务 */
  Parallel = 'parallel',
  /** 层级执行 - 有层级结构的执行 */
  Hierarchical = 'hierarchical',
  /** 自定义 - 用户自定义执行流程 */
  Custom = 'custom',
}

/** Agent 角色 */
export enum AgentRole {
  /** 领导者 - 负责协调和决策 */
  Leader = 'leader',
  /** 工作者 - 执行具体任务 */
  Worker = 'worker',
  /** 审查者 - 审查结果 */
  Reviewer = 'reviewer',
  /** 专家 - 提供专业建议 */
  Expert = 'expert',
  /** 协调者 - 协调团队活动 */
  Coordinator = 'coordinator',
}

/** 任务状态 */
export enum TaskStatus {
  /** 待办 */
  Pending = 'pending',
  /** 进行中 */
  InProgress = 'in_progress',
  /** 等待中 */
  Waiting = 'waiting',
  /** 已完成 */
  Completed = 'completed',
  /** 已失败 */
  Failed = 'failed',
  /** 已取消 */
  Cancelled = 'cancelled',
}

/** 任务优先级 */
export enum TaskPriority {
  /** 低 */
  Low = 'low',
  /** 中 */
  Medium = 'medium',
  /** 高 */
  High = 'high',
  /** 紧急 */
  Urgent = 'urgent',
}

/** 通信类型 */
export enum CommunicationType {
  /** 直接消息 */
  Direct = 'direct',
  /** 广播 */
  Broadcast = 'broadcast',
  /** 委托 */
  Delegation = 'delegation',
  /** 通知 */
  Notification = 'notification',
}

// ------------------------------------------------------------------------------------------------
// 核心接口
// ------------------------------------------------------------------------------------------------

/** Crew (团队) */
export interface ICrew {
  /** Crew ID */
  id: string;
  /** Crew 名称 */
  name: string;
  /** Crew 描述 */
  description: string;
  /** Crew 类型 */
  type: CrewType;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
  /** 所有者 */
  owner: string;
  /** 是否活跃 */
  isActive: boolean;
  /** 成员列表 */
  members: ICrewMember[];
  /** 任务列表 */
  tasks: ITask[];
  /** 工作流定义 */
  workflow?: IWorkflow;
  /** 配置 */
  config: ICrewConfig;
}

/** Crew 成员 */
export interface ICrewMember {
  /** Agent ID */
  agentId: string;
  /** Agent 名称 */
  agentName: string;
  /** 角色 */
  role: AgentRole;
  /** 是否活跃 */
  isActive: boolean;
  /** 加入时间 */
  joinedAt: number;
  /** 权限 */
  permissions: string[];
  /** 元数据 */
  metadata?: Record<string, any>;
}

/** 任务 */
export interface ITask {
  /** 任务ID */
  id: string;
  /** 任务名称 */
  name: string;
  /** 任务描述 */
  description: string;
  /** 任务状态 */
  status: TaskStatus;
  /** 任务优先级 */
  priority: TaskPriority;
  /** 分配给的 Agent ID */
  assignedTo?: string;
  /** 创建者 Agent ID */
  createdBy: string;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
  /** 开始时间 */
  startedAt?: number;
  /** 完成时间 */
  completedAt?: number;
  /** 依赖的任务ID列表 */
  dependencies: string[];
  /** 输入 */
  input: any;
  /** 输出 */
  output?: any;
  /** 错误信息 */
  error?: string;
  /** 元数据 */
  metadata?: Record<string, any>;
}

/** 工作流 */
export interface IWorkflow {
  /** 工作流ID */
  id: string;
  /** 工作流名称 */
  name: string;
  /** 工作流描述 */
  description: string;
  /** 步骤列表 */
  steps: IWorkflowStep[];
  /** 是否活跃 */
  isActive: boolean;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt: number;
}

/** 工作流步骤 */
export interface IWorkflowStep {
  /** 步骤ID */
  id: string;
  /** 步骤名称 */
  name: string;
  /** 步骤类型 */
  type: 'task' | 'condition' | 'parallel' | 'loop';
  /** 执行者 Agent ID */
  executorId?: string;
  /** 任务ID (如果类型是 task) */
  taskId?: string;
  /** 条件表达式 (如果类型是 condition) */
  condition?: string;
  /** 并行步骤列表 (如果类型是 parallel) */
  parallelSteps?: string[];
  /** 循环配置 (如果类型是 loop) */
  loopConfig?: {
    items: string;
    itemVariable: string;
  };
  /** 下一步骤ID */
  nextStepId?: string;
  /** 元数据 */
  metadata?: Record<string, any>;
}

/** Crew 配置 */
export interface ICrewConfig {
  /** 最大并发任务数 */
  maxConcurrentTasks: number;
  /** 任务超时时间 (ms) */
  taskTimeoutMs: number;
  /** 是否允许自动分配任务 */
  autoAssignTasks: boolean;
  /** 是否允许成员间通信 */
  allowCommunication: boolean;
  /** 通信规则 */
  communicationRules: {
    /** 是否允许直接消息 */
    allowDirectMessages: boolean;
    /** 是否允许广播 */
    allowBroadcast: boolean;
    /** 是否允许委托 */
    allowDelegation: boolean;
  };
  /** 工作流配置 */
  workflowConfig: {
    /** 是否启用工作流 */
    enabled: boolean;
    /** 失败策略 */
    failurePolicy: 'stop' | 'continue' | 'retry';
    /** 最大重试次数 */
    maxRetries: number;
  };
}

/** 通信消息 */
export interface IMessage {
  /** 消息ID */
  id: string;
  /** 发送者 Agent ID */
  fromAgentId: string;
  /** 接收者 Agent ID (如果是直接消息) */
  toAgentId?: string;
  /** 接收者 Crew ID (如果是广播) */
  toCrewId?: string;
  /** 消息类型 */
  type: CommunicationType;
  /** 消息内容 */
  content: string;
  /** 发送时间 */
  sentAt: number;
  /** 是否已读 */
  isRead: boolean;
  /** 元数据 */
  metadata?: Record<string, any>;
}

/** Crew 执行报告 */
export interface ICrewReport {
  /** Crew ID */
  crewId: string;
  /** 报告生成时间 */
  generatedAt: number;
  /** 总任务数 */
  totalTasks: number;
  /** 已完成任务数 */
  completedTasks: number;
  /** 失败任务数 */
  failedTasks: number;
  /** 进行中任务数 */
  inProgressTasks: number;
  /** 等待中任务数 */
  waitingTasks: number;
  /** 总执行时间 (ms) */
  totalExecutionTimeMs: number;
  /** 成员统计 */
  memberStats: Array<{
    agentId: string;
    agentName: string;
    completedTasks: number;
    failedTasks: number;
    totalExecutionTimeMs: number;
  }>;
  /** 任务列表 */
  tasks: ITask[];
  /** 错误信息 */
  errors: string[];
}

// ------------------------------------------------------------------------------------------------
// 服务接口
// ------------------------------------------------------------------------------------------------

/** Crew/Team 编排服务接口 */
export interface ICrewTeamService {
  /** 服务标识 */
  readonly _serviceBrand: undefined;

  // ------------------------------------------------------------------------------------------------
  // 事件
  // ------------------------------------------------------------------------------------------------
  
  /** Crew 创建事件 */
  readonly onDidCreateCrew: Event<ICrew>;
  
  /** Crew 更新事件 */
  readonly onDidUpdateCrew: Event<ICrew>;
  
  /** Crew 删除事件 */
  readonly onDidDeleteCrew: Event<string>;
  
  /** 成员加入事件 */
  readonly onDidJoinCrew: Event<{ crewId: string; member: ICrewMember }>;
  
  /** 成员离开事件 */
  readonly onDidLeaveCrew: Event<{ crewId: string; agentId: string }>;
  
  /** 任务创建事件 */
  readonly onDidCreateTask: Event<ITask>;
  
  /** 任务更新事件 */
  readonly onDidUpdateTask: Event<ITask>;
  
  /** 任务完成事件 */
  readonly onDidCompleteTask: Event<ITask>;
  
  /** 消息接收事件 */
  readonly onDidReceiveMessage: Event<IMessage>;
  
  /** 工作流开始事件 */
  readonly onDidStartWorkflow: Event<{ crewId: string; workflowId: string }>;
  
  /** 工作流完成事件 */
  readonly onDidCompleteWorkflow: Event<{ crewId: string; workflowId: string; success: boolean }>;

  // ------------------------------------------------------------------------------------------------
  // Crew 生命周期
  // ------------------------------------------------------------------------------------------------

  /**
   * 创建 Crew
   * @param name Crew 名称
   * @param description Crew 描述
   * @param type Crew 类型
   * @param config Crew 配置
   * @returns Crew
   */
  createCrew(
    name: string,
    description: string,
    type: CrewType,
    config?: Partial<ICrewConfig>
  ): Promise<ICrew>;

  /**
   * 更新 Crew
   * @param crewId Crew ID
   * @param updates 要更新的字段
   * @returns 更新后的 Crew
   */
  updateCrew(crewId: string, updates: Partial<ICrew>): Promise<ICrew>;

  /**
   * 删除 Crew
   * @param crewId Crew ID
   * @returns 是否成功
   */
  deleteCrew(crewId: string): Promise<boolean>;

  /**
   * 获取 Crew
   * @param crewId Crew ID
   * @returns Crew
   */
  getCrew(crewId: string): Promise<ICrew | undefined>;

  /**
   * 列出所有 Crew
   * @param filter 过滤条件
   * @returns Crew 列表
   */
  listCrews(filter?: {
    type?: CrewType;
    owner?: string;
    isActive?: boolean;
    search?: string;
  }): Promise<ICrew[]>;

  // ------------------------------------------------------------------------------------------------
  // 成员管理
  // ------------------------------------------------------------------------------------------------

  /**
   * 添加成员
   * @param crewId Crew ID
   * @param agentId Agent ID
   * @param role 角色
   * @returns 是否成功
   */
  addMember(crewId: string, agentId: string, role: AgentRole): Promise<boolean>;

  /**
   * 移除成员
   * @param crewId Crew ID
   * @param agentId Agent ID
   * @returns 是否成功
   */
  removeMember(crewId: string, agentId: string): Promise<boolean>;

  /**
   * 更新成员角色
   * @param crewId Crew ID
   * @param agentId Agent ID
   * @param role 新角色
   * @returns 是否成功
   */
  updateMemberRole(crewId: string, agentId: string, role: AgentRole): Promise<boolean>;

  /**
   * 获取成员列表
   * @param crewId Crew ID
   * @returns 成员列表
   */
  getMembers(crewId: string): Promise<ICrewMember[]>;

  // ------------------------------------------------------------------------------------------------
  // 任务编排
  // ------------------------------------------------------------------------------------------------

  /**
   * 创建任务
   * @param crewId Crew ID
   * @param name 任务名称
   * @param description 任务描述
   * @param priority 任务优先级
   * @param input 任务输入
   * @param assignedTo 分配给的 Agent ID (可选)
   * @param dependencies 依赖的任务ID列表
   * @returns 任务
   */
  createTask(
    crewId: string,
    name: string,
    description: string,
    priority: TaskPriority,
    input: any,
    assignedTo?: string,
    dependencies?: string[]
  ): Promise<ITask>;

  /**
   * 分配任务
   * @param taskId 任务ID
   * @param agentId Agent ID
   * @returns 是否成功
   */
  assignTask(taskId: string, agentId: string): Promise<boolean>;

  /**
   * 执行任务
   * @param taskId 任务ID
   * @returns 是否成功
   */
  executeTask(taskId: string): Promise<boolean>;

  /**
   * 取消任务
   * @param taskId 任务ID
   * @returns 是否成功
   */
  cancelTask(taskId: string): Promise<boolean>;

  /**
   * 获取任务
   * @param taskId 任务ID
   * @returns 任务
   */
  getTask(taskId: string): Promise<ITask | undefined>;

  /**
   * 列出任务
   * @param crewId Crew ID
   * @param filter 过滤条件
   * @returns 任务列表
   */
  listTasks(crewId: string, filter?: {
    status?: TaskStatus;
    assignedTo?: string;
    priority?: TaskPriority;
  }): Promise<ITask[]>;

  // ------------------------------------------------------------------------------------------------
  // 通信机制
  // ------------------------------------------------------------------------------------------------

  /**
   * 发送消息
   * @param fromAgentId 发送者 Agent ID
   * @param toAgentId 接收者 Agent ID
   * @param content 消息内容
   * @returns 消息
   */
  sendMessage(fromAgentId: string, toAgentId: string, content: string): Promise<IMessage>;

  /**
   * 广播消息
   * @param fromAgentId 发送者 Agent ID
   * @param toCrewId 接收者 Crew ID
   * @param content 消息内容
   * @returns 消息
   */
  broadcastMessage(fromAgentId: string, toCrewId: string, content: string): Promise<IMessage>;

  /**
   * 委托任务
   * @param fromAgentId 委托者 Agent ID
   * @param toAgentId 被委托者 Agent ID
   * @param taskId 任务ID
   * @param message 委托消息
   * @returns 是否成功
   */
  delegateTask(fromAgentId: string, toAgentId: string, taskId: string, message?: string): Promise<boolean>;

  /**
   * 获取消息
   * @param agentId Agent ID
   * @param options 查询选项
   * @returns 消息列表
   */
  getMessages(agentId: string, options?: {
    unreadOnly?: boolean;
    fromAgentId?: string;
    type?: CommunicationType;
  }): Promise<IMessage[]>;

  /**
   * 标记消息已读
   * @param messageId 消息ID
   * @returns 是否成功
   */
  markMessageRead(messageId: string): Promise<boolean>;

  // ------------------------------------------------------------------------------------------------
  // 工作流编排
  // ------------------------------------------------------------------------------------------------

  /**
   * 定义工作流
   * @param crewId Crew ID
   * @param name 工作流名称
   * @param description 工作流描述
   * @param steps 步骤列表
   * @returns 工作流
   */
  defineWorkflow(
    crewId: string,
    name: string,
    description: string,
    steps: IWorkflowStep[]
  ): Promise<IWorkflow>;

  /**
   * 执行工作流
   * @param workflowId 工作流ID
   * @returns 是否成功
   */
  executeWorkflow(workflowId: string): Promise<boolean>;

  /**
   * 停止工作流
   * @param workflowId 工作流ID
   * @returns 是否成功
   */
  stopWorkflow(workflowId: string): Promise<boolean>;

  /**
   * 获取工作流
   * @param workflowId 工作流ID
   * @returns 工作流
   */
  getWorkflow(workflowId: string): Promise<IWorkflow | undefined>;

  /**
   * 列出工作流
   * @param crewId Crew ID
   * @returns 工作流列表
   */
  listWorkflows(crewId: string): Promise<IWorkflow[]>;

  // ------------------------------------------------------------------------------------------------
  // 监控和报告
  // ------------------------------------------------------------------------------------------------

  /**
   * 获取 Crew 状态
   * @param crewId Crew ID
   * @returns Crew 状态
   */
  getCrewStatus(crewId: string): Promise<{
    isActive: boolean;
    totalMembers: number;
    totalTasks: number;
    completedTasks: number;
    failedTasks: number;
    inProgressTasks: number;
  }>;

  /**
   * 生成报告
   * @param crewId Crew ID
   * @returns 报告
   */
  generateReport(crewId: string): Promise<ICrewReport>;

  /**
   * 获取执行历史
   * @param crewId Crew ID
   * @param options 查询选项
   * @returns 执行历史
   */
  getExecutionHistory(crewId: string, options?: {
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
  }>>;
}

// ------------------------------------------------------------------------------------------------
// 常量
// ------------------------------------------------------------------------------------------------

/** 服务标识 */
export const CREW_TEAM_SERVICE_ID = 'crewTeamService';

/** 默认 Crew 配置 */
export const DEFAULT_CREW_CONFIG: ICrewConfig = {
  maxConcurrentTasks: 5,
  taskTimeoutMs: 30 * 60 * 1000, // 30 minutes
  autoAssignTasks: true,
  allowCommunication: true,
  communicationRules: {
    allowDirectMessages: true,
    allowBroadcast: true,
    allowDelegation: true,
  },
  workflowConfig: {
    enabled: false,
    failurePolicy: 'stop',
    maxRetries: 3,
  },
};
