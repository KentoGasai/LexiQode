'use strict';

/**
 * Separating what a shell printed from what the shell reported about itself.
 *
 * Without a pseudo-console there is no prompt to read, so the session is asked
 * to emit one out of band: a start marker, the working directory, an end marker,
 * the status word and a newline. Everything else in the stream is output the
 * user should see.
 *
 * The subtle part is chunk boundaries. A pipe delivers whatever it wants, so a
 * marker routinely arrives in two pieces, and a naive parse either loses the
 * report or - worse - prints half a control sequence into the terminal. This
 * function therefore keeps the incomplete tail in `rest` and returns it to be
 * prefixed to the next chunk, which is why it is pure and separately tested.
 */

const START = '\u0001';
const END = '\u0002';

/**
 * @param {string} buffer unparsed text carried over from the previous chunk
 * @param {string} chunk newly arrived text
 * @returns {{output: string, reports: Array<{cwd: string, status: string}>, rest: string}}
 */
function consume(buffer, chunk) {
  let rest = `${buffer || ''}${chunk || ''}`;
  let output = '';
  const reports = [];

  for (;;) {
    const start = rest.indexOf(START);
    if (start === -1) {
      output += rest;
      rest = '';
      break;
    }
    output += rest.slice(0, start);

    const end = rest.indexOf(END, start + 1);
    if (end === -1) {
      rest = rest.slice(start);
      break;
    }
    const newline = rest.indexOf('\n', end + 1);
    if (newline === -1) {
      // The status word has not arrived yet; hold the whole marker back.
      rest = rest.slice(start);
      break;
    }
    reports.push({
      cwd: rest.slice(start + 1, end),
      status: rest.slice(end + 1, newline).replace(/\r$/, '').trim()
    });
    rest = rest.slice(newline + 1);
  }

  return { output, reports, rest };
}

module.exports = { END, START, consume };