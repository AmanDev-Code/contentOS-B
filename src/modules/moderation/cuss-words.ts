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

function buildWordSet(): Set<string> {
  return new Set(CUSS_WORDS.map((w) => w.toLowerCase()));
}

const wordSet = buildWordSet();

const WORD_BOUNDARY = String.raw`(?<![a-zA-Z0-9])`;
const WORD_BOUNDARY_END = String.raw`(?![a-zA-Z0-9])`;

function buildRegex(): RegExp {
  const escaped = CUSS_WORDS.map((w) =>
    w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  const sorted = [...escaped].sort((a, b) => b.length - a.length);
  const pattern = `${WORD_BOUNDARY}(?:${sorted.join('|')})${WORD_BOUNDARY_END}`;
  return new RegExp(pattern, 'gi');
}

const cussRegex = buildRegex();

export function containsCussWord(input: string): {
  hit: boolean;
  matches: string[];
} {
  const normalised = normalise(input);

  cussRegex.lastIndex = 0;

  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = cussRegex.exec(normalised)) !== null) {
    const word = match[0].toLowerCase();
    if (wordSet.has(word)) {
      found.add(word);
    }
  }

  return {
    hit: found.size > 0,
    matches: [...found],
  };
}
