export interface WordLimitConfig {
  target: number;
  hardCap: number;
}

export function resolveWordLimit(input: {
  kind: string;
  words?: number;
}): WordLimitConfig {
  switch (input.kind) {
    case 'short':
      return { target: 60, hardCap: 90 };
    case 'medium':
      return { target: 150, hardCap: 220 };
    case 'long':
      return { target: 280, hardCap: 400 };
    case 'custom':
      return { target: input.words!, hardCap: Math.ceil(input.words! * 1.1) };
    default:
      return { target: 150, hardCap: 220 };
  }
}

export function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

export function isWithinLimit(text: string, hardCap: number): boolean {
  return countWords(text) <= hardCap;
}
