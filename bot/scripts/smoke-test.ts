// Checks the Opus decoding and whisper-server without Discord:
//   npm run smoke-test -- speech.wav
// The WAV must be 16 kHz mono 16-bit, like whisper.cpp's samples/jfk.wav.
// It's encoded to Opus and decoded again the way the bot does, then transcribed.

import { readFileSync } from 'node:fs';
import OpusScript from 'opusscript';
import { SAMPLE_RATE, transcribe, warmUp } from '../src/whisper.ts';

const file = process.argv[2];
if (!file || !process.env.WHISPER_URL) {
  console.error('Usage: WHISPER_URL=http://host:8080 npm run smoke-test -- speech.wav');
  process.exit(1);
}

const wav = readFileSync(file);
if (wav.readUInt16LE(22) !== 1 || wav.readUInt32LE(24) !== SAMPLE_RATE || wav.readUInt16LE(34) !== 16) {
  console.error('Expected a 16 kHz mono 16-bit WAV.');
  process.exit(1);
}
const data = wav.indexOf('data');
const pcm = wav.subarray(data + 8, data + 8 + wav.readUInt32LE(data + 4));

const frame = (SAMPLE_RATE / 1000) * 20; // 20 ms, like Discord
const encoder = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);
const decoder = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);
const decoded: Buffer[] = [];
for (let i = 0; i + frame * 2 <= pcm.length; i += frame * 2) {
  decoded.push(decoder.decode(encoder.encode(pcm.subarray(i, i + frame * 2), frame)));
}
console.log(`Round-tripped ${decoded.length} Opus frames`);

console.log(`Waiting for ${process.env.WHISPER_URL}...`);
if (!(await warmUp())) {
  console.error('whisper-server is not reachable.');
  process.exit(1);
}
const started = Date.now();
transcribe({
  pcm: Buffer.concat(decoded),
  context: () => [],
  done: (text) => {
    console.log(`Transcribed in ${((Date.now() - started) / 1000).toFixed(1)}s: ${JSON.stringify(text)}`);
    process.exit(text ? 0 : 1);
  },
});
