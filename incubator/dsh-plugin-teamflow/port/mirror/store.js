/**
 * dsh-plugin-teamflow — 持久化层（纯 node:fs，无 cordis 依赖，可独立测试）。
 *
 * 职责：
 * - $DSH_HOME/teamflow 目录布局（backlog 产品目录 + runs 运行日志目录）
 * - 原子写 + .bak 备份 + 损坏自动恢复（backlog 与 journal 共用）
 * - journal 序列化/持久化/加载（断点续跑基座，LangGraph checkpointer 语义）
 */

import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import {
  mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, copyFileSync, renameSync, readdirSync,
} from 'node:fs'
import { homedir } from 'node:os'

/** 运行阶段（journal 序列化/续跑重建单元）。 */
                               
             
               
                                                                                      
               
                                                
                                                                   
                         
                                                       
                                                                 
                                                                      
                                                            
                           
                
                         
                         
                           
                         
                                                                                                        
                         
                         
                        
                                                                                 
                             
                                                                                                           
                                                                     
     
                                                                      
                                                         
                                                                                  
     
                                
                                                                                   
                                
                                                      
                                                                  
                          
                       
                                                                          
                                                        
                                                                        
                                                                                                      
                                                         
 

/** 运行日志（journal）——运行时对象与磁盘可持久化形态的公共形状。 */
                                
            
              
                
                      
                                   
                                                                           
                                                                     
                                                                      
                                                                      
                                                   
                                                                     
                                                                          
                           
                                              
                               
                                           
                              
                                        
            
                
                          
                      
                  
                          
                    
          
                                                
               
                                     
                                                                     
          
                         
                                                                 
                                                                         
                        
                                                               
                        
                                                                                                                                    
                                                               
                       
                                                                                      
                         
                                
                        
                                  
                        
                             
                     
                       
                               
                              
                           
                         
                       
                         
                                                             
     
                                                                       
                                                                                              
                                                                                   
                                                            
     
                                                  
                                                                      
                                                                                  
                                                                  
                        
                                                                         
                                                           
                             
                          
                                                                 
                                  
                                                                            
                                                                    
                                                     
                        
                              
                                                                                    
                                                                    
                                                                                                                    
                                                                    
                                                                                
                                                                  
                             
                                                               
                                                               
                                           
                                                     
                               
                                                                      
                                                                    
                                                                        
                                                                         
                                                               
                                                                               
                                                            
                                                                         
                 
                          
                                          
                                                                                                                                             
          
     
                                                                            
                                                       
                                                                     
     
                 
                                                             
                                                           
                                    
     
                                                                    
                                                         
                                
     
                            
     
                                                                    
                                                                
                                                       
     
                 
                 
                     
                      
                  
                 
          
                  
                        
 

export function dshHome()         {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}
export function teamflowRoot()         {
  return join(dshHome(), 'teamflow')
}

/**
 * 工作区 → 稳定安全槽位：以路径 basename 为可读前缀 + sha1 短哈希，保证同路径稳定、
 * 跨路径唯一，且只含 [a-zA-Z0-9_-]（可安全作目录段，不穿越 $DSH_HOME）。
 * 例：C:\...\tetris → ws-tetris-3f9a2c7b
 */
export function slugPath(p                           )         {
  const raw = String(p || '').replace(/\\/g, '/')
  const base = raw.split('/').filter(Boolean).pop() || 'root'
  const tag = base.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'ws'
  const hash = createHash('sha1').update(raw || 'default').digest('hex').slice(0, 8)
  return `ws-${tag}-${hash}`
}

