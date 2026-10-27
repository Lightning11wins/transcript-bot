// Session notes are "Session N.md" files in SESSIONS_DIR, linked to each other by a header line:
//   [[Session 3|Previous Session]] - [[Session 5|Next Session]]
// Transcript lines go under a "# Transcript" heading in the newest one.
// Glossary.md there lists names for whisper to spell right, one "- Name" per line.

import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.SESSIONS_DIR ?? '';
const HEADING = '# Transcript';

const sessionFile = (n: number) => join(dir, `Session ${n}.md`);

function latestNumber(): number {
  let latest = 0;
  for (const name of readdirSync(dir)) {
    const n = Number(/^Session (\d+)\.md$/.exec(name)?.[1] ?? 0);
    if (n > latest) latest = n;
  }
  return latest;
}

function createSession(n: number): string {
  const file = sessionFile(n);
  const previous = n > 1 ? `[[Session ${n - 1}|Previous Session]]` : 'Previous Session';
  // The next session's link won't work until that file exists, which it will eventually.
  // "wx" refuses to overwrite a file that appeared in the meantime.
  writeFileSync(file, `${previous} - [[Session ${n + 1}|Next Session]]\n\n${HEADING}\n`, { flag: 'wx' });
  return file;
}

/** The newest session file (created if there are none), with a transcript heading. */
export function currentSession(): string {
  const n = latestNumber();
  if (n === 0) return createSession(1);
  const file = sessionFile(n);
  const text = readFileSync(file, 'utf8');
  if (!new RegExp(`^${HEADING}\\s*$`, 'm').test(text)) {
    appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}\n${HEADING}\n`);
  }
  return file;
}

/** Creates the next session file and links the previous one to it. */
export function newSession(): string {
  const n = latestNumber() + 1;
  const file = createSession(n);
  if (n > 1) {
    const previous = sessionFile(n - 1);
    const text = readFileSync(previous, 'utf8');
    const linked = text.replace(/^(.*) - Next Session[ \t]*$/m, `$1 - [[Session ${n}|Next Session]]`);
    if (linked !== text) writeFileSync(previous, linked);
  }
  return file;
}

/** Glossary.md's list items as "A, B, C.", or "" if there's no glossary. */
export function readGlossary(): string {
  let text: string;
  try {
    text = readFileSync(join(dir, 'Glossary.md'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
  const terms = [...text.matchAll(/^\s*[-*]\s+(.+?)\s*$/gm)].map((m) => m[1]);
  return terms.length ? `${terms.join(', ')}.` : '';
}

export const sessionName = (file: string) => file.slice(file.lastIndexOf('/') + 1, -'.md'.length);

export interface Entry {
  start: Date;
  speaker: string;
  text: string | null;
  done: boolean;
}

/**
 * Writes lines in the order people started speaking, even though clips finish
 * transcribing out of order: a line waits until every earlier one is done.
 */
export class Transcript {
  private entries: Entry[] = [];
  file: string;

  constructor(file: string) {
    this.file = file;
  }

  /** Holds a line's place in the order. Fill it in later with finish(). */
  begin(start: Date, speaker: string): Entry {
    const entry: Entry = { start, speaker, text: null, done: false };
    this.entries.push(entry);
    return entry;
  }

  /** null or empty text drops the line. */
  finish(entry: Entry, text: string | null): void {
    entry.text = text;
    entry.done = true;
    let lines = '';
    while (this.entries[0]?.done) {
      const e = this.entries.shift()!;
      if (e.text) lines += `[${e.start.toTimeString().slice(0, 8)}] **${e.speaker}:** ${e.text}\n`;
    }
    if (!lines) return;
    try {
      // In case the file was edited and lost its final newline.
      const text = readFileSync(this.file, 'utf8');
      appendFileSync(this.file, text === '' || text.endsWith('\n') ? lines : `\n${lines}`);
    } catch (err) {
      // Better in the journal than lost.
      console.error(`[transcript] couldn't write to ${this.file}:`, err, `\n${lines}`);
    }
  }
}
