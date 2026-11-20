#!/usr/bin/env node
// pending-stop: a turn does not end while the agent's own background command or PR is still open.
//
// Shaan, 15 Nov 2026: "why the fuck do you keep auto-settling ... not have landed all of the PRs and worked
// through the task list". The house rule "never end a turn while your own job runs" was prose; this is the
// mechanism. Idea and shape from Cursor's advisor and ralph-loop Stop hooks (MIT © Cursor, cursor/plugins
// advisor/hooks/{mark-pending,stop-hook}.sh, ralph-loop/hooks/stop-hook.sh @ bf0c7cd): a marker armed by one
// hook, a Stop hook bound to one conversation, a loop limit of 3, and silence when the reply ends in "?".
//
// A delegate (T3 delegate_task) never blocks. T3 hands it off when it starts: when the child ends, T3 posts
// "Delegated task <id> (...) [status]" into this thread and wakes it. Shaan, 19 Nov: "I'm sending messages and they
// end up queuing, which is very, very not fucking good". The old delegate hint sent owners into t3_thread_wait
// loops; a partner house's owner sat in one from 01:30Z to 01:45Z with 6 builders running, and Shaan's messages queued behind it.
//
//   node pending-stop.mjs mark                 PostToolUse: record or clear open work for this session
//   node pending-stop.mjs stop                 Stop: block while open work remains
//   node pending-stop.mjs release <id|all> why  run from Bash when the work is truly handed off; the
//                                              PostToolUse hook sees the command and clears the marker
//
// State: $SISO_STATE_HOME/pending/<session>.json (default ~/.siso). Fails open on anything unexpected.
//
// Report guard (lib/report-guard.mjs): when nothing else blocks, a final reply may not ask the reader to run a command,
// and a pinned thread woken by another agent closes in 60 words. Blocks once per turn. Shaan, 19 Nov: "I don't
// understand why you would ever ask me to run a fucking command".
import { existsSync, openSync, readFileSync, readSync, closeSync, fstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonLinesReverse, readPayload, safeId, stateRoot, t3Thread, writeJsonAtomic } from './lib/common.mjs';
import { LONG_WORDS, isAgentWake, reportGuard, wordCount } from './lib/report-guard.mjs';

export const LOOP_LIMIT = 3;
const TTL_HOURS = Number(process.env.SISO_PENDING_STOP_TTL_HOURS) > 0 ? Number(process.env.SISO_PENDING_STOP_TTL_HOURS) : 6;
const SCAN_LIMIT = 16 * 1024 * 1024;
const RELEASE_COMMAND = "node ~/.siso/agent-hooks/0.1.0/hooks/pending-stop.mjs release <id|all> '<why it is handed off>'";
const T3 = 'mcp__t3-code__';

const mode = process.argv[2] || '';

if (mode === 'release') {
  // Run by the agent from Bash. The PostToolUse hook, which knows the session, does the clearing.
  console.log(`pending-stop: release ${process.argv[3] || 'all'} recorded for this session (${process.argv.slice(4).join(' ') || 'no reason given'}).`);
} else if (mode === 'mark' || mode === 'stop') {
  const payload = await readPayload();
  if (payload && typeof payload === 'object' && process.env.SISO_PENDING_STOP !== 'off') {
    try {
      if (mode === 'mark') mark(payload);
      else if (!stop(payload)) guardReport(payload);
    } catch {
      // Fail open: a broken marker must never trap a turn.
    }
  }
}

function statePath(sessionId) {
  return join(stateRoot(), 'pending', `${safeId(sessionId)}.json`);
}

function load(sessionId) {
  try { return JSON.parse(readFileSync(statePath(sessionId), 'utf8')); } catch { return null; }
}

function save(sessionId, state) {
  const path = statePath(sessionId);
  if (!state || !Object.keys(state.items || {}).length) {
    rmSync(path, { force: true });
    return;
  }
  state.updated_at = new Date().toISOString();
  writeJsonAtomic(path, state);
}

function transcriptSize(path) {
  try {
    const descriptor = openSync(path, 'r');
    try { return fstatSync(descriptor).size; } finally { closeSync(descriptor); }
  } catch { return 0; }
}

// MCP results arrive as a JSON string, a content array of text blocks, or an object.
function responseObject(response) {
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    if (typeof response.text === 'string') return responseObject(response.text);
    if (Array.isArray(response.content)) return responseObject(response.content);
    return response;
  }
  const text = Array.isArray(response)
    ? response.map((block) => (typeof block === 'string' ? block : block?.text || '')).join('')
    : typeof response === 'string' ? response : '';
  try { return JSON.parse(text); } catch { return { _text: text }; }
}

function responseText(response) {
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object') {
    return [response.stdout, response.stderr, response._text].filter((part) => typeof part === 'string').join('\n')
      || JSON.stringify(response);
  }
  return '';
}

