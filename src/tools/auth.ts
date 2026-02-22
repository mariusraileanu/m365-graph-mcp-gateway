import { z } from 'zod';
import { isLoggedIn, currentUser, login, logout, getGraph } from '../auth/index.js';
import { ok } from '../utils/helpers.js';
import type { ToolSpec, LoginMode } from '../utils/types.js';

export const authTools: ToolSpec[] = [
  {
    name: 'auth',
    description:
      'Authenticate with Microsoft Graph. Actions: login (interactive browser), login_device (device code for headless), logout, whoami.',
    schema: z.object({ action: z.enum(['login', 'login_device', 'logout', 'whoami']) }).strict(),
    run: async (params) => {
      const action = String(params.action);

      if (action === 'login' || action === 'login_device') {
        const mode: LoginMode = action === 'login_device' ? 'device' : 'interactive';
        await login(mode);
        return ok(`Login successful (${mode}).`, { success: true, mode, user: currentUser() });
      }

      if (action === 'logout') {
        await logout();
        return ok('Logged out.', { success: true });
      }

      // whoami
      if (!isLoggedIn()) throw new Error('AUTH_REQUIRED: not logged in');
      const user = await getGraph().api('/me').select('displayName,mail,userPrincipalName,id').get();
      return ok('User profile retrieved.', {
        id: user.id,
        display_name: user.displayName,
        mail: user.mail,
        user_principal_name: user.userPrincipalName,
      });
    },
  },
];
