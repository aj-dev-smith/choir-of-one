/**
 * The choir-of-one page's pitch detector (`pitchOf`, through `listen` as the page calls it), on
 * made-up voices and whistles at every pitch the page asks for, at both of a Mac's sample rates and
 * with the page's window lengths: no octave mistakes, and within a few cents of the true pitch.
 * And what the page tells someone who is off.
 */
import { describe, expect, test } from "bun:test";
import { advise, listen, pitchOf, WINDOW } from "../web/record.ts";

/** a seeded random source, so a failure is the same failure every run */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

interface Voice {
  /** cents off the note at time t (s): vibrato, wobble */
  bend: (t: number) => number;
  /** amplitude of harmonic k (1 = the fundamental) */
  harmonic: (k: number) => number;
  /** noise level, against a peak of about 0.3 */
  noise: number;
  /** breath noise is hissy: high-passed */
  hiss?: boolean;
  /** a real voice's unsteadiness, cycle to cycle (cents, about) */
  jitter?: number;
}

/**
 * `seconds` of a voice on `midi`, and its true pitch (Hz) averaged over the last `window`
 * samples, which is the stretch the page looks at.
 */
function make(midi: number, rate: number, v: Voice, seed: number, window: number, seconds = 0.4): { x: Float32Array; truth: number } {
  const r = random(seed), n = Math.round(seconds * rate), x = new Float32Array(n), f0 = hz(midi);
  const phases = Array.from({ length: 65 }, () => r() * 2 * Math.PI);
  const top = Math.min(64, Math.floor(Math.min(rate / 2 - 500, 8000) / f0));
  let phase = 0, logSum = 0, prev = 0, shake = 0;
  const settle = Math.exp((-2 * Math.PI * 80) / rate);
  for (let i = 0; i < n; i++) {
    shake = settle * shake + (1 - settle) * gauss(r) * (v.jitter ?? 0) * Math.sqrt(rate / 80);
    const f = f0 * 2 ** ((v.bend(i / rate) + shake) / 1200);
    phase += (2 * Math.PI * f) / rate;
    if (i >= n - window) logSum += Math.log2(f);
    let s = 0;
    for (let k = 1; k <= top; k++) s += v.harmonic(k) * Math.sin(k * phase + phases[k]);
    const w = gauss(r);
    s = 0.3 * s + v.noise * (v.hiss ? w - prev : w);
    prev = w;
    x[i] = s;
  }
  // scale to a believable microphone level (peak about 0.3)
  let peak = 0;
  for (const s of x) peak = Math.max(peak, Math.abs(s));
  for (let i = 0; i < n; i++) x[i] *= 0.3 / peak;
  return { x, truth: 2 ** (logSum / window) };
}

const vibrato = (depth: number, rate = 5, at = 0) => (t: number) => depth * Math.sin(2 * Math.PI * rate * t + at);
const VOICES: Record<string, Voice> = {
  steady: { bend: () => 0, harmonic: (k) => 0.75 ** (k - 1), noise: 0.004 },
  "weak fundamental": { bend: () => 0, harmonic: (k) => (k === 1 ? 0.12 : 0.8 ** (k - 2)), noise: 0.004 },
  // "ooh": the fundamental and the second strong, the rest falling away fast
  ooh: { bend: () => 0, harmonic: (k) => [1, 0.6, 0.25, 0.1][k - 1] ?? 0.02 / k, noise: 0.006 },
  vibrato: { bend: vibrato(15), harmonic: (k) => 0.7 ** (k - 1), noise: 0.006 },
  "vibrato, weak fundamental": { bend: vibrato(15, 5.5, 1), harmonic: (k) => (k === 1 ? 0.15 : 0.75 ** (k - 2)), noise: 0.006 },
  // a laptop microphone hardly hears under 100 Hz: a low note's fundamental is gone
  "no fundamental": { bend: vibrato(10), harmonic: (k) => (k === 1 ? 0 : 0.8 ** (k - 2)), noise: 0.006, jitter: 2 },
  // an untrained voice: unsteady, breathy, a weak fundamental and a wavering vibrato
  rough: { bend: vibrato(15, 4.5, 2), harmonic: (k) => (k === 1 ? 0.3 : 0.7 ** (k - 2)), noise: 0.02, hiss: true, jitter: 4 },
};
const WHISTLES: Record<string, Voice> = {
  steady: { bend: () => 0, harmonic: (k) => (k === 1 ? 1 : k === 2 ? 0.03 : 0), noise: 0.01, hiss: true },
  breathy: { bend: () => 0, harmonic: (k) => (k === 1 ? 1 : 0), noise: 0.05, hiss: true },
  wobble: { bend: (t) => 8 * Math.sin(2 * Math.PI * 3 * t) + 4 * Math.sin(2 * Math.PI * 7.3 * t), harmonic: (k) => (k === 1 ? 1 : k === 2 ? 0.05 : 0), noise: 0.02, hiss: true },
};