function prNumber(text) {
  const url = String(text || '').match(/\/pull\/(\d+)/);
  if (url) return url[1];
  // A number right before ">" is a redirect (2>&1), not a PR.
  const bare = String(text || '').match(/\bgh\s+pr\s+(?:merge|close)\b[^|;&\n]*?\s#?(\d+)\b(?!>)/);
  return bare ? bare[1] : null;
}

function mark(input) {
  const sessionId = input.session_id;
  if (!sessionId || input.agent_id) return; // a subagent's own work is the subagent's to wait on
  const tool = String(input.tool_name || '');
  const toolInput = input.tool_input || {};
  const response = input.tool_response;
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  let state = load(sessionId);
  const add = (key, item) => {
    state ||= { session_id: sessionId, items: {}, blocks: 0 };
    state.transcript_path = input.transcript_path || state.transcript_path;
    state.items[key] = { ...item, started_at: new Date().toISOString(), offset: transcriptSize(input.transcript_path) };
  };
  const clear = (predicate) => {
    if (!state) return;
    for (const [key, item] of Object.entries(state.items)) if (predicate(key, item)) delete state.items[key];
  };

  if (tool === 'Bash') {
    // Every release in the command counts, not only the first ("release a && release b").
    const releases = [...command.matchAll(/pending-stop\.mjs['"]?\s+release\b\s*['"]?([^\s'"]*)/g)];
    if (releases.length) {
      for (const release of releases) {
        const target = release[1] || 'all';
        clear((key, item) => target === 'all' || key === target || item.id === target || key.endsWith(`:${target}`) || String(item.id).endsWith(`/pull/${target}`));
      }
    } else if (toolInput.run_in_background && response && typeof response === 'object' && response.backgroundTaskId) {
      const id = String(response.backgroundTaskId);
      add(`bash:${id}`, { kind: 'bash', id, label: toolInput.description || command.slice(0, 80) });
    } else {
      // One command may create a PR and then merge it, so both are read.
      const created = /\bgh\s+pr\s+create\b/.test(command)
        && responseText(response).match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/);
      if (created) add(`pr:${created[0]}`, { kind: 'pr', id: created[0], label: `PR ${created[0]}` });
      if (/\bgh\s+pr\s+(merge|close)\b/.test(command)) {
        // Each "gh pr merge|close" in the command clears its own PR (16 Nov: "merge 974; ...; merge 978" cleared only
        // 974). "gh pr merge $n": the number is not in the command, so take it from the PR this command created.
        const numbers = [...command.matchAll(/\bgh\s+pr\s+(?:merge|close)\b[^|;&\n]*/g)].map((m) => prNumber(m[0])).filter(Boolean);
        if (!numbers.length && created) numbers.push(prNumber(created[0]));
        clear((key, item) => item.kind === 'pr' && (!numbers.length || numbers.some((n) => String(item.id).endsWith(`/pull/${n}`))));
      }
    }
  } else if (tool === 'KillShell' || tool === 'KillBash' || tool === 'TaskStop') {
    const id = String(toolInput.shell_id || toolInput.task_id || toolInput.bash_id || toolInput.id || '');
    if (id) clear((key) => key === `bash:${id}`);
  } else if (tool === 'BashOutput' || tool === 'TaskOutput') {
    const id = String(toolInput.bash_id || toolInput.task_id || toolInput.shell_id || '');
    const status = responseObject(response)?.status;
    if (id && /^(completed|failed|killed|stopped|exited)$/.test(String(status))) clear((key) => key === `bash:${id}`);
  } else if (tool === `${T3}watch_pull_request`) {
    // T3 now watches the PR and wakes this thread when it changes: the sanctioned hand-off.
    const result = responseObject(response);
    const url = result?.url || toolInput.url || '';
    const number = prNumber(url) || (result?.number ? String(result.number) : null);
    if (result?.watching !== false && number) clear((key, item) => item.kind === 'pr' && String(item.id).endsWith(`/pull/${number}`));
  }
  if (state) save(sessionId, state);
}

