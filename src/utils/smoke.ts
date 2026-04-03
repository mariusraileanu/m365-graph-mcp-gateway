/**
 * Built-in smoke test runner.
 *
 * Runs a series of HTTP calls against the local MCP server (localhost:3000)
 * and reports pass/fail for each. Designed to be invoked via:
 *
 *   node dist/index.js --smoke
 *   az containerapp exec --command "node dist/index.js --smoke"
 *
 * Uses direct console output with ANSI colors (not the structured JSON logger)
 * since this is a human-facing CLI tool.
 */

import http from 'node:http';

const BASE = 'http://127.0.0.1:3000';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let passCount = 0;
let failCount = 0;
let warnCount = 0;

function log(msg: string): void {
  process.stdout.write(`\n${CYAN}▸ ${msg}${RESET}\n`);
}

function pass(label: string): void {
  passCount++;
  process.stdout.write(`  ${GREEN}✓ ${label}${RESET}\n`);
}

function fail(label: string, detail?: string): void {
  failCount++;
  process.stdout.write(`  ${RED}✗ ${label}${RESET}\n`);
  if (detail) {
    process.stdout.write(`    ${detail.slice(0, 300)}\n`);
  }
}

function warn(label: string): void {
  warnCount++;
  process.stdout.write(`  ${YELLOW}⚠ ${label}${RESET}\n`);
}

/** Make an HTTP request and return the response body as a string. */
function httpRequest(method: string, path: string, body?: string, timeoutMs = 30_000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    if (body) req.write(body);
    req.end();
  });
}

