export interface AzureConfig {
    clientId: string;
    clientSecret: string;
    tenantId: string;
    redirectUri: string;
}
export interface GuardrailsConfig {
    email: {
        allowDomains: string[];
        requireDraftApproval: boolean;
        stripSensitiveFromLogs: boolean;
    };
    audit: {
        enabled: boolean;
        logPath: string;
        retentionDays: number;
    };
}
export interface StorageConfig {
    tokenPath: string;
    sessionTimeoutMinutes: number;
}
export interface Config {
    azure: AzureConfig;
    scopes: string[];
    guardrails: GuardrailsConfig;
    storage: StorageConfig;
}
export declare function loadConfig(): Config;
//# sourceMappingURL=config.d.ts.map