export default function Footer() {
  return (
    <footer className="py-12 border-t border-[#2a2a3a]">
      <div className="max-w-7xl mx-auto px-6">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary-600 to-accent-500 flex items-center justify-center">
              <svg width="16" height="16" viewBox="0 0 32 32" fill="none">
                <path d="M6 8h4v16H6V8zm8 0h4v7h-4V8zm8 0h4v11h-4V8z" fill="white" opacity="0.9"/>
              </svg>
            </div>
            <span className="text-[#8888a0] text-sm">
              VsSarosis — AI 驱动的多智能体开发环境
            </span>
          </div>

          <div className="flex items-center gap-6 text-sm text-[#6c7086]">
            <a href="#features" className="hover:text-white transition-colors">特色</a>
            <a href="#download" className="hover:text-white transition-colors">下载</a>
            <a href="#feedback" className="hover:text-white transition-colors">反馈</a>
            <span>|</span>
            <span>MIT License</span>
          </div>
        </div>

        <div className="mt-8 text-center text-xs text-[#6c7086]">
          基于 VS Code OSS 开发 · Powered by Agent Studio
        </div>
      </div>
    </footer>
  )
}