/** 工作区绝对路径 → 该工作区的 `$DSH_HOME/teamflow/<slug>/backlog` 等目录基座。 */
export function workspaceDir(workspacePath                           )         {
  return join(teamflowRoot(), slugPath(workspacePath || null))
}
export function productDir(product                           )         {
  // 双保险：危险路径退化到 default（与 host normalizeRoot 白名单一致）。
  let safe = String(product || 'default').replace(/\\/g, '/').trim() || 'default'
  if (safe.startsWith('/') || safe.startsWith('.') || /^[a-zA-Z]:/.test(safe) || safe.includes('..')) safe = 'default'
  if (!safe.split('/').every((seg) => /^[a-zA-Z0-9_-]+$/.test(seg))) safe = 'default'
  return join(teamflowRoot(), safe)
}
export function fileFor(product                           , name        )         {
  return join(productDir(product), 'backlog', name)
}
export function runsDir()         {
  return join(teamflowRoot(), 'runs')
}
export function journalFile(runId        )         {
  return join(runsDir(), `${runId}.json`)
}

/* ── 原子读/写（备份 + 损坏自愈） ────────────────────────────────── */
/** 通用 JSON 读取（对象或数组），主文件损坏自动 .bak 恢复。 */
export function readJsonAny   (file        , fallback   )    {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))     
  } catch (e) {
    console.error('[teamflow] readJson 主文件损坏', file, (e         )?.message)
    try {
      if (existsSync(file + '.bak')) {
        const b = JSON.parse(readFileSync(file + '.bak', 'utf8'))     
        console.warn('[teamflow] 已从 .bak 恢复', file)
        return b
      }
    } catch (e2) { /* 备份也损坏 */ }
    console.error('[teamflow] .bak 也损坏，返回空（数据可能丢失）', file)
    return fallback
  }
}

/** 数组 JSON 读取（backlog 专用），非数组视为无效。 */
export function readJson   (file        , fallback   )    {
  const v = readJsonAny   (file, fallback)
  return Array.isArray(v) ? v : fallback
}

/**
 * 原子写 JSON：先 .tmp 再 rename（崩溃无半截文件）；
 * 只把「可解析的完整数组」备份为 .bak；损坏主文件改名 .corrupt-<ts> 保留现场。
 */
export function writeJson(file        , value         )          {
  try {
    mkdirSync(dirname(file), { recursive: true })
    if (existsSync(file)) {
      try {
        const cur = JSON.parse(readFileSync(file, 'utf8'))
        if (Array.isArray(cur)) copyFileSync(file, file + '.bak')
      } catch (e) {
        try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch (e2) { /* 保留现场失败可忽略 */ }
      }
    }
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, file)
    return true
  } catch (e) {
    console.error('[teamflow] writeJson failed', file, (e         )?.message)
    return false
  }
}

/* ── journal（运行日志）序列化 / 持久化 / 加载 ────────────────────── */
/** 阶段产物全文保留上限（dev 任务等大输出裁剪；重跑时足够重建上下文）。 */
export const STAGE_OUTPUT_CLIP = 50000

function clip(text         , n        )         {
  const s = text === null || text === undefined ? '' : String(text)
  return s.length > n ? s.slice(0, n) : s
}

