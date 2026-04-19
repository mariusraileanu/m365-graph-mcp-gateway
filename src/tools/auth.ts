import { z } from 'zod';
import {
  currentUser,
  login,
  logout,
  getGraph,
  authStatus,
  startDeviceCodeLogin,
  deviceCodeLoginStatus,
} from '../auth/index.js';
import { ok } from './results.js';
import { requireLoggedIn } from './shared.js';
import { defineTool } from './types.js';
import type { LoginMode } from '../auth/types.js';

export const authTools = [
  defineTool({
    name: 'auth',
    description:
      'Authenticate with Microsoft Graph. Actions: login (interactive browser), login_device (device code for headless — returns code immediately, poll with status), logout, whoami, status (diagnostics + device code poll).',
    schema: z.object({ action: z.enum(['login', 'login_device', 'logout', 'whoami', 'status']) }).strict(),
    run: async (params) => {
      const action = params.action;

      if (action === 'login') {
        const mode: LoginMode = 'interactive';
        await login(mode);
        return ok(`Login successful (${mode}).`, { success: true, mode, user: await currentUser() });
      }

      if (action === 'login_device') {
        const codeInfo = await startDeviceCodeLogin();
        return ok(
          `Device code login initiated. To sign in, open ${codeInfo.verificationUri} and enter code: ${codeInfo.userCode}. ` +
            `The code expires in ${codeInfo.expiresIn} seconds. Use auth { action: "status" } to check when login completes.`,
          {
            success: true,
            mode: 'device' as LoginMode,
            pending: true,
            verification_uri: codeInfo.verificationUri,
            user_code: codeInfo.userCode,
            expires_in: codeInfo.expiresIn,
            message: codeInfo.message,
          },
        );
      }

      if (action === 'logout') {
        await logout();
        return ok('Logged out.', { success: true });
      }

      if (action === 'status') {
        const status = await authStatus();
        const dcStatus = deviceCodeLoginStatus();

        if (status.logged_in) {
          return ok(`Authenticated as ${status.user}. Graph ${status.graph_reachable ? 'reachable' : 'unreachable'}.`, {
            ...status,
          });
        }

        if (dcStatus.pending) {
          return ok(
            `Device code login in progress. Open ${status.device_code_verification_uri} and enter code: ${status.device_code_user_code}.`,
            { ...status },
          );
        }

        if (dcStatus.error) {
          return ok(`Device code login failed: ${dcStatus.error}`, {
            ...status,
            device_code_error: dcStatus.error,
          });
        }

        return ok('Not authenticated.', { ...status });
      }

      // whoami
      await requireLoggedIn();
      const user = await getGraph().api('/me').select('displayName,mail,userPrincipalName,id').get();
      return ok('User profile retrieved.', {
        id: user.id,
        display_name: user.displayName,
        mail: user.mail,
        user_principal_name: user.userPrincipalName,
      });
    },
  }),
];