// Completion evidence written to the transcript after the work started: Claude Code's
// <task-notification> for a background command.
function readTranscriptFrom(path, offset) {
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
    const size = fstatSync(descriptor).size;
    const start = Math.max(Math.min(offset || 0, size), size - SCAN_LIMIT);
    const buffer = Buffer.alloc(size - start);
    readSync(descriptor, buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function finishedInTranscript(item, text) {
  if (!text) return false;
  if (item.kind === 'bash') return text.includes(`<task-id>${item.id}</task-id>`);
  return false;
}

// T3's t3_background_wait hands a background command to T3, which wakes this thread when it exits: the sanctioned
// hand-off, like watch_pull_request for a PR (17 Nov 2026). Counted only for ids T3 answered as matched. Read from the
// transcript, so it works on every seat without a new PostToolUse matcher.
function handedToT3(text) {
  const calls = new Set();
  const ids = new Set();
  for (const line of String(text || '').split('\n')) {
    if (!line.includes('t3_background_wait') && !(calls.size && line.includes('matched'))) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const content = Array.isArray(event?.message?.content) ? event.message.content : [];
    for (const block of content) {
      if (block?.type === 'tool_use' && String(block.name || '').endsWith('t3_background_wait')) calls.add(block.id);
      if (block?.type === 'tool_result' && calls.has(block.tool_use_id)) {
        const matched = responseObject(block.content)?.matched;
        if (Array.isArray(matched)) for (const id of matched) ids.add(String(id));
      }
    }
  }
  return ids;
}

function lastAssistantText(input) {
  if (typeof input.last_assistant_message === 'string') return input.last_assistant_message;
  const tail = readTranscriptFrom(input.transcript_path, Math.max(0, transcriptSize(input.transcript_path) - 262144));
  let text = '';
  for (const line of tail.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const message = event?.message;
    if (event?.type !== 'assistant' || !Array.isArray(message?.content)) continue;
    for (const block of message.content) if (block?.type === 'text' && block.text) text = block.text;
  }
  return text;
}

function waitHint(item) {
  // Never a foreground wait: while one runs, Shaan's messages sit in T3 as "waiting to be read" (17 Nov 2026).
  if (item.kind === 'bash') return `background command ${item.id} ("${item.label}"): call t3_background_wait with taskIds ["${item.id}"] and end your turn; T3 wakes this thread when it exits. Never wait for it in the foreground: Shaan's messages cannot reach you until a foreground command returns`;
  return `PR ${item.id}: merge it if its checks are already green (gh pr merge), otherwise hand it to T3 with watch_pull_request and end your turn`;
}

function stop(input) {
  const sessionId = input.session_id;
  if (!sessionId) return;
  const state = load(sessionId);
  if (!state || !Object.keys(state.items || {}).length) return;

  const now = Date.now();
  const transcript = input.transcript_path || state.transcript_path;
  const offsets = Object.values(state.items).map((item) => item.offset || 0);
  const text = readTranscriptFrom(transcript, Math.min(...offsets));
  const handed = handedToT3(text);
  for (const [key, item] of Object.entries(state.items)) {
    const stale = now - Date.parse(item.started_at || 0) > TTL_HOURS * 3600 * 1000;
    // A delegate marker can only be one written before 19 Nov: T3 already wakes this thread when it ends.
    if (stale || item.kind === 'delegate' || finishedInTranscript(item, text) || (item.kind === 'bash' && handed.has(item.id))) delete state.items[key];
  }
  if (!input.stop_hook_active) state.blocks = 0;
  const open = Object.entries(state.items);
  if (!open.length) { save(sessionId, state); return; }

  // Cursor's rule: the agent stopped to ask the user something. Stay quiet; keep the marker armed.
  if (lastAssistantText(input).trim().endsWith('?')) { save(sessionId, state); return; }
  if (input.stop_hook_active && (state.blocks || 0) >= LOOP_LIMIT) { save(sessionId, state); return; }

  state.blocks = (state.blocks || 0) + 1;
  save(sessionId, state);
  const [firstKey, first] = open[0];
  const others = open.slice(1).map(([, item]) => waitHint(item));
  const reason = [
    `Your job ${first.label} is still running: hand it off as below so you are woken when it ends, then report.`,
    `Open: ${waitHint(first)}.`,
    ...(others.length ? [`Also open: ${others.join('; ')}.`] : []),
    `If it is truly handed off to someone else, run \`${RELEASE_COMMAND.replace('<id|all>', firstKey)}\` and say so in your report.`,
    `(SISO pending-stop, block ${state.blocks} of ${LOOP_LIMIT}.)`
  ].join(' ');
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  return true;
}

// The newest message a person or agent sent: not a tool result, not a system reminder.
function lastUserText(transcriptPath) {
  if (!transcriptPath) return '';
  let records = 0;
  for (const event of readJsonLinesReverse(transcriptPath)) {
    if (++records > 2000) break;
    if (event?.type !== 'user') continue;
    const content = event.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    if (blocks.some((block) => block?.type === 'tool_result')) continue;
    const text = blocks.map((block) => (typeof block === 'string' ? block : block?.type === 'text' ? block.text || '' : '')).join('\n');
    // A reminder can ride in front of what the person typed: drop the reminder, keep their words.
    const said = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
    if (!said) continue;
    return said;
  }
  return '';
}

// Runs only when pending-stop let the turn end. stop_hook_active means this guard (or another) already blocked once.
function guardReport(input) {
  if (input.stop_hook_active === true) return;
  const text = lastAssistantText(input);
  if (!text) return;
  const userText = lastUserText(input.transcript_path);
  // The t3 CLI is only asked when the answer could matter: an agent's wake and a long reply.
  const pinned = isAgentWake(userText) && wordCount(text) > LONG_WORDS
    && t3Thread(process.env.T3CODE_THREAD_ID)?.pinned === true;
  const reason = reportGuard({ text, lastUserText: userText, pinned });
  if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}
