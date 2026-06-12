/**
 * Parse JSON from LLM completions: markdown fences, JS tokens (undefined), truncation.
 */

/** Replace JavaScript literals that models emit inside "JSON" payloads. */
export function sanitizeJavascriptTokensInJson(raw: string): string {
  return raw
    .replace(/:\s*undefined\b/g, ': null')
    .replace(/,\s*undefined\b/g, ', null')
    .replace(/\[\s*undefined\s*\]/g, '[]');
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function tryParseWithSanitize(text: string): unknown | null {
  const direct = tryParseJson(text);
  if (direct !== null) return direct;
  const sanitized = sanitizeJavascriptTokensInJson(text);
  if (sanitized !== text) {
    const fromSanitized = tryParseJson(sanitized);
    if (fromSanitized !== null) return fromSanitized;
  }
  const repaired = repairUnescapedQuotesInJsonStrings(text);
  if (repaired !== text) {
    const fromRepaired = tryParseJson(repaired);
    if (fromRepaired !== null) return fromRepaired;
    const repairedSanitized = sanitizeJavascriptTokensInJson(repaired);
    if (repairedSanitized !== repaired) {
      const fromRepairedSanitized = tryParseJson(repairedSanitized);
      if (fromRepairedSanitized !== null) return fromRepairedSanitized;
    }
  }
  return null;
}

/**
 * Escape double quotes that appear inside JSON string values (common LLM mistake).
 * Closing quotes are followed by structural chars: , } ] or end-of-input.
 */
export function repairUnescapedQuotesInJsonStrings(raw: string): string {
  let result = '';
  let inString = false;
  let escape = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) {
      result += ch;
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      result += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      if (!inString) {
        inString = true;
        result += ch;
        continue;
      }
      let j = i + 1;
      while (j < raw.length && /\s/.test(raw[j])) j++;
      const next = raw[j];
      if (
        next === ',' ||
        next === ':' ||
        next === '}' ||
        next === ']' ||
        next === undefined
      ) {
        inString = false;
        result += ch;
      } else {
        result += '\\"';
      }
      continue;
    }
    result += ch;
  }
  if (inString) result += '"';
  return result;
}

/** Close truncated JSON objects (model hit max_tokens mid-response). */
function tryRepairTruncatedObject(trimmed: string): unknown | null {
  const start = trimmed.indexOf('{');
  if (start < 0) return null;
  const end = trimmed.lastIndexOf('}');
  if (end > start) return null;

  let slice = trimmed.slice(start);
  slice = slice.replace(/,\s*"[^"]*$/, '');
  slice = slice.replace(/,\s*$/, '');

  let braces = 0;
  let brackets = 0;
  let inString = false;
  let escape = false;
  for (const ch of slice) {
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') braces++;
    if (ch === '}') braces--;
    if (ch === '[') brackets++;
    if (ch === ']') brackets--;
  }
  if (inString) slice += '"';
  for (let i = 0; i < brackets; i++) slice += ']';
  for (let i = 0; i < braces; i++) slice += '}';

  return tryParseWithSanitize(slice);
}

/**
 * Best-effort parse of model output into a JSON value.
 */
export function parseJsonFromLlmPayload(raw: string): unknown | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;

  const candidates: string[] = [trimmed];

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    candidates.push(trimmed.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    const parsed = tryParseWithSanitize(candidate);
    if (parsed !== null) return parsed;
  }

  return tryRepairTruncatedObject(trimmed);
}