/** Send a JSON-RPC MCP call and return the parsed response. */
async function mcpCall(
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; result: unknown; raw: string }> {
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const { body } = await httpRequest('POST', '/mcp', payload);
  try {
    const json = JSON.parse(body) as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
      error?: unknown;
    };
    const isErr = !!(json.result?.isError || json.error);
    return { ok: !isErr, result: json.result ?? json.error, raw: body };
  } catch {
    return { ok: false, result: null, raw: body };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function assertOk(label: string, result: { ok: boolean; raw: string }): void {
  if (result.ok) {
    pass(label);
  } else {
    fail(label, result.raw);
  }
}

export async function runSmoke(): Promise<void> {
  process.stdout.write(`\n${CYAN}MCP Gateway — Remote Smoke Test${RESET}\n`);

  // ── Health ──────────────────────────────────────────────
  log('Health check');
  try {
    const { status, body } = await httpRequest('GET', '/health');
    if (status === 200 && body.includes('"status"')) {
      pass('health');
      process.stdout.write(`    ${body.trim()}\n`);
    } else {
      fail('health', `status=${status} body=${body}`);
    }
  } catch (err) {
    fail('health', `Connection failed: ${err instanceof Error ? err.message : String(err)}`);
    process.stdout.write(`\n${RED}Cannot reach server at ${BASE} — is it running?${RESET}\n`);
    process.exit(1);
  }

  // ── tools/list ──────────────────────────────────────────
  log('tools/list');
  try {
    const toolsResult = await mcpCall(1, 'tools/list', {});
    assertOk('tools/list', toolsResult);

    // A1: Verify exactly 20 tools are registered (11 Phase 1 + 9 Phase 2 Teams)
    const toolsPayload = toolsResult.result as { tools?: Array<{ name?: string }> } | undefined;
    const toolCount = toolsPayload?.tools?.length ?? -1;
    if (toolCount === 20) {
      pass(`tools/list count = ${toolCount}`);
    } else {
      fail(`tools/list count = ${toolCount} (expected 20)`);
    }

    // A2: Verify all 9 Teams tools are present
    const teamsTool = [
      'list_chats',
      'get_chat',
      'list_chat_messages',
      'get_chat_message',
      'send_chat_message',
      'resolve_meeting',
      'list_meeting_transcripts',
      'get_meeting_transcript',
      'get_transcript_content',
    ];
    const registeredNames = new Set((toolsPayload?.tools ?? []).map((t) => t.name));
    const missingTeams = teamsTool.filter((t) => !registeredNames.has(t));
    if (missingTeams.length === 0) {
      pass('all 9 Teams tools registered');
    } else {
      fail(`missing Teams tools: ${missingTeams.join(', ')}`);
    }
  } catch (err) {
    fail('tools/list', errMsg(err));
  }

  // ── removed tools return NOT_FOUND ─────────────────────
  log('removed tools → NOT_FOUND');
  for (const removed of ['summarize', 'prepare_meeting']) {
    try {
      const res = await mcpCall(100, 'tools/call', {
        name: removed,
        arguments: { query: 'test' },
      });
      if (!res.ok) {
        const sc = (res.result as { structuredContent?: { error_code?: string } })?.structuredContent;
        if (sc?.error_code === 'NOT_FOUND') {
          pass(`${removed} → NOT_FOUND`);
        } else {
          fail(`${removed} → unexpected error`, res.raw);
        }
      } else {
        fail(`${removed} → should not succeed (tool was removed)`);
      }
    } catch (err) {
      fail(`${removed}`, errMsg(err));
    }
  }

  // ── auth whoami ─────────────────────────────────────────
  log('auth whoami');
  let currentUserEmail = '';
  try {
    const authResult = await mcpCall(2, 'tools/call', {
      name: 'auth',
      arguments: { action: 'whoami' },
    });
    assertOk('auth whoami', authResult);
    if (authResult.ok) {
      const content = (authResult.result as { structuredContent?: { mail?: string; user_principal_name?: string } })?.structuredContent;
      currentUserEmail = content?.mail || content?.user_principal_name || '';
      const user = currentUserEmail || 'unknown';
      process.stdout.write(`    User: ${user}\n`);
    }
  } catch (err) {
    fail('auth whoami', errMsg(err));
  }

  // ── find mail ───────────────────────────────────────────
  log('find — mail');
  let firstMailId: string | null = null;
  try {
    const mailResult = await mcpCall(3, 'tools/call', {
      name: 'find',
      arguments: { query: '*', entity_types: ['mail'], top: 3 },
    });
    assertOk('find mail', mailResult);
    // Capture first mail ID for get_email / compose_email reply tests
    const sc = (mailResult.result as { structuredContent?: { results?: Array<{ id?: string }> } })?.structuredContent;
    firstMailId = sc?.results?.[0]?.id ?? null;
  } catch (err) {
    fail('find mail', errMsg(err));
  }

  // ── find mail with kql override ────────────────────────
  log('find — mail with kql');
  try {
    const kqlResult = await mcpCall(30, 'tools/call', {
      name: 'find',
      arguments: {
        query: 'fallback-text',
        kql: 'from:noreply@microsoft.com',
        entity_types: ['mail'],
        top: 3,
      },
    });
    assertOk('find mail+kql', kqlResult);
    const sc = (kqlResult.result as { structuredContent?: { kql?: string } })?.structuredContent;
    if (sc?.kql === 'from:noreply@microsoft.com') {
      pass('kql echoed in response');
    } else {
      fail('kql not echoed in response', JSON.stringify(sc));
    }
  } catch (err) {
    fail('find mail+kql', errMsg(err));
  }

  // ── find events ─────────────────────────────────────────
  log('find — events');
  try {
    const eventsResult = await mcpCall(4, 'tools/call', {
      name: 'find',
      arguments: { query: 'meeting', entity_types: ['events'], top: 3 },
    });
    assertOk('find events', eventsResult);
  } catch (err) {
    fail('find events', errMsg(err));
  }

  // ── find events with date range → calendar-view ────────
  log('find — events date-range (calendar-view)');
  let firstEventId: string | null = null;
  try {
    const now = new Date();
    const startDate = now.toISOString().slice(0, 10) + 'T00:00:00';
    const tomorrow = new Date(now.getTime() + 86_400_000);
    const endDate = tomorrow.toISOString().slice(0, 10) + 'T00:00:00';
    const dateResult = await mcpCall(40, 'tools/call', {
      name: 'find',
      arguments: {
        query: 'meetings',
        entity_types: ['events'],
        start_date: startDate,
        end_date: endDate,
        top: 3,
      },
    });
    assertOk('find events date-range', dateResult);
    const sc = (dateResult.result as { structuredContent?: { providers?: string[]; results?: Array<{ id?: string }> } })?.structuredContent;
    const providers = sc?.providers ?? [];
    if (providers.includes('calendar-view')) {
      pass('date-range provider = calendar-view');
    } else {
      fail(`date-range provider = ${JSON.stringify(providers)} (expected calendar-view)`);
    }
    // Capture first event ID for get_event test
    firstEventId = sc?.results?.[0]?.id ?? null;
  } catch (err) {
    fail('find events date-range', errMsg(err));
  }

  // ── find files ──────────────────────────────────────────
  log('find — files');
  let firstFileDriveId: string | null = null;
  let firstFileItemId: string | null = null;
  try {
    const filesResult = await mcpCall(5, 'tools/call', {
      name: 'find',
      arguments: { query: 'budget', entity_types: ['files'], top: 3 },
    });
    if (filesResult.ok) {
      pass('find files');
      // Verify provider is graph-search (not copilot-retrieval)
      const sc = (
        filesResult.result as { structuredContent?: { providers?: string[]; results?: Array<{ drive_id?: string; id?: string }> } }
      )?.structuredContent;
      const providers = sc?.providers ?? [];
      if (providers.includes('graph-search') && !providers.includes('copilot-retrieval')) {
        pass('files provider = graph-search');
      } else {
        fail(`files provider = ${JSON.stringify(providers)} (expected graph-search only)`);
      }
      // Capture first file IDs for get_file_metadata / get_file_content tests
      firstFileDriveId = sc?.results?.[0]?.drive_id ?? null;
      firstFileItemId = sc?.results?.[0]?.id ?? null;
    } else {
      // Graph Search may return empty for certain tenants or queries — treat as warning
      warn('find files (search returned no results)');
    }
  } catch (err) {
    // Timeout or network error — treat as warning, not hard failure
    warn(`find files (${errMsg(err)})`);
  }

  // ── get_file_metadata ──────────────────────────────────
  log('get_file_metadata');
  if (firstFileDriveId && firstFileItemId) {
    try {
      const metaResult = await mcpCall(62, 'tools/call', {
        name: 'get_file_metadata',
        arguments: { drive_id: firstFileDriveId, item_id: firstFileItemId, include_full: true },
      });
      assertOk('get_file_metadata', metaResult);
      const sc = (metaResult.result as { structuredContent?: { id?: string; name?: string } })?.structuredContent;
      if (sc?.id === firstFileItemId) {
        pass(`get_file_metadata correct ID, name="${sc?.name}"`);
      } else {
        fail(`get_file_metadata ID mismatch: ${sc?.id} vs ${firstFileItemId}`);
      }
    } catch (err) {
      fail('get_file_metadata', errMsg(err));
    }
  } else {
    warn('get_file_metadata skipped (no file found by find)');
  }

  // ── get_file_content ───────────────────────────────────
  log('get_file_content');
  if (firstFileDriveId && firstFileItemId) {
    try {
      const contentResult = await mcpCall(63, 'tools/call', {
        name: 'get_file_content',
        arguments: { drive_id: firstFileDriveId, item_id: firstFileItemId, max_chars: 500 },
      });
      assertOk('get_file_content', contentResult);
      const sc = (contentResult.result as { structuredContent?: { name?: string; encoding?: string; size_bytes?: number } })
        ?.structuredContent;
      if (sc?.encoding === 'text' || sc?.encoding === 'base64') {
        pass(`get_file_content encoding=${sc.encoding}, size=${sc.size_bytes} bytes`);
      } else {
        fail(`get_file_content unexpected encoding`, JSON.stringify(sc));
      }
    } catch (err) {
      // File may be too large or restricted — treat as warning
      const msg = errMsg(err);
      if (msg.includes('VALIDATION_ERROR') || msg.includes('exceeds')) {
        warn(`get_file_content skipped (file too large)`);
      } else {
        fail('get_file_content', msg);
      }
    }
  } else {
    warn('get_file_content skipped (no file found by find)');
  }

  // ── get_email ───────────────────────────────────────────
  log('get_email');
  let firstMailConversationId: string | null = null;
  if (firstMailId) {
    try {
      const getResult = await mcpCall(50, 'tools/call', {
        name: 'get_email',
        arguments: { message_id: firstMailId, include_full: true },
      });
      assertOk('get_email by ID', getResult);
      const sc = (getResult.result as { structuredContent?: { id?: string; conversation_id?: string } })?.structuredContent;
      if (sc?.id === firstMailId) {
        pass('get_email returned correct ID');
      } else {
        fail(`get_email ID mismatch: ${sc?.id} vs ${firstMailId}`);
      }
      firstMailConversationId = sc?.conversation_id ?? null;
    } catch (err) {
      fail('get_email', errMsg(err));
    }
  } else {
    warn('get_email skipped (no mail found by find)');
  }

  // ── get_email_thread ───────────────────────────────────
  log('get_email_thread');
  if (firstMailConversationId) {
    try {
      const threadResult = await mcpCall(60, 'tools/call', {
        name: 'get_email_thread',
        arguments: { conversation_id: firstMailConversationId, top: 5 },
      });
      assertOk('get_email_thread by conversation_id', threadResult);
      const sc = (threadResult.result as { structuredContent?: { conversation_id?: string; message_count?: number; messages?: unknown[] } })
        ?.structuredContent;
      if (sc?.conversation_id === firstMailConversationId) {
        pass('get_email_thread correct conversation_id');
      } else {
        fail(`get_email_thread conversation_id mismatch`, JSON.stringify(sc));
      }
      if (typeof sc?.message_count === 'number' && sc.message_count >= 1) {
        pass(`get_email_thread returned ${sc.message_count} message(s)`);
      } else {
        fail('get_email_thread empty or missing messages', JSON.stringify(sc));
      }
    } catch (err) {
      fail('get_email_thread', errMsg(err));
    }
  } else if (firstMailId) {
    // Fallback: use message_id path
    try {
      const threadResult = await mcpCall(61, 'tools/call', {
        name: 'get_email_thread',
        arguments: { message_id: firstMailId, top: 5 },
      });
      assertOk('get_email_thread by message_id', threadResult);
      const sc = (threadResult.result as { structuredContent?: { message_count?: number } })?.structuredContent;
      if (typeof sc?.message_count === 'number' && sc.message_count >= 1) {
        pass(`get_email_thread (by msg_id) returned ${sc.message_count} message(s)`);
      } else {
        fail('get_email_thread (by msg_id) empty', JSON.stringify(sc));
      }
    } catch (err) {
      fail('get_email_thread by message_id', errMsg(err));
    }
  } else {
    warn('get_email_thread skipped (no mail found by find)');
  }

  // ── get_event ──────────────────────────────────────────
  log('get_event');
  if (firstEventId) {
    try {
      const getResult = await mcpCall(51, 'tools/call', {
        name: 'get_event',
        arguments: { event_id: firstEventId, include_full: true },
      });
      assertOk('get_event by ID', getResult);
      const sc = (getResult.result as { structuredContent?: { id?: string } })?.structuredContent;
      if (sc?.id === firstEventId) {
        pass('get_event returned correct ID');
      } else {
        fail(`get_event ID mismatch: ${sc?.id} vs ${firstEventId}`);
      }
    } catch (err) {
      fail('get_event', errMsg(err));
    }
  } else {
    warn('get_event skipped (no event found by find)');
  }

  // ── compose_email — draft (safe, no send) ──────────────
  log('compose_email — draft to self');
  if (currentUserEmail) {
    try {
      const draftResult = await mcpCall(52, 'tools/call', {
        name: 'compose_email',
        arguments: {
          mode: 'draft',
          to: currentUserEmail,
          subject: `[Smoke Test] Draft — ${new Date().toISOString()}`,
          body_html: '<p>This is a smoke-test draft. Safe to delete.</p>',
        },
      });
      assertOk('compose_email draft', draftResult);
      const sc = (draftResult.result as { structuredContent?: { is_draft?: boolean; id?: string } })?.structuredContent;
      if (sc?.is_draft === true && sc?.id) {
        pass('compose_email draft has id + is_draft');
      } else {
        fail('compose_email draft missing id or is_draft', JSON.stringify(sc));
      }
    } catch (err) {
      fail('compose_email draft', errMsg(err));
    }
  } else {
    warn('compose_email draft skipped (no current user email)');
  }

  // ── compose_email — send to self ───────────────────────
  log('compose_email — send to self');
  if (currentUserEmail) {
    try {
      const sendResult = await mcpCall(53, 'tools/call', {
        name: 'compose_email',
        arguments: {
          mode: 'send',
          to: currentUserEmail,
          subject: `[Smoke Test] Send — ${new Date().toISOString()}`,
          body_html: '<p>Smoke-test email sent to self. Safe to delete.</p>',
          confirm: true,
        },
      });
      assertOk('compose_email send', sendResult);
      const sc = (sendResult.result as { structuredContent?: { success?: boolean } })?.structuredContent;
      if (sc?.success === true) {
        pass('compose_email send success=true');
      } else {
        fail('compose_email send missing success', JSON.stringify(sc));
      }
    } catch (err) {
      fail('compose_email send', errMsg(err));
    }
  } else {
    warn('compose_email send skipped (no current user email)');
  }

  // ── compose_email — reply ──────────────────────────────
  log('compose_email — reply');
  if (firstMailId) {
    try {
      const replyResult = await mcpCall(54, 'tools/call', {
        name: 'compose_email',
        arguments: {
          mode: 'reply',
          message_id: firstMailId,
          body_html: '<p>Smoke-test reply draft. Safe to delete.</p>',
        },
      });
      assertOk('compose_email reply draft', replyResult);
      const sc = (replyResult.result as { structuredContent?: { mode?: string; is_draft?: boolean } })?.structuredContent;
      if (sc?.mode === 'draft' && sc?.is_draft === true) {
        pass('compose_email reply is draft');
      } else {
        fail('compose_email reply unexpected shape', JSON.stringify(sc));
      }
    } catch (err) {
      fail('compose_email reply', errMsg(err));
    }
  } else {
    warn('compose_email reply skipped (no mail found by find)');
  }

  // ── schedule_meeting — preview (no confirm) ────────────
  log('schedule_meeting — preview');
  try {
    const futureStart = new Date(Date.now() + 7 * 86_400_000);
    futureStart.setHours(10, 0, 0, 0);
    const futureEnd = new Date(futureStart.getTime() + 30 * 60_000);
    const previewResult = await mcpCall(55, 'tools/call', {
      name: 'schedule_meeting',
      arguments: {
        subject: '[Smoke Test] Preview Meeting',
        start: futureStart.toISOString(),
        end: futureEnd.toISOString(),
      },
    });
    assertOk('schedule_meeting preview', previewResult);
    const sc = (previewResult.result as { structuredContent?: { requires_confirmation?: boolean } })?.structuredContent;
    if (sc?.requires_confirmation === true) {
      pass('schedule_meeting returns requires_confirmation');
    } else {
      fail('schedule_meeting preview unexpected shape', JSON.stringify(sc));
    }
  } catch (err) {
    fail('schedule_meeting preview', errMsg(err));
  }

  // ── schedule_meeting — create + cancel ─────────────────
  log('schedule_meeting — create + cancel');
  let scheduledEventId: string | null = null;
  try {
    const futureStart = new Date(Date.now() + 8 * 86_400_000);
    futureStart.setHours(15, 0, 0, 0);
    const futureEnd = new Date(futureStart.getTime() + 30 * 60_000);
    const createResult = await mcpCall(56, 'tools/call', {
      name: 'schedule_meeting',
      arguments: {
        subject: `[Smoke Test] Create+Cancel — ${new Date().toISOString()}`,
        start: futureStart.toISOString(),
        end: futureEnd.toISOString(),
        confirm: true,
      },
    });
    assertOk('schedule_meeting create', createResult);
    const sc = (createResult.result as { structuredContent?: { id?: string } })?.structuredContent;
    scheduledEventId = sc?.id ?? null;
    if (scheduledEventId) {
      pass(`schedule_meeting created event ${scheduledEventId.slice(0, 20)}...`);

      // Cancel the event we just created
      const cancelResult = await mcpCall(57, 'tools/call', {
        name: 'respond_to_meeting',
        arguments: {
          event_id: scheduledEventId,
          action: 'cancel',
          comment: 'Smoke test cleanup',
          confirm: true,
        },
      });
      assertOk('respond_to_meeting cancel (cleanup)', cancelResult);
    } else {
      fail('schedule_meeting create returned no event ID', JSON.stringify(sc));
    }
  } catch (err) {
    fail('schedule_meeting create+cancel', errMsg(err));
  }

  // ── respond_to_meeting — accept (on found event) ───────
  log('respond_to_meeting — accept');
  if (firstEventId) {
    try {
      const acceptResult = await mcpCall(58, 'tools/call', {
        name: 'respond_to_meeting',
        arguments: {
          event_id: firstEventId,
          action: 'accept',
          confirm: true,
        },
      });
      assertOk('respond_to_meeting accept', acceptResult);
      const sc = (acceptResult.result as { structuredContent?: { success?: boolean; action?: string } })?.structuredContent;
      if (sc?.success === true && sc?.action === 'accept') {
        pass('respond_to_meeting accept success');
      } else {
        // Accept may fail if we organized the event — treat as warning
        warn('respond_to_meeting accept — unexpected shape (may be self-organized)');
      }
    } catch (err) {
      warn(`respond_to_meeting accept (${errMsg(err)})`);
    }
  } else {
    warn('respond_to_meeting accept skipped (no event found)');
  }

  // ── audit_list ──────────────────────────────────────────
  log('audit_list');
  try {
    const auditResult = await mcpCall(6, 'tools/call', {
      name: 'audit_list',
      arguments: { limit: 5 },
    });
    assertOk('audit_list', auditResult);
  } catch (err) {
    fail('audit_list', errMsg(err));
  }

  // ── list_chats ─────────────────────────────────────────
  log('list_chats');
  let firstChatId: string | null = null;
  try {
    const chatsResult = await mcpCall(70, 'tools/call', {
      name: 'list_chats',
      arguments: { top: 5 },
    });
    assertOk('list_chats', chatsResult);
    const sc = (chatsResult.result as { structuredContent?: { chats?: Array<{ id?: string; chat_type?: string }> } })?.structuredContent;
    const chats = sc?.chats ?? [];
    if (chats.length > 0) {
      firstChatId = chats[0]?.id ?? null;
      pass(`list_chats returned ${chats.length} chat(s), first type=${chats[0]?.chat_type}`);
    } else {
      warn('list_chats returned 0 chats (user may have no Teams chats)');
    }
  } catch (err) {
    fail('list_chats', errMsg(err));
  }

  // ── get_chat ───────────────────────────────────────────
  log('get_chat');
  if (firstChatId) {
    try {
      const chatResult = await mcpCall(71, 'tools/call', {
        name: 'get_chat',
        arguments: { chat_id: firstChatId },
      });
      assertOk('get_chat by ID', chatResult);
      const sc = (chatResult.result as { structuredContent?: { id?: string } })?.structuredContent;
      if (sc?.id === firstChatId) {
        pass('get_chat returned correct ID');
      } else {
        fail(`get_chat ID mismatch: ${sc?.id} vs ${firstChatId}`);
      }
    } catch (err) {
      fail('get_chat', errMsg(err));
    }
  } else {
    warn('get_chat skipped (no chat found)');
  }

  // ── list_chat_messages ─────────────────────────────────
  log('list_chat_messages');
  if (firstChatId) {
    try {
      const msgsResult = await mcpCall(72, 'tools/call', {
        name: 'list_chat_messages',
        arguments: { chat_id: firstChatId, top: 5 },
      });
      assertOk('list_chat_messages', msgsResult);
      const sc = (msgsResult.result as { structuredContent?: { messages?: Array<{ id?: string }> } })?.structuredContent;
      const msgs = sc?.messages ?? [];
      pass(`list_chat_messages returned ${msgs.length} message(s)`);
    } catch (err) {
      fail('list_chat_messages', errMsg(err));
    }
  } else {
    warn('list_chat_messages skipped (no chat found)');
  }

  // ── send_chat_message — preview (no confirm) ──────────
  log('send_chat_message — preview');
  if (firstChatId) {
    try {
      const previewResult = await mcpCall(73, 'tools/call', {
        name: 'send_chat_message',
        arguments: {
          chat_id: firstChatId,
          content: '[Smoke Test] Preview — not actually sent',
        },
      });
      assertOk('send_chat_message preview', previewResult);
      const sc = (previewResult.result as { structuredContent?: { requires_confirmation?: boolean } })?.structuredContent;
      if (sc?.requires_confirmation === true) {
        pass('send_chat_message returns requires_confirmation');
      } else {
        fail('send_chat_message preview unexpected shape', JSON.stringify(sc));
      }
    } catch (err) {
      fail('send_chat_message preview', errMsg(err));
    }
  } else {
    warn('send_chat_message preview skipped (no chat found)');
  }

  // ── resolve_meeting — with invalid URL ────────────────
  log('resolve_meeting — invalid URL');
  try {
    const resolveResult = await mcpCall(74, 'tools/call', {
      name: 'resolve_meeting',
      arguments: { join_web_url: 'https://example.com/not-a-teams-url' },
    });
    // Expected: MEETING_NOT_RESOLVABLE or VALIDATION_ERROR
    if (!resolveResult.ok) {
      const sc = (resolveResult.result as { structuredContent?: { error_code?: string } })?.structuredContent;
      const code = sc?.error_code ?? '';
      if (code === 'MEETING_NOT_RESOLVABLE' || code === 'VALIDATION_ERROR') {
        pass(`resolve_meeting invalid URL → ${code}`);
      } else {
        fail(`resolve_meeting invalid URL → unexpected error: ${code}`, resolveResult.raw);
      }
    } else {
      warn('resolve_meeting invalid URL succeeded unexpectedly');
    }
  } catch (err) {
    fail('resolve_meeting invalid URL', errMsg(err));
  }

  // ── Summary ─────────────────────────────────────────────
  process.stdout.write('\n');
  log(`Results: ${passCount} passed, ${failCount} failed, ${warnCount} warnings`);
  if (failCount === 0) {
    process.stdout.write(`${GREEN}All smoke tests passed!${RESET}\n`);
  } else {
    process.stdout.write(`${RED}Some tests failed.${RESET}\n`);
  }

  process.exit(failCount > 0 ? 1 : 0);
}
