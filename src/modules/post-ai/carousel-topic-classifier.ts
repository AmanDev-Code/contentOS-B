/**
 * Subject routing for carousel decks (programming vs general study content).
 */

export type CarouselSubjectMode = 'auto' | 'programming' | 'general';

const PROGRAMMING_TOPIC_RE =
  /\b(dsa|data\s+structures?|algorithms?|leetcode|hackerrank|codechef|interview\s+prep|coding\s+interview|big-?o\b|time\s+complexity|space\s+complexity|java\b|kotlin\b|python\b|javascript\b|typescript\b|go\b|c\+\+|rust\b|pseudo-?code)\b/i;

export function inferProgrammingCarouselTopic(topicLower: string): boolean {
  const t = topicLower.trim();
  return PROGRAMMING_TOPIC_RE.test(t);
}

export function effectiveCarouselProgrammingMode(params: {
  subjectMode: CarouselSubjectMode;
  topicLower: string;
}): boolean {
  if (params.subjectMode === 'programming') return true;
  if (params.subjectMode === 'general') return false;
  return inferProgrammingCarouselTopic(params.topicLower);
}
