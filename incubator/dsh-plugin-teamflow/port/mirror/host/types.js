/**
 * dsh-plugin-teamflow — host 公共类型（strip-types 可剥离：无 enum/namespace/装饰器）。
 * 依赖方向：本文件可 import '../store.ts' 的类型；严禁被下层（util/constants）反向依赖。
 */
                                                              

/** 流水线运行日志（运行时对象，含 result 等非持久化字段）。 */
                                                
                                                                                                 
                        
                                                            
 

/**
 * **声明本插件自己的 message source kind**（2026-09-23 补：v4 source 适配的类型面，此前只改了字面量）。
 *
 * 宿主 `MessageSource` 是**声明合并的可扩展联合**——`packages/llm/llm/src/message.ts:103-115` 原文：
 * "Merge-extensible sum type — each producer declares its own `kind` in its own module; there is no
 * shared catch-all `plugin` kind"。会话格式 v4 同样要求 producer-owned kind
 * （`plugin:<name>`；退役的 `{ kind: 'plugin', plugin }` wrapper 会被 `assertV4MessageSources` 拒绝）。
 *
 * 所以按宿主约定在这里注册我们的 kind（而不是在调用点写裸字面量）：
 * v4 修复当时只改了 `createUserMessage` 的 source 字面量、没登记类型 → tsc 报
 * 「'"plugin:dsh-plugin-teamflow"' is not assignable to ...」而 **bundle 不做类型检查**，
 * 于是这个错误一路留到本轮跑 typecheck 才暴露（AGENTS.md：改 type 后必跑 typecheck）。
 * `form` 按宿主 `ContextFormed` 判别式给足字段：`notice` 必须带一行 `summary`。
 */
                                       
                              
                                 
                                                                              
                                                                                      
                                                                                                          
   
 
/** backlog 记录（需求/任务/缺陷通用形状）。 */
                              
            
                
                
                             
                  
                   
                       
                         
                                                                                             
                                                                                       
                    
 
/** 需求分诊路由模式（ADR-0004：full/medium/lite/tech/patch）。 */
                                                                        

/**
 * **澄清策略变体**（ADR-0011 ③；2026-10-08 收窄为**对照实验开关**）。
 *
 * 历史：它曾是 `PipelineOptions` 的独立字段（`off`/`once`/`interview`），并在 ADR-0011 里
 * **刻意不做成 `PipelineMode` 的一档**——`PipelineMode` 决定阶段集 / PRD 形态 / 架构护栏
 * （`resolveStages` / `MODE_RANK` / `guardrailUpgrade` 三处按它分派），把「追问几次」塞进去会让
 * 同一张表承担两件正交的事，并把 `interview` 变成「没有对应阶段集」的伪档位。**该论证仍成立。**
 *
 * ⚠️ **2026-10-08 字段本身被删掉**，理由与论证无关：它**从来没影响过流水线**，只选 `tool.ctx.team`
 * 中间那段文案；而 ctx 只在**选团队时**注入 ⇒ 作为 run 参数结构上「迟一拍」（反查历史 run 还带来
 * 「重启丢失」）。用户指出切口应是**手册本身** ⇒ 默认行为写进 ctx（`once` 的文案保留为对照组），
 * 这个 union 只剩 `TEAMFLOW_CLARIFY` 的取值域，不再是 pipeline 选项。
 */
                                                          
/**
 * **PRD 确认单的触发档**（ADR-0011 ①；2026-10-08 由显式 `needConfirm` 开关改为内容驱动）。
 *
 * - `auto`（缺省）—— **判据是内容**：PRD 的 `openQuestions` 里存在 `kind: "taste"`（主观品味项）
 *   ⇒ 暂停等用户拍板；只有信息缺口（`fact`）或没有待澄清项 ⇒ 直通不打断。
 *   为什么两类要分开：信息缺口的代价由 `default` 兜住，品味项猜错的代价是「成品不是我要的」
 *   ——后者表现为流失/差评、**不表现为 QA 打回**（用户 2026-10-08 定调）；而纯信息缺口也打断用户
 *   会白毁 §1 的无人值守卖点。
 * - `always` / `never` —— **只是 A/B 对照与端到端验证的内部强制位**。
 *
 * ⚠️ **不是工具参数**：由环境变量 `TEAMFLOW_CONFIRM` 传入（`always` / `never`，其余/未设 = `auto`）。
 * 2026-10-08 之前它是公开参数 `needConfirm`，被用户当场否掉：「用户又不知道这参数」——
 * 而工具描述里也没有任何「何时该设它」的触发条件 ⇒ 实践中没人设 ⇒ 功能是死的。
 * `patch` 档恒不生效（STAGE_POLICY：单 agent 直改，PRD 是机械的单点确认）。
 */
                                                     
/** 流水线启动选项。 */
                                  
                      
                        
                                                                       
                            
                           
                 
                             
                         
                                                                                 
                
                                          
                     
                                                
                 
                                                                     
                                                                     
                                                         
                                                                    
                                                      
                 
                                      
                                                              
                         
                                                               
                                
                                                                            
                            
                                       
                                           
                                               
                                                                          
                         
                                                             
                       
                                                               
                                 
                               
                                                                 
                                                             
                                       
                                                                               
                    
 
/** 断点续跑上下文。 */
                                
               
                                   
                                                                          
                                                                           
                                                                        
                
 
/** 运行中的本地子代理活 Agent 的鸭子类型（`runtime.agents` 注册表返回）。
 *  `status` 是宿主唯一的生命周期态（`'idle' | 'running'`，见 `packages/core/agent/src/runtime-types.ts`）。
 *  ⚠️ 这里**没有** `phase` —— 宿主从未提供该字段，护栏曾按 `localAgent.phase.kind` 判忙，恒 false 静默失效（2026-10-15 修正）。 */
                                      
                   
                 
                                                
                               
 

/** 子代理运行句柄的鸭子类型（避免强依赖内部类型）。 */
                                  
            
                          
                                 
                                                                     
                                                                              
                                                       
                                  
 

/** `subagents.startActivation` 的入参/出参鸭子类型。
 *  ⚠️ **宿主 API 迁移锚点（2026-10-15 / issue #20）**：alpha.1 的 `subagents.start(name, request)`
 *  在 alpha.2 被整体删除（提交 `3d852a1cea`，首个含它的 tag = `dsh-v0.2.1-alpha.2`），取而代之的是
 *  单一入口 `startActivation(spec)`：`provider`/`label`/`signal`/`delivery` 提到 spec 顶层，`label` 变必填，
 *  且**不再回传 `localAgent`**。官方迁移指南：`docs/upgrade-guide/v0.2.1-alpha.1/subagent-activations/`。 */
                                         
                 
                                                                
                    
                                                            
                                 
 

                                   
                            
                    
                 
                                                                                          
                   
                                                        
                                                                    
                                 
                                       
 
/** 父 Agent 句柄的鸭子类型（deliverCompletion / runAgent 共用）。 */
                                  
                               
                                 
                 
                                 
 
/** 单子代理真实 LLM usage 桶（来自会话 assistant/message 事件的 provider usage）。 */
                               
               
                   
                    
                
               
 


//# sourceURL=file:///G:/SarosWorkspace/sarosis-agents-client/incubator/dsh-plugin-teamflow/host/types.ts