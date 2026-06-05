import { useState } from 'react'

const RELEASES_URL = 'https://git.woa.com/zijianqiu/vssarosis_issue/-/releases'

// 版本信息 - 可从 CI/CD 自动注入，此处为静态展示
const versionInfo = {
  version: '1.0.0',
  buildDate: '2026-06-04',
  changelog: '初始版本发布，包含 Agent Studio、Browser-Use、Skill 系统等核心功能',
  downloads: {
    'VsSarosisUserSetup.exe': '163 MB',
    'VsSarosisSetup.exe': '163 MB',
  },
}

export default function Download() {
  const [copied, setCopied] = useState(false)

  const handleCopyCommand = async () => {
    const cmd = `winget install VsSarosis`
    try {
      await navigator.clipboard.writeText(cmd)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // fallback
    }
  }

  return (
    <section id="download" className="py-24 md:py-32 relative">
      <div className="max-w-4xl mx-auto px-6">
        {/* Section header */}
        <div className="text-center mb-16">
          <span className="text-primary-400 font-semibold text-sm tracking-wider uppercase mb-4 block">
            Download
          </span>
          <h2 className="section-title text-white">
            下载 <span className="gradient-text">VsSarosis</span>
          </h2>
          <p className="text-[#8888a0] text-lg max-w-xl mx-auto mt-4">
            免费开源，MIT 协议。所有安装包均可在 Git 工蜂 Releases 页签下载。
          </p>
        </div>

        {/* Version info card */}
        <div className="glass-card glow-border p-8 mb-8">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
            <div>
              <div className="flex items-center gap-3 mb-1">
                <h3 className="text-2xl font-bold text-white">v{versionInfo.version}</h3>
                <span className="px-2 py-0.5 text-xs font-semibold bg-green-500/20 text-green-400 rounded-full border border-green-500/30">
                  Latest
                </span>
              </div>
              <p className="text-[#8888a0] text-sm">发布日期：{versionInfo.buildDate}</p>
            </div>
            <a
              href={RELEASES_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary inline-flex items-center gap-2 whitespace-nowrap"
            >
              <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              前往 Releases 下载
            </a>
          </div>

          {/* Changelog */}
          <div className="bg-[#0d0d14] rounded-lg p-4 mb-6">
            <h4 className="text-white font-semibold text-sm mb-2">📝 更新日志</h4>
            <p className="text-[#8888a0] text-sm leading-relaxed">{versionInfo.changelog}</p>
          </div>

          {/* Download files */}
          <div>
            <h4 className="text-white font-semibold text-sm mb-3">📦 安装包</h4>
            <div className="space-y-3">
              {Object.entries(versionInfo.downloads).map(([filename, size]) => (
                <div key={filename} className="flex items-center justify-between bg-[#0d0d14] rounded-lg px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className="text-lg">🪟</span>
                    <div>
                      <p className="text-white text-sm font-mono">{filename}</p>
                      <p className="text-[#6c7086] text-xs">{size}</p>
                    </div>
                  </div>
                  <a
                    href={`${RELEASES_URL}/${versionInfo.version}/downloads/${filename}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary-400 hover:text-primary-300 text-sm font-medium transition-colors"
                  >
                    下载 →
                  </a>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Quick install */}
        <div className="glass-card p-6 mb-8">
          <h4 className="text-white font-semibold mb-3">⚡ 快速安装（winget）</h4>
          <div className="bg-[#0d0d14] rounded-lg p-4 flex items-center justify-between gap-4">
            <code className="text-primary-400 text-sm font-mono select-all">winget install VsSarosis</code>
            <button
              onClick={handleCopyCommand}
              className="shrink-0 px-3 py-1.5 text-xs font-medium bg-primary-500/20 text-primary-400 rounded-lg hover:bg-primary-500/30 transition-colors"
            >
              {copied ? '已复制 ✓' : '复制'}
            </button>
          </div>
        </div>

        {/* System requirements */}
        <div className="glass-card p-6">
          <h4 className="text-white font-semibold mb-4">💻 系统要求</h4>
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
              安装后 VsSarosis 将自动检测更新，无需手动升级。首次安装建议使用用户级版本（VsSarosisUserSetup.exe）。
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
