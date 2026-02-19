import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
function expandEnvVars(value) {
    return value.replace(/\$\{([^}]+)\}/g, (_, key) => {
        return process.env[key] || '';
    });
}
function expandEnvVarsInObject(obj) {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string') {
            result[key] = expandEnvVars(value);
        }
        else if (Array.isArray(value)) {
            result[key] = value.map(v => typeof v === 'string' ? expandEnvVars(v) : v);
        }
        else if (value && typeof value === 'object') {
            result[key] = expandEnvVarsInObject(value);
        }
        else {
            result[key] = value;
        }
    }
    return result;
}
let cachedConfig = null;
export function loadConfig() {
    if (cachedConfig) {
        return cachedConfig;
    }
    const configPath = path.resolve(__dirname, '../config.yaml');
    const fileContents = fs.readFileSync(configPath, 'utf-8');
    const parsed = yaml.parse(fileContents);
    const expanded = expandEnvVarsInObject(parsed);
    if (!expanded.azure.clientId || !expanded.azure.tenantId) {
        throw new Error('Azure clientId and tenantId are required. Set GRAPH_MCP_CLIENT_ID and GRAPH_MCP_TENANT_ID environment variables.');
    }
    cachedConfig = expanded;
    return expanded;
}
//# sourceMappingURL=config.js.map