/**
 * Profanity detection with leetspeak normalisation, unicode NFKC
 * canonicalisation, zero-width character stripping, and whole-word
 * matching to avoid false positives (e.g. "scunthorpe", "assassin").
 */

export const CUSS_WORDS: readonly string[] = [
  'anal',
  'anus',
  'arse',
  'arsehole',
  'ass',
  'asshole',
  'asswipe',
  'ballsack',
  'bastard',
  'bitch',
  'blowjob',
  'bollock',
  'bollocks',
  'boner',
  'boob',
  'bugger',
  'bullshit',
  'butt',
  'buttplug',
  'clitoris',
  'cock',
  'cocksucker',
  'coon',
  'crap',
  'cunt',
  'damn',
  'dick',
  'dickhead',
  'dildo',
  'dyke',
  'fag',
  'faggot',
  'fellate',
  'fellatio',
  'flange',
  'fuck',
  'fucked',
  'fucker',
  'fucking',
  'fudgepacker',
  'goddamn',
  'handjob',
  'homo',
  'horny',
  'jerk',
  'jizz',
  'knobend',
  'labia',
  'masturbate',
  'motherfucker',
  'muff',
  'negro',
  'nigga',
  'nigger',
  'nonce',
  'nutter',
  'penis',
  'piss',
  'pissed',
  'prick',
  'pube',
  'pussy',
  'queer',
  'retard',
  'rimjob',
  'sadist',
  'scrotum',
  'semen',
  'shit',
  'shithead',
  'slut',
  'smegma',
  'spunk',
  'tit',
  'tosser',
  'turd',
  'twat',
  'vagina',
  'wank',
  'wanker',
  'whore',
] as const;

/**
 * Reduced list for AI OUTPUT safety checks only.
 * Excludes words that are common proper names (Dick, Homo-sapiens),
 * mild expressions in professional writing (damn, crap, jerk, pissed),
 * or anatomical terms the LLM may use in health/science contexts.
 * The full CUSS_WORDS list is still used for user INPUT moderation.
 */
export const OUTPUT_SAFETY_WORDS: readonly string[] = [
  'arsehole',
  'asshole',
  'asswipe',
  'ballsack',
  'blowjob',
  'bollocks',
  'buttplug',
  'cock',
  'cocksucker',
  'coon',
  'cunt',
  'dickhead',
  'dildo',
  'dyke',
  'fag',
  'faggot',
  'fellate',
  'fellatio',
  'fuck',
  'fucked',
  'fucker',
  'fucking',
  'fudgepacker',
  'handjob',
  'jizz',
  'knobend',
  'masturbate',
  'motherfucker',
  'negro',
  'nigga',
  'nigger',
  'nonce',
  'prick',
  'pussy',
  'retard',
  'rimjob',
  'shithead',
  'slut',
  'smegma',
  'spunk',
  'tosser',
  'twat',
  'wank',
  'wanker',
  'whore',
] as const;

const LEET_MAP: Record<string, string> = {
  '3': 'e',
  '0': 'o',
  '1': 'i',
  '@': 'a',
  $: 's',
  '!': 'i',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
};

const ZERO_WIDTH_RE =
  /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u2060\u2061\u2062\u2063\u2064\u2066\u2067\u2068\u2069\u206A\u206B\u206C\u206D\u206E\u206F]/g;

function normaliseLeet(input: string): string {
  let out = '';
  for (const ch of input) {
    out += LEET_MAP[ch] ?? ch;
  }
  return out;
}

function normalise(raw: string): string {
  let text = raw.normalize('NFKC');
  text = text.replace(ZERO_WIDTH_RE, '');
  text = text.toLowerCase();
  text = normaliseLeet(text);
  return text;
}

const WORD_BOUNDARY = String.raw`(?<![a-zA-Z0-9])`;
const WORD_BOUNDARY_END = String.raw`(?![a-zA-Z0-9])`;

function buildWordSet(words: readonly string[]): Set<string> {
  return new Set(words.map((w) => w.toLowerCase()));
}

function buildRegex(words: readonly string[]): RegExp {
  const escaped = words.map((w) =>
    w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  const sorted = [...escaped].sort((a, b) => b.length - a.length);
  const pattern = `${WORD_BOUNDARY}(?:${sorted.join('|')})${WORD_BOUNDARY_END}`;
  return new RegExp(pattern, 'gi');
}

const wordSet = buildWordSet(CUSS_WORDS);
const cussRegex = buildRegex(CUSS_WORDS);

const outputWordSet = buildWordSet(OUTPUT_SAFETY_WORDS);
const outputRegex = buildRegex(OUTPUT_SAFETY_WORDS);

function matchWords(
  input: string,
  regex: RegExp,
  set: Set<string>,
): { hit: boolean; matches: string[] } {
  const normalised = normalise(input);
  regex.lastIndex = 0;
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(normalised)) !== null) {
    const word = match[0].toLowerCase();
    if (set.has(word)) {
      found.add(word);
    }
  }
  return { hit: found.size > 0, matches: [...found] };
}

/** Full profanity check — used for user INPUT moderation. */
export function containsCussWord(input: string): {
  hit: boolean;
  matches: string[];
} {
  return matchWords(input, cussRegex, wordSet);
}

/** Reduced check for AI-generated OUTPUT — allows proper names & mild terms. */
export function containsOutputUnsafeWord(input: string): {
  hit: boolean;
  matches: string[];
} {
  return matchWords(input, outputRegex, outputWordSet);
}
