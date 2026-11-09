/**
 * Server text is untrusted display text: it is cleaned again before it reaches a component.
 * Kept apart from `view.ts` so the modules that explain a Run can use it without importing the view.
 */

const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);

/**
 * The most of an alert's text the page shows: what the wire format (`RunAlertViewSchema`) and the ledger
 * allow for one. The longest text the server writes (a used-up re-check of a lost turn) is over 300
 * characters, and a lower cut stopped its sentence about what to do in the middle.
 */
export const ALERT_DISPLAY_MAX = 1000;

/** Strip controls, bidi/zero-width marks, fold whitespace, cut by code point. */
export function displayText(value: unknown, max: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  let folded = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) folded += " ";
    else if (ZERO_WIDTH.has(code) || /\p{Bidi_Control}/u.test(character)) continue;
    else folded += character;
  }
  const clean = folded.replace(/\s+/gu, " ").trim();
  if (clean === "") return fallback;
  const points = [...clean];
  return points.length <= max ? clean : `${points.slice(0, Math.max(1, max - 1)).join("")}…`;
}
