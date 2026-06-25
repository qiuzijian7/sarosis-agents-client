# VsSaros - AI-Enhanced Code Editor with Real-Time Collaboration

![Version](https://img.shields.io/badge/version-2.1.156951-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Electron](https://img.shields.io/badge/Electron-39.8.7-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-6.0.0-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

**VsSaros** is a customized version of Visual Studio Code (VS Code) that integrates **real-time collaborative editing** (Saros) and **AI-assisted programming** (Claude SDK + GitHub Copilot) to provide a modern, intelligent development experience.

---

## 🚀 Core Features

### 1. **Code Editor (Monaco Editor)**
- ✅ Advanced code editing with IntelliSense
- ✅ Syntax highlighting for 100+ languages
- ✅ Multi-cursor and snippet support
- ✅ Integrated terminal (Xterm.js)
- ✅ Git version control integration

### 2. **Real-Time Collaboration (Saros)**
- ✅ Live collaborative editing (multiple users)
- ✅ Real-time cursor and selection sharing
- ✅ Integrated chat and comments
- ✅ Session recording and playback
- ✅ Conflict resolution algorithms

### 3. **AI-Assisted Programming**
- ✅ **Claude AI SDK** (@anthropic-ai/sdk ^0.82.0)
- ✅ **GitHub Copilot** (@github/copilot-sdk ^0.3.0)
- ✅ Code completion and generation
- ✅ Intelligent refactoring suggestions
- ✅ Natural language code search

### 4. **Remote Development**
- ✅ SSH remote development
- ✅ Dev Containers support
- ✅ GitHub Codespaces integration
- ✅ Microsoft Dev Tunnels

### 5. **Extensibility**
- ✅ Full VS Code extension API compatibility
- ✅ Custom extension marketplace
- ✅ Built-in extensions (Copilot, Saros, etc.)

---

## 📦 Quick Start

### Prerequisites
- **Node.js**: 22.18.10 or higher
- **npm**: 10.0.0 or higher
- **Electron**: 39.8.7
- **Git**: 2.40.0 or higher

### Installation

#### Option A: Download Pre-built Release (Recommended)
```bash
# Download from GitHub Releases (coming soon)
# https://github.com/your-org/vssaros/releases
```

#### Option B: Build from Source
```bash
# 1. Clone the repository
git clone https://github.com/your-org/vssaros.git
cd vssaros

# 2. Install dependencies (requires 8GB+ RAM)
npm install

# 3. Compile the project (takes 10-30 minutes)
npm run compile

# 4. Run VsSaros
npm start
```

### Development Workflow

#### Start Development Mode (with hot reload)
```bash
# Terminal 1: Start the compiler in watch mode
npm run watch

# Terminal 2: Launch VsSaros (with debugger attached)
npm run electron
```

#### Run Tests
```bash
# Unit tests (browser)
npm run test-browser

# Unit tests (Node.js)
npm run test-node

# Extension tests
npm run test-extension

# E2E tests (Playwright)
npm run test-browser-no-install
```

---

## 🏗️ Project Structure

```
vssaros/
├── src/                          # Source code (TypeScript)
│   ├── vs/                       # VS Code core (customized)
│   │   ├── base/                  # Base utilities
│   │   ├── code/                  # Code editor core
│   │   ├── editor/                # Editor UI components
│   │   ├── platform/              # Platform abstraction (Windows/macOS/Linux)
│   │   ├── server/                # Server-side code (remote development)
│   │   ├── sessions/              # Session management (Saros collaboration)
│   │   ├── workbench/             # Workbench UI
│   │   └── bootstrap-*.ts        # Bootstrap files
│   └── typings/                  # TypeScript type definitions
├── build/                        # Build scripts and tools
│   ├── lib/                       # Build libraries
│   ├── saros/                     # Saros-specific build scripts
│   ├── checker/                   # Code quality checkers
│   ├── npm/                       # npm hook scripts
│   └── rspack/                   # Rspack bundler config
├── extensions/                    # Built-in extensions
│   ├── copilot/                   # GitHub Copilot integration
│   ├── saros/                     # Saros collaboration plugin
│   ├── shared/                    # Shared extension code
│   └── tdb-am-gateway/           # TDB integration
├── cli/                          # Command-line interface
├── config/                        # Configuration files
├── doc/                          # Project documentation
├── docs/                         # User documentation
├── examples/                     # Example code and extensions
├── scripts/                      # Utility scripts
├── test/                         # Test suites
├── out/                          # Compiled output (main application)
├── out-build/                     # Build output
├── out-vscode/                   # VS Code output
├── dist/                         # Distribution packages
├── node_modules/                 # Node.js dependencies
├── package.json                  # Node.js project configuration
├── product.json                  # VsSaros product configuration
├── tsconfig.json                 # TypeScript configuration
├── gulpfile.mjs                  # Gulp build tasks
└── README.md                    # This file
```

---

## 🔧 Technology Stack

### Runtime
| Technology | Version | Purpose |
|------------|---------|---------|
| **Electron** | 39.8.7 | Desktop application framework |
| **Node.js** | 22.18.10 | JavaScript runtime |
| **TypeScript** | 6.0.0-dev | Primary development language |

### Frontend
| Technology | Version | Purpose |
|------------|---------|---------|
| **Monaco Editor** | * | Code editor core |
| **Xterm.js** | 6.1.0-beta.213 | Terminal emulation |
| **React** | 18.2.0 | UI components (optional) |

### Build Tools
| Technology | Version | Purpose |
|------------|---------|---------|
| **Gulp** | 4.0.0 | Task automation |
| **Rspack** | * | Module bundler (replacing Webpack) |
| **ESBuild** | 0.28.0 | Fast TypeScript compilation |
| **Playwright** | 1.59.1 | E2E testing |

### AI and Collaboration
| Technology | Version | Purpose |
|------------|---------|---------|
| **@anthropic-ai/sdk** | ^0.82.0 | Claude AI SDK |
| **@github/copilot-sdk** | ^0.3.0 | GitHub Copilot |
| **Saros** | * | Real-time collaboration plugin |

---

## 🎯 Key Scripts

### Build Scripts
```bash
npm run compile              # Full compilation (main + extensions)
npm run watch               # Watch mode (hot reload)
npm run compile-web         # Web version compilation
npm run compile-cli         # CLI tool compilation
```

### Development Scripts
```bash
npm start                   # Launch VsSaros
npm run electron            # Launch Electron with debugger
npm run workflow            # AI-assisted development workflow
npm run workflow:basic      # Basic development workflow
```

### Quality Scripts
```bash
npm run eslint              # Run ESLint
npm run stylelint           # Run Stylelint
npm run hygiene             # Run code hygiene checks
npm test                    # Run tests (see "Run Tests" above)
```

---

## 📝 Configuration

### product.json
VsSaros product configuration (name, version, extensions, etc.):
```json
{
  "name": "VsSaros",
  "version": "2.1.156951",
  "extensionsGallery": {
    "serviceUrl": "https://marketplace.visualstudio.com/_apis/public/gallery"
  }
}
```

### .saros/ Directory
Saros collaboration configuration:
```
.saros/
├── config.json             # Saros session settings
├── accounts.json           # User accounts
└── sessions/              # Session data
```

---

## 🤝 Contributing

We welcome contributions! Please follow these steps:

### 1. Fork the Repository
```bash
git fork https://github.com/your-org/vssaros.git
```

### 2. Create a Feature Branch
```bash
git checkout -b feature/your-feature-name
```

### 3. Make Changes and Commit
```bash
# Run code quality checks before committing
npm run hygiene
npm run eslint

# Commit with a descriptive message
git commit -m "feat: add your feature"
```

### 4. Push and Create Pull Request
```bash
git push origin feature/your-feature-name
# Open a Pull Request on GitHub
```

### Code Style Guide
- **Language**: TypeScript (strict mode)
- **Indentation**: 2 spaces
- **Quotes**: Single quotes (')
- **Semicolons**: Required
- **Linting**: ESLint + Prettier

---

## 🐛 Troubleshooting

### Common Issues

#### 1. Compilation Fails (Out of Memory)
**Solution**: Increase Node.js heap size
```bash
export NODE_OPTIONS="--max-old-space-size=8192"
npm run compile
```

#### 2. Electron Fails to Launch
**Solution**: Reinstall Electron
```bash
npm exec electron --version
# If error, reinstall:
rm -rf node_modules/electron
npm install
```

#### 3. Saros Plugin Not Working
**Solution**: Check Saros configuration
```bash
cat .saros/config.json
# Ensure valid session settings
```

#### 4. AI Features Not Available
**Solution**: Check API keys
```bash
# Ensure Claude API key is set
export ANTHROPIC_API_KEY="your-key-here"

# Ensure GitHub Copilot is authenticated
npm run copilot:get_token
```

---

## 📄 License

This project is licensed under the **MIT License** - see the [LICENSE.txt](LICENSE.txt) file for details.

### Third-Party Notices
See [ThirdPartyNotices.txt](ThirdPartyNotices.txt) for attribution to open-source libraries.

---

## 📞 Contact & Support

### Official Channels
- **GitHub Issues**: [Report a bug](https://github.com/your-org/vssaros/issues)
- **GitHub Discussions**: [Community forum](https://github.com/your-org/vssaros/discussions)
- **Documentation**: [docs/](docs/) directory

### Community
- **Discord**: [Join our server](https://discord.gg/your-invite-link)
- **Stack Overflow**: Tag questions with `vssaros`

### Email
- **General Inquiry**: support@vssaros.com
- **Security Issues**: security@vssaros.com

---

## 🙏 Acknowledgments

- **Microsoft VS Code Team** - Core editor platform
- **Saros Community** - Real-time collaboration
- **Anthropic** - Claude AI SDK
- **GitHub** - Copilot integration
- **Electron Team** - Desktop application framework

---

## 🗺️ Roadmap

### Current Version (2.1.156951)
- ✅ Real-time collaboration (Saros)
- ✅ AI-assisted programming (Claude + Copilot)
- ✅ Remote development (SSH + Dev Containers)
- ✅ Advanced code editing (Monaco Editor)

### Upcoming Features (v2.2)
- [ ] Enhanced AI code generation
- [ ] Multi-user session recording
- [ ] Plugin marketplace
- [ ] Mobile companion app

### Future Vision (v3.0)
- [ ] Cloud-native version
- [ ] Advanced code analysis (static + dynamic)
- [ ] Integration with more AI models
- [ ] Real-time code review tools

---

**Built with ❤️ by the VsSaros Team**

*Customized from Microsoft VS Code (https://github.com/microsoft/vscode)*
