#!/usr/bin/env bash
set -euo pipefail

OPENCLAW_STATE_DIR="${1:-./data/.openclaw}"
SKILLS_DIR_NAME="${2:-skills}"
SKILL_NAME="${3:-self-improving-agent}"
WORKSPACE_DIR="${4:-./data/workspace}"
CLAWHUB_VERSION="${CLAWHUB_VERSION:-0.6.1}"
CONTAINER_NAME="${CONTAINER_NAME:-openclaw}"

SKILL_DIR="${OPENCLAW_STATE_DIR}/${SKILLS_DIR_NAME}/${SKILL_NAME}"
LEARNINGS_DIR="${WORKSPACE_DIR}/.learnings"

if [[ ! -f "${SKILL_DIR}/SKILL.md" ]]; then
  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
    docker exec "${CONTAINER_NAME}" sh -lc "npx -y 'clawhub@${CLAWHUB_VERSION}' install --workdir /home/node/.openclaw --dir '${SKILLS_DIR_NAME}' --force '${SKILL_NAME}'"
  else
    npx -y "clawhub@${CLAWHUB_VERSION}" install --workdir "${OPENCLAW_STATE_DIR}" --dir "${SKILLS_DIR_NAME}" --force "${SKILL_NAME}"
  fi
else
  echo "Skill already present: ${SKILL_DIR}"
fi

mkdir -p "${LEARNINGS_DIR}"

for f in LEARNINGS.md ERRORS.md FEATURE_REQUESTS.md; do
  src="${SKILL_DIR}/assets/${f}"
  if [[ ! -f "${src}" ]]; then
    src="${SKILL_DIR}/.learnings/${f}"
  fi
  dst="${LEARNINGS_DIR}/${f}"
  if [[ -f "${src}" && ! -f "${dst}" ]]; then
    cp "${src}" "${dst}"
    echo "Created ${dst}"
  fi
done

echo "Self-improving-agent skill synced."
echo "Skill path: ${SKILL_DIR}"
echo "Workspace learnings: ${LEARNINGS_DIR}"
