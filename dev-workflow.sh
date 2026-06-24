#!/bin/bash

# 完整开发流程快速启动脚本

set -e  # 遇到错误立即退出

echo "🚀 启动完整开发流程..."
echo "================================================"

# 检查 Node.js 版本
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 16 ]; then
  echo "❌ Node.js 版本过低，需要 16.0 或更高版本"
  echo "当前版本: $(node -v)"
  exit 1
fi

echo "✅ Node.js 版本检查通过: $(node -v)"

# 检查依赖是否安装
if [ ! -d "node_modules" ]; then
  echo "📦 首次运行，正在安装依赖..."
  npm install
fi

echo "✅ 依赖检查完成"

# 处理命令行参数
A_I_ENABLED=true
SKIP_TESTS=false
SKIP_CHECKS=false
AUTO_COMMIT=false
CONFIG_FILE=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --no-ai)
      AI_ENABLED=false
      shift
      ;;
    --skip-tests)
      SKIP_TESTS=true
      shift
      ;;
    --skip-checks)
      SKIP_CHECKS=true
      shift
      ;;
    --auto-commit)
      AUTO_COMMIT=true
      shift
      ;;
    --config)
      CONFIG_FILE="$2"
      shift 2
      ;;
    --help|-h)
      echo "用法: ./dev-workflow.sh [选项]"
      echo ""
      echo "选项:"
      echo "  --no-ai              禁用 AI 辅助"
      echo "  --skip-tests          跳过测试阶段"
      echo "  --skip-checks        跳过错误检查阶段"
      echo "  --auto-commit        自动提交（使用 AI 生成的提交信息）"
      echo "  --config <path>      指定配置文件路径"
      echo "  --help, -h           显示帮助信息"
      echo ""
      echo "示例:"
      echo "  ./dev-workflow.sh"
      echo "  ./dev-workflow.sh --no-ai"
      echo "  ./dev-workflow.sh --skip-tests"
      exit 0
      ;;
    *)
      echo "❌ 未知选项: $1"
      echo "使用 --help 查看帮助"
      exit 1
      ;;
  esac
done

echo ""
echo "📋 配置:"
echo "  AI 辅助: $AI_ENABLED"
echo "  跳过测试: $SKIP_TESTS"
echo "  跳过检查: $SKIP_CHECKS"
echo "  自动提交: $AUTO_COMMIT"
[ ! -z "$CONFIG_FILE" ] && echo "  配置文件: $CONFIG_FILE"
echo ""

# 构建命令
CMD="node ai-dev-workflow.js"

if [ "$AI_ENABLED" = false ]; then
  CMD="$CMD --no-ai"
fi

if [ "$SKIP_TESTS" = true ]; then
  CMD="$CMD --skip-tests"
fi

if [ "$SKIP_CHECKS" = true ]; then
  CMD="$CMD --skip-checks"
fi

if [ "$AUTO_COMMIT" = true ]; then
  CMD="$CMD --auto-commit"
fi

if [ ! -z "$CONFIG_FILE" ]; then
  CMD="$CMD --config $CONFIG_FILE"
fi

echo "🚀 执行命令: $CMD"
echo "================================================"
echo ""

# 执行命令
eval $CMD

# 检查执行结果
if [ $? -eq 0 ]; then
  echo ""
  echo "================================================"
  echo "✅ 开发流程执行成功！"
  echo "================================================"
else
  echo ""
  echo "================================================"
  echo "❌ 开发流程执行失败！"
  echo "请查看上面的错误信息"
  echo "================================================"
  exit 1
fi
