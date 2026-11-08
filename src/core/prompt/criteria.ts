const MAX_CRITERIA = 15;
const MAX_CRITERION_CHARS = 240;

const LIST_ITEM = /^\s*(?:[-*•]|\d{1,2}[.)]|-\s\[[ xX]\])\s+(.+)$/;
const SECTION_HEADER = /^\s*(?:#{1,4}\s*)?(?:acceptance criteria|requirements?|definition of done|constraints?|must have)\s*:?\s*$/i;
const OBLIGATION = /\b(?:must|should|shall|needs? to|has to|have to|ensure|make sure|never|cannot|can't|do not|don't|only|at least|at most|no more than|no less than|within|without|exactly)\b|\b\d+\s*(?:ms|s|seconds?|minutes?|%|px|kb|mb|items?|rows?|chars?|characters?)\b/i;

const clean = (line: string): string => line.replace(/\s+/g, ' ').trim().slice(0, MAX_CRITERION_CHARS);

// Pulls out what the user said must hold. Nothing here rewrites the request; the original stays in the output verbatim.
export function extractCriteria(request: string): string[] {
  const lines = request.split(/\r?\n/);
  const found: string[] = [];
  let inSection = false;

  for (const line of lines) {
    if (SECTION_HEADER.test(line)) {
      inSection = true;
      continue;
    }
    if (line.trim() === '') {
      inSection = false;
      continue;
    }

    const item = LIST_ITEM.exec(line)?.[1];
    if (item && (inSection || OBLIGATION.test(item))) {
      found.push(clean(item));
    } else if (inSection && !item) {
      found.push(clean(line));
    } else if (!item) {
      for (const sentence of line.split(/(?<=[.!?])\s+/)) {
        if (OBLIGATION.test(sentence)) found.push(clean(sentence));
      }
    }
  }

  return [...new Set(found.filter((c) => c.length >= 6))].slice(0, MAX_CRITERIA);
}
