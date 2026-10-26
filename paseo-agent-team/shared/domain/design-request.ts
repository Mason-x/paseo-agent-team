/** The longest design request the Team designer accepts, counted in Unicode code points. */
export const DESIGN_REQUEST_MAX_CODE_POINTS = 4000;

export type DesignRequestCheck =
  | { ok: true; request: string; length: number }
  | { ok: false; reason: "empty"; length: 0 }
  | { ok: false; reason: "too-long"; length: number; excess: number };

/** Unicode code points, so an emoji or a rare CJK ideograph counts once, not as two UTF-16 units. */
export function countCodePoints(text: string): number {
  let count = 0;
  for (const _point of text) count += 1;
  return count;
}

/**
 * Judges a design request as it would be sent: trimmed, non-empty, and at most
 * `DESIGN_REQUEST_MAX_CODE_POINTS` code points. `length` always describes the trimmed text.
 */
export function checkDesignRequest(
  text: string,
  max: number = DESIGN_REQUEST_MAX_CODE_POINTS,
): DesignRequestCheck {
  const request = text.trim();
  if (request === "") return { ok: false, reason: "empty", length: 0 };
  const length = countCodePoints(request);
  if (length > max) return { ok: false, reason: "too-long", length, excess: length - max };
  return { ok: true, request, length };
}
