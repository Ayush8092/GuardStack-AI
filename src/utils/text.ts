// One definition of "text that is invisible or reorders what a reader sees while a model still reads it", used by every path that builds
// a prompt. Two groups, so that each path can pick what it needs:
//   HIDDEN   line and paragraph separators, zero-width space, bidirectional controls and isolates, word joiner and invisible operators,
//            the byte order mark and the Unicode "tag" block (U+E0000 to U+E007F), which can carry an entire invisible sentence.
//   JOINERS  characters that are invisible but that emoji and some scripts need: zero-width non-joiner and joiner, variation selectors,
//            soft hyphen, filler characters, annotation marks and the rest of the tag block.
// Text typed by the developer keeps its joiners (an emoji must survive); anything read from the repository loses both groups.
export const HIDDEN_CLASS = '\\u007f-\\u009f\\u061c\\u200b\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2069\\ufeff\\u{e0000}-\\u{e007f}';
export const JOINER_CLASS = '\\u00ad\\u034f\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200c\\u200d\\u206a-\\u206f\\u3164\\ufe00-\\ufe0f\\uffa0\\ufff9-\\ufffb\\u{e0080}-\\u{e0fff}';
const CONTROLS_CLASS = '\\u0000-\\u001f';

const SCRUBBED = new RegExp(`[${CONTROLS_CLASS}${HIDDEN_CLASS}]`, 'gu');
const EVERYTHING_INVISIBLE = new RegExp(`[${CONTROLS_CLASS}${HIDDEN_CLASS}${JOINER_CLASS}]`, 'gu');
const HIDDEN = new RegExp(`[${HIDDEN_CLASS}]`, 'gu');

// General-purpose scrub for text shown to a person or a model: controls and hidden text become '?'. Joiners are kept.
export const safe = (value: string): string => value.replace(SCRUBBED, '?');

// The scrub for anything read from the repository (paths, names, signatures, comments) that goes into a prompt: every invisible
// character, joiners included, becomes '?'.
export const scrubRepositoryText = (value: string): string => value.replace(EVERYTHING_INVISIBLE, '?');

// The same hidden set as `safe`, minus the ordinary controls: tabs and newlines in a developer's request are legitimate.
export const hasHiddenText = (value: string): boolean => new RegExp(HIDDEN.source, 'u').test(value);
export const replaceHiddenText = (value: string, replacement: string): string => value.replace(HIDDEN, replacement);

export const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
