#!/bin/bash
# -----------------------------------------------------------
# Repo setup script — sets GitHub metadata after first push.
# Run once: ./setup-repo.sh
#
# Requires: gh CLI authenticated
# -----------------------------------------------------------

set -e

echo "=== GitHub Repo Setup ==="
echo ""

# Gather info
read -p "GitHub username/org [gabelul]: " OWNER
OWNER=${OWNER:-gabelul}

read -p "Repo name: " REPO
if [ -z "$REPO" ]; then
  echo "Repo name is required."
  exit 1
fi

echo ""
read -p "Description (max ~350 chars): " DESCRIPTION
read -p "Homepage URL (or blank): " HOMEPAGE

echo ""
echo "Enter up to 20 topic tags, comma-separated."
echo "Tips: include tool-specific, ecosystem, category, and discovery terms."
echo "Example: claude-code,codex-cli,mcp,ai-agent-skills,text-to-ui"
read -p "Topics: " TOPICS_RAW

# Set description
if [ -n "$DESCRIPTION" ]; then
  gh repo edit "$OWNER/$REPO" --description "$DESCRIPTION"
  echo "  Description set."
fi

# Set homepage
if [ -n "$HOMEPAGE" ]; then
  gh repo edit "$OWNER/$REPO" --homepage "$HOMEPAGE"
  echo "  Homepage set."
fi

# Set topics one by one (gh cli wants individual --add-topic calls)
if [ -n "$TOPICS_RAW" ]; then
  IFS=',' read -ra TOPICS <<< "$TOPICS_RAW"
  for topic in "${TOPICS[@]}"; do
    topic=$(echo "$topic" | xargs)  # trim whitespace
    gh repo edit "$OWNER/$REPO" --add-topic "$topic" 2>/dev/null || echo "  (skipped '$topic' — may already exist or at 20 cap)"
  done
  echo "  Topics set."
fi

echo ""
echo "Done. Don't forget to:"
echo "  1. Export social-preview.svg to PNG (1280x640)"
echo "  2. Upload it in Settings > Social Preview"
echo "  3. Add this project to the Related section of other repos"
