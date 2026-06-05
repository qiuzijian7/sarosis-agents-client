export default function Issues() {
  return (
    <section id="issues" className="py-24 md:py-32 relative">
      <div className="max-w-5xl mx-auto px-6">
        {/* Section header */}
        <div className="text-center mb-16">
          <span className="text-primary-400 font-semibold text-sm tracking-wider uppercase mb-4 block">
            Community
          </span>
          <h2 className="section-title text-white">
            问题与 <span className="gradient-text">讨论</span>
          </h2>
          <p className="text-[#8888a0] text-lg max-w-xl mx-auto mt-4">
            在工蜂 Issues 中提出问题、报告 Bug 或参与功能讨论
          </p>
        </div>

        {/* Git Issues CTA */}
        <div className="glass-card p-8 md:p-12 text-center">
          <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-primary-600/20 to-accent-500/20 flex items-center justify-center text-4xl">
            🐛
          </div>

          <h3 className="text-2xl font-bold text-white mb-4">
            前往工蜂 Issues
          </h3>
          <p className="text-[#8888a0] max-w-2xl mx-auto mb-8 leading-relaxed">
            在这里你可以：<br/>
            提交 Bug 报告 · 提出功能建议 · 参与社区讨论 · 查看已解决的问题
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <a
              href="https://git.woa.com/zijianqiu/vssarosis_issue/issues/new"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary text-lg flex items-center gap-2"
            >
              <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5v14M5 12h14" strokeLinecap="round"/>
              </svg>
              新建 Issue
            </a>
            <a
              href="https://git.woa.com/zijianqiu/vssarosis_issue/issues?state=opened&sort=created_desc&page=1"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary text-lg"
            >
              查看所有 Issues
            </a>
          </div>

          <div className="mt-8 pt-6 border-t border-[#2a2a3a] text-sm text-[#6c7086]">
            <p>需要帮助？也可以直接在工蜂 Issues 中搜索相关问题</p>
          </div>
        </div>
      </div>
    </section>
  )
}
