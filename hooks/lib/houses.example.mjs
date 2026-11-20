// The shape of lib/houses.mjs, the machine's own house table that safety-guard.mjs reads. Copy this file to
// houses.mjs beside it and name your houses. With no houses.mjs, no house is known and both guards stay open.
// Regexes take no g flag: each is tested once per value.

// Plan guard: a seat's CLAUDE_CONFIG_DIR or a T3 providerInstanceId names its house anywhere in it, first match wins.
// A seat may not start T3 work on another house's provider, since each house's agents bill to its own plans.
export const plans = { fallback: 'HOME', houses: [['ACME', /acme/i]] };

// House wall: a seat's house is its config dir; a command that names another house's fenced paths is denied.
export const seats = { fallback: 'home', houses: [['acme', /(?:claude|codex)-acme\b/i]] };
export const fences = [
  { house: 'acme', pattern: /ACME_Workspace\/\.credentials(?![\w.-])|\.config\/(?:claude|codex)-acme\b/i, what: "ACME's credentials or seat config" }
];
export const wallNote = 'Credentials and seat config folders hold logins.';
