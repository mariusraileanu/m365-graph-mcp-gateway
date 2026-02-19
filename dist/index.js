import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';
import { v4 as uuidv4 } from 'uuid';
import { PublicClientApplication, InteractionRequiredAuthError } from '@azure/msal-node';
import { Client } from '@microsoft/microsoft-graph-client';
import http from 'http';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
function expandEnvVars(value) {
    return value.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] || '');
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
function loadConfig() {
    if (cachedConfig)
        return cachedConfig;
    const configPath = path.resolve(process.cwd(), 'config.yaml');
    const fileContents = fs.readFileSync(configPath, 'utf-8');
    const parsed = yaml.parse(fileContents);
    const expanded = expandEnvVarsInObject(parsed);
    if (!expanded.azure.clientId || !expanded.azure.tenantId) {
        throw new Error('Azure clientId and tenantId are required. Set GRAPH_MCP_CLIENT_ID and GRAPH_MCP_TENANT_ID environment variables.');
    }
    cachedConfig = expanded;
    return expanded;
}
class AuditLogger {
    logPath;
    enabled;
    constructor() {
        const config = loadConfig();
        this.enabled = config.guardrails.audit.enabled;
        this.logPath = resolveStoragePath(config.guardrails.audit.logPath);
    }
    async init() {
        if (!this.enabled)
            return;
        const logDir = path.dirname(this.logPath);
        await fs.promises.mkdir(logDir, { recursive: true });
        if (!fs.existsSync(this.logPath)) {
            await fs.promises.writeFile(this.logPath, '');
        }
    }
    async log(entry) {
        if (!this.enabled)
            return;
        const fullEntry = {
            ...entry,
            id: uuidv4(),
            timestamp: new Date().toISOString(),
        };
        const line = JSON.stringify(fullEntry) + '\n';
        await fs.promises.appendFile(this.logPath, line, { encoding: 'utf-8' });
    }
    async getRecentEntries(limit = 100) {
        if (!this.enabled || !fs.existsSync(this.logPath))
            return [];
        const content = await fs.promises.readFile(this.logPath, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        return lines.slice(-limit).map(line => JSON.parse(line));
    }
}
const auditLogger = new AuditLogger();
function checkEmailAllowed(recipient) {
    const config = loadConfig();
    const domain = recipient.split('@')[1]?.toLowerCase();
    if (!domain)
        return { allowed: false, reason: 'Invalid email address' };
    const allowedDomains = config.guardrails.email.allowDomains.map((d) => d.toLowerCase());
    if (!allowedDomains.includes(domain)) {
        return { allowed: false, reason: `Domain @${domain} is not in allowlist` };
    }
    return { allowed: true, requiresApproval: config.guardrails.email.requireDraftApproval };
}
function sanitizeForLogs(content) {
    if (!loadConfig().guardrails.email.stripSensitiveFromLogs)
        return content;
    let sanitized = content;
    sanitized = sanitized.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[EMAIL_REDACTED]');
    sanitized = sanitized.replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[PHONE_REDACTED]');
    sanitized = sanitized.replace(/\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, '[CARD_REDACTED]');
    return sanitized;
}
const cache = { account: null, accessToken: null, expiresAt: null };
let msalInstance = null;
let msalHydrated = false;
async function getMsalInstance() {
    if (msalInstance)
        return msalInstance;
    const config = loadConfig();
    const msalConfig = {
        auth: {
            clientId: config.azure.clientId,
            authority: `https://login.microsoftonline.com/${config.azure.tenantId}`,
            clientSecret: config.azure.clientSecret || undefined,
        },
    };
    msalInstance = new PublicClientApplication(msalConfig);
    await hydrateMsalTokenCache(msalInstance);
    return msalInstance;
}
async function login() {
    const config = loadConfig();
    const msal = await getMsalInstance();
    console.log('Initiating device code login...');
    console.log('Please sign in with your Microsoft account.');
    const request = {
        scopes: config.scopes,
        deviceCodeCallback: (response) => {
            console.log('To sign in, use a web browser to open the page https://microsoft.com/devicelogin');
            console.log(`and enter the code ${response.userCode} to authenticate.`);
            console.log('');
        },
    };
    const response = await msal.acquireTokenByDeviceCode(request);
    if (response && response.account) {
        cache.account = response.account;
        cache.accessToken = response.accessToken;
        cache.expiresAt = response.expiresOn?.getTime() || null;
        await saveTokenCache(msal);
        console.log('✓ Login successful!');
        console.log(`  Account: ${response.account.username}`);
    }
}
async function getAccessToken() {
    const config = loadConfig();
    if (cache.accessToken && cache.expiresAt && Date.now() < cache.expiresAt - 60000) {
        return cache.accessToken;
    }
    await loadTokenCache();
    if (!cache.account)
        throw new Error('Not logged in. Run with --login first.');
    const msal = await getMsalInstance();
    const request = { scopes: config.scopes, account: cache.account };
    try {
        const response = await msal.acquireTokenSilent(request);
        cache.accessToken = response.accessToken;
        cache.expiresAt = response.expiresOn?.getTime() || null;
        if (response.account)
            cache.account = response.account;
        await saveTokenCache(msal);
        return response.accessToken;
    }
    catch (error) {
        if (error instanceof InteractionRequiredAuthError) {
            // Never trigger interactive login from request path; callers should run --login explicitly.
            throw new Error('Authentication expired. Run m365-graph-mcp-gateway login (make login) to re-authenticate.');
        }
        throw error;
    }
}
function isLoggedIn() {
    return cache.account !== null && cache.accessToken !== null;
}
function getCurrentUser() {
    return cache.account?.username || null;
}
function resolveStoragePath(relativePath) {
    if (fs.existsSync('/app')) {
        return path.resolve('/app', relativePath);
    }
    return path.resolve(process.cwd(), relativePath);
}
async function getTokenCachePath() {
    const config = loadConfig();
    const tokenDir = resolveStoragePath(config.storage.tokenPath);
    await fs.promises.mkdir(tokenDir, { recursive: true });
    return path.join(tokenDir, 'token-cache.json');
}
async function saveTokenCache(msal) {
    const cachePath = await getTokenCachePath();
    const app = msal || await getMsalInstance();
    const msalSerialized = app.getTokenCache().serialize();
    const data = {
        account: cache.account,
        accessToken: cache.accessToken,
        expiresAt: cache.expiresAt,
        msalCache: msalSerialized,
    };
    await fs.promises.writeFile(cachePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}
async function loadTokenCache() {
    try {
        const cachePath = await getTokenCachePath();
        const data = await fs.promises.readFile(cachePath, 'utf-8');
        const parsed = JSON.parse(data);
        if (parsed.account && parsed.accessToken && parsed.expiresAt) {
            cache.account = parsed.account;
            cache.accessToken = parsed.accessToken;
            cache.expiresAt = parsed.expiresAt;
        }
    }
    catch { /* No cached token */ }
}
async function hydrateMsalTokenCache(msal) {
    if (msalHydrated)
        return;
    try {
        const cachePath = await getTokenCachePath();
        const data = await fs.promises.readFile(cachePath, 'utf-8');
        const parsed = JSON.parse(data);
        if (parsed.msalCache && typeof parsed.msalCache === 'string') {
            msal.getTokenCache().deserialize(parsed.msalCache);
        }
    }
    catch {
        // No persisted msal cache yet.
    }
    finally {
        msalHydrated = true;
    }
}
async function logout() {
    cache.account = null;
    cache.accessToken = null;
    cache.expiresAt = null;
    msalHydrated = false;
    try {
        const cachePath = await getTokenCachePath();
        await fs.promises.unlink(cachePath);
    }
    catch { /* Ignore */ }
    console.log('Logged out.');
}
// ============================================
// GRAPH
// ============================================
let graphClient = null;
function getGraphClient() {
    if (!graphClient) {
        graphClient = Client.init({
            authProvider: async (done) => {
                try {
                    const token = await getAccessToken();
                    done(null, token);
                }
                catch (error) {
                    const err = error instanceof Error ? error : new Error(String(error));
                    done(err, null);
                }
            },
        });
    }
    return graphClient;
}
async function listUnreadEmails(top = 10) {
    const client = getGraphClient();
    const result = await client.api('/me/messages')
        .filter('isRead eq false')
        .select('id,subject,from,toRecipients,bodyPreview,isRead,receivedDateTime')
        .top(top)
        .orderby('receivedDateTime desc')
        .get();
    return result.value;
}
async function searchEmails(query, top = 25) {
    const client = getGraphClient();
    const normalized = query.replace(/"/g, '').trim();
    if (!normalized)
        return [];
    const result = await client.api('/me/messages')
        .header('ConsistencyLevel', 'eventual')
        .search(`"${normalized}"`)
        .select('id,subject,from,toRecipients,bodyPreview,isRead,receivedDateTime')
        .top(top)
        .get();
    const items = (result.value || []);
    items.sort((a, b) => (b.receivedDateTime || '').localeCompare(a.receivedDateTime || ''));
    return items;
}
async function getEmailThread(messageId) {
    return await getGraphClient().api(`/me/messages/${messageId}`).get();
}
async function sendEmail(to, subject, body, isDraft = false) {
    const user = getCurrentUser() || 'unknown';
    const recipients = to
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean);
    if (!recipients.length) {
        throw new Error('At least one recipient is required');
    }
    for (const recipient of recipients) {
        const check = checkEmailAllowed(recipient);
        if (!check.allowed) {
            await auditLogger.log({ action: 'send_email', user, details: { recipient, subject }, status: 'blocked', error: check.reason });
            throw new Error(`BLOCKED: ${check.reason}`);
        }
    }
    const client = getGraphClient();
    const message = {
        subject,
        body: { contentType: 'HTML', content: body },
        toRecipients: recipients.map((address) => ({ emailAddress: { address } })),
    };
    if (isDraft) {
        // Graph draft creation uses /me/messages (or /me/mailFolders('Drafts')/messages).
        const created = await client.api('/me/messages').post(message);
        await auditLogger.log({
            action: 'draft_email',
            user,
            details: { recipientCount: recipients.length, recipientDomains: recipients.map((r) => r.split('@')[1]), subject: sanitizeForLogs(subject) },
            status: 'success',
        });
        return { id: created?.id || 'done', isDraft: true };
    }
    await client.api('/me/sendMail').post({ message, saveToSentItems: true });
    await auditLogger.log({
        action: 'send_email',
        user,
        details: { recipientCount: recipients.length, recipientDomains: recipients.map((r) => r.split('@')[1]), subject: sanitizeForLogs(subject) },
        status: 'success',
    });
    return { id: 'done', isDraft: false };
}
async function getCalendarEvent(eventId) {
    const client = getGraphClient();
    return await client.api(`/me/events/${eventId}`)
        .select('id,subject,start,end,location,organizer,attendees,iCalUId')
        .get();
}
async function findInviteMessageForEvent(event) {
    // Mailbox-wide search by subject + organizer.
    const organizer = event.organizer?.emailAddress?.address || event.organizer?.emailAddress?.name || '';
    const query = `${event.subject || ''} ${organizer}`.trim();
    if (!query)
        return null;
    const searched = await searchEmails(query, 30);
    for (const msg of searched) {
        const full = await getEmailThread(msg.id);
        if ((full.meetingMessageType || '').toLowerCase() === 'meetingrequest') {
            return full;
        }
    }
    return searched[0] || null;
}
async function createReplyAllDraftFromMessage(messageId, bodyHtml) {
    const client = getGraphClient();
    // Create a real reply-all draft so Outlook keeps thread/invite history.
    const created = await client.api(`/me/messages/${messageId}/createReplyAll`).post({});
    const draftId = String(created?.id || '').trim();
    if (!draftId)
        throw new Error('Failed to create reply-all draft');
    if (bodyHtml.trim()) {
        const current = await client.api(`/me/messages/${draftId}`).select('body').get();
        const existing = current?.body?.content || '';
        const merged = `${bodyHtml}<br><br>${existing}`;
        await client.api(`/me/messages/${draftId}`).patch({
            body: { contentType: 'HTML', content: merged },
        });
    }
    return { id: draftId, isDraft: true, sourceMessageId: messageId };
}
async function draftReplyAllForEvent(eventId, bodyHtml) {
    const event = await getCalendarEvent(eventId);
    const invite = await findInviteMessageForEvent(event);
    if (!invite?.id) {
        throw new Error('Could not find meeting invite message to reply-all');
    }
    return await createReplyAllDraftFromMessage(invite.id, bodyHtml);
}
async function listCalendarEvents(startDate, endDate) {
    const client = getGraphClient();
    const result = await client.api('/me/calendar/events')
        .filter(`start/dateTime ge '${startDate}' and end/dateTime le '${endDate}'`)
        .select('id,subject,start,end,location,organizer,attendees')
        .orderby('start/dateTime')
        .get();
    return result.value;
}
async function createMeeting(subject, startDateTime, endDateTime, attendees, body) {
    const user = getCurrentUser() || 'unknown';
    const client = getGraphClient();
    const event = {
        subject,
        start: { dateTime: startDateTime, timeZone: 'UTC' },
        end: { dateTime: endDateTime, timeZone: 'UTC' },
        body: body ? { contentType: 'HTML', content: body } : undefined,
        attendees: attendees.map(email => ({ emailAddress: { address: email }, type: 'required' })),
    };
    const result = await client.api('/me/events').post(event);
    await auditLogger.log({ action: 'create_meeting', user, details: { subject, attendees, startDateTime }, status: 'success' });
    return result;
}
async function respondToEvent(eventId, response) {
    const user = getCurrentUser() || 'unknown';
    await getGraphClient().api(`/me/events/${eventId}/${response}`).post({});
    await auditLogger.log({ action: `respond_${response}`, user, details: { eventId, response }, status: 'success' });
}
async function findFreeSlots(startDate, endDate, durationMinutes = 60) {
    const client = getGraphClient();
    const schedule = await client.api('/me/calendar/getSchedule').post({
        schedules: [getCurrentUser() || ''],
        startTime: { dateTime: startDate, timeZone: 'UTC' },
        endTime: { dateTime: endDate, timeZone: 'UTC' },
        availabilityViewInterval: 30,
    });
    const slots = [];
    const busySlots = schedule.value[0]?.scheduleItems || [];
    let currentTime = new Date(startDate);
    const endTime = new Date(endDate);
    while (currentTime < endTime) {
        const slotEnd = new Date(currentTime.getTime() + durationMinutes * 60000);
        const isFree = !busySlots.some((slot) => {
            const slotStart = new Date(slot.start.dateTime);
            const slotEndTime = new Date(slot.end.dateTime);
            return currentTime < slotEndTime && slotStart < slotEnd;
        });
        if (isFree && slotEnd <= endTime)
            slots.push({ start: currentTime.toISOString(), end: slotEnd.toISOString() });
        currentTime = new Date(currentTime.getTime() + 30 * 60000);
    }
    return slots;
}
async function getCurrentUserProfile() {
    return await getGraphClient().api('/me').select('displayName,mail,userPrincipalName').get();
}
function toFileSearchResult(resource) {
    const id = String(resource.id || '').trim();
    const name = String(resource.name || '').trim();
    if (!id || !name)
        return null;
    const parentReference = (resource.parentReference || {});
    const path = typeof parentReference.path === 'string' ? parentReference.path : undefined;
    const driveId = typeof parentReference.driveId === 'string' ? parentReference.driveId : undefined;
    return {
        id,
        driveId,
        name,
        webUrl: typeof resource.webUrl === 'string' ? resource.webUrl : undefined,
        path,
        lastModifiedDateTime: typeof resource.lastModifiedDateTime === 'string' ? resource.lastModifiedDateTime : undefined,
        size: typeof resource.size === 'number' ? resource.size : undefined,
        file: typeof resource.file === 'object' && resource.file !== null ? resource.file : undefined,
        createdBy: typeof resource.createdBy === 'object' && resource.createdBy !== null ? resource.createdBy : undefined,
        lastModifiedBy: typeof resource.lastModifiedBy === 'object' && resource.lastModifiedBy !== null ? resource.lastModifiedBy : undefined,
        source: 'search',
    };
}
async function searchFiles(query, top = 20, mode = 'both') {
    const client = getGraphClient();
    const normalized = query.replace(/"/g, '').trim();
    if (!normalized)
        return [];
    // Microsoft Search spans OneDrive + SharePoint for driveItem.
    const response = await client.api('/search/query').post({
        requests: [
            {
                entityTypes: ['driveItem'],
                query: { queryString: normalized },
                from: 0,
                size: Math.max(1, Math.min(50, top)),
                fields: [
                    'id',
                    'name',
                    'webUrl',
                    'lastModifiedDateTime',
                    'size',
                    'file',
                    'parentReference',
                    'createdBy',
                    'lastModifiedBy',
                ],
            },
        ],
    });
    const values = Array.isArray(response.value)
        ? response.value
        : [];
    const first = (values[0] || {});
    const containers = Array.isArray(first.hitsContainers) ? first.hitsContainers : [];
    const hitsContainer = (containers[0] || {});
    const hits = Array.isArray(hitsContainer.hits) ? hitsContainer.hits : [];
    const q = normalized.toLowerCase();
    const results = [];
    for (const hit of hits) {
        const hitObj = hit;
        const resource = (hitObj.resource || {});
        const mapped = toFileSearchResult(resource);
        if (!mapped)
            continue;
        mapped.summary = String(hitObj.summary || '').trim() || undefined;
        if (mode === 'name') {
            if (!mapped.name.toLowerCase().includes(q))
                continue;
        }
        else if (mode === 'content') {
            const summary = String(hitObj.summary || '').toLowerCase();
            const inSummary = summary.includes(q);
            if (!inSummary)
                continue;
        }
        results.push(mapped);
    }
    results.sort((a, b) => (b.lastModifiedDateTime || '').localeCompare(a.lastModifiedDateTime || ''));
    return results.slice(0, top);
}
function stripHtml(input) {
    return input
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
function isTextLike(contentType, fileName) {
    const ct = contentType.toLowerCase();
    const name = fileName.toLowerCase();
    if (ct.startsWith('text/'))
        return true;
    if (ct.includes('json') || ct.includes('xml') || ct.includes('yaml') || ct.includes('csv'))
        return true;
    return ['.txt', '.md', '.csv', '.json', '.xml', '.yml', '.yaml', '.log', '.html', '.htm'].some(ext => name.endsWith(ext));
}
function isUnsupportedBinary(contentType, fileName) {
    const ct = contentType.toLowerCase();
    const name = fileName.toLowerCase();
    if (ct.includes('pdf') || ct.includes('officedocument'))
        return true;
    return ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx'].some(ext => name.endsWith(ext));
}
async function getDriveItemMetadata(driveId, itemId) {
    const client = getGraphClient();
    const item = await client.api(`/drives/${driveId}/items/${itemId}`)
        .select('id,name,size,webUrl,lastModifiedDateTime,file,parentReference')
        .get();
    const parentReference = (item?.parentReference || {});
    const resolvedDriveId = String(parentReference.driveId || driveId || '').trim();
    if (!resolvedDriveId)
        throw new Error('Could not resolve driveId for file.');
    return {
        id: String(item?.id || itemId),
        driveId: resolvedDriveId,
        name: String(item?.name || 'unknown'),
        size: typeof item?.size === 'number' ? item.size : undefined,
        webUrl: typeof item?.webUrl === 'string' ? item.webUrl : undefined,
        lastModifiedDateTime: typeof item?.lastModifiedDateTime === 'string' ? item.lastModifiedDateTime : undefined,
        mimeType: typeof item?.file?.mimeType === 'string' ? item.file.mimeType : undefined,
    };
}
async function readDriveItemText(driveId, itemId, maxChars = 12000) {
    const item = await getDriveItemMetadata(driveId, itemId);
    const token = await getAccessToken();
    const endpoint = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(item.driveId)}/items/${encodeURIComponent(item.id)}/content`;
    const response = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
        throw new Error(`Graph content fetch failed (${response.status}): ${response.statusText}`);
    }
    const contentType = response.headers.get('content-type') || item.mimeType || '';
    const bytes = Buffer.from(await response.arrayBuffer());
    let text = '';
    if (isUnsupportedBinary(contentType, item.name)) {
        text = `Binary Office/PDF format is not directly extractable in this gateway. Use webUrl for external summarize flow: ${item.webUrl || 'N/A'}`;
    }
    else if (isTextLike(contentType, item.name)) {
        text = bytes.toString('utf-8');
        if (contentType.toLowerCase().includes('html') || item.name.toLowerCase().endsWith('.html') || item.name.toLowerCase().endsWith('.htm')) {
            text = stripHtml(text);
        }
    }
    else {
        text = `Unsupported content type for text extraction: ${contentType || 'unknown'}`;
    }
    const normalized = text.replace(/\r\n/g, '\n').trim();
    const capped = normalized.slice(0, Math.max(1000, maxChars));
    return {
        item,
        contentType: contentType || undefined,
        extractedText: capped,
        extractedChars: capped.length,
        truncated: normalized.length > capped.length,
        source: 'graph-content',
    };
}
// ============================================
// MCP SERVER
// ============================================
const tools = {
    login: async () => { await login(); return { success: true, user: getCurrentUser() }; },
    logout: async () => { await logout(); return { success: true }; },
    get_user: async () => { if (!isLoggedIn())
        throw new Error('Not logged in'); return await getCurrentUserProfile(); },
    list_unread: async (params) => { if (!isLoggedIn())
        throw new Error('Not logged in'); return await listUnreadEmails(params.top ? parseInt(String(params.top), 10) : 10); },
    search_emails: async (params) => {
        if (!isLoggedIn())
            throw new Error('Not logged in');
        const query = String(params.query || '').trim();
        if (!query)
            throw new Error('query is required');
        return await searchEmails(query, params.top ? parseInt(String(params.top), 10) : 25);
    },
    search_files: async (params) => {
        if (!isLoggedIn())
            throw new Error('Not logged in');
        const query = String(params.query || '').trim();
        if (!query)
            throw new Error('query is required');
        const modeRaw = String(params.mode || 'both').toLowerCase();
        const mode = modeRaw === 'name' || modeRaw === 'content' || modeRaw === 'both' ? modeRaw : 'both';
        const top = params.top ? parseInt(String(params.top), 10) : 20;
        return await searchFiles(query, top, mode);
    },
    read_file_content: async (params) => {
        if (!isLoggedIn())
            throw new Error('Not logged in');
        const query = String(params.query || '').trim();
        const maxChars = params.maxChars ? parseInt(String(params.maxChars), 10) : 12000;
        let driveId = String(params.driveId || '').trim();
        let itemId = String(params.itemId || '').trim();
        if (!itemId && query) {
            const matches = await searchFiles(query, 1, 'both');
            if (!matches.length)
                throw new Error(`No files found for query: ${query}`);
            itemId = matches[0].id;
            driveId = matches[0].driveId || '';
            if (!driveId)
                throw new Error('Top match did not include driveId. Try explicit driveId + itemId.');
        }
        if (!driveId || !itemId) {
            throw new Error('Provide either query OR both driveId and itemId.');
        }
        return await readDriveItemText(driveId, itemId, maxChars);
    },
    get_email: async (params) => { if (!isLoggedIn())
        throw new Error('Not logged in'); return await getEmailThread(params.messageId); },
    send_email: async (params) => { if (!isLoggedIn())
        throw new Error('Not logged in'); return await sendEmail(params.to, params.subject, params.body, params.isDraft); },
    draft_email: async (params) => { if (!isLoggedIn())
        throw new Error('Not logged in'); return await sendEmail(params.to, params.subject, params.body, true); },
    list_calendar: async (params) => { if (!isLoggedIn())
        throw new Error('Not logged in'); return await listCalendarEvents(params.startDate, params.endDate); },
    get_event: async (params) => {
        if (!isLoggedIn())
            throw new Error('Not logged in');
        if (!params.eventId)
            throw new Error('eventId is required');
        return await getCalendarEvent(params.eventId);
    },
    draft_reply_all_event: async (params) => {
        if (!isLoggedIn())
            throw new Error('Not logged in');
        const eventId = String(params.eventId || '').trim();
        const body = String(params.body || '');
        if (!eventId)
            throw new Error('eventId is required');
        return await draftReplyAllForEvent(eventId, body);
    },
    create_meeting: async (params) => { if (!isLoggedIn())
        throw new Error('Not logged in'); return await createMeeting(params.subject, params.startDateTime, params.endDateTime, params.attendees || [], params.body); },
    respond_event: async (params) => { if (!isLoggedIn())
        throw new Error('Not logged in'); await respondToEvent(params.eventId, params.response); return { success: true }; },
    find_free_slots: async (params) => { if (!isLoggedIn())
        throw new Error('Not logged in'); return await findFreeSlots(params.startDate, params.endDate, params.durationMinutes ? parseInt(String(params.durationMinutes), 10) : 60); },
    get_audit_log: async (params) => await auditLogger.getRecentEntries(params.limit ? parseInt(String(params.limit), 10) : 100),
    list_tools: async () => ({ tools: Object.keys(tools).map(name => ({ name, description: name })) }),
};
async function handleRequest(request) {
    const { jsonrpc, id, method, params } = request;
    try {
        if (method === 'tools/list') {
            return { jsonrpc, id, result: { tools: Object.keys(tools).map(name => ({ name, inputSchema: { type: 'object' } })) } };
        }
        if (method === 'tools/call') {
            const toolName = params?.name;
            const toolParams = params?.arguments || {};
            if (!tools[toolName])
                return { jsonrpc, id, error: { code: -32601, message: `Tool not found: ${toolName}` } };
            const result = await tools[toolName](toolParams);
            return { jsonrpc, id, result };
        }
        return { jsonrpc, id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
    catch (error) {
        return { jsonrpc, id, error: { code: -32000, message: error instanceof Error ? error.message : 'Unknown error' } };
    }
}
function startMCPServer() {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
        buffer += chunk;
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (!line.trim())
                continue;
            try {
                const request = JSON.parse(line);
                handleRequest(request).then(response => console.log(JSON.stringify(response)));
            }
            catch { /* Ignore parse errors */ }
        }
    });
}
function startHTTPServer(port = 3000) {
    const server = http.createServer(async (req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok', user: getCurrentUser() }));
            return;
        }
        if (req.method === 'POST' && req.url === '/mcp') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const request = JSON.parse(body);
                    const response = await handleRequest(request);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(response));
                }
                catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: String(e) }));
                }
            });
            return;
        }
        res.writeHead(404);
        res.end('Not found');
    });
    server.listen(port, '0.0.0.0', () => {
        console.log(`HTTP server listening on http://0.0.0.0:${port}`);
        console.log(`  Health: http://0.0.0.0:${port}/health`);
        console.log(`  MCP:    http://0.0.0.0:${port}/mcp`);
    });
}
// ============================================
// MAIN
// ============================================
async function main() {
    const args = process.argv.slice(2);
    loadConfig();
    await auditLogger.init();
    await loadTokenCache();
    if (args.includes('--login')) {
        await login();
        return;
    }
    if (args.includes('--logout')) {
        await logout();
        return;
    }
    if (args.includes('--user')) {
        if (!isLoggedIn()) {
            console.error('Not logged in.');
            process.exit(1);
        }
        console.log(`Logged in as: ${getCurrentUser()}`);
        return;
    }
    if (!isLoggedIn()) {
        console.error('Not logged in. Run with --login first.');
        process.exit(1);
    }
    console.log('Starting Graph MCP Gateway...');
    console.log(`User: ${getCurrentUser()}`);
    startHTTPServer(3000);
}
main().catch(console.error);
//# sourceMappingURL=index.js.map