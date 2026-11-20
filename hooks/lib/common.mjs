import { execFileSync } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export async function readPayload() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function stateRoot() {
  return process.env.SISO_STATE_HOME || join(homedir(), '.siso');
}

export function safeId(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function readJsonLines(path, maxBytes = 131072) {
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, size - length);
    return buffer.toString('utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch {
    return [];
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function *readJsonLinesReverse(path, chunkBytes = 1048576, maxRecordBytes = 8388608) {
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
    let position = fstatSync(descriptor).size;
    let carry = '';
    let discardingOversizedRecord = false;
    while (position > 0) {
      const length = Math.min(position, chunkBytes);
      position -= length;
      const buffer = Buffer.alloc(length);
      readSync(descriptor, buffer, 0, length, position);
      let text = buffer.toString('utf8');
      if (discardingOversizedRecord) {
        const boundary = text.lastIndexOf('\n');
        if (boundary < 0) continue;
        text = text.slice(0, boundary);
        discardingOversizedRecord = false;
      }
      const lines = `${text}${carry}`.split('\n');
      carry = lines.shift() || '';
      if (carry.length > maxRecordBytes) {
        carry = '';
        discardingOversizedRecord = true;
      }
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (!lines[index]) continue;
        try { yield JSON.parse(lines[index]); } catch { /* Skip malformed transcript records. */ }
      }
    }
    if (carry) {
      try { yield JSON.parse(carry); } catch { /* Skip a malformed first record. */ }
    }
  } catch {
    return;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function additionalContext(hookEventName, message) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName, additionalContext: message }
  }));
}

export function denyPreTool(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  }));
}

// The text of the agent's last reply: Claude Code's Stop input carries it; older inputs only have the transcript.
export function lastAssistantText(input, tailBytes = 262144) {
  if (typeof input?.last_assistant_message === 'string') return input.last_assistant_message;
  if (!input?.transcript_path) return '';
  let text = '';
  for (const event of readJsonLines(input.transcript_path, tailBytes)) {
    const message = event?.message;
    if (event?.type !== 'assistant' || !Array.isArray(message?.content)) continue;
    for (const block of message.content) if (block?.type === 'text' && block.text) text = block.text;
  }
  return text;
}

// A T3 thread as the local t3 CLI shows it, or null when it can't be read (another machine, no CLI, a slow server).
export function t3Thread(threadId, cli = process.env.T3CODE_CLI_PATH) {
  if (!threadId || !cli) return null;
  try {
    const shown = JSON.parse(execFileSync(cli, ['thread', 'show', '--json', '--messages', '0', threadId],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
    return shown.thread || shown;
  } catch {
    return null;
  }
}
