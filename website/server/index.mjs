import express from 'express'
import cors from 'cors'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3001

// 飞书文档 token - 反馈汇总文档
// 部署后通过环境变量 LARK_DOC_TOKEN 或手动设置
const LARK_DOC_TOKEN = process.env.LARK_DOC_TOKEN || ''
const LARK_CLI_PATH = process.env.LARK_CLI_PATH || 'lark-cli'

app.use(cors())
app.use(express.json())

// 静态文件服务（生产模式）
const distPath = path.join(__dirname, '..', 'dist')
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath))
}

// 反馈类型映射
const typeLabels = {
  bug: '🐛 Bug 报告',
  feature: '💡 功能建议',
  question: '❓ 使用问题',
  other: '💬 其他',
}

/**
 * 将反馈内容追加到飞书文档
 */
async function appendToLarkDoc(feedback) {
  const { type, title, content, email, timestamp } = feedback
  const date = new Date(timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  const typeLabel = typeLabels[type] || type

  const markdown = [
    `---`,
    `**${typeLabel}** | ${date}`,
    `## ${title}`,
    content,
    email ? `> 联系邮箱: ${email}` : '',
    '',
  ].filter(Boolean).join('\n')

  if (!LARK_DOC_TOKEN) {
    // 没有配置飞书文档 token，保存到本地文件作为后备
    const feedbackDir = path.join(__dirname, 'feedback-data')
    if (!fs.existsSync(feedbackDir)) {
      fs.mkdirSync(feedbackDir, { recursive: true })
    }
    const filename = `feedback-${Date.now()}.json`
    fs.writeFileSync(
      path.join(feedbackDir, filename),
      JSON.stringify({ ...feedback, typeLabel, date }, null, 2)
    )
    console.log(`[Feedback] 保存到本地: ${filename}`)
    return { ok: true, method: 'local' }
  }

  try {
    // 使用 lark-cli 将反馈追加到飞书文档
    const cmd = `${LARK_CLI_PATH} docs +update ${LARK_DOC_TOKEN} --markdown "${markdown.replace(/"/g, '\\"')}" --mode append`
    execSync(cmd, { timeout: 15000, encoding: 'utf-8' })
    console.log(`[Feedback] 已追加到飞书文档: ${LARK_DOC_TOKEN}`)
    return { ok: true, method: 'lark' }
  } catch (err) {
    console.error(`[Feedback] 飞书写入失败: ${err.message}`)
    // 降级到本地保存
    const feedbackDir = path.join(__dirname, 'feedback-data')
    if (!fs.existsSync(feedbackDir)) {
      fs.mkdirSync(feedbackDir, { recursive: true })
    }
    const filename = `feedback-${Date.now()}.json`
    fs.writeFileSync(
      path.join(feedbackDir, filename),
      JSON.stringify({ ...feedback, typeLabel, date }, null, 2)
    )
    return { ok: true, method: 'local-fallback' }
  }
}

/**
 * POST /api/feedback - 提交用户反馈
 */
app.post('/api/feedback', async (req, res) => {
  const { type, title, content, email, timestamp } = req.body

  // 验证必填字段
  if (!title || !content) {
    return res.status(400).json({ ok: false, error: '标题和内容不能为空' })
  }

  // 验证类型
  if (!typeLabels[type]) {
    return res.status(400).json({ ok: false, error: '无效的反馈类型' })
  }

  const feedback = {
    type,
    title: title.trim(),
    content: content.trim(),
    email: email?.trim() || '',
    timestamp: timestamp || new Date().toISOString(),
  }

  try {
    const result = await appendToLarkDoc(feedback)
    res.json({ ok: true, ...result })
  } catch (err) {
    console.error('[Feedback] 处理失败:', err)
    res.status(500).json({ ok: false, error: '服务器内部错误' })
  }
})

/**
 * GET /api/health - 健康检查
 */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'vssarosis-website',
    larkDocConfigured: !!LARK_DOC_TOKEN,
  })
})

// SPA fallback（生产模式）
if (fs.existsSync(distPath)) {
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'))
  })
}

app.listen(PORT, () => {
  console.log(`[VsSarosis Website] Server running on http://localhost:${PORT}`)
  console.log(`[Lark Doc] Token configured: ${!!LARK_DOC_TOKEN}`)
})