/** journal → 可持久化 JSON（阶段含 output，供断点续跑重建产物）。 */
export function serializeJournal(journal               )                {
  return {
    id: journal.id,
    name: journal.name,
    status: journal.status,
    requirement: journal.requirement,
    options: journal.options,
    // 引擎留痕（2026-09-18）：run 起始模型路由（provider/model）——排查「是不是模型的锅」的第一手依据
    engine: journal.engine || null,
    workspace: journal.workspace || null,
    workspacePath: journal.workspacePath || null,
    ownerSession: journal.ownerSession || null,
    product: journal.product || null,
    locale: journal.locale || null,
    sanity: journal.sanity || null,
    blueprint: journal.blueprint || null,
    reqId: journal.reqId || null,
    runDocs: journal.runDocs || null,
    // 分支与合回决策留痕（结构性门禁发现：这两个字段也曾**只写不落盘**）
    branch: journal.branch || null,
    mergeStatus: journal.mergeStatus || null,
    taskId: journal.taskId || null,
    taskMap: journal.taskMap || {},
    agentsStarted: journal.agentsStarted || 0,
    humanIntervention: journal.humanIntervention === true,
    /** E 方案（2026-09-15）：本轮验收是「已知问题」只读模式（QA 打回超限后补跑）——report 据此给
     *  「结论被强制为需人工裁定、不要据此合回」的显式提示（持久化：重启/resume 后仍可判）。 */
    knownIssuesAcceptance: journal.knownIssuesAcceptance === true,
    cancelled: journal.cancelled === true,
    /** 取消来源（ui=界面按钮/人工，tool=模型工具，unknown=历史 run）：主线程据此判断「谁停的」。 */
    cancelSource: journal.cancelSource || null,
    cancelRequestedAt: journal.cancelRequestedAt || null,
    /** 需求澄清闸门（2026-09-16 Phase 1）：分诊裁决（intent/blockers）+ PRD 假设段 + 澄清答复。
     *  裁决是 shadow 埋点（Phase 2 定闸门强度的数据源）；假设段是「agent 替你决定了什么」的可见化。 */
    triage: journal.triage || null,
    assumptions: journal.assumptions || null,
    hostResearch: journal.hostResearch === true,
    hostContract: journal.hostContract || null,
    installEnv: journal.installEnv || null,
    requirementSupplement: journal.requirementSupplement || null,
    // PRD 确认单（ADR-0011 ①）：暂停后重启也要能把「批准什么」讲给用户（见上方 JournalRecord 注释）
    confirmSheet: journal.confirmSheet || null,
    // 本轮 PRD 的结构化输出快照（2026-10-16 修「汇报层串了模版」）：**必须落盘**，
    // 否则 resume/重跑时确认单与闸门又退回读累积 state（结构门禁 journal.test.js 当场抓到漏写）
    prdSnapshot: journal.prdSnapshot || null,
    // PRD 版本 + 已批准版本（2026-10-17，issue #11）：确认单的「批准失效」判据**必须跨进程存活**——
    // 暂停后重启、或 resume 判断时都要读它。漏写 ⇒ 重启后 approvedRev 归零 ⇒ 同一版 PRD 被反复打断
    // （结构门禁 journal.test.js 会当场抓到漏写）。
    prdRev: Number(journal.prdRev || 0) || 0,
    confirmApprovedRev: journal.confirmApprovedRev == null ? null : (Number(journal.confirmApprovedRev) || 0),
    // 产出当前 PRD 的子代理 id（redo 续跑用；阶段记录被摘掉后它是唯一线索）
    prdChildId: journal.prdChildId || null,
    // PRD 阶段的用量累计（跨改写轮次；节点卡是「本阶段总用量」，不是「这一轮」）
    prdUsageAcc: journal.prdUsageAcc || null,
    /** 外部供应商故障标记（限流/无额度/上游故障/超时）：run 落可续跑中断态时置位，汇报据此讲清「非交付缺陷」。 */
    externalFailure: journal.externalFailure === true,
    interrupted: journal.interrupted === true,
    interruptedAt: journal.interruptedAt || null,
    supersededBy: journal.supersededBy || null,
    startedAt: journal.startedAt,
    endedAt: journal.endedAt,
    error: journal.error || null,
    stages: (journal.stages || []).map((s) => ({
      seq: s.seq,
      label: s.label,
      phase: s.phase,
      taskKey: s.taskKey || null,
      taskIds: (Array.isArray(s.taskIds) && s.taskIds.length) ? s.taskIds : null,
      // 该阶段**实际生效**的模型路由（子代理可被改道，故逐阶段记）
      provider: s.provider || null,
      model: s.model || null,
      status: s.status,
      outcome: s.outcome || null,
      childId: s.childId || null,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      usage: s.usage || null,
      handoff: clip(s.handoff || '', 2000),
      summary: clip(s.summary || '', 3000),
      // 护栏中止留痕（结构性门禁发现：这两个字段曾**只写不落盘**——内存里写了、serialize 丢了）
      guardReason: s.guardReason || null,
      guardOutcome: s.guardOutcome || null,
      envUnavailable: s.envUnavailable || null,
      // 产物新鲜度基线（2026-10-16）：有内容才写，避免给存量 stage 平添 null 噪声
      artifactBaseline: (s.artifactBaseline && Object.keys(s.artifactBaseline).length) ? { ...s.artifactBaseline } : null,
      output: clip(s.output || s.summary || '', STAGE_OUTPUT_CLIP),
      verifyEvidence: s.verifyEvidence ? clip(s.verifyEvidence, 8000) : null,
    })),
    qaReworkRound: Number(journal.qaReworkRound || 0) || 0,
    qaReworkResumes: Number(journal.qaReworkResumes || 0) || 0,
    qaFixSummaries: Array.isArray(journal.qaFixSummaries)
      ? journal.qaFixSummaries.slice(-6).map((s) => clip(String(s || ''), 3000))
      : [],
    logs: (journal.logs || []).slice(-300).map((l) => ({ t: l.t, level: l.level, message: clip(l.message, 500) })),
    // D 埋点（2026-09-15）：逐轮 QA 阻断集合（稳定身份 = 检测命令优先）。留最近 12 轮、每轮最多 20 条缺陷。
    qaRounds: (journal.qaRounds || []).slice(-12).map((r) => ({
      round: r.round, seq: r.seq, blocking: r.blocking, p3: r.p3,
      defects: Array.isArray(r.defects)
        ? (r.defects                                  )
          .slice(0, 20)
          .map((d) => ({ id: clip(d.id, 40), sev: d.sev, module: clip(d.module, 60), fp: clip(d.fp, 200) }))
        : [],
      withCheck: r.withCheck, withCriterion: r.withCriterion,
      qaCalls: r.qaCalls, fixCalls: r.fixCalls, gate: r.gate,
      newFps: r.newFps, repeats: r.repeats, resolved: r.resolved,
      outcome: r.outcome,
    })),
  }
}

