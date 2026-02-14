#!/usr/bin/env bash
set -euo pipefail

DEST_SKILL_DIR="${1:-./data/.openclaw/skills/weather}"
DEST_SCRIPT_PATH="${2:-./data/.openclaw/skills/weather/scripts/weather}"
SKILL_URL="${3:-https://raw.githubusercontent.com/steipete/clawdis/main/skills/weather/SKILL.md}"

mkdir -p "${DEST_SKILL_DIR}" "$(dirname "${DEST_SCRIPT_PATH}")"

curl -sSfL "${SKILL_URL}" -o "${DEST_SKILL_DIR}/SKILL.md"

cat > "${DEST_SCRIPT_PATH}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

location="${*:-${OPENCLAW_CITY:-Abu Dhabi}}"
location_q="${location// /+}"

wttr_out="$(curl -fsS --max-time 8 "https://wttr.in/${location_q}?format=3" 2>/dev/null || true)"
if [[ -n "${wttr_out}" ]]; then
  echo "${wttr_out}"
  exit 0
fi

geo_json="$(curl -fsS --max-time 10 "https://geocoding-api.open-meteo.com/v1/search?name=${location_q}&count=1&language=en&format=json")"

parsed_geo="$(node -e '
const d = JSON.parse(process.argv[1]);
const r = d?.results?.[0];
if (!r) process.exit(2);
console.log([r.name, r.latitude, r.longitude, r.timezone || "auto"].join("|"));
' "${geo_json}")"

name="$(printf "%s" "${parsed_geo}" | cut -d'|' -f1)"
lat="$(printf "%s" "${parsed_geo}" | cut -d'|' -f2)"
lon="$(printf "%s" "${parsed_geo}" | cut -d'|' -f3)"
tz="$(printf "%s" "${parsed_geo}" | cut -d'|' -f4)"

forecast_json="$(curl -fsS --max-time 10 "https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,wind_speed_10m,wind_direction_10m,weather_code&timezone=${tz}")"

node -e '
const data = JSON.parse(process.argv[1]);
const c = data.current || {};
const code = Number(c.weather_code);
const map = {
  0: "Clear",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  71: "Slight snow",
  73: "Moderate snow",
  75: "Heavy snow",
  80: "Rain showers",
  95: "Thunderstorm"
};
const dir = (deg) => {
  if (!Number.isFinite(deg)) return "";
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
};
const weather = map[code] || `Code ${code}`;
const line = `${process.argv[2]}: ${weather}, ${c.temperature_2m}°C (feels ${c.apparent_temperature}°C), humidity ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} km/h ${dir(c.wind_direction_10m)}, precipitation ${c.precipitation} mm @ ${c.time} ${data.timezone_abbreviation || data.timezone || ""}`;
console.log(line.trim());
' "${forecast_json}" "${name}"
EOF

chmod 0755 "${DEST_SCRIPT_PATH}"
chmod -R a+rX "${DEST_SKILL_DIR}"

echo "Weather skill synced to: ${DEST_SKILL_DIR}"
echo "Weather helper script: ${DEST_SCRIPT_PATH}"
