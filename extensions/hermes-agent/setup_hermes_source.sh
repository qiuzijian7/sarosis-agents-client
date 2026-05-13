#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# Hermes Agent — Source Code Link/Clone Script
#
# This script sets up the hermes/ directory inside the extension with
# the full hermes-agent repository code. It supports:
#
#   1. Clone: If hermes/ is empty, clone from GitHub
#   2. Link:  If HERMES_AGENT_SRC is set, create a symlink
#   3. Pull:  If hermes/ already has code, pull latest changes
#
# Usage:
#   ./setup_hermes_source.sh              # Clone or pull
#   HERMES_AGENT_SRC=/path/to/src ./setup_hermes_source.sh  # Symlink
#
# The hermes/ directory is used by the bridge server to import
# hermes-agent Python modules (AIAgent, ToolRegistry, Providers, etc.)
# ──────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_DIR="${SCRIPT_DIR}/hermes"
REPO_URL="https://github.com/NousResearch/hermes-agent.git"
BRANCH="main"

echo "🏛️  Hermes Agent Source Setup"
echo "   Target: ${HERMES_DIR}"

# ─── Option 1: Symlink to existing source ────────────────────────────
if [ -n "${HERMES_AGENT_SRC:-}" ] && [ -d "${HERMES_AGENT_SRC}" ]; then
    echo "📍 Linking to existing source: ${HERMES_AGENT_SRC}"
    if [ -L "${HERMES_DIR}" ]; then
        rm "${HERMES_DIR}"
    elif [ -d "${HERMES_DIR}" ]; then
        echo "⚠️  hermes/ directory already exists (not a symlink). Remove it first."
        exit 1
    fi
    ln -s "${HERMES_AGENT_SRC}" "${HERMES_DIR}"
    echo "✅ Symlink created: ${HERMES_DIR} → ${HERMES_AGENT_SRC}"
    exit 0
fi

# ─── Option 2: Clone if empty ────────────────────────────────────────
if [ ! -d "${HERMES_DIR}/.git" ] && [ ! -L "${HERMES_DIR}" ]; then
    echo "📥 Cloning hermes-agent repository..."
    if [ -d "${HERMES_DIR}" ] && [ -z "$(ls -A "${HERMES_DIR}")" ]; then
        rmdir "${HERMES_DIR}"
    fi
    git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${HERMES_DIR}"
    echo "✅ Repository cloned to ${HERMES_DIR}"
    exit 0
fi

# ─── Option 3: Pull if already cloned ────────────────────────────────
if [ -d "${HERMES_DIR}/.git" ]; then
    echo "🔄 Pulling latest changes..."
    cd "${HERMES_DIR}"
    git pull --ff-only origin "${BRANCH}" || {
        echo "⚠️  Pull failed. You may need to resolve conflicts manually."
        echo "   cd ${HERMES_DIR} && git pull"
        exit 1
    }
    echo "✅ Repository updated"
    exit 0
fi

echo "❌ Unable to determine hermes/ state. Manual setup required."
exit 1