/**
 * **追加一行 JSONL**（append-only 事件流；ADR-0010 D2）。
 *
 * 与 `writeJson` 的区别不是风格而是**语义**：`writeJson` 是快照（覆盖，只保留最新状态），
 * 本函数是**事件流**（每次调用留一行，早期事件永不丢失）。
 *
 * 为什么必须存在（2026-09-30 实锤）：澄清闸门命中时**不建 run**，此时 journal 还不存在；
 * 若只把「澄清成功并建了 run」的样本记下来，就看不到「问了但用户没答」「反复问直到放弃」——
 * 幸存者偏差，正是那次「闸门从未触发」错误统计的同型成因。
 *
 * 单行写入不产生半截文件，故不做 tmp+rename；失败返回 false 不抛（观测是旁路，不得拦住主流程）。
 */
export function appendJsonl(file        , obj         )          {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8')
    return true
  } catch (e) {
    console.error('[teamflow] appendJsonl failed', file, (e         )?.message)
    return false
  }
}

/** 通用文本写（原子写 + 递归建目录），供 run 日志等使用。 */
export function writeText(file        , text        )          {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
    return true
  } catch (e) {
    console.error('[teamflow] writeText failed', file, (e         )?.message)
    return false
  }
}

/* ── 运行日志落点（B 方案 2026-09-15：日志根离开用户项目） ──────────────
 * 背景：子代理受 DSH 文件沙箱约束（workspace-write = **只允许写会话工作区 + 平台临时区**，
 * 实测 `$DSH_HOME` 写入被拒），所以子代理产出的命令日志只能先在**工作区内暂存**；
 * run 结束由 host（进程侧无沙箱限制）归档到 `$DSH_HOME/teamflow/<workspace>/logs/<runId>/`
 * 并把暂存目录从项目里删掉——项目内不留存、`$DSH_HOME` 侧按最近 K 次保留（见 host/core/workspace/runlogs.ts）。
 */

