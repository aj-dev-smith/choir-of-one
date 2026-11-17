/**
 * A recording as notes: at each instant, the strongest peaks of its spectrum, each moved to the nearest
 * piano key and held for as long as it lasts. Voices, drums and instruments all land in one list, the way
 * a crude audio-to-MIDI converter flattens a song. Played back on steady tones the notes add up to
 * something the ear takes for the recording, words included.
 */
import { FFT, hann } from "./fft.ts";

/** start and end in seconds, the piano key (MIDI number), and how loud (0..1 of the loudest peak) */
export type Note = [on: number, off: number, midi: number, level: number];

export interface TranscribeOptions {
  /** most notes sounding at once (30) */
  peaks?: number;
  /** quietest peak kept, dB under the loudest (-55) */
  floor?: number;
  /** dB an octave by which higher peaks are preferred when a frame's peaks are chosen (3): without it the
   *  low harmonics take every place. The levels stay as measured. */
  tilt?: number;
  /** the lowest and highest keys (36 and 105: C2 and A7) */
  low?: number;
  high?: number;
  /** samples of each spectrum (2048 at 22050 Hz: 93 ms) and between spectra (a quarter of it). Shorter for
   *  drums, whose hits are over in less; longer for a bass, whose notes are closer than a short one can tell apart. */
  window?: number;
  hop?: number;
}

/** the rate the transcriber wants its samples at */
export const TRANSCRIBE_FS = 22050;
/** A note is struck again when its peak has moved this far (dB) from the level it started at. */
const RESTRIKE_DB = 6;

export function transcribe(x: Float32Array, o: TranscribeOptions = {}): Note[] {
  const FS = TRANSCRIBE_FS, N = o.window ?? 2048, HOP = o.hop ?? N / 4;
  const peaks = o.peaks ?? 30, floorDb = o.floor ?? -55, tilt = o.tilt ?? 3, low = o.low ?? 36, high = o.high ?? 105;

  // per frame, the size of the spectral peak nearest each key (0 where there is none)
  const fft = new FFT(N), win = hann(N);
  const frames = Math.max(0, Math.floor((x.length - N) / HOP) + 1), keys = high - low + 1;
  const amp = Array.from({ length: frames }, () => new Float32Array(keys));
  const re = new Float64Array(N), im = new Float64Array(N), mag = new Float64Array(N / 2 + 1);
  let loudest = 0;
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) {
      re[i] = x[f * HOP + i] * win[i];
      im[i] = 0;
    }
    fft.transform(re, im);
    for (let k = 0; k <= N / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    for (let k = 2; k < N / 2; k++) {
      if (mag[k] <= mag[k - 1] || mag[k] < mag[k + 1]) continue;
      // where the peak is between bins, from a parabola through the three log magnitudes
      const [a, b, c] = [mag[k - 1], mag[k], mag[k + 1]].map((m) => Math.log(m + 1e-12));
      const d = (0.5 * (a - c)) / (a - 2 * b + c);
      const m = Math.round(69 + 12 * Math.log2(((k + d) * FS) / N / 440)) - low;
      if (m < 0 || m >= keys) continue;
      const v = Math.exp(b - 0.25 * (a - c) * d);
      if (v > amp[f][m]) amp[f][m] = v;
      if (v > loudest) loudest = v;
    }
  }
  if (loudest === 0) return [];

  // keep each frame's strongest peaks over the floor, as levels 0..1
  const floor = loudest * 10 ** (floorDb / 20);
  for (const a of amp) {
    const rank = (m: number) => a[m] * 2 ** (((m + low - 69) / 12) * (tilt / 6.02));
    const kept = [...a.keys()].filter((m) => a[m] >= floor).sort((p, q) => rank(q) - rank(p)).slice(0, peaks);
    const level = kept.map((m) => a[m] / loudest);
    a.fill(0);
    kept.forEach((m, i) => (a[m] = level[i]));
  }

  // a run of frames on one key is a note; a run is cut where its level moves away from where it started
  const notes: Note[] = [];
  const t = (f: number) => Math.round(((f * HOP + N / 2) / FS) * 1000) / 1000;
  const step = 10 ** (RESTRIKE_DB / 20);
  for (let m = 0; m < keys; m++) {
    let from = -1, first = 0, sum = 0;
    for (let f = 0; f <= frames; f++) {
      const v = f < frames ? amp[f][m] : 0;
      if (from >= 0 && (v === 0 || v > first * step || v < first / step)) {
        notes.push([t(from), t(f), m + low, Math.round((sum / (f - from)) * 1000) / 1000]);
        from = -1;
      }
      if (v > 0) {
        if (from < 0) [from, first, sum] = [f, v, 0];
        sum += v;
      }
    }
  }
  return notes.sort((p, q) => p[0] - q[0] || p[2] - q[2]);
}
