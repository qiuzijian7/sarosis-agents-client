import { useState } from 'react'

const feedbackTypes = [
  { id: 'bug', label: 'Bug 报告', icon: '🐛', color: '#f38ba8' },
  { id: 'feature', label: '功能建议', icon: '💡', color: '#f9e2af' },
  { id: 'question', label: '使用问题', icon: '❓', color: '#89b4fa' },
  { id: 'other', label: '其他', icon: '💬', color: '#a6e3a1' },
]

export default function Feedback() {
  const [type, setType] = useState('bug')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState(null)

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!title.trim() || !content.trim()) return

    setSubmitting(true)
    setResult(null)

    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          title: title.trim(),
          content: content.trim(),
          email: email.trim(),
          timestamp: new Date().toISOString(),
        }),
      })

      const data = await res.json()
      if (data.ok) {
        setResult({ success: true, message: '反馈已提交，感谢你的贡献！' })
        setTitle('')
        setContent('')
        setEmail('')
      } else {
        setResult({ success: false, message: data.error || '提交失败，请稍后重试' })
      }
    } catch {
      setResult({ success: false, message: '网络错误，请检查网络连接' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section id="feedback" className="py-24 md:py-32 relative">
      <div className="max-w-3xl mx-auto px-6">
        {/* Section header */}
        <div className="text-center mb-16">
          <span className="text-primary-400 font-semibold text-sm tracking-wider uppercase mb-4 block">
            Feedback
          </span>
          <h2 className="section-title text-white">
            问题与 <span className="gradient-text">反馈</span>
          </h2>
          <p className="text-[#8888a0] text-lg max-w-xl mx-auto mt-4">
            遇到问题或有新功能想法？告诉我们，反馈将自动汇总到飞书文档中。
          </p>
        </div>

        {/* Feedback form */}
        <div className="glass-card p-8">
          <form onSubmit={handleSubmit}>
            {/* Type selector */}
            <div className="mb-6">
              <label className="text-sm font-medium text-[#8888a0] mb-3 block">反馈类型</label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {feedbackTypes.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setType(t.id)}
                    className={`flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                      type === t.id
                        ? 'bg-primary-600/20 border border-primary-600/40 text-white'
                        : 'bg-[#1a1a24] border border-[#2a2a3a] text-[#8888a0] hover:border-[#3a3a4a]'
                    }`}
                  >
                    <span>{t.icon}</span>
                    <span>{t.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Title */}
            <div className="mb-4">
              <label className="text-sm font-medium text-[#8888a0] mb-2 block">
                标题 <span className="text-[#f38ba8]">*</span>
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="简要描述你的反馈"
                required
                className="w-full px-4 py-3 rounded-xl bg-[#1a1a24] border border-[#2a2a3a] text-white placeholder-[#6c7086] focus:outline-none focus:border-primary-600 transition-colors"
              />
            </div>

            {/* Content */}
            <div className="mb-4">
              <label className="text-sm font-medium text-[#8888a0] mb-2 block">
                详细描述 <span className="text-[#f38ba8]">*</span>
              </label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="详细描述你遇到的问题或建议..."
                required
                rows={5}
                className="w-full px-4 py-3 rounded-xl bg-[#1a1a24] border border-[#2a2a3a] text-white placeholder-[#6c7086] focus:outline-none focus:border-primary-600 transition-colors resize-none"
              />
            </div>

            {/* Email (optional) */}
            <div className="mb-6">
              <label className="text-sm font-medium text-[#8888a0] mb-2 block">
                邮箱 <span className="text-[#6c7086]">(可选，用于回复)</span>
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@email.com"
                className="w-full px-4 py-3 rounded-xl bg-[#1a1a24] border border-[#2a2a3a] text-white placeholder-[#6c7086] focus:outline-none focus:border-primary-600 transition-colors"
              />
            </div>

            {/* Submit button */}
            <button
              type="submit"
              disabled={submitting || !title.trim() || !content.trim()}
              className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? (
                <>
                  <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  提交中...
                </>
              ) : (
                <>
                  <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  提交反馈
                </>
              )}
            </button>
          </form>

          {/* Result message */}
          {result && (
            <div className={`mt-4 p-4 rounded-xl text-sm ${
              result.success
                ? 'bg-accent-500/10 border border-accent-500/20 text-accent-400'
                : 'bg-[#f38ba8]/10 border border-[#f38ba8]/20 text-[#f38ba8]'
            }`}>
              {result.success ? '✅ ' : '❌ '}{result.message}
            </div>
          )}

          {/* Feishu integration info */}
          <div className="mt-6 pt-4 border-t border-[#2a2a3a]">
            <div className="flex items-center gap-2 text-[#6c7086] text-xs">
              <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" transform="scale(0.583)"/>
                <path d="M9 9h6M9 13h4" strokeLinecap="round" transform="scale(0.583)"/>
              </svg>
              <span>反馈将自动汇总到飞书文档，团队会及时查看处理</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
