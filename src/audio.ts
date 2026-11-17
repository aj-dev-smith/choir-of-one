/** Sound in and out: ffmpeg reads anything; what is written is 16-bit mono WAV. */

/** Run a command; its output, or an error carrying the last line it said. */
export async function run(cmd: string[], what = cmd[0]): Promise<Uint8Array> {
  let p;
  try {
    p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  } catch {
    throw new Error(`${cmd[0]} is not installed (needed for: ${what})`);
  }
  const [out, err, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${what}: ${err.trim().split("\n").pop() || `${cmd[0]} failed (${code})`}`);
  return new Uint8Array(out);
}

/** A file's sound as mono samples at `fs`, from `start` s for `dur` s (all of it if 0). */
export async function decode(file: string, fs: number, start = 0, dur = 0): Promise<Float32Array> {
  const raw = await run(["ffmpeg", "-v", "error", "-ss", String(start), ...(dur > 0 ? ["-t", String(dur)] : []), "-i", file, "-vn", "-ac", "1", "-ar", String(fs), "-f", "f32le", "-"], file.split("/").pop());
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2).slice();
}

export function rms(x: ArrayLike<number>, a = 0, b = x.length): number {
  let sum = 0;
  for (let i = a; i < b; i++) sum += x[i] * x[i];
  return b > a ? Math.sqrt(sum / (b - a)) : 0;
}

export async function writeWav(path: string, pcm: Int16Array, fs: number): Promise<void> {
  const h = new DataView(new ArrayBuffer(44));
  const tag = (at: number, s: string) => [...s].forEach((c, i) => h.setUint8(at + i, c.charCodeAt(0)));
  tag(0, "RIFF");
  h.setUint32(4, 36 + pcm.byteLength, true);
  tag(8, "WAVEfmt ");
  h.setUint32(16, 16, true);
  h.setUint16(20, 1, true);
  h.setUint16(22, 1, true);
  h.setUint32(24, fs, true);
  h.setUint32(28, fs * 2, true);
  h.setUint16(32, 2, true);
  h.setUint16(34, 16, true);
  tag(36, "data");
  h.setUint32(40, pcm.byteLength, true);
  await Bun.write(path, new Blob([h.buffer, pcm.buffer as ArrayBuffer]));
}

/** MIDI number to Hz (A4 = 69 = 440) and to a name (C4 = 60). */
export const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const noteName = (midi: number) => `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
