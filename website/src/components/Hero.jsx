export default function Hero() {
  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden pt-20">
      {/* Background glows */}
      <div className="hero-glow bg-primary-600 top-1/4 -left-40" />
      <div className="hero-glow bg-accent-500 bottom-1/4 -right-40" />

      <div className="max-w-7xl mx-auto px-6 text-center relative z-10">
        {/* Badge */}
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-primary-600/10 border border-primary-600/20 text-primary-400 text-sm font-medium mb-8 animate-fade-in-up">
          <span className="w-2 h-2 rounded-full bg-accent-500 animate-pulse" />
          AI 驱动 · 多智能体协作 · 自动热更新
        </div>

        {/* Title */}
        <h1 className="text-5xl md:text-7xl font-extrabold leading-tight mb-6 animate-fade-in-up" style={{animationDelay: '0.1s'}}>
          <span className="text-white">重新定义</span>
          <br />
          <span className="gradient-text">开发环境</span>
        </h1>

        {/* Subtitle */}
        <p className="text-lg md:text-xl text-[#8888a0] max-w-2xl mx-auto mb-10 animate-fade-in-up" style={{animationDelay: '0.2s'}}>
          VsSarosis 基于 VS Code 打造，内置 Agent Studio 多智能体工作台，
          支持 AI 自主编程、浏览器自动化、Skill 技能系统与自动热更新，
          让开发效率倍增。
        </p>

        {/* CTA Buttons */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16 animate-fade-in-up" style={{animationDelay: '0.3s'}}>
          <a href="#download" className="btn-primary text-lg flex items-center gap-2">
            <svg width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            免费下载
          </a>
          <a href="#features" className="btn-secondary text-lg">
            了解更多
          </a>
        </div>

        {/* Preview image mockup */}
        <div className="relative max-w-5xl mx-auto animate-fade-in-up" style={{animationDelay: '0.4s'}}>
          <div className="glass-card p-1 animate-pulse-glow">
            <div className="rounded-xl overflow-hidden bg-[#1e1e2e]">
              {/* Fake editor titlebar */}
              <div className="flex items-center gap-2 px-4 py-2.5 bg-[#181825] border-b border-[#313244]">
                <div className="flex gap-1.5">
                  <div className="w-3 h-3 rounded-full bg-[#f38ba8]" />
                  <div className="w-3 h-3 rounded-full bg-[#f9e2af]" />
                  <div className="w-3 h-3 rounded-full bg-[#a6e3a1]" />
                </div>
                <span className="text-xs text-[#6c7086] ml-2">VsSarosis — Agent Studio</span>
              </div>
              {/* Fake editor content */}
              <div className="p-6 text-left font-mono text-sm leading-8 h-64 md:h-80 overflow-hidden">
                <div className="flex gap-4">
                  <div className="text-[#6c7086] select-none">
                    <div>1</div><div>2</div><div>3</div><div>4</div><div>5</div><div>6</div><div>7</div><div>8</div><div>9</div>
                  </div>
                  <div>
                    <div><span className="text-[#cba6f7]">import</span> <span className="text-[#f9e2af]">{'{ AgentStudio }'}</span> <span className="text-[#cba6f7]">from</span> <span className="text-[#a6e3a1]">'@vssarosis/agent-studio'</span></div>
                    <div><span className="text-[#cba6f7]">import</span> <span className="text-[#f9e2af]">{'{ BrowserUse }'}</span> <span className="text-[#cba6f7]">from</span> <span className="text-[#a6e3a1]">'@vssarosis/browser-use'</span></div>
                    <div className="text-[#6c7086]">{'// 创建多智能体协作任务'}</div>
                    <div><span className="text-[#cba6f7]">const</span> <span className="text-[#89b4fa]">agent</span> = <span className="text-[#cba6f7]">new</span> <span className="text-[#89b4fa]">AgentStudio</span>({'{'}</div>
                    <div className="pl-4"><span className="text-[#f9e2af]">model</span>: <span className="text-[#a6e3a1]">'gpt-4o'</span>,</div>
                    <div className="pl-4"><span className="text-[#f9e2af]">skills</span>: [<span className="text-[#a6e3a1]">'code-edit'</span>, <span className="text-[#a6e3a1]">'browser'</span>],</div>
                    <div className="pl-4"><span className="text-[#f9e2af]">autoUpdate</span>: <span className="text-[#cba6f7]">true</span></div>
                    <div>{'}'})</div>
                    <div><span className="text-[#cba6f7]">await</span> <span className="text-[#89b4fa]">agent</span>.<span className="text-[#89b4fa]">delegate</span>(<span className="text-[#a6e3a1]">'重构认证模块并更新测试'</span>)</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          {/* Decorative floating elements */}
          <div className="absolute -top-4 -right-4 w-24 h-24 rounded-2xl bg-gradient-to-br from-primary-600/20 to-accent-500/20 backdrop-blur-sm border border-primary-600/20 flex items-center justify-center animate-float">
            <span className="text-2xl">🤖</span>
          </div>
          <div className="absolute -bottom-4 -left-4 w-20 h-20 rounded-2xl bg-gradient-to-br from-accent-500/20 to-primary-600/20 backdrop-blur-sm border border-accent-500/20 flex items-center justify-center animate-float" style={{animationDelay: '1s'}}>
            <span className="text-xl">⚡</span>
          </div>
        </div>
      </div>
    </section>
  )
}
