// report-guard: what a final reply may not do. Pure; pending-stop's Stop mode feeds it and prints the block.
// Shaan, 19 Nov: "I don't understand why you would ever ask me to run a fucking command" and
// "you're just sending me so much bullshit".

export const REASON_COMMAND = 'SISO report guard: this reply asks the reader to run a command. Shaan, 14 Nov: "No, you run these commands. Don\'t be telling me to run commands and shit." 19 Nov: "I don\'t understand why you would ever ask me to run a fucking command". Run it yourself. If a wall stops you, send one request to the owner whose seat can, or make the need go away. A sign-in goes through request_secret, never a terminal. Rewrite the reply without the command. If the reader is another agent, end as you were.';

export const reasonLong = (words) => `SISO report guard: another agent's message started this turn, and this reply is ${words} words. Shaan, 19 Nov: "you're just sending me so much bullshit". He already gets that agent's own report. Close in two lines at most: what changed for him, if anything. The rest goes in STATUS.md. Say more only if a sign-in, a physical step, money or a message sent as him now waits.`;

export const LONG_WORDS = 60;

const VERB = /\b(run|paste|type|execute)\b/gi;
const NEGATION = /\b(never|not|no longer|without)\b|n't|don't need to/i;
const ADDRESS = /\b(you|your|shaan)\b/i;
const OBJECT = /\b(commands?|terminal|shell)\b/i;
const MARKS = /^[\s>*_#`~+\-\d.)]*/;
// Right before the verb, these make it a noun ("the run", "your last run") or a past participle ("has run"): a mention.
// Only words that can't end a clause: "this" and "that" stay out, since "After that run X" is an ask.
const MENTIONED = /\b(?:(?:the|a|an|each|every|another|which|what|my|our|your|its|their)(?:\s+(?:test|ci|dry|trial|full|clean|first|last|next|final|nightly|latest|previous))?|(?:has|have|had|ve|was|were|been)(?:\s+(?:already|just|also))?)\s+$/i;

// An ask, not a mention: a line that speaks to the reader, has a base verb that no nearby negation cancels and that is
// not a noun or past participle, and names a command, terminal or shell. Lines inside a fenced code block are the
// command itself, not the ask.
export function asksToRunCommand(text) {
  let fenced = false;
  for (const line of String(text || '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced || !OBJECT.test(line)) continue;
    const bare = line.replace(MARKS, '');
    const imperative = /^(run|paste|type|execute)\b/i.test(bare);
    if (!imperative && !ADDRESS.test(line)) continue;
    for (const match of line.matchAll(VERB)) {
      if (MENTIONED.test(line.slice(0, match.index))) continue;
      if (!NEGATION.test(line.slice(Math.max(0, match.index - 30), match.index))) return true;
    }
  }
  return false;
}

export function wordCount(text) {
  return String(text || '').split(/\s+/).filter(Boolean).length;
}

export function isAgentWake(lastUserText) {
  return String(lastUserText || '').trimStart().startsWith('[from');
}

export function reportGuard({ text, lastUserText, pinned }) {
  if (asksToRunCommand(text)) return REASON_COMMAND;
  const words = wordCount(text);
  if (pinned === true && isAgentWake(lastUserText) && words > LONG_WORDS) return reasonLong(words);
  return null;
}