/** 工作区内暂存目录段（与 host/constants.TF_LOG_DIR 同址；store 是独立 entry、刻意不引 host 代码，一致性由 test/runlogs.test.js 守门）。 */
const STAGING_SEGMENTS = ['logs', 'teamflow']         

/** 归档用的工作区槽位：优先 journal.workspace，缺失/兜底时按 workspacePath 派生（与 backlog 同键）。 */
function logWorkspaceKey(journal               )                {
  const w = journal && typeof journal.workspace === 'string' ? journal.workspace.trim() : ''
  if (w && w !== 'default') return w
  const p = journal ? journal.workspacePath : null
  return p ? slugPath(p) : null
}

/** 归档根（工作区级）：`$DSH_HOME/teamflow/<workspace>/logs/`（每个 run 一个子目录）。 */
export function logsArchiveRoot(journal               )                {
  const key = logWorkspaceKey(journal)
  return key ? join(teamflowRoot(), key, 'logs') : null
}

/** 归档落点（run 级目录）：`$DSH_HOME/teamflow/<workspace>/logs/<runId>/`（与 journal/backlog 同槽位）。 */
export function runLogArchiveDir(journal               )                {
  const root = logsArchiveRoot(journal)
  return root ? join(root, journal.id) : null
}

/** 工作区内暂存落点（子代理写、run 结束归档后删除）：`<workspacePath>/logs/teamflow/<runId>/`。 */
export function runLogStagingDir(journal               )                {
  if (!journal.workspacePath) return null
  return join(journal.workspacePath, ...STAGING_SEGMENTS, journal.id)
}

/** host 事件日志落点：`<归档 run 目录>/run.log`（run 期间即写终态位置，无需搬运）。 */
export function runLogFile(journal               )                {
  const dir = runLogArchiveDir(journal)
  return dir ? join(dir, 'run.log') : null
}

/** 把运行事件日志聚合写到 `$DSH_HOME/teamflow/<workspace>/logs/<runId>/run.log`（logs 离开用户项目）。 */
export function persistRunLog(journal               )          {
  const file = runLogFile(journal)
  if (!file) return false
  const lines = [
    // 文件头随 run 语言（R3-1③）：store.ts 是独立 lib entry、不引 host 词典（保持持久化层零 host 依赖），
    // 故只在这一行内联两语言取值；其余行是 `key=value` 机器可读格式，无需本地化。
    journal.locale === 'en' ? `# TeamFlow run log (${journal.name})` : `# TeamFlow 运行日志（${journal.name}）`,
    `runId=${journal.id}`,
    `workspace=${journal.workspacePath || ''}`,
    `product=${journal.product || ''}`,
    `status=${journal.status}`,
    `startedAt=${journal.startedAt ? new Date(journal.startedAt).toISOString() : ''}`,
    `endedAt=${journal.endedAt ? new Date(journal.endedAt).toISOString() : ''}`,
    `requirement=${journal.requirement || ''}`,
    '',
  ]
  for (const l of (journal.logs || []).slice(-300)) {
    lines.push(`[${l.t ? new Date(l.t).toISOString() : ''}] ${l.level}: ${l.message}`)
  }
  if (journal.error) lines.push('', `ERROR: ${journal.error}`)
  return writeText(file, lines.join('\n') + '\n')
}

/** 原子写 journal 文件（新 journal 写 per-project runs/，旧 journal 写全局 runs/）。 */
export function persistJournal(journal               )          {
  // 有 workspace 字段的新 journal → 写到 per-project runs/
  if (journal.workspace && journal.workspace !== 'default') {
    const projectDir = join(teamflowRoot(), journal.workspace, 'runs')
    const file = join(projectDir, `${journal.id}.json`)
    const ok = writeJson(file, serializeJournal(journal))
    if (ok && journal.workspacePath) persistRunLog(journal)
    return ok
  }
  // 旧格式 / 兜底 → 写到全局 runs/
  const ok = writeJson(journalFile(journal.id), serializeJournal(journal))
  if (ok && journal.workspacePath) persistRunLog(journal)
  return ok
}

