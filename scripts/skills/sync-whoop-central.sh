#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_STATE_DIR="${1:-./data/.openclaw}"
SKILLS_DIR_NAME="${2:-skills}"
SKILL_NAME="${3:-whoop-central}"
CLAWHUB_VERSION="${CLAWHUB_VERSION:-0.6.1}"

SKILL_DIR="${OPENCLAW_STATE_DIR}/${SKILLS_DIR_NAME}/${SKILL_NAME}"

if [[ ! -f "${SKILL_DIR}/SKILL.md" ]]; then
  npx -y "clawhub@${CLAWHUB_VERSION}" install --workdir "${OPENCLAW_STATE_DIR}" --dir "${SKILLS_DIR_NAME}" --force "${SKILL_NAME}"
else
  echo "Skill already present: ${SKILL_DIR}"
fi

echo "whoop-central skill synced."
echo "Skill path: ${SKILL_DIR}"

