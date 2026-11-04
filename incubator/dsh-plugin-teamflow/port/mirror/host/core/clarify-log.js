/**
 * dsh-plugin-teamflow core — 澄清闸门的可观测埋点（ADR-0010 D1/D2）。
 *
 * **为什么单独一个模块、而不是塞进 journal**：澄清命中时 `teamflow_start` 返回
 * `needs-clarification` 且**不建 run** —— 那一刻 journal 还不存在。而 `journal.triage.blockers`
 * 记的是**澄清之后**建 run 那一次（残余 blocker 已被收敛规则放过，恒为 0）。2026-09-30 曾据此
 * 统计得出「闸门从未触发过」的**反结论**，实际真实澄清至少 4 例（贪吃蛇的运行形态/技术栈/
 * 玩法范围、缺陷返工方式、插件安装形态）。本模块就是为堵这个盲区而建。
 *
 * **append-only（D2）**：只记「澄清成功并建了 run」的样本会重犯幸存者偏差 —— 看不到
 * 「问了但用户没答」「反复问直到用户放弃」。事件流按发生顺序落盘，不覆盖、不聚合成快照。
 *
 * **写域**：`$DSH_HOME/teamflow/<product>/clarify.jsonl`（ADR-0002 允许的写域内）。
 * **旁路**：全部失败静默 —— 观测挂掉绝不拦住启动。
 * **不记轮次**：轮次由事件流事后推导（同 fp 的 `asked` 计数，见 `clarifyRounds`），
 * 避免写入路径退化成读-改-写。
 */
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { productDir, appendJsonl } from '../../store.js'
                                                

/** 事件类型（每个事件一行）。 */
                          
                                                   
           
                                                                    
                     
                                   
              
                                                    
                                

/** 事件来源：tool 侧预检（快路径）还是 pipeline 内（权威判定）。两处**互斥**，不可相加当两次。 */
                                                    

/** 一行事件（平铺字段便于 jq；字段缺失即该事件不适用）。 */
                                
            
                     
                       
                                                     
            
                                          
                     
                 
               
                     
                 
                             
                                                         
                          
                                              
                 
                
                           
                               
                     
                              
                  
 

/** 事件流落点：`$DSH_HOME/teamflow/<product>/clarify.jsonl`。 */
export function clarifyLogFile(product                           )         {
  return join(productDir(product), 'clarify.jsonl')
}

/** 需求指纹：sha1 前 12 位（只作关联键，不作安全用途）。 */
export function requirementFp(requirement         )         {
  // trim 后再哈希：指纹是**跨调用关联键**，两侧取值路径不同（tool 侧预检 / pipeline 侧落盘），
  // 尾随空白差异不该把同一条需求裂成两个身份（与 `triageCacheKey` 同口径）。
  return createHash('sha1').update(String(requirement || '').trim()).digest('hex').slice(0, 12)
}

const clip = (s         , n        )         => String(s === null || s === undefined ? '' : s).slice(0, n)

/** 统一写入口：补 `at` 后追加一行（失败返回 false，不抛）。 */
function noteClarify(
  product                           ,
  rec                           ,
)          {
  return appendJsonl(clarifyLogFile(product), { at: Date.now(), ...rec })
}

/** 闸门命中：记录「问了什么」（这是 journal 结构上记不到的那一次）。 */
export function noteClarifyAsked(
  product                           ,
  requirement        ,
  v                                                                                                                                ,
  origin               ,
)          {
  const blockers = (v.blockers || []).map((b) => ({ settles: String(b.settles || 'other'), question: clip(b.question, 160) }))
  return noteClarify(product, {
    event: 'asked', origin, fp: requirementFp(requirement), requirement: clip(requirement, 200),
    intent: v.intent, mode: v.mode, confidence: v.confidence, source: v.source,
    blockers, blockersDropped: v.blockersDropped,
  })
}

/** 分诊退兜底：闸门**静默失效**的那一类（不拦启动）。 */
export function noteTriageFallback(
  product                           ,
  requirement        ,
  v                                    ,
  origin               ,
)          {
  return noteClarify(product, {
    event: 'triage-fallback', origin, fp: requirementFp(requirement), requirement: clip(requirement, 200),
    reason: clip(v.reason, 300), mode: v.mode,
  })
}

/** 用户答复随 run 落盘（澄清闭环走通）。 */
export function noteClarifyAnswered(
  product                           ,
  requirement        ,
  v                                                        ,
)          {
  return noteClarify(product, {
    event: 'answered', origin: 'pipeline', fp: requirementFp(requirement), requirement: clip(requirement, 200),
    runId: v.runId, mode: v.mode,
    supplementLength: String(v.supplement || '').length, supplement: clip(v.supplement, 500),
  })
}

/** 已澄清仍有残余 blocker → 按假设开工。 */
export function noteClarifyProceeded(
  product                           ,
  requirement        ,
  v                                      ,
)          {
  return noteClarify(product, {
    event: 'proceeded-with-assumptions', origin: 'pipeline',
    fp: requirementFp(requirement), requirement: clip(requirement, 200),
    runId: v.runId, assumed: v.assumed,
  })
}

/** 读事件流（供测试与报告脚本；损坏/空行跳过，绝不抛）。 */
export function readClarifyLog(product                           )                  {
  try {
    const file = clarifyLogFile(product)
    if (!existsSync(file)) return []
    const out                  = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line)                 ) } catch (e) { /* 损坏行跳过，不影响其余 */ }
    }
    return out
  } catch (e) { return [] }
}

/** 该需求迄今被问了几轮（事件流事后推导：同 fp 的 `asked` 计数）。 */
export function clarifyRounds(product                           , requirement        )         {
  const fp = requirementFp(requirement)
  return readClarifyLog(product).filter((r) => r.fp === fp && r.event === 'asked').length
}


//# sourceURL=file:///G:/SarosWorkspace/sarosis-agents-client/incubator/dsh-plugin-teamflow/host/core/clarify-log.ts