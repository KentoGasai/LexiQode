/*
 * Fuzzy subsequence scoring for the file picker and the command palette.
 *
 * Returns null when the query is not a subsequence of the candidate, otherwise a
 * score where lower is better: a match at the start of a path segment beats one
 * in the middle, and a compact match beats a scattered one. The caller breaks
 * ties on length, which is what makes short, obviously-named files win.
 *
 * It lives in the window rather than in the shared layer because only the window
 * ranks anything; the main process either matches or does not.
 */

export function fuzzyScore(candidate, query) {
  if (!query) return 0;
  const target = String(candidate).toLowerCase();
  const needle = String(query).toLowerCase();
  let score = 0;
  let position = 0;
  let previous = -1;
  for (const character of needle) {
    const found = target.indexOf(character, position);
    if (found === -1) return null;
    // Distance costs. This is the only term that is always positive, so it is
    // what makes a compact match beat a scattered one.
    score += found - position;
    // Starting a run at a boundary is a bonus, not merely the absence of a
    // penalty. Without the bonus, `a-p-p-deep.js` would rank above `app.js` for
    // the query `app`, because each hyphen resets the distance to zero - which
    // is the opposite of what someone typing `app` means.
    if (found === 0 || '/-_. '.includes(target[found - 1])) score -= 1;
    if (previous !== -1 && found === previous + 1) score -= 1;
    previous = found;
    position = found + 1;
  }
  // Length only breaks ties between equally good matches.
  return score + target.length / 100;
}

/** Rank a list of candidates, best first, dropping anything that cannot match. */
export function rank(candidates, query, limit = 60) {
  const scored = [];
  for (const candidate of candidates) {
    const score = fuzzyScore(candidate, query);
    if (score === null) continue;
    scored.push({ candidate, score });
  }
  scored.sort((left, right) => left.score - right.score || left.candidate.length - right.candidate.length);
  return scored.slice(0, limit).map((entry) => entry.candidate);
}