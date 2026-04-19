/**
 * Built-in smoke test runner.
 * Runs a series of HTTP calls against the local MCP server and reports pass/fail.
 *
 *   node dist/index.js --smoke
 *   az containerapp exec --command "node dist/index.js --smoke"
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

/** Extract structuredContent from a mcpCall result. */
function sc<T = Record<string, unknown>>(callResult: { result: unknown }): T {
  const r = callResult.result as { structuredContent?: T } | null;
  return r?.structuredContent ?? ({} as T);
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

  log('tools/list');
  try {
    const toolsResult = await mcpCall(1, 'tools/list', {});
    assertOk('tools/list', toolsResult);

    const toolsPayload = toolsResult.result as { tools?: Array<{ name?: string }> } | undefined;
    const toolCount = toolsPayload?.tools?.length ?? -1;
    if (toolCount === 22) {
      pass(`tools/list count = ${toolCount}`);
    } else {
      fail(`tools/list count = ${toolCount} (expected 22)`);
    }

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

    const retrievalTools = ['retrieve_context', 'retrieve_context_multi'];
    const missingRetrieval = retrievalTools.filter((t) => !registeredNames.has(t));
    if (missingRetrieval.length === 0) {
      pass('both Retrieval tools registered');
    } else {
      fail(`missing Retrieval tools: ${missingRetrieval.join(', ')}`);
    }
  } catch (err) {
    fail('tools/list', errMsg(err));
  }

  log('auth whoami');
  let currentUserEmail = '';
  try {
    const authResult = await mcpCall(2, 'tools/call', {
      name: 'auth',
      arguments: { action: 'whoami' },
    });
    assertOk('auth whoami', authResult);
    if (authResult.ok) {
      const content = sc<{ mail?: string; user_principal_name?: string }>(authResult);
      currentUserEmail = content?.mail || content?.user_principal_name || '';
      const user = currentUserEmail || 'unknown';
      process.stdout.write(`    User: ${user}\n`);
    }
  } catch (err) {
    fail('auth whoami', errMsg(err));
  }

  log('find — mail');
  let firstMailId: string | null = null;
  try {
    const mailResult = await mcpCall(3, 'tools/call', {
      name: 'find',
      arguments: { query: '*', entity_types: ['mail'], top: 3 },
    });
    assertOk('find mail', mailResult);
    const content = sc<{ results?: Array<{ id?: string }> }>(mailResult);
    firstMailId = content?.results?.[0]?.id ?? null;
  } catch (err) {
    fail('find mail', errMsg(err));
  }

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
    const content = sc<{ kql?: string }>(kqlResult);
    if (content?.kql === 'from:noreply@microsoft.com') {
      pass('kql echoed in response');
    } else {
      fail('kql not echoed in response', JSON.stringify(content));
    }
  } catch (err) {
    fail('find mail+kql', errMsg(err));
  }

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
    const content = sc<{ providers?: string[]; results?: Array<{ id?: string }> }>(dateResult);
    const providers = content?.providers ?? [];
    if (providers.includes('calendar-view')) {
      pass('date-range provider = calendar-view');
    } else {
      fail(`date-range provider = ${JSON.stringify(providers)} (expected calendar-view)`);
    }
    firstEventId = content?.results?.[0]?.id ?? null;
  } catch (err) {
    fail('find events date-range', errMsg(err));
  }

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
      const content = sc<{ providers?: string[]; results?: Array<{ drive_id?: string; id?: string }> }>(filesResult);
      const providers = content?.providers ?? [];
      if (providers.includes('graph-search') && !providers.includes('copilot-retrieval')) {
        pass('files provider = graph-search');
      } else {
        fail(`files provider = ${JSON.stringify(providers)} (expected graph-search only)`);
      }
      firstFileDriveId = content?.results?.[0]?.drive_id ?? null;
      firstFileItemId = content?.results?.[0]?.id ?? null;
    } else {
      warn('find files (search returned no results)');
    }
  } catch (err) {
    warn(`find files (${errMsg(err)})`);
  }

  log('get_file_metadata');
  if (firstFileDriveId && firstFileItemId) {
    try {
      const metaResult = await mcpCall(62, 'tools/call', {
        name: 'get_file_metadata',
        arguments: { drive_id: firstFileDriveId, item_id: firstFileItemId, include_full: true },
      });
      assertOk('get_file_metadata', metaResult);
      const content = sc<{ id?: string; name?: string }>(metaResult);
      if (content?.id === firstFileItemId) {
        pass(`get_file_metadata correct ID, name="${content?.name}"`);
      } else {
        fail(`get_file_metadata ID mismatch: ${content?.id} vs ${firstFileItemId}`);
      }
    } catch (err) {
      fail('get_file_metadata', errMsg(err));
    }
  } else {
    warn('get_file_metadata skipped (no file found by find)');
  }

  log('get_file_content');
  if (firstFileDriveId && firstFileItemId) {
    try {
      const contentResult = await mcpCall(63, 'tools/call', {
        name: 'get_file_content',
        arguments: { drive_id: firstFileDriveId, item_id: firstFileItemId, max_chars: 500 },
      });
      assertOk('get_file_content', contentResult);
      const content = sc<{ name?: string; encoding?: string; size_bytes?: number }>(contentResult);
      if (content?.encoding === 'text' || content?.encoding === 'base64') {
        pass(`get_file_content encoding=${content.encoding}, size=${content.size_bytes} bytes`);
      } else {
        fail(`get_file_content unexpected encoding`, JSON.stringify(content));
      }
    } catch (err) {
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

  log('get_email');
  let firstMailConversationId: string | null = null;
  if (firstMailId) {
    try {
      const getResult = await mcpCall(50, 'tools/call', {
        name: 'get_email',
        arguments: { message_id: firstMailId, include_full: true },
      });
      assertOk('get_email by ID', getResult);
      const content = sc<{ id?: string; conversation_id?: string }>(getResult);
      if (content?.id === firstMailId) {
        pass('get_email returned correct ID');
      } else {
        fail(`get_email ID mismatch: ${content?.id} vs ${firstMailId}`);
      }
      firstMailConversationId = content?.conversation_id ?? null;
    } catch (err) {
      fail('get_email', errMsg(err));
    }
  } else {
    warn('get_email skipped (no mail found by find)');
  }

  log('get_email_thread');
  if (firstMailConversationId) {
    try {
      const threadResult = await mcpCall(60, 'tools/call', {
        name: 'get_email_thread',
        arguments: { conversation_id: firstMailConversationId, top: 5 },
      });
      assertOk('get_email_thread by conversation_id', threadResult);
      const content = sc<{ conversation_id?: string; message_count?: number; messages?: unknown[] }>(threadResult);
      if (content?.conversation_id === firstMailConversationId) {
        pass('get_email_thread correct conversation_id');
      } else {
        fail(`get_email_thread conversation_id mismatch`, JSON.stringify(content));
      }
      if (typeof content?.message_count === 'number' && content.message_count >= 1) {
        pass(`get_email_thread returned ${content.message_count} message(s)`);
      } else {
        fail('get_email_thread empty or missing messages', JSON.stringify(content));
      }
    } catch (err) {
      fail('get_email_thread', errMsg(err));
    }
  } else if (firstMailId) {
    try {
      const threadResult = await mcpCall(61, 'tools/call', {
        name: 'get_email_thread',
        arguments: { message_id: firstMailId, top: 5 },
      });
      assertOk('get_email_thread by message_id', threadResult);
      const content = sc<{ message_count?: number }>(threadResult);
      if (typeof content?.message_count === 'number' && content.message_count >= 1) {
        pass(`get_email_thread (by msg_id) returned ${content.message_count} message(s)`);
      } else {
        fail('get_email_thread (by msg_id) empty', JSON.stringify(content));
      }
    } catch (err) {
      fail('get_email_thread by message_id', errMsg(err));
    }
  } else {
    warn('get_email_thread skipped (no mail found by find)');
  }

  log('get_event');
  if (firstEventId) {
    try {
      const getResult = await mcpCall(51, 'tools/call', {
        name: 'get_event',
        arguments: { event_id: firstEventId, include_full: true },
      });
      assertOk('get_event by ID', getResult);
      const content = sc<{ id?: string }>(getResult);
      if (content?.id === firstEventId) {
        pass('get_event returned correct ID');
      } else {
        fail(`get_event ID mismatch: ${content?.id} vs ${firstEventId}`);
      }
    } catch (err) {
      fail('get_event', errMsg(err));
    }
  } else {
    warn('get_event skipped (no event found by find)');
  }

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
      const content = sc<{ is_draft?: boolean; id?: string }>(draftResult);
      if (content?.is_draft === true && content?.id) {
        pass('compose_email draft has id + is_draft');
      } else {
        fail('compose_email draft missing id or is_draft', JSON.stringify(content));
      }
    } catch (err) {
      fail('compose_email draft', errMsg(err));
    }
  } else {
    warn('compose_email draft skipped (no current user email)');
  }

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
      const content = sc<{ success?: boolean }>(sendResult);
      if (content?.success === true) {
        pass('compose_email send success=true');
      } else {
        fail('compose_email send missing success', JSON.stringify(content));
      }
    } catch (err) {
      fail('compose_email send', errMsg(err));
    }
  } else {
    warn('compose_email send skipped (no current user email)');
  }

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
      const content = sc<{ mode?: string; is_draft?: boolean }>(replyResult);
      if (content?.mode === 'draft' && content?.is_draft === true) {
        pass('compose_email reply is draft');
      } else {
        fail('compose_email reply unexpected shape', JSON.stringify(content));
      }
    } catch (err) {
      fail('compose_email reply', errMsg(err));
    }
  } else {
    warn('compose_email reply skipped (no mail found by find)');
  }

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
    const content = sc<{ requires_confirmation?: boolean }>(previewResult);
    if (content?.requires_confirmation === true) {
      pass('schedule_meeting returns requires_confirmation');
    } else {
      fail('schedule_meeting preview unexpected shape', JSON.stringify(content));
    }
  } catch (err) {
    fail('schedule_meeting preview', errMsg(err));
  }

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
    const content = sc<{ id?: string }>(createResult);
    scheduledEventId = content?.id ?? null;
    if (scheduledEventId) {
      pass(`schedule_meeting created event ${scheduledEventId.slice(0, 20)}...`);

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
      fail('schedule_meeting create returned no event ID', JSON.stringify(content));
    }
  } catch (err) {
    fail('schedule_meeting create+cancel', errMsg(err));
  }

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
      const content = sc<{ success?: boolean; action?: string }>(acceptResult);
      if (content?.success === true && content?.action === 'accept') {
        pass('respond_to_meeting accept success');
      } else {
        warn('respond_to_meeting accept — unexpected shape (may be self-organized)');
      }
    } catch (err) {
      warn(`respond_to_meeting accept (${errMsg(err)})`);
    }
  } else {
    warn('respond_to_meeting accept skipped (no event found)');
  }

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

  log('list_chats');
  let firstChatId: string | null = null;
  try {
    const chatsResult = await mcpCall(70, 'tools/call', {
      name: 'list_chats',
      arguments: { top: 5 },
    });
    assertOk('list_chats', chatsResult);
    const content = sc<{ chats?: Array<{ id?: string; chat_type?: string }> }>(chatsResult);
    const chats = content?.chats ?? [];
    if (chats.length > 0) {
      firstChatId = chats[0]?.id ?? null;
      pass(`list_chats returned ${chats.length} chat(s), first type=${chats[0]?.chat_type}`);
    } else {
      warn('list_chats returned 0 chats (user may have no Teams chats)');
    }
  } catch (err) {
    fail('list_chats', errMsg(err));
  }

  log('get_chat');
  if (firstChatId) {
    try {
      const chatResult = await mcpCall(71, 'tools/call', {
        name: 'get_chat',
        arguments: { chat_id: firstChatId },
      });
      assertOk('get_chat by ID', chatResult);
      const content = sc<{ id?: string }>(chatResult);
      if (content?.id === firstChatId) {
        pass('get_chat returned correct ID');
      } else {
        fail(`get_chat ID mismatch: ${content?.id} vs ${firstChatId}`);
      }
    } catch (err) {
      fail('get_chat', errMsg(err));
    }
  } else {
    warn('get_chat skipped (no chat found)');
  }

  log('list_chat_messages');
  if (firstChatId) {
    try {
      const msgsResult = await mcpCall(72, 'tools/call', {
        name: 'list_chat_messages',
        arguments: { chat_id: firstChatId, top: 5 },
      });
      assertOk('list_chat_messages', msgsResult);
      const content = sc<{ messages?: Array<{ id?: string }> }>(msgsResult);
      const msgs = content?.messages ?? [];
      pass(`list_chat_messages returned ${msgs.length} message(s)`);
    } catch (err) {
      fail('list_chat_messages', errMsg(err));
    }
  } else {
    warn('list_chat_messages skipped (no chat found)');
  }

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
      const content = sc<{ requires_confirmation?: boolean }>(previewResult);
      if (content?.requires_confirmation === true) {
        pass('send_chat_message returns requires_confirmation');
      } else {
        fail('send_chat_message preview unexpected shape', JSON.stringify(content));
      }
    } catch (err) {
      fail('send_chat_message preview', errMsg(err));
    }
  } else {
    warn('send_chat_message preview skipped (no chat found)');
  }

  log('resolve_meeting — invalid URL');
  try {
    const resolveResult = await mcpCall(74, 'tools/call', {
      name: 'resolve_meeting',
      arguments: { join_web_url: 'https://example.com/not-a-teams-url' },
    });
      if (!resolveResult.ok) {
      const content = sc<{ error_code?: string }>(resolveResult);
      const code = content?.error_code ?? '';
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

  process.stdout.write('\n');
  log(`Results: ${passCount} passed, ${failCount} failed, ${warnCount} warnings`);
  if (failCount === 0) {
    process.stdout.write(`${GREEN}All smoke tests passed!${RESET}\n`);
  } else {
    process.stdout.write(`${RED}Some tests failed.${RESET}\n`);
  }

  process.exit(failCount > 0 ? 1 : 0);
}
