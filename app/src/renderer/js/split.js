/*
 * Split boundaries, as arithmetic.
 *
 * A boundary belongs to a panel, and a panel is anchored on one side. The
 * sidebar is on the left, so its handle moves right while the panel grows and
 * the pointer delta is positive. The chat is on the right and the terminal panel
 * at the bottom, so their handles move *towards the middle* of the window while
 * those panels grow, which makes the delta negative for a growth the user asked
 * for.
 *
 * Getting that sign wrong shipped once: dragging the chat's handle left shrank
 * it. Keeping the sign and the clamping in a pure function means both directions
 * are tested without a window being open, so the mistake cannot come back
 * unnoticed.
 */

/** The size a boundary should have, given where it started and how far it moved. */
export function nextSize({ origin, delta, invert = false, min = 0, max = Number.POSITIVE_INFINITY }) {
  const wanted = origin + (invert ? -delta : delta);
  return Math.min(max, Math.max(min, Math.round(wanted)));
}