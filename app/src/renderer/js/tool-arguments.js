/*
 * One readable line for a tool call, for the assistant's transcript.
 *
 * The core sends arguments as the object the model produced, and the first
 * version of the panel put that object into a text node: every row in the
 * transcript read `read_file [object Object]`, which told the reader nothing
 * about what the agent had actually touched. A row naming the file, pattern or
 * command is the difference between a log and a record.
 *
 * The rules are deliberately boring. One field is the interesting one per tool
 * and it goes first; a field that can hold kilobytes of source is never printed,
 * only measured; everything else is appended as `name=value` when it is short
 * enough to read. Splitting this out of the panel is what lets it be tested
 * without a window: the fault was in a string, not in a layout.
 */

const PRIMARY = {
  read_file: 'path',
  write_file: 'path',
  edit_file: 'path',
  list_dir: 'path',
  glob: 'pattern',
  grep: 'pattern',
  run_command: 'command'
};

/** Fields whose value is a document, not a datum. */
const BULKY = ['content', 'old_text', 'new_text'];

function scalar(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return Array.isArray(value) ? '[…]' : '{…}';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function clip(text, limit) {
  const value = String(text);
  return value.length <= limit ? value : `${value.slice(0, Math.max(1, limit - 1))}…`;
}

/**
 * Describe a tool call in one line.
 *
 * Returns an empty string when there is nothing to say, which callers render as
 * nothing at all rather than as empty punctuation.
 */
export function describeArguments(name, args, { limit = 120 } = {}) {
  if (typeof args === 'string') return clip(args.trim(), limit);
  if (!args || typeof args !== 'object') return '';

  if (Array.isArray(args)) {
    return args.length ? clip(args.map(scalar).join(' '), limit) : '';
  }

  const fields = Object.keys(args);
  if (!fields.length) return '';

  const preferred = PRIMARY[String(name)];
  const primary = preferred && Object.prototype.hasOwnProperty.call(args, preferred) ? preferred : '';
  const parts = [];

  if (primary) {
    let head = scalar(args[primary]);
    // A line range belongs to the file it is a range of: `config.py:10-40` reads
    // as one thing, `path=config.py start_line=10 end_line=40` reads as three.
    const from = scalar(args.start_line);
    const to = scalar(args.end_line);
    if (from || to) head += `:${from || 1}-${to || '…'}`;
    if (head) parts.push(head);
  }

  for (const key of fields) {
    if (key === primary || key === 'start_line' || key === 'end_line') continue;
    const value = args[key];
    if (BULKY.includes(key)) {
      const size = typeof value === 'string' ? value.length : 0;
      if (size) parts.push(`${key}=${size} ${size === 1 ? 'char' : 'chars'}`);
      continue;
    }
    if (value === null || value === undefined || value === '') continue;
    parts.push(`${key}=${scalar(value)}`);
  }

  return clip(parts.join(' ').trim(), limit);
}

/** Group thousands, so a token count does not have to be counted by eye. */
export function formatTokens(value) {
  const number = Math.max(0, Math.round(Number(value) || 0));
  return String(number).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export { BULKY, PRIMARY };