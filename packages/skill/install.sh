#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DST="$HOME/.agents/skills/iris"
mkdir -p "$SKILL_DST"
ln -sfn "$SCRIPT_DIR/SKILL.md" "$SKILL_DST/SKILL.md"
printf 'Installed: %s/SKILL.md -> %s/SKILL.md\n' "$SKILL_DST" "$SCRIPT_DIR"