/**
 * 按 id 从磁盘读**单个** journal（2026-09-26）：先扫 per-project `$DSH_HOME/teamflow/<project>/runs/`，
 * 再查全局 `$DSH_HOME/teamflow/runs/`（与 persistJournal 的写路径一一对应）。
 * 用途：① 内存 run 注册表淘汰后的回读（context.getRun 统一入口）；
 * ② resume 的权威磁盘读——旧实现只查全局路径（journalFile），per-project 新格式 journal
 *    一直靠启动时 loadJournals 的内存兜底才续得上（隐性缺口，此处一并修正）。
 * runId 必须通过 `^[A-Za-z0-9-]+$` 白名单（journal.id 形如 tf-xxx-xxx），防路径拼接注入。
 */
export function loadJournalById(runId        )                       {
  if (!runId || !/^[A-Za-z0-9-]+$/.test(runId)) return null
  try {
    const root = teamflowRoot()
    if (existsSync(root)) {
      for (const d of readdirSync(root)) {
        const p = join(root, d, 'runs', `${runId}.json`)
        if (!existsSync(p)) continue
        const j = readJsonAny                      (p, null)
        if (j && typeof j === 'object' && j.id === runId) return j
      }
    }
    const j = readJsonAny                      (journalFile(runId), null)
    return j && typeof j === 'object' && j.id === runId ? j : null
  } catch (e) { return null }
}

/**
 * 启动时扫描磁盘 journal：
 * - 全局 $DSH_HOME/teamflow/runs/（兼容旧格式）
 * - 各 per-project $DSH_HOME/teamflow/<project>/runs/（新格式）
 * - 正常状态原样载入；running/pending → 标记 interrupted（进程崩溃/重启残留）。
 * @returns 全部历史 run（含是否本次被标记中断）。
 */
export function loadJournals()                                                             {
  const out                                                             = []
  const seen = new Set        () // 去重（同一 journal 不要重复加载）
  const loadDir = (dir        ) => {
    try {
      if (!existsSync(dir)) return
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json') || f.includes('.bak') || f.includes('.tmp') || f.includes('.corrupt')) continue
        const j = readJsonAny                      (join(dir, f), null)
        if (!j || typeof j !== 'object' || typeof j.id !== 'string') continue
        if (seen.has(j.id)) continue
        seen.add(j.id)
        let wasInterrupted = false
        if (j.status === 'running' || j.status === 'pending') {
          j.status = 'interrupted'
          j.interrupted = true
          j.interruptedAt = Date.now()
          j.endedAt = j.endedAt || Date.now()
          for (const s of (j.stages || [])) {
            if (s.status === 'running') { s.status = 'interrupted'; s.endedAt = s.endedAt || Date.now() }
          }
          writeJson(join(dir, f), j)
          wasInterrupted = true
          out.push({ journal: j, wasInterrupted })
        } else {
          out.push({ journal: j, wasInterrupted })
        }
      }
    } catch (e) { /* 单目录失败不影响其他 */ }
  }
  try {
    // 1. 全局 runs/（兼容旧格式 journal）
    loadDir(runsDir())
    // 2. per-project runs/（新格式 journal）
    const root = teamflowRoot()
    if (existsSync(root)) {
      for (const entry of readdirSync(root)) {
        const sub = join(root, entry)
        try {
          if (entry === 'runs') continue // 全局已扫描
          if (existsSync(sub) && readdirSync(sub).includes('runs')) {
            loadDir(join(sub, 'runs'))
          }
        } catch (e) { /* 跳过非目录 */ }
      }
    }
  } catch (e) {
    console.error('[teamflow] loadJournals failed', (e         )?.message)
  }
  return out
}


//# sourceURL=file:///G:/SarosWorkspace/sarosis-agents-client/incubator/dsh-plugin-teamflow/store.ts