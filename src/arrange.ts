/**
 * The shape of the film, worked out from the song: the voices come in one after another at the start;
 * where there are instruments, each is heard alone for a bar; there is a stretch where the notes are
 * shown falling onto a keyboard; and there are moments set aside for words on screen.
 */
import { rms } from "./audio.ts";
import type { Note } from "./transcribe.ts";

export interface Part {
  /** "vocals" | "drums" | "bass" | "other", or "song" when the song was not split */
  name: string;
  notes: Note[];
  /** this part of the song itself, to find where it is playing and how loud it is */
  sound: Float32Array;
  fs: number;
}

export type Caption = "start" | "words" | "band" | "keys" | "after";

export interface Arrangement {
  /** each part's notes, with the ones before its voice has come in taken out */
  notes: Note[][];
  /** seconds over which the voices come in */
  joining: number;
  /** [start, end, part]: that part is heard alone */
  solos: [number, number, number][];
  /** [start, end]: slow push-ins on the wall */
  looks: [number, number][];
  /** [start, end]: the wall unfolds into a keyboard and the notes fall onto it */
  keys: [number, number][];
  /** [start, end, which]: when each of the script's captions would show (see script.ts) */
  captions: [number, number, Caption][];
  /** the beat found (s), for anyone curious; 0 if none was looked for */
  beat: number;
}

/**
 * The song's beat and where it falls, from the sound: the period and phase whose comb gathers the most
 * of the loudness's rises. Between 80 and 180 to the minute.
 */
export function beatOf(x: Float32Array, fs: number): { beat: number; phase: number } {
  const hop = Math.round(fs / 200), n = Math.floor(x.length / hop) - 1;
  const e = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) e[i] = rms(x, i * hop, (i + 1) * hop);
  const rise = new Float64Array(n);
  for (let i = 0; i < n; i++) rise[i] = Math.max(0, e[i + 1] - e[i]);
  let best = { size: -1, beat: 0.5, phase: 0 };
  for (let beat = 60 / 180; beat <= 60 / 80; beat += 0.0005) {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) {
      const a = (-2 * Math.PI * i * hop) / fs / beat;
      re += rise[i] * Math.cos(a);
      im += rise[i] * Math.sin(a);
    }
    const size = Math.hypot(re, im);
    if (size > best.size) best = { size, beat, phase: ((((-Math.atan2(im, re) / (2 * Math.PI)) % 1) + 1) % 1) * beat };
  }
  return { beat: best.beat, phase: best.phase };
}

export function arrange(parts: Part[], length: number): Arrangement {
  const split = parts.length > 1, singers = Math.max(0, parts.findIndex((p) => p.name === "vocals"));

  // ---- the voices come in one after another: the strongest of the opening first (the singers before the
  // band, so the words come out of one voice and then the rest arrive), quickly at first and then slowly
  const joining = Math.min(10, length / 4);
  const score = new Map<string, number>();
  parts.forEach((p, pi) => {
    for (const [a, b, m, l] of p.notes) if (a < joining + 2) score.set(`${pi}:${m}`, (score.get(`${pi}:${m}`) ?? 0) + l * (b - a));
  });
  const by = (a: string, b: string) => score.get(b)! - score.get(a)!;
  const mine = (v: string) => Number(v.split(":")[0]) === singers;
  const rank = [...[...score.keys()].filter(mine).sort(by), ...[...score.keys()].filter((v) => !mine(v)).sort(by)];
  const enter = new Map(rank.map((v, r) => [v, rank.length > 1 ? (joining * Math.log(r + 1)) / Math.log(rank.length) : 0]));
  const notes = parts.map((p, pi) => p.notes.filter(([a, , m]) => a >= (enter.get(`${pi}:${m}`) ?? 0)));

  // ---- each instrument alone for a bar, one after another, once everyone is in and where each is playing
  const solos: [number, number, number][] = [];
  let beat = 0;
  if (split && length > 45) {
    const drums = parts.find((p) => p.name === "drums") ?? parts[0];
    const found = beatOf(drums.sound, drums.fs);
    beat = found.beat;
    let bar = 4 * beat;
    while (bar < 1.7) bar *= 2;
    while (bar > 3.4) bar /= 2;
    let bar0 = found.phase;
    while (bar0 > 0) bar0 -= bar;
    const order = ["drums", "bass", "other", "vocals"].map((n) => parts.findIndex((p) => p.name === n)).filter((i) => i >= 0);
    const loud = (pi: number, k: number) => {
      const p = parts[pi], a = Math.max(0, Math.round((bar0 + k * bar) * p.fs));
      return rms(p.sound, a, Math.min(p.sound.length, a + Math.round(bar * p.fs)));
    };
    const bars = Math.floor((length - bar0) / bar) - 1;
    const usual = order.map((pi) => {
      const all = Array.from({ length: bars }, (_, k) => loud(pi, k)).filter((r) => r > 1e-3).sort((a, b) => a - b);
      return all[all.length >> 1] ?? 0;
    });
    let k = Math.ceil((joining + 9.5 - bar0) / bar);
    const last = Math.floor((length * 0.6 - bar0) / bar);
    while (k < last && !order.every((pi, i) => loud(pi, k + i) > 0.35 * usual[i])) k++;
    if (k < last) order.forEach((pi, i) => solos.push([bar0 + (k + i) * bar, bar0 + (k + i + 1) * bar, pi]));
  }

  // ---- the keyboard stretch, and a push-in on the wall either side of it
  const afterSolos = solos.length ? solos[solos.length - 1][1] : joining + 6;
  const keys: [number, number][] = [], looks: [number, number][] = [];
  const k0 = Math.max(afterSolos + 12, 0.53 * length), k1 = Math.min(length - 14, k0 + 24);
  if (k1 - k0 >= 10) keys.push([k0, k1]);
  const mid = keys.length ? keys[0][0] : length - 10;
  if (afterSolos + 2.5 + 7 < mid - 1.5) looks.push([afterSolos + 2.5, afterSolos + 9.5]);
  if (keys.length && keys[0][1] + 4 + 7 < length - 3) looks.push([keys[0][1] + 4, keys[0][1] + 11]);

  const captions: [number, number, Caption][] = [];
  captions.push([0.4, Math.min(4.6, joining * 0.45), "start"]);
  captions.push([Math.min(5.2, joining * 0.52), Math.min(11, joining * 1.1), "words"]);
  if (solos.length) captions.push([solos[0][0] - 3.6, solos[0][0] - 0.2, "band"]);
  for (const [a, b] of keys) {
    captions.push([a + 1.4, a + 7, "keys"]);
    if (b + 7 < length - 2) captions.push([b + 1.5, b + 7, "after"]);
  }
  return { notes, joining, solos, looks, keys, captions, beat };
}
