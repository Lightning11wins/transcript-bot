// Turns each speaker's Discord audio into clips, in memory only, and queues them for transcription.

import { EndBehaviorType, type VoiceConnection } from '@discordjs/voice';
import type { Guild } from 'discord.js';
import OpusScript from 'opusscript';
import type { Entry, Transcript } from './transcript.ts';
import { SAMPLE_RATE, transcribe } from './whisper.ts';

/** A pause this long ends a clip. */
const END_SILENCE_MS = 800;
/** Shorter clips wait to be merged into the speaker's next one... */
const MIN_CLIP_MS = 1_000;
/** ...but no longer than this. */
const MERGE_WAIT_MS = 5_000;
/** Long clips are split at the first pause after this, */
const SPLIT_AFTER_MS = 25_000;
/** or here if there's no pause. */
const MAX_CLIP_MS = 40_000;
const PAUSE_MS = 300;
/** Clips with less sound than this are dropped (coughs, clicks). */
const MIN_SOUND_MS = 200;
/** 16-bit RMS below this counts as quiet. */
const QUIET_RMS = 300;
/** Discord sends nothing during silence, so gaps longer than this are filled with silence. */
const GAP_MS = 100;
/** Silence put between merged clips. */
const MERGE_GAP_MS = 300;
/** Lines kept as whisper context; more than fit in its prompt. */
const CONTEXT_LINES = 50;

const samples = (ms: number) => Math.round((ms * SAMPLE_RATE) / 1000);
const millis = (n: number) => (n * 1000) / SAMPLE_RATE;

interface Clip {
  userId: string;
  name: string;
  entry: Entry;
  chunks: Buffer[];
  samples: number;
  soundSamples: number;
  /** Length of the quiet stretch at the end so far. */
  quietSamples: number;
  mergeTimer?: NodeJS.Timeout;
  sent: boolean;
}

export class Recorder {
  private clips = new Map<string, Clip>();
  /** The call's last few lines from everyone, passed to whisper as context. */
  private recentLines: string[] = [];
  private ignored = new Set<string>();
  private stopped = false;
  private connection: VoiceConnection;
  private guild: Guild;
  readonly transcript: Transcript;

  constructor(connection: VoiceConnection, guild: Guild, transcript: Transcript) {
    this.connection = connection;
    this.guild = guild;
    this.transcript = transcript;
    connection.receiver.speaking.on('start', this.onSpeaking);
  }

  /** Sends what's been recorded so far and stops listening. */
  stop(): void {
    this.stopped = true;
    this.connection.receiver.speaking.off('start', this.onSpeaking);
    for (const stream of this.connection.receiver.subscriptions.values()) stream.destroy();
    for (const clip of [...this.clips.values()]) this.send(clip);
  }

  private onSpeaking = (userId: string) => void this.listen(userId);

  private async listen(userId: string) {
    const receiver = this.connection.receiver;
    if (this.stopped || this.ignored.has(userId) || receiver.subscriptions.has(userId)) return;
    const member =
      this.guild.members.cache.get(userId) ?? (await this.guild.members.fetch(userId).catch(() => null));
    if (!member) return;
    // Other bots, like the music bot.
    if (member.user.bot) return void this.ignored.add(userId);
    if (this.stopped || receiver.subscriptions.has(userId)) return;

    const stream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: END_SILENCE_MS },
    });
    // Decoding straight to 16 kHz mono is what whisper wants, so there's no resampling.
    const decoder = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);
    // Markdown and wiki-link characters in names would garble the notes.
    const name = member.displayName.replace(/[[\]*_`|#]/g, '') || member.user.username;

    const held = this.clips.get(userId);
    if (held) {
      clearTimeout(held.mergeTimer);
      addSilence(held, samples(MERGE_GAP_MS));
    } else {
      this.startClip(userId, name);
    }

    let lastPacket = 0;
    stream.on('data', (packet: Buffer) => {
      const clip = this.clips.get(userId);
      if (!clip) return;
      const now = Date.now();
      if (lastPacket && now - lastPacket > GAP_MS) addSilence(clip, samples(Math.min(now - lastPacket, END_SILENCE_MS)));
      lastPacket = now;

      let pcm: Buffer;
      try {
        pcm = decoder.decode(packet);
      } catch {
        return; // Corrupt, or one DAVE couldn't decrypt yet.
      }
      addAudio(clip, pcm);

      const length = millis(clip.samples);
      if (length >= MAX_CLIP_MS || (length >= SPLIT_AFTER_MS && millis(clip.quietSamples) >= PAUSE_MS)) {
        this.send(clip);
        this.startClip(userId, name);
      }
    });

    stream.once('close', () => {
      decoder.delete();
      const clip = this.clips.get(userId);
      if (!clip) return;
      if (this.stopped || millis(clip.samples) >= MIN_CLIP_MS) this.send(clip);
      else clip.mergeTimer = setTimeout(() => this.send(clip), MERGE_WAIT_MS);
    });
  }

  private startClip(userId: string, name: string) {
    this.clips.set(userId, {
      userId,
      name,
      entry: this.transcript.begin(new Date(), name),
      chunks: [],
      samples: 0,
      soundSamples: 0,
      quietSamples: 0,
      sent: false,
    });
  }

  private send(clip: Clip) {
    if (clip.sent) return;
    clip.sent = true;
    clearTimeout(clip.mergeTimer);
    if (this.clips.get(clip.userId) === clip) this.clips.delete(clip.userId);
    if (millis(clip.soundSamples) < MIN_SOUND_MS) return this.transcript.finish(clip.entry, null);

    transcribe({
      pcm: Buffer.concat(clip.chunks),
      context: () => this.recentLines,
      done: (raw) => {
        const text = raw === null ? null : cleanText(raw);
        if (text && this.recentLines.push(text) > CONTEXT_LINES) this.recentLines.shift();
        this.transcript.finish(clip.entry, text);
      },
    });
  }
}

function addSilence(clip: Clip, n: number) {
  clip.chunks.push(Buffer.alloc(n * 2));
  clip.samples += n;
  clip.quietSamples += n;
}

function addAudio(clip: Clip, pcm: Buffer) {
  const n = pcm.length / 2;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2;
  if (Math.sqrt(sum / n) < QUIET_RMS) {
    clip.quietSamples += n;
  } else {
    clip.quietSamples = 0;
    clip.soundSamples += n;
  }
  clip.chunks.push(pcm);
  clip.samples += n;
}

/** Whisper marks non-speech like [BLANK_AUDIO] or (coughs). A clip with only those had no words. */
function cleanText(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.replace(/\[[^\]]*\]|\([^)]*\)/g, '').trim() ? t : '';
}
