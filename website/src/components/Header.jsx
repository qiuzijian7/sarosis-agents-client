export default function Header({ scrollY }) {
  const isScrolled = scrollY > 50

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        isScrolled
          ? 'bg-[#0a0a0f]/90 backdrop-blur-xl border-b border-[#2a2a3a]'
          : 'bg-transparent'
      }`}
    >
      <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
        <a href="#" className="flex items-center gap-3 group">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-primary-600 to-accent-500 flex items-center justify-center">
            <svg width="20" height="20" viewBox="0 0 32 32" fill="none">
              <path d="M6 8h4v16H6V8zm8 0h4v7h-4V8zm8 0h4v11h-4V8z" fill="white" opacity="0.9"/>
              <circle cx="24" cy="24" r="4" fill="#10b981"/>
              <path d="M23 23l2 2 3-3" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <span className="text-xl font-bold text-white group-hover:text-primary-400 transition-colors">
            VsSarosis
          </span>
        </a>

        <nav className="hidden md:flex items-center gap-8">
          <a href="#features" className="text-sm text-[#8888a0] hover:text-white transition-colors">
            特色功能
          </a>
          <a href="#download" className="text-sm text-[#8888a0] hover:text-white transition-colors">
            下载
          </a>
          <a href="#feedback" className="text-sm text-[#8888a0] hover:text-white transition-colors">
            问题反馈
          </a>
          <a
            href="#download"
            className="btn-primary text-sm !px-4 !py-2"
          >
            立即下载
          </a>
        </nav>

        {/* Mobile menu button */}
        <button className="md:hidden text-white p-2" aria-label="菜单">
          <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 12h18M3 6h18M3 18h18" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
    </header>
  )
}
