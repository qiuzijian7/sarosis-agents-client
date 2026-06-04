import { useState } from 'react'

const platforms = [
  {
    id: 'win-x64',
    label: 'Windows x64',
    icon: '🪟',
    file: 'VsSarosisUserSetup.exe',
    desc: '用户级安装，无需管理员权限',
    size: '~160 MB',
  },
  {
    id: 'win-x64-system',
    label: 'Windows x64 (系统级)',
    icon: '🖥️',
    file: 'VsSarosisSetup.exe',
    desc: '系统级安装，所有用户可用',
    size: '~160 MB',
  },
]

export default function Download() {
  const [downloading, setDownloading] = useState(null)

  const handleDownload = (platform) => {
    setDownloading(platform.id)
    // 指向更新服务器的下载地址
    const url = `http://zijianqiu-any1.devcloud.woa.com:3030/downloads/${platform.file}`
    window.open(url, '_blank')
    setTimeout(() => setDownloading(null), 3000)
  }

  return (
    <section id="download" className="py-24 md:py-32 relative">
      <div className="max-w-5xl mx-auto px-6">
        {/* Section header */}
        <div className="text-center mb-16">
          <span className="text-primary-400 font-semibold text-sm tracking-wider uppercase mb-4 block">
            Download
          </span>
          <h2 className="section-title text-white">
            下载 <span className="gradient-text">VsSarosis</span>
          </h2>
          <p className="text-[#8888a0] text-lg max-w-xl mx-auto mt-4">
            免费开源，MIT 协议。下载安装后即可享受 AI 驱动的开发体验。
          </p>
        </div>

        {/* Download cards */}
        <div className="grid sm:grid-cols-2 gap-6 mb-12">
          {platforms.map((p) => (
            <div key={p.id} className="glass-card glow-border p-8 text-center">
              <div className="text-4xl mb-4">{p.icon}</div>
              <h3 className="text-xl font-semibold text-white mb-2">{p.label}</h3>
              <p className="text-[#8888a0] text-sm mb-1">{p.desc}</p>
              <p className="text-[#6c7086] text-xs mb-6">安装包大小: {p.size}</p>
              <button
                onClick={() => handleDownload(p)}
                disabled={downloading === p.id}
                className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {downloading === p.id ? (
                  <>
                    <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    下载中...
                  </>
                ) : (
                  <>
                    <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    下载安装包
                  </>
                )}
              </button>
            </div>
          ))}
        </div>

        {/* System requirements */}
        <div className="glass-card p-6">
          <h4 className="text-white font-semibold mb-4">系统要求</h4>
          <div className="grid sm:grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-primary-400 font-medium mb-1">操作系统</p>
              <p className="text-[#8888a0]">Windows 10 / 11 (64-bit)</p>
            </div>
            <div>
              <p className="text-primary-400 font-medium mb-1">磁盘空间</p>
              <p className="text-[#8888a0]">至少 500 MB 可用空间</p>
            </div>
            <div>
              <p className="text-primary-400 font-medium mb-1">网络</p>
              <p className="text-[#8888a0]">用于自动更新和 AI 功能</p>
            </div>
          </div>
          <div className="mt-4 pt-4 border-t border-[#2a2a3a] flex items-start gap-2">
            <svg width="16" height="16" fill="none" stroke="#10b981" strokeWidth="2" className="mt-0.5 shrink-0">
              <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" transform="scale(0.667)"/>
              <path d="M8 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" transform="scale(0.667)"/>
            </svg>
            <p className="text-[#8888a0] text-sm">
              安装后 VsSarosis 将自动检测更新，无需手动升级。首次安装建议使用用户级版本。
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
