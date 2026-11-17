/**
 * The person's takes as an instrument: each take's held note is looped, tuned to the key it is asked
 * for, and switched on and off by the song's notes.
 */
import { join } from "node:path";
import { decode, hz, rms } from "./audio.ts";
import { FFT, hann } from "./fft.ts";
import type { Note } from "./transcribe.ts";

export const FS = 48000;

/** A take, as the recorder wrote it: the file, where the held note is in it, and the pitch it measured. */
export interface Take {
  file: string;
  from: number;
  to: number;
  hz: number;
  cents?: number;
  rms?: number;
  peak?: number;
  /** a quiet stretch before the note, for a picture of the person waiting */
  rest?: [number, number];
}

export const midiOf = (id: string) => Number(id.split("-")[1]);
export const isSung = (id: string) => id.startsWith("sung");

export interface Voices {
  dir: string;
  takes: Record<string, Take>;
  /** each usable take's held stretch, clear of the note's start and end */
  held: Map<string, Float32Array>;
  /** sung takes whose sound is mostly a squeal (see `strained` below) */
  strained: Set<string>;
  /** what a person should know about takes left out or doubted */
  notes: string[];
}

/**
 * Is this sung take a squeal? A voice puts much of a note into its harmonics; near the top of a range
 * nearly all of it can land between 1.5 and 5 kHz, where hearing is keenest. Such a take is real, but in
 * a choir it pierces, and a whistle of the same pitch (if there is one) does the job better.
 */
