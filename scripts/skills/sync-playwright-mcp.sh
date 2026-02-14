#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_STATE_DIR="${1:-./data/.openclaw}"
SKILLS_DIR_NAME="${2:-skills}"
SKILL_NAME="${3:-playwright-mcp}"
CLAWHUB_VERSION="${CLAWHUB_VERSION:-0.6.1}"
CONTAINER_NAME="${CONTAINER_NAME:-openclaw}"

SKILL_DIR="${OPENCLAW_STATE_DIR}/${SKILLS_DIR_NAME}/${SKILL_NAME}"

if [[ ! -f "${SKILL_DIR}/SKILL.md" ]]; then
  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
    docker exec "${CONTAINER_NAME}" sh -lc "npx -y 'clawhub@${CLAWHUB_VERSION}' install --workdir /home/node/.openclaw --dir '${SKILLS_DIR_NAME}' --force '${SKILL_NAME}'"
  else
    npx -y "clawhub@${CLAWHUB_VERSION}" install --workdir "${OPENCLAW_STATE_DIR}" --dir "${SKILLS_DIR_NAME}" --force "${SKILL_NAME}"
  fi
else
  echo "Skill already present: ${SKILL_DIR}"
fi

echo "playwright-mcp skill synced."
echo "Skill path: ${SKILL_DIR}"
