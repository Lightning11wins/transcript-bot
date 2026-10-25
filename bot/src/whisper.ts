// Sends clips to whisper-server one at a time, retrying for as long as it's unreachable.

export const SAMPLE_RATE = 16_000;

const REQUEST_TIMEOUT_MS = 10 * 60_000;
const MAX_BACKOFF_MS = 30_000;
/** Whisper only reads the end of a long prompt anyway. */
const MAX_PROMPT_CHARS = 300;

const baseUrl = (process.env.WHISPER_URL ?? '').replace(/\/+$/, '');

export interface Job {
  /** 16 kHz mono 16-bit PCM. */
  pcm: Buffer;
  /** Called just before sending, so it can see the text of earlier jobs. */
  prompt: () => string;
  /** Gets the text, or null if whisper-server rejected the clip. */
  done: (text: string | null) => void;
}

/** Network trouble or whisper-server starting up: worth retrying. */
class Unreachable extends Error {}

const queue: Job[] = [];
let busy = false;
let drainedWaiters: (() => void)[] = [];

export function transcribe(job: Job): void {
  queue.push(job);
  if (!busy) void work();
}

/** Resolves once every queued clip is transcribed. */
export function drained(): Promise<void> {
  if (!busy) return Promise.resolve();
  return new Promise((resolve) => drainedWaiters.push(resolve));
}

async function work() {
  busy = true;
  while (queue.length) {
    const job = queue.shift()!;
    job.done(await sendWithRetry(job));
  }
  busy = false;
  for (const resolve of drainedWaiters) resolve();
  drainedWaiters = [];
}

async function sendWithRetry(job: Job): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await inference(job.pcm, job.prompt().slice(-MAX_PROMPT_CHARS));
    } catch (err) {
      if (!(err instanceof Unreachable)) {
        console.error('[whisper] dropping a clip:', (err as Error).message);
        return null;
      }
      const wait = Math.min(1_000 * 2 ** attempt, MAX_BACKOFF_MS);
      console.warn(`[whisper] ${err.message}; retrying in ${wait / 1000}s (${queue.length + 1} clips waiting)`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

async function inference(pcm: Buffer, prompt: string): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'clip.wav');
  form.append('response_format', 'json');
  // Leave out markers like "(music)" rather than writing them.
  form.append('suppress_nst', 'true');
  if (prompt) form.append('prompt', prompt);

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/inference`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Unreachable(`can't reach ${baseUrl}: ${causeText(err)}`);
  }
  if (res.status >= 502 && res.status <= 504) throw new Unreachable(`HTTP ${res.status}`);
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  const json = JSON.parse(body) as { text?: string; error?: string };
  if (json.error) throw new Error(json.error);
  return json.text ?? '';
}

/**
 * Wakes whisper-server so the model starts loading before anyone speaks.
 * Returns false if it still isn't reachable after a few minutes.
 */
export async function warmUp(): Promise<boolean> {
  const deadline = Date.now() + 3 * 60_000;
  for (let attempt = 0; Date.now() < deadline; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(60_000) });
      if (res.ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000 * 2 ** attempt, MAX_BACKOFF_MS)));
  }
  return false;
}

/** fetch() hides the useful part ("ECONNREFUSED") in err.cause. */
function causeText(err: unknown): string {
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  return cause?.code ?? cause?.message ?? (err as Error).message;
}

/** Wraps PCM in a 44-byte WAV header. */
export function wav(pcm: Buffer): Buffer<ArrayBuffer> {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // bytes per second
  header.writeUInt16LE(2, 32); // bytes per sample
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