function strained(x: Float32Array): boolean {
  const N = 8192, fft = new FFT(N), win = hann(N), re = new Float64Array(N), im = new Float64Array(N);
  let high = 0, all = 0;
  for (let at = 0; at + N <= x.length; at += N / 2) {
    for (let i = 0; i < N; i++) {
      re[i] = x[at + i] * win[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    for (let k = 1; k < N / 2; k++) {
      const e = re[k] * re[k] + im[k] * im[k], f = (k * FS) / N;
      all += e;
      if (f >= 1500 && f < 5000) high += e;
    }
  }
  return all > 0 && high / all > 0.25;
}

export async function loadVoices(dir: string, skip: string[] = [], on: (done: number, of: number) => void = () => {}): Promise<Voices> {
  const file = Bun.file(join(dir, "takes.json"));
  if (!(await file.exists())) throw new Error(`no takes yet: ${join(dir, "takes.json")} is not there. Record some notes first.`);
  const { takes } = (await file.json()) as { takes: Record<string, Take> };
  const ids = Object.keys(takes).filter((id) => !skip.includes(id)).sort();
  const v: Voices = { dir, takes, held: new Map(), strained: new Set(), notes: [] };
  for (const [i, id] of ids.entries()) {
    const t = takes[id];
    on(i, ids.length);
    let all: Float32Array;
    try {
      all = await decode(join(dir, t.file), FS);
    } catch (e) {
      v.notes.push(`${id} could not be read and was left out (${(e as Error).message})`);
      continue;
    }
    const seg = all.subarray(Math.round((t.from + 0.12) * FS), Math.min(all.length, Math.round((t.to - 0.05) * FS)));
    if (seg.length < 0.5 * FS || rms(seg) < 1e-4) {
      v.notes.push(`${id} was left out: its held note is too short or silent`);
      continue;
    }
    v.held.set(id, seg.slice());
    if (isSung(id) && strained(seg)) v.strained.add(id);
  }
  if (v.held.size === 0) throw new Error("none of the takes could be used");
  return v;
}

/**
 * Whose clip plays a key: the person's own take of it, else their nearest. Sung comes before whistled,
 * except that a strained sung take gives way to a whistle of the same pitch.
 */
export function clipFor(v: Voices, midi: number): string {
  let best = "", far = Infinity;
  for (const id of v.held.keys()) {
    const d = Math.abs(midiOf(id) - midi) + (isSung(id) ? 0 : 0.1) + (v.strained.has(id) ? 0.5 : 0);
    if (d < far) [best, far] = [id, d];
  }
  return best;
}

/** The RMS of a loop as the ear weighs it (A-weighting at 48 kHz), run round the loop twice so it has no start. */
function heardAs(x: Float32Array): number {
  const b = [0.234301792299513, -0.468603584599026, -0.234301792299513, 0.937207169198054, -0.234301792299515, -0.468603584599025, 0.234301792299513];
  const a = [1, -4.113043408775871, 6.553121752655047, -4.990849294163381, 1.785737302937573, -0.246190595319487, 0.011224250033231];
  const xs = new Float64Array(7), ys = new Float64Array(7);
  let sum = 0;
  for (let pass = 0; pass < 2; pass++) {
    sum = 0;
    for (let i = 0; i < x.length; i++) {
      for (let k = 6; k > 0; k--) (xs[k] = xs[k - 1]), (ys[k] = ys[k - 1]);
      xs[0] = x[i];
      let y = b[0] * xs[0];
      for (let k = 1; k < 7; k++) y += b[k] * xs[k] - a[k] * ys[k];
      ys[0] = y;
      sum += y * y;
    }
  }
  return Math.sqrt(sum / x.length);
}

/** A take played at `to` Hz, as a loop: resampled to the pitch, its end crossfaded into its start. */
function loopAt(v: Voices, id: string, to: number): Float32Array {
  const seg = v.held.get(id)!, step = to / v.takes[id].hz, n = Math.floor((seg.length - 1) / step);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * step, k = Math.floor(p);
    x[i] = seg[k] + (seg[k + 1] - seg[k]) * (p - k);
  }
  const fade = Math.min(Math.round(0.2 * FS), Math.floor(n / 3)), out = new Float32Array(n - fade);
  for (let i = 0; i < out.length; i++) {
    if (i < fade) {
      const u = i / fade;
      out[i] = x[i] * Math.sin((u * Math.PI) / 2) + x[n - fade + i] * Math.cos((u * Math.PI) / 2);
    } else out[i] = x[i];
  }
  // As loud to the ear as every other take, not as large on paper: a high note or a whistle is all at
  // 1.5 to 4 kHz, and at equal size it squeals over low notes whose sound is at 300 Hz.
  // (Held to +12 and -3 dB of equal size.)
  const size = rms(out), level = size / Math.min(4, Math.max(0.7, size / (heardAs(out) || size)));
  for (let i = 0; i < out.length; i++) out[i] /= level;
  return out;
}

/**
 * One section's notes, sung: `seconds` of sound, and which take sang each key.
 * `sharp` is for drums, whose notes are short: the voices start and stop faster.
 */
export function sing(v: Voices, notes: Note[], seconds: number, sharp = false): { sound: Float32Array; sangBy: Map<number, string> } {
  const N = Math.ceil(seconds * FS), out = new Float32Array(N), sangBy = new Map<number, string>();
  const up = 1 - Math.exp(-1 / ((sharp ? 0.004 : 0.012) * FS)), down = 1 - Math.exp(-1 / ((sharp ? 0.025 : 0.06) * FS));
  const by = new Map<number, Note[]>();
  for (const n of notes) (by.get(n[2]) ?? by.set(n[2], []).get(n[2])!).push(n);
  // A whistle is one pure tone where the song had a spread of sound: its loudest moments still stand out.
  // Above 1.5 kHz the loudest tenth of a section's notes are pressed toward the rest (three to one).
  const levels = notes.map((n) => n[3]).sort((a, b) => a - b), ceiling = levels[Math.floor(0.9 * (levels.length - 1))] ?? 1;
  const HOP = 64, want = new Float32Array(Math.ceil(N / HOP) + 1);
  for (const [midi, mine] of by) {
    const id = clipFor(v, midi), loop = loopAt(v, id, hz(midi));
    sangBy.set(midi, id);
    want.fill(0);
    const high = hz(midi) > 1500;
    for (const [on, off, , loud] of mine) {
      const level = high && loud > ceiling ? ceiling * (loud / ceiling) ** (1 / 3) : loud;
      for (let b = Math.max(0, Math.floor((on * FS) / HOP)), e = Math.min(want.length, Math.ceil((off * FS) / HOP)); b < e; b++) want[b] = Math.max(want[b], level);
    }
    let env = 0, pos = 0;
    for (let i = 0; i < N; i++) {
      const to = want[(i / HOP) | 0];
      if (to === 0 && env < 1e-5) {
        [env, pos] = [0, 0];
        continue;
      }
      env += (to - env) * (to > env ? up : down);
      out[i] += env * loop[pos];
      if (++pos === loop.length) pos = 0;
    }
  }
  return { sound: out, sangBy };
}

export interface MixPlan {
  /** how loud each section is in the song (the RMS of its part of it) */
  levels: number[];
  /** [start, end, section]: that section is heard alone */
  solos: [number, number, number][];
  /** seconds over which the voices come in at the start (0: all there from the first note) */
  joining: number;
}

/**
 * The sections together, as loud relative to each other as their parts of the song are, each alone where
 * the film cuts to it alone, and held at a steady loudness while the voices are still coming in.
 * Peaks at 0.9.
 */
export function mixDown(stems: Float32Array[], plan: MixPlan): Float32Array {
  const N = stems[0].length;
  const settled = Math.min(Math.max(0, N - FS), Math.round((plan.joining + (plan.joining > 0 ? 1 : 0)) * FS));
  stems.forEach((x, si) => {
    const now = rms(x, settled);
    if (plan.levels[si] > 0 && now > 0) for (let i = 0; i < N; i++) x[i] *= plan.levels[si] / now;
  });
  const together = () => {
    const m = new Float32Array(N);
    for (const x of stems) for (let i = 0; i < N; i++) m[i] += x[i];
    return m;
  };
  const whole = rms(together(), settled) || 1;
  const ramp = Math.round(0.015 * FS);
  for (const [a, b, who] of plan.solos) {
    const i0 = Math.max(0, Math.round(a * FS)), i1 = Math.min(N, Math.round(b * FS));
    stems.forEach((x, si) => {
      // alone, a section is brought up toward the loudness of all of them (four times at most)
      const g = si === who ? Math.min(4, Math.max(1, (0.75 * whole) / Math.max(1e-6, rms(x, i0, i1)))) : 0;
      for (let i = i0 - ramp; i < i1 + ramp; i++) {
        if (i < 0 || i >= N) continue;
        const edge = Math.min(1, Math.max(0, (i - i0 + ramp) / ramp), Math.max(0, (i1 + ramp - i) / ramp));
        x[i] *= 1 + (g - 1) * edge;
      }
    });
  }
  const mix = together();
  if (plan.joining > 0) {
    // One gain for each quarter of the voices coming in, eased between. (A gain that followed the loudness
    // moment by moment would be highest in each silence, and the next note would click.)
    const edges = [0, 1, 2, 3, 4].map((k) => Math.min(N, Math.round(((k * plan.joining) / 4) * FS)));
    const gain = new Float32Array(N).fill(1);
    for (let k = 0; k + 1 < edges.length; k++) {
      let peak = 0, sum = 0, count = 0;
      for (let i = edges[k]; i < edges[k + 1]; i++) peak = Math.max(peak, Math.abs(mix[i]));
      for (let i = edges[k]; i < edges[k + 1]; i++) if (Math.abs(mix[i]) > 0.05 * peak) (sum += mix[i] * mix[i]), count++;
      const g = count ? Math.min(14, Math.max(1, (whole * (0.6 + (0.4 * k) / 3)) / Math.sqrt(sum / count))) : 1;
      gain.fill(g, edges[k], edges[k + 1]);
    }
    const w = Math.round(0.25 * FS), sums = new Float64Array(N + 1);
    for (let i = 0; i < N; i++) sums[i + 1] = sums[i] + gain[i];
    for (let i = 0; i < N; i++) {
      const lo = Math.max(0, i - w), hi = Math.min(N, i + w + 1);
      mix[i] *= (sums[hi] - sums[lo]) / (hi - lo);
    }
  }
  // a soft limit, so a few loud hits do not set the level of everything; then the end fades
  let peak = 0;
  for (let i = 0; i < N; i++) {
    mix[i] = Math.tanh(mix[i] / (5 * whole)) * 5 * whole;
    peak = Math.max(peak, Math.abs(mix[i]));
  }
  const fade = Math.min(N, 2 * FS);
  for (let i = 0; i < N; i++) mix[i] *= ((i > N - fade ? ((N - i) / fade) ** 2 : 1) * 0.9) / (peak || 1);
  return mix;
}
