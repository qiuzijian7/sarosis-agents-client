const features = [
  {
    icon: '🤖',
    title: 'Agent Studio 多智能体工作台',
    desc: '内置 Agent Studio，支持多个 AI Agent（Employee）协同工作。每个 Agent 拥有独立的模型配置、Skill 技能集和工具链，可自主完成编码、调试、测试等复杂任务。',
    tags: ['多 Agent 编排', '任务委派', 'SubAgent 调度'],
  },
  {
    icon: '🌐',
    title: 'Browser-Use 浏览器自动化',
    desc: '集成 Browser-Use 引擎，AI Agent 可自主操控浏览器、填写表单、提取数据，实现端到端的 Web 自动化流程，无需人工干预。',
    tags: ['CDP 协议控制', 'DOM 智能提取', '自主浏览'],
  },
  {
    icon: '🛠️',
    title: 'Skill 技能系统',
    desc: '灵活的 SKILL.md 驱动的技能注册机制。为 Agent 注入专业能力——代码审查、数据库操作、API 调用等，技能即插即用，无限扩展。',
    tags: ['SKILL.md 规约', '按需激活', '社区共享'],
  },
  {
    icon: '🔄',
    title: '自动热更新',
    desc: '内置更新服务器，客户端每小时自动检测新版本。后台静默下载，下次重启即完成升级，用户无感知。支持增量发布和版本回滚。',
    tags: ['静默更新', '版本对比', '零停机'],
  },
  {
    icon: '🎨',
    title: '多模型适配',
    desc: '支持 OpenAI、Anthropic、Google Gemini、Ollama 等多家 LLM 提供商。统一适配层抽象，自由切换模型，适应不同场景需求。',
    tags: ['OpenAI', 'Gemini', 'Ollama'],
  },
  {
    icon: '🔒',
    title: '安全与私有化',
    desc: '完全开源，基于 VS Code OSS。数据本地存储，支持私有化部署更新服务器和 Agent 模型。企业级安全，代码不离境。',
    tags: ['MIT 开源', '本地数据', '私有部署'],
  },
]

export default function Features() {
  return (
    <section id="features" className="py-24 md:py-32 relative">
      <div className="max-w-7xl mx-auto px-6">
        {/* Section header */}
        <div className="text-center mb-16">
          <span className="text-primary-400 font-semibold text-sm tracking-wider uppercase mb-4 block">
            Core Features
          </span>
          <h2 className="section-title text-white">
            为什么选择 <span className="gradient-text">VsSarosis</span>
          </h2>
          <p className="text-[#8888a0] text-lg max-w-2xl mx-auto mt-4">
            不只是代码编辑器，更是 AI 原生的智能开发环境
          </p>
        </div>

        {/* Feature cards */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((f, i) => (
            <div
              key={i}
              className="glass-card glow-border p-6 hover:bg-[#1a1a24] transition-all duration-300 group"
            >
              <div className="feature-icon mb-4 text-2xl">
                {f.icon}
              </div>
              <h3 className="text-lg font-semibold text-white mb-3 group-hover:text-primary-400 transition-colors">
                {f.title}
              </h3>
              <p className="text-[#8888a0] text-sm leading-relaxed mb-4">
                {f.desc}
              </p>
              <div className="flex flex-wrap gap-2">
                {f.tags.map((tag, j) => (
                  <span
                    key={j}
                    className="px-2.5 py-1 rounded-md text-xs font-medium bg-primary-600/10 text-primary-400 border border-primary-600/20"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Architecture highlight */}
        <div className="mt-20 glass-card p-8 md:p-12">
          <div className="grid md:grid-cols-2 gap-8 items-center">
            <div>
              <h3 className="text-2xl font-bold text-white mb-4">
                Agent Studio 架构
              </h3>
              <p className="text-[#8888a0] leading-relaxed mb-6">
                采用分层架构设计：AgentOS 操作系统层 → AgentDriver 驱动层 → Provider 能力层 →
                Adapter 适配层，各层解耦，灵活扩展。
              </p>
              <div className="space-y-3">
                {[
                  { name: 'AgentOS', desc: '智能体操作系统，管理生命周期' },
                  { name: 'AgentDriver', desc: '任务编排与流控引擎' },
                  { name: 'Provider', desc: '工具/检索/模型能力提供' },
                  { name: 'Adapter', desc: '多模型统一适配层' },
                ].map((layer, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full bg-accent-500" />
                    <span className="text-primary-400 font-medium text-sm">{layer.name}</span>
                    <span className="text-[#8888a0] text-sm">— {layer.desc}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="relative">
              <div className="space-y-3">
                {[
                  { label: '用户输入', color: 'from-primary-600 to-primary-800' },
                  { label: 'AgentOS 调度', color: 'from-primary-500 to-primary-700' },
                  { label: 'Driver 编排', color: 'from-accent-500 to-accent-700' },
                  { label: 'Provider 执行', color: 'from-accent-400 to-accent-600' },
                  { label: '结果返回', color: 'from-primary-600 to-primary-800' },
                ].map((step, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className={`w-full h-10 rounded-lg bg-gradient-to-r ${step.color} opacity-80 flex items-center px-4`}>
                      <span className="text-white text-sm font-medium">{step.label}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="absolute -right-2 top-1/2 -translate-y-1/2 w-4 h-4 border-r-2 border-b-2 border-accent-500 transform rotate-45" />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