/** every take of a family: how far off (cents) each was, and the misses */
function run(kind: "sung" | "whistle", low: number, high: number, family: Record<string, Voice>) {
  const rows: { name: string; rate: number; midi: number; cents: number }[] = [];
  let seed = 1;
  for (const rate of [44100, 48000])
    for (const [name, v] of Object.entries(family))
      for (let midi = low; midi <= high; midi++) {
        const { x, truth } = make(midi, rate, v, seed++, WINDOW[kind]);
        const p = listen(kind, x, rate);
        rows.push({ name, rate, midi, cents: p ? 1200 * Math.log2(p.hz / truth) : NaN });
      }
  return rows;
}

function report(label: string, rows: ReturnType<typeof run>) {
  const by = new Map<string, number[]>();
  for (const r of rows) by.set(r.name, [...(by.get(r.name) ?? []), Math.abs(r.cents)]);
  for (const [name, c] of by) {
    const sorted = c.filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
    const missed = c.length - sorted.length;
    console.log(`${label} ${name.padEnd(26)} max ${sorted[sorted.length - 1]?.toFixed(2)}c  median ${sorted[sorted.length >> 1]?.toFixed(2)}c  silent ${missed}/${c.length}`);
  }
}

describe("pitchOf on voices", () => {
  const rows = run("sung", 36, 84, VOICES);
  test("every sung pitch 36..84 is found, in the right octave, within 10 cents", () => {
    report("sung", rows);
    const bad = rows.filter((r) => !(Math.abs(r.cents) < 10));
    expect(bad).toEqual([]);
  });
});

describe("pitchOf on whistles", () => {
  const rows = run("whistle", 72, 105, WHISTLES);
  test("every whistled pitch 72..105 is found, in the right octave, within 10 cents", () => {
    report("whistle", rows);
    const bad = rows.filter((r) => !(Math.abs(r.cents) < 10));
    expect(bad).toEqual([]);
  });
});

describe("pitchOf in silence and noise", () => {
  test("quiet is nothing", () => {
    expect(pitchOf(new Float32Array(4096), 48000)).toBeNull();
    const r = random(7), x = new Float32Array(4096).map(() => 0.001 * gauss(r));
    expect(pitchOf(x, 48000)).toBeNull();
  });

  test("breath alone is rarely a pitch, and never a sure one", () => {
    const r = random(9);
    let found = 0;
    for (let t = 0; t < 50; t++) {
      let prev = 0;
      const x = new Float32Array(4096).map(() => {
        const w = gauss(r), s = 0.05 * (w - prev);
        prev = w;
        return s;
      });
      const p = listen("sung", x, 48000);
      if (p) found++;
    }
    expect(found).toBeLessThan(5);
  });
});

test("one look is quick enough for every animation frame", () => {
  const { x } = make(36, 48000, VOICES.steady, 3, WINDOW.sung);
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) listen("sung", x, 48000);
  const each = (performance.now() - t0) / 20;
  console.log(`one sung look at 48 kHz: ${each.toFixed(2)} ms`);
  expect(each).toBeLessThan(6);
});

describe("what the page says when someone is off", () => {
  const a3 = { kind: "sung" as const, midi: 57 };
  test("near is nothing, a little off is a little", () => {
    expect(advise(20, a3)).toBe("");
    expect(advise(-60, a3)).toBe("A LITTLE HIGHER");
    expect(advise(70, a3)).toBe("A LITTLE LOWER");
  });
  test("far off names the note they are on", () => {
    expect(advise(-400, a3)).toBe("YOU ARE ON F3: SING HIGHER");
    expect(advise(300, { kind: "whistle", midi: 88 })).toBe("YOU ARE ON G6: WHISTLE LOWER");
  });
  test("the right note in the wrong octave is said so", () => {
    expect(advise(-1190, a3)).toBe("A2: THE RIGHT NOTE, AN OCTAVE TOO LOW");
    expect(advise(1215, a3)).toBe("A4: THE RIGHT NOTE, AN OCTAVE TOO HIGH");
    expect(advise(-2400, a3)).toBe("A1: THE RIGHT NOTE, 2 OCTAVES TOO LOW");
  });
});
