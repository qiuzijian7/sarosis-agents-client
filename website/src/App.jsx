import { useState, useEffect } from 'react'
import Header from './components/Header'
import Hero from './components/Hero'
import Features from './components/Features'
import Download from './components/Download'
import Footer from './components/Footer'
import Issues from './components/Issues'

export default function App() {
  const [scrollY, setScrollY] = useState(0)

  useEffect(() => {
    const handleScroll = () => setScrollY(window.scrollY)
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  return (
    <div className="min-h-screen bg-grid">
      <Header scrollY={scrollY} />
      <main>
        <Hero />
        <Features />
        <Download />
        <Issues />
      </main>
      <Footer />
    </div>
  )
}
