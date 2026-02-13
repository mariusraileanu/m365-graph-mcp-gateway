# Security Runbook

## 1) Secret Rotation

Rotate at minimum:
- `OPENCLAW_GATEWAY_AUTH_TOKEN`: every 30 days
- API keys (`COMPASS_API_KEY`, `TELEGRAM_BOT_TOKEN`, etc.): every 60-90 days
- WHOOP/Clippy auth: on expiry or suspected compromise

Gateway token rotation:

```bash
bin/openclawctl rotate-token
```

## 2) Post-Rotation Validation

```bash
bin/openclawctl validate
bin/openclawctl smoke
docker exec -it openclaw openclaw status
```

## 3) Break-Glass Mode

Secure profile blocks auth-check bypass by default.

Temporary bypass:

```bash
OPENCLAW_ALLOW_INSECURE_BYPASS=1 OPENCLAW_SKIP_AUTH_CHECKS=clippy,whoop bin/openclawctl provision
```

After incident:
1. Remove bypass vars.
2. Re-run normal provision.
3. Rotate any affected secrets.

## 4) Credential Leak Response

1. Rotate leaked key/token immediately.
2. Rotate gateway token.
3. Re-provision and run smoke checks.
4. Review logs and runtime state:
   - `docker logs --tail 300 openclaw`
   - `data/.openclaw/diagnostics/latest.json`
5. Remove leaked data from history and revoke old credentials.
