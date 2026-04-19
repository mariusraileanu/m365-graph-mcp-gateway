export type LoginMode = 'interactive' | 'device';

export interface DeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  message: string;
  expiresIn: number;
}

export interface IdentityVerificationResult {
  checked: boolean;
  mismatch: boolean;
  cached_user: string | null;
  cached_object_id: string | null;
  expected_object_id: string | null;
  reason?: string;
  quarantined_path?: string;
}

export interface AuthStatusResult {
  logged_in: boolean;
  user: string | null;
  cache_file_exists: boolean;
  cache_encrypted: boolean;
  cache_decryptable: boolean;
  encryption_key_configured: boolean;
  account_count: number;
  graph_reachable: boolean;
  device_code_pending: boolean;
  expected_object_id: string | null;
  actual_object_id: string | null;
  identity_match: boolean | null;
  identity_binding_status: 'valid' | 'invalid' | 'missing';
  device_code_verification_uri?: string;
  device_code_user_code?: string;
  error?: string;
}
