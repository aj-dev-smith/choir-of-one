/**
 * The recorder: takes a person through singing every pitch they can reach, and then whistling
 * the ones above, on camera, a clip for each. The clips are what the choir film is made from:
 * each pitch's clip is one voice.
 *
 * First the setup, one screen each: the camera and microphone (a refusal is explained), a level
 * meter (too quiet, clipping, and which microphone: a Bluetooth headset's is poor), a headphone
 * check (two guide notes play and the microphone must not hear them, or they are in every clip)
 * and one practice note, not saved. The setup is done once per visit to the page.
 *
 * Then for each pitch it plays the note (LISTEN; the clip starts recording here, so it opens on
 * the person's resting face), then listens (SING): a needle shows how far off the voice is, a line
 * says what note they are on when far off or an octave away, and when it has held the pitch for
 * HOLD seconds the take is kept and the next pitch comes. A held note that clipped or was far too
 * quiet is asked again. A pitch out of reach is skipped (S); two skipped in a row and that
 * direction is done. B goes back one (the old take stays until it is replaced), P pauses, and
 * hiding the tab pauses too (the note starts again). Sung pitches go up from a middle note, then
 * down from it; whistles the same from theirs. A strip of keys along the bottom shows each pitch
 * kept, skipped, now and to come. Up and down arrows set the guide's loudness. Every key also has
 * a button under the picture.
 *
 * Takes are saved to the app's server, into the project's takes folder:
 * `<sung|whistle>-<midi>.webm`, camera and microphone, and `takes.json`:
 * { takes: { "sung-57": { file, from, to, hz, cents, rms, peak, rest } }, skipped: [ids] },
 * where { from, to } (s) is the held pitch in its clip, rms and peak its level, rest the stillness
 * before it. The page starts from the project's takes.json, so a session carries on where the last
 * one stopped; a copy of takes.json is also kept in localStorage. A save that fails is said, and
 * can be tried again: the take is held until it is saved or the person chooses to sing it again.
 *
 * `?from=52&whistle=84` set where each starts; `?only=60` asks for one pitch (`&kind=whistle` for
 * a whistle); `&nosetup` goes straight to the notes; `&quiet=0.05` sets the level (rms) under which
 * a held note is too quiet to keep.
 */
import type { ProjectView, Take } from "./api.ts";
import { C, font } from "./look.ts";

/**
 * How long a pitch must be held (s); how near it must come to count (cents) and how far it may
 * then stray; the dropouts a hold rides over (s).
 */
const HOLD = 2.0, NEAR = 35, STRAY = 50, GAP = 0.35;
/** how long the guide note plays (s) */
const GUIDE = 1.2;
/** a held note whose peak reaches CLIP clipped; under QUIET (rms) it is too quiet to use */
const CLIP = 0.99, QUIET = 0.008;
/** the stillness a clip must open with before the voice (s): the film's resting face */
const REST = 0.5;
/** the pitches asked for: sung, then whistled */
export const SUNG = { low: 36, high: 84 }, WHISTLED = { low: 72, high: 105 };
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const name = (midi: number) => `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

type Kind = "sung" | "whistle";
interface Ask {
  kind: Kind;
  midi: number;
}
type Outcome = "kept" | "skipped" | "back" | "again" | "paused";

/**
 * The pitch of a stretch of sound (Hz) and how sure (0..1), or null in silence or noise: the first
 * deep dip of the difference function (YIN), which does not mistake a voice's octave as a plain
 * autocorrelation peak does. A whistle's period is a dozen samples, so a sample's error is 13
 * cents: the period is measured again at the deepest whole number of periods the stretch allows.
 */
export function pitchOf(x: Float32Array, rate: number, low = 60, high = 4500): { hz: number; sure: number } | null {
  let power = 0;
  for (const v of x) power += v * v;
  if (Math.sqrt(power / x.length) < 0.006) return null;
  // periods are looked for up to `to`; the difference goes on to `far` for measuring them again
  const far = Math.floor(x.length / 3), from = Math.max(2, Math.floor(rate / high)), to = Math.min(far - 1, Math.ceil(rate / low));
  const n = x.length - far - 1, d = new Float32Array(far + 2), dn = new Float32Array(far + 2);
  let sum = 0;
  for (let lag = 1; lag <= far + 1; lag++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const e = x[i] - x[i + lag];
      s += e * e;
    }
    d[lag] = s;
    sum += s;
    dn[lag] = sum > 0 ? (s * lag) / sum : 1;
  }
  // the first dip under the threshold; a rough voice may not reach it, so then the first near the deepest
  let deepest = 1;
  for (let lag = from; lag < to; lag++) deepest = Math.min(deepest, dn[lag]);
  const under = deepest < 0.15 ? 0.15 : deepest < 0.35 ? deepest + 0.05 : -1;
  let best = -1;
  for (let lag = from; lag < to && best < 0; lag++) {
    if (dn[lag] < under) {
      while (lag + 1 < to && dn[lag + 1] < dn[lag]) lag++;
      best = lag;
    }
  }
  if (best < 0) return null;
  // between samples: the bottom of the parabola through the dip and its neighbours
  const bottom = (k: number) => {
    const a = d[k - 1], b = d[k], c = d[k + 1], bend = a + c - 2 * b;
    return bend > 0 ? k + Math.max(-1, Math.min(1, (0.5 * (a - c)) / bend)) : k;
  };
  // then again at two periods, four, ..., the most there is room for, each a closer look
  let period = bottom(best);
  for (let many = 2, last = false; !last; many *= 2) {
    const most = Math.floor((far - 1) / period);
    if (many >= most) [many, last] = [most, true];
    if (many < 2) break;
    let k = Math.round(many * period);
    const reach = Math.max(1, Math.floor(period / 4)), at = k;
    for (let j = Math.max(2, at - reach), top = Math.min(far, at + reach); j <= top; j++) if (d[j] < d[k]) k = j;
    period = bottom(k) / many;
  }
  return { hz: rate / period, sure: 1 - dn[best] };
}

/** samples of sound looked at for a pitch */
export const WINDOW = { sung: 3072, whistle: 2048 };
/** the pitch in the last of `x`, as the page looks for it: a whistle in less, and nothing under it */
export function listen(kind: Kind, x: Float32Array, rate: number) {
  const w = x.subarray(Math.max(0, x.length - WINDOW[kind]));
  return kind === "whistle" ? pitchOf(w, rate, 500, 4500) : pitchOf(w, rate, 55, 1400);
}

/** The order pitches are asked in: up from `start` until two are skipped, then down from under it. */
function* outward(kind: Kind, start: number, low: number, high: number, skipped: Set<string>): Generator<Ask> {
  for (const step of [1, -1]) {
    let missed = 0;
    for (let midi = step > 0 ? start : start - 1; midi >= low && midi <= high && missed < 2; midi += step) {
      yield { kind, midi };
      missed = skipped.has(`${kind}-${midi}`) ? missed + 1 : 0;
    }
  }
}

/** the middle of the last few pitch readings (cents), or NaN if fewer than three were heard */
function median(v: number[]): number {
  const h = v.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  return h.length < 3 ? NaN : h[h.length >> 1];
}

/** What to tell someone `cents` off the note they were asked for, or nothing when near it. */
export function advise(cents: number, a: Ask): string {
  if (Number.isNaN(cents) || Math.abs(cents) < NEAR) return "";
  const on = name(Math.round(a.midi + cents / 100)), verb = a.kind === "sung" ? "SING" : "WHISTLE";
  const octaves = Math.round(cents / 1200);
  if (octaves !== 0 && Math.abs(cents - 1200 * octaves) < 60) {
    const many = Math.abs(octaves) === 1 ? "AN OCTAVE" : `${Math.abs(octaves)} OCTAVES`;
    return `${on}: THE RIGHT NOTE, ${many} TOO ${octaves < 0 ? "LOW" : "HIGH"}`;
  }
  if (Math.abs(cents) < 100) return cents < 0 ? `A LITTLE HIGHER` : `A LITTLE LOWER`;
  return `YOU ARE ON ${on}: ${verb} ${cents < 0 ? "HIGHER" : "LOWER"}`;
}

/** what a refused camera or microphone means, in plain words */
function refusal(err: unknown): string[] {
  const why = err instanceof DOMException ? err.name : "";
  if (why === "NotAllowedError" || why === "SecurityError")
    return [
      "THE CAMERA OR MICROPHONE WAS REFUSED",
      "CLICK THE CAMERA ICON AT THE RIGHT OF THE ADDRESS BAR, ALLOW BOTH, AND RELOAD.",
      "ON A MAC, CHROME MUST ALSO BE ALLOWED IN SYSTEM SETTINGS > PRIVACY & SECURITY.",
      "OR PRESS ANY KEY TO ASK AGAIN.",
    ];
  if (why === "NotFoundError") return ["NO CAMERA OR MICROPHONE FOUND", "CONNECT ONE, THEN PRESS ANY KEY TO TRY AGAIN."];
  if (why === "NotReadableError" || why === "AbortError")
    return ["THE CAMERA OR MICROPHONE IS BUSY", "ANOTHER APP (ZOOM, FACETIME, PHOTO BOOTH) MAY HAVE IT.", "CLOSE THAT, THEN PRESS ANY KEY TO TRY AGAIN."];
  return ["THE CAMERA OR MICROPHONE DID NOT START", `${why} ${err instanceof Error ? err.message : String(err)}`.trim().toUpperCase(), "PRESS ANY KEY TO TRY AGAIN."];
}

/** thrown out of the recorder's waits when the person leaves the step: everything stops */
export class Left extends Error {
  constructor() {
    super("left the recorder");
  }
}

/** a button under the picture: what it says, the key it presses, and the key's name on it */
interface Button {
  label: string;
  key: string;
  cap: string;
  main?: boolean;
}

/**
 * What lasts while the page is open, across visits to the recorder step: the setup is done once,
 * and the headphone check's answer and the guide's loudness are remembered.
 */
const kept = { setUp: false, introduced: false, leak: null as boolean | null, guide: 0.25 };

export interface RecordOptions {
  /** the project the takes are saved in */
  project: string;
  /** aborted when the person leaves the step: the camera and microphone are let go */
  signal: AbortSignal;
  /** what the last screen's button does: on to the song */
  next?: () => void;
}

export async function record(root: HTMLElement, { project, signal, next }: RecordOptions): Promise<void> {
  const query = new URLSearchParams(window.location.search);
  const quiet = Number(query.get("quiet") ?? QUIET);
  const api = `/api/projects/${encodeURIComponent(project)}`;
  const canvas = document.createElement("canvas");
  const W = 1280, H = 720;
  canvas.width = W;
  canvas.height = H;
  const bar = document.createElement("div");
  bar.className = "keys";
  root.replaceChildren(canvas, bar);
  const ctx = canvas.getContext("2d")!;
  // what has to be let go when the person leaves: filled in as things start
  let stream: MediaStream | null = null, audio: AudioContext | null = null;
  signal.addEventListener("abort", () => {
    stream?.getTracks().forEach((t) => t.stop());
    void audio?.close();
    state.screen = "left";
    state.live = stream?.getTracks().filter((t) => t.readyState === "live").length ?? 0;
  });

  // ---- drawing: text, the camera on the left, a panel on the right, the keys along the bottom
  const CAM = { x: 40, y: 40, s: 560 }, X0 = 650, PW = W - 40 - X0;
  const text = (s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = "left", most = PW) => {
    ctx.font = font(size);
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(s, x, y, most);
  };
  const clear = () => {
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
  };
  const say = (lines: string[], title: string = C.text) => {
    clear();
    lines.forEach((l, i) => text(l, W / 2, H / 2 - 60 + i * 52 + (i > 0 ? 24 : 0), i === 0 ? 44 : 24, i === 0 ? title : C.soft, "center", W - 80));
  };
  let notice = { text: "", color: C.now, until: 0 };
  const note = (s: string, color: string = C.now, seconds = 4) => (notice = { text: s, color, until: performance.now() + seconds * 1000 });
  /** what tests (and a curious person in the console) can read: where the page is */
  const state = { screen: "start", ask: "", advice: "", notice: "", held: 0, leak: kept.leak, saving: "", live: 0, takes: {} as Record<string, Take>, skipped: [] as string[] };
  (window as unknown as { choir: typeof state }).choir = state;

  // ---- keys: the last one pressed, read each frame, or waited for. Arrows set the guide's loudness.
  // A button presses its key, so the two are the same thing to everything below.
  let pressed = "";
  const IGNORED = new Set(["shift", "meta", "alt", "control", "tab", "capslock", "arrowup", "arrowdown"]);
  const waiting = new Set<(k: string) => void>();
  const press = (k: string) => {
    if (k === "arrowup" || k === "arrowdown") {
      kept.guide = Math.max(0.02, Math.min(0.8, kept.guide * (k === "arrowup" ? 1.4 : 1 / 1.4)));
      note(`GUIDE VOLUME ${Math.round(kept.guide * 100)}`, C.dim, 1.5);
    }
    if (IGNORED.has(k)) return;
    pressed = k;
    for (const w of [...waiting]) w(k);
  };
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.metaKey || e.ctrlKey) return;
      // keys typed into a field elsewhere on the page are not for the recorder
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select")) return;
      if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === " ") e.preventDefault();
      press(e.key.toLowerCase());
    },
    { signal },
  );
  const key = () =>
    new Promise<string>((done, fail) => {
      if (signal.aborted) return fail(new Left());
      const on = (k: string) => {
        waiting.delete(on);
        done(k);
      };
      waiting.add(on);
      signal.addEventListener("abort", () => (waiting.delete(on), fail(new Left())), { once: true });
    });
  /** a key from `wanted` */
  const keyOf = async (wanted: string[]) => {
    for (;;) {
      const k = await key();
      if (wanted.includes(k)) return k;
    }
  };
  let shown = "";
  /** the buttons under the picture, for this screen */
  const buttons = (list: Button[]) => {
    const sig = JSON.stringify(list);
    if (sig === shown) return;
    shown = sig;
    bar.replaceChildren(
      ...list.map((b) => {
        const el = document.createElement("button");
        el.type = "button";
        el.className = b.main ? "main" : "";
        el.dataset.key = b.key;
        const cap = document.createElement("kbd");
        cap.textContent = b.cap;
        el.append(cap, b.label);
        // a click must not leave the button focused, or the next Space would press it again
        el.addEventListener("mousedown", (e) => e.preventDefault());
        el.addEventListener("click", () => press(b.key));
        return el;
      }),
    );
  };
  /** wait for any key, with a button for it */
  const anyKey = async (label = "Continue") => {
    buttons([{ label, key: "enter", cap: "any key", main: true }]);
    return key();
  };
  const VOLUME: Button[] = [
    { label: "Guide quieter", key: "arrowdown", cap: "↓" },
    { label: "Guide louder", key: "arrowup", cap: "↑" },
  ];
  // a hidden tab gets no animation frames: hiding wakes the waiting frame, and pauses
  let wake: (() => void) | null = null, paused = false;
  const frame = async () => {
    await new Promise<void>((r) => ((wake = r), requestAnimationFrame(() => r())));
    if (signal.aborted) throw new Left();
  };
  signal.addEventListener("abort", () => wake?.());
  document.addEventListener(
    "visibilitychange",
    () => {
      if (!document.hidden) return;
      paused = true;
      wake?.();
    },
    { signal },
  );

  // ---- what this browser can do: a webm recorder, and the camera and microphone at all
  const mime = typeof MediaRecorder === "undefined" ? undefined : ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) return void (say(["THIS BROWSER CAN'T RECORD THE CLIPS", "IT CANNOT MAKE WEBM VIDEO. OPEN THIS PAGE IN CHROME."], C.bad), buttons([]));
  if (!navigator.mediaDevices?.getUserMedia) return void (say(["NO CAMERA ACCESS HERE", "OPEN THIS PAGE FROM LOCALHOST OR HTTPS, IN CHROME."], C.bad), buttons([]));

  if (!kept.introduced) {
    say([
      "THE CHOIR OF ONE",
      "YOU WILL SING EVERY NOTE YOU CAN REACH, ONE AT A TIME, THEN WHISTLE THE HIGH ONES.",
      "PUT ON HEADPHONES: THE GUIDE NOTE MUST NOT BE IN THE RECORDING.",
      "PRESS ANY KEY: THE BROWSER WILL ASK FOR THE CAMERA AND THE MICROPHONE.",
    ]);
    await anyKey("Start the camera");
    kept.introduced = true;
  } else say(["STARTING THE CAMERA..."]);

  // ---- the camera and microphone as they are: no echo cancelling or gain riding, which bend a held note
  const AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  for (;;) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 720, height: 720, facingMode: "user" }, audio: AUDIO });
      // left while the browser was asking: let it go at once
      if (signal.aborted) stream.getTracks().forEach((t) => t.stop());
      break;
    } catch (err) {
      say(refusal(err), C.bad);
      await anyKey("Ask again");
      say(["ASKING AGAIN..."]);
    }
  }
  if (signal.aborted) throw new Left();
  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  audio = new AudioContext();
  const sound = audio;
  const rate = sound.sampleRate;
  const ear = sound.createAnalyser();
  ear.fftSize = 4096;
  let source = sound.createMediaStreamSource(stream);
  source.connect(ear);
  const heard = new Float32Array(ear.fftSize);
  document.addEventListener("visibilitychange", () => void (document.hidden || sound.resume()), { signal });
  /** the microphone now: its level over the last pitch window, and its peak over all it holds */
  const hear = () => {
    ear.getFloatTimeDomainData(heard);
    let sq = 0, peak = 0;
    for (let i = heard.length - WINDOW.sung; i < heard.length; i++) sq += heard[i] * heard[i];
    for (const v of heard) peak = Math.max(peak, Math.abs(v));
    return { rms: Math.sqrt(sq / WINDOW.sung), peak };
  };
  const micName = () => (stream?.getAudioTracks()[0]?.label || "UNKNOWN").toUpperCase();
  /** the next microphone the computer has */
  async function nextMic() {
    const mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications");
    const now = stream!.getAudioTracks()[0]?.getSettings().deviceId;
    if (mics.length < 2) return note("THERE IS NO OTHER MICROPHONE");
    const next = mics[(mics.findIndex((m) => m.deviceId === now) + 1) % mics.length];
    const got = await navigator.mediaDevices.getUserMedia({ audio: { ...AUDIO, deviceId: { exact: next.deviceId } } }).catch(() => null);
    if (!got) return note("THAT MICROPHONE DID NOT START", C.bad);
    if (signal.aborted) return got.getTracks().forEach((t) => t.stop());
    stream!.getAudioTracks().forEach((t) => t.stop());
    stream = new MediaStream([...stream!.getVideoTracks(), ...got.getAudioTracks()]);
    source.disconnect();
    source = sound.createMediaStreamSource(stream);
    source.connect(ear);
  }

  /** a guide note: a soft organ for singing, a plain sine for whistling. Stops it early. */
  const organ = sound.createPeriodicWave(new Float32Array(7), new Float32Array([0, 1, 0.5, 0.3, 0.15, 0.08, 0.04]));
  function tone(f: number, seconds: number, kind: Kind, at = sound.currentTime): () => void {
    const o = sound.createOscillator(), g = sound.createGain(), level = kind === "whistle" ? kept.guide * 0.5 : kept.guide;
    if (kind === "sung") o.setPeriodicWave(organ);
    o.frequency.value = f;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(level, at + 0.03);
    g.gain.setValueAtTime(level, at + seconds - 0.08);
    g.gain.linearRampToValueAtTime(0, at + seconds);
    o.connect(g).connect(sound.destination);
    o.start(at);
    o.stop(at + seconds);
    return () => {
      if (sound.state === "closed") return;
      g.gain.cancelScheduledValues(sound.currentTime);
      g.gain.setTargetAtTime(0, sound.currentTime, 0.01);
      o.stop(sound.currentTime + 0.05);
    };
  }

  function camera(border: string, width: number, dash: number[] = []) {
    const side = Math.min(video.videoWidth, video.videoHeight) || 1;
    ctx.save();
    ctx.translate(CAM.x + CAM.s, CAM.y);
    ctx.scale(-1, 1);
    ctx.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, CAM.s, CAM.s);
    ctx.restore();
    ctx.strokeStyle = border;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.strokeRect(CAM.x, CAM.y, CAM.s, CAM.s);
    ctx.setLineDash([]);
  }
  function drawNotice(y: number) {
    state.notice = performance.now() < notice.until ? notice.text : "";
    if (!document.hasFocus()) text("CLICK HERE: THE KEYS ARE GOING TO ANOTHER WINDOW", X0, y, 20, C.bad);
    else if (state.notice) text(state.notice, X0, y, 20, notice.color);
  }
  /** a level as a bar from -60 dB to 0 */
  const dbX = (v: number, x: number, w: number) => x + w * Math.max(0, Math.min(1, 1 + (20 * Math.log10(Math.max(v, 1e-6))) / 60));

  // ---- where takes go: the app's server, which writes them into the project's takes folder
  /**
   * Saves a file, and keeps trying for as long as the person wants: a take is never dropped
   * because the server hiccuped. False only if they chose to sing it again instead.
   */
  async function save(file: string, blob: Blob, canSingAgain: boolean): Promise<boolean> {
    for (;;) {
      state.saving = file;
      let why = "";
      try {
        const r = await fetch(`${api}/takes/${file}`, { method: "PUT", body: blob, headers: { "content-type": blob.type || "application/octet-stream" } });
        if (r.ok) {
          state.saving = "";
          return true;
        }
        why = `THE SERVER SAID ${r.status}: ${(await r.text().catch(() => "")).slice(0, 120)}`;
      } catch (err) {
        why = `THE SERVER DID NOT ANSWER (${err instanceof Error ? err.message : String(err)})`;
      }
      if (signal.aborted) throw new Left();
      state.screen = "save failed";
      say(
        [
          `COULD NOT SAVE ${file}`,
          why.toUpperCase(),
          canSingAgain ? "THE TAKE IS STILL HERE. IS THE APP STILL RUNNING (bun run start)?" : "IS THE APP STILL RUNNING (bun run start)?",
        ],
        C.bad,
      );
      buttons([{ label: "Try saving again", key: "r", cap: "R", main: true }, ...(canSingAgain ? [{ label: "Sing it again instead", key: " ", cap: "Space" }] : [])]);
      if ((await keyOf(canSingAgain ? ["r", "enter", " "] : ["r", "enter"])) === " ") {
        state.saving = "";
        return false;
      }
      say([`SAVING ${file}...`]);
    }
  }
  /** the project as the server has it; asked again until the server answers */
  async function load(): Promise<ProjectView> {
    for (;;) {
      let why = "";
      try {
        const r = await fetch(api);
        if (r.ok) return (await r.json()) as ProjectView;
        why = `THE SERVER SAID ${r.status}`;
      } catch (err) {
        why = err instanceof Error ? err.message : String(err);
      }
      if (signal.aborted) throw new Left();
      say(["CAN'T REACH THE APP", why.toUpperCase(), "IS IT STILL RUNNING (bun run start)? PRESS ANY KEY TO TRY AGAIN."], C.bad);
      await anyKey("Try again");
    }
  }
  // a session picks up where the project's last one stopped
  const takes: Record<string, Take> = {};
  const skipped = new Set<string>();
  {
    say(["LOOKING FOR YOUR TAKES..."]);
    const old = await load();
    const files = new Set(old.files);
    let missing = 0;
    for (const [id, t] of Object.entries(old.takes?.takes ?? {})) {
      if (files.has(t.file)) takes[id] = t;
      else missing++;
    }
    (old.takes?.skipped ?? []).forEach((s) => skipped.add(s));
    if (old.unreadable) note("THE PROJECT'S takes.json COULD NOT BE READ: IT WILL BE KEPT AS takes-unreadable-...json", C.bad, 10);
    if (Object.keys(takes).length || skipped.size) {
      say([
        "WELCOME BACK",
        `THIS PROJECT HAS ${Object.keys(takes).length} CLIP${Object.keys(takes).length === 1 ? "" : "S"} AND ${skipped.size} SKIPPED NOTE${skipped.size === 1 ? "" : "S"}.`,
        missing ? `${missing} CLIPS IN takes.json ARE MISSING FROM THE PROJECT: THEY WILL BE ASKED AGAIN.` : "THE NOTES DONE ARE NOT ASKED AGAIN (B GOES BACK TO ONE).",
        "PRESS ANY KEY TO CARRY ON WHERE YOU STOPPED.",
      ]);
      state.screen = "welcome back";
      await anyKey("Carry on");
    }
  }
  state.takes = takes;
  const keep = async () => {
    state.skipped = [...skipped];
    const json = JSON.stringify({ takes, skipped: [...skipped] }, null, 1);
    try {
      localStorage.setItem(`choir-of-one:${project}`, json);
    } catch {
      // a full or blocked localStorage only loses the spare copy
    }
    await save("takes.json", new Blob([json], { type: "application/json" }), false);
  };

  // ---- the strip of keys: every pitch asked for, kept, skipped, now and to come
  function strip(asks: Ask[], now: string, on = NaN) {
    const low = SUNG.low, high = WHISTLED.high, x0 = 40, cw = (W - 80) / (high - low + 1);
    const coming = new Set(asks.map((a) => `${a.kind}-${a.midi}`));
    const row = (kind: Kind, from: number, to: number, y: number) => {
      for (let m = from; m <= to; m++) {
        const id = `${kind}-${m}`, black = NAMES[m % 12].includes("#"), x = x0 + (m - low) * cw + 1, h = black ? 12 : 20;
        if (id === now || takes[id] || skipped.has(id)) {
          ctx.fillStyle = id === now ? C.now : takes[id] ? C.good : C.bad;
          ctx.globalAlpha = id === now || takes[id] ? 1 : 0.5;
          ctx.fillRect(x, y, cw - 2, h);
          ctx.globalAlpha = 1;
        } else {
          ctx.strokeStyle = coming.has(id) ? C.dim : C.line;
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, cw - 3, h - 1);
        }
      }
    };
    row("sung", SUNG.low, SUNG.high, 636);
    row("whistle", WHISTLED.low, WHISTLED.high, 664);
    // where the voice is now: a mark over the row being sung
    if (!Number.isNaN(on) && on >= low - 0.5 && on <= high + 0.5) {
      const x = x0 + (on - low + 0.5) * cw, y = now.startsWith("sung") ? 634 : 662;
      ctx.fillStyle = C.text;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - 5, y - 8);
      ctx.lineTo(x + 5, y - 8);
      ctx.fill();
    }
    text("SUNG", x0 + (SUNG.high - low + 1) * cw + 10, 653, 16, C.dim, "left", 200);
    text("WHISTLED", x0 + (WHISTLED.low - low) * cw - 10, 681, 16, C.dim, "right", 200);
    for (let m = 36; m <= high; m += 12) text(name(m), x0 + (m - low) * cw + 1, 704, 14, C.faint, "left", 60);
    // the legend, ending at the right margin whatever the system font's widths
    const legend = [["KEPT", C.good], ["SKIPPED", C.bad], ["NOW", C.now], ["TO COME", C.dim]] as const;
    ctx.font = font(16);
    let x = W - 40 - legend.reduce((w, [label]) => w + ctx.measureText(label).width + 22, -22);
    for (const [label, color] of legend) {
      text(label, x, 653, 16, color, "left", 120);
      ctx.font = font(16);
      x += ctx.measureText(label).width + 22;
    }
  }

  const warned = new Set<string>();
  /**
   * One pitch: the note, then listening until it is held. What happened. A practice is the same
   * but records nothing.
   */
  async function ask(a: Ask, asks: Ask[], practice = false): Promise<Outcome> {
    const id = `${a.kind}-${a.midi}`, target = hz(a.midi), verb = a.kind === "sung" ? "SING" : "WHISTLE";
    pressed = "";
    paused = document.hidden;
    state.screen = practice ? "practice" : "ask";
    state.ask = id;
    buttons(
      practice
        ? [{ label: "Hear it again", key: " ", cap: "Space" }, { label: "Skip the practice", key: "s", cap: "S" }, { label: "Pause", key: "p", cap: "P" }, ...VOLUME]
        : [{ label: "Hear it again", key: " ", cap: "Space" }, { label: "Can't reach it: skip", key: "s", cap: "S" }, { label: "Back one", key: "b", cap: "B" }, { label: "Pause", key: "p", cap: "P" }, ...VOLUME],
    );
    const hush = tone(target, GUIDE, a.kind);
    // the clip starts with the guide note, while the person listens: its opening is their resting face
    let rec: MediaRecorder | null = null, opened = -1;
    const chunks: Blob[] = [];
    if (!practice) {
      rec = new MediaRecorder(stream!, { mimeType: mime, audioBitsPerSecond: 128000 });
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstart = () => (opened = sound.currentTime);
      rec.start();
      // leaving mid-note throws the clip away
      signal.addEventListener("abort", () => rec?.state !== "inactive" && rec?.stop(), { once: true });
    }
    const stopped = rec ? new Promise<void>((r) => (rec.onstop = () => r())) : Promise.resolve();
    const started = sound.currentTime;
    const track: number[] = [];
    let began = -1, last = -1, sumCents = 0, count = 0, sumSq = 0, frames = 0, peak = 0, shown = 0, before = 0;
    // the longest stillness so far (no voice heard), and the longest before the hold began
    let voiced = 0, still: [number, number] = [0, 0], rest: [number, number] = [0, 0];
    let advice = "", candidate = "", candidateAt = 0, outcome: Outcome | "" = "";
    for (;;) {
      await frame();
      const clock = sound.currentTime - started, singing = clock >= GUIDE + 0.08;
      const level = hear();
      // the voice is listened for while the guide plays too, but only to see that the person waits
      const any = listen(a.kind, heard, rate), p = singing ? any : null;
      if (any) voiced = clock;
      else if (clock - voiced > still[1] - still[0]) still = [voiced, clock];
      const raw = p ? 1200 * Math.log2(p.hz / target) : NaN;
      track.push(raw);
      if (track.length > 5) track.shift();
      // a reading is the middle of the last five, so one wild frame moves nothing
      const cents = median(track);
      if (!Number.isNaN(cents) && Math.abs(cents) < (began >= 0 ? STRAY : NEAR)) {
        if (began < 0) [began, sumCents, count, sumSq, frames, peak, rest] = [clock, 0, 0, 0, 0, 0, still];
        last = clock;
        if (Math.abs(raw) < STRAY) [sumCents, count] = [sumCents + raw, count + 1];
        [sumSq, frames, peak] = [sumSq + level.rms ** 2, frames + 1, Math.max(peak, level.peak)];
      } else if (began >= 0 && clock - last > GAP) began = -1;
      const held = began < 0 ? 0 : last - began;
      // the bar drains rather than snaps when a hold is lost
      shown = held >= shown ? held : Math.max(held, shown - (clock - before) * 1.5);
      before = clock;
      state.held = held;
      if (held >= HOLD) outcome = "kept";
      else if (paused || pressed === "p") outcome = "paused";
      else if (pressed === "s") outcome = "skipped";
      else if (pressed === "b" && !practice) outcome = "back";
      else if (pressed === " ") outcome = "again";
      pressed = "";
      // what to say about the pitch: only once it has held still a moment, so it doesn't flicker
      const now = advise(cents, a);
      if (now !== candidate) [candidate, candidateAt] = [now, clock];
      if (clock - candidateAt > 0.25 || now === "") advice = candidate;
      state.advice = advice;

      // ---- the picture
      clear();
      const listening = !singing;
      camera(listening ? C.faint : held > 0 ? C.now : C.dim, held > 0 ? 4 : 2, listening ? [10, 8] : []);
      text(practice ? "PRACTICE: THIS ONE IS NOT SAVED" : `${verb} THIS NOTE`, X0, 72, 22, practice ? C.now : C.dim);
      if (!practice) text(`${Object.keys(takes).length} KEPT  ${skipped.size} SKIPPED`, W - 40, 72, 18, C.faint, "right", 260);
      drawNotice(106);
      text(name(a.midi), X0 - 6, 225, 140, listening ? C.dim : C.text);
      text(`${target.toFixed(1)} HZ`, X0, 276, 20, C.dim);
      if (listening) {
        // LISTEN: the guide plays, a bar runs down, and the needle is not there yet
        text("LISTEN", X0, 375, 72, C.now);
        ctx.font = font(72);
        const lx = X0 + ctx.measureText("LISTEN").width + 30;
        ctx.strokeStyle = C.now;
        ctx.lineWidth = 3;
        for (let k = 0; k < 3; k++) {
          ctx.globalAlpha = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(clock * 10 - k * 1.2));
          ctx.beginPath();
          ctx.arc(lx, 350, 14 + k * 16, -0.8, 0.8);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        text(`DON'T ${verb} YET`, X0, 420, 24, C.soft);
        ctx.fillStyle = C.now;
        ctx.fillRect(X0, 450, PW * Math.max(0, 1 - clock / GUIDE), 6);
      } else {
        // SING: the needle, the middle the note, the band what counts as on it
        const mid = X0 + PW / 2, y = 340, span = 200, band = (began >= 0 ? STRAY : NEAR) / span;
        ctx.fillStyle = C.nowWash;
        ctx.fillRect(mid - band * (PW / 2), y - 30, band * PW, 60);
        ctx.strokeStyle = C.dim;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(X0, y);
        ctx.lineTo(X0 + PW, y);
        ctx.moveTo(mid, y - 40);
        ctx.lineTo(mid, y + 40);
        ctx.stroke();
        text("TOO LOW", X0, y + 62, 16, C.dim);
        text("TOO HIGH", X0 + PW, y + 62, 16, C.dim, "right");
        if (!Number.isNaN(cents)) {
          const nx = mid + (Math.max(-span, Math.min(span, cents)) / span) * (PW / 2);
          ctx.strokeStyle = Math.abs(cents) < (began >= 0 ? STRAY : NEAR) ? C.now : C.bad;
          ctx.lineWidth = 6;
          ctx.beginPath();
          ctx.moveTo(nx, y - 36);
          ctx.lineTo(nx, y + 36);
          ctx.stroke();
        }
        if (advice) text(advice, X0, 446, 26, C.bad);
        // how long it has been held
        ctx.strokeStyle = C.dim;
        ctx.lineWidth = 2;
        ctx.strokeRect(X0, 468, PW, 24);
        ctx.fillStyle = C.now;
        ctx.fillRect(X0, 468, PW * Math.min(1, shown / HOLD), 24);
        text(held > 0 ? "HOLD IT..." : a.kind === "sung" ? 'NOW SING "OOH" ON THAT NOTE' : "NOW WHISTLE THAT NOTE", X0, 534, 26, C.text);
      }
      if (!practice) strip(asks, id, a.midi + cents / 100);
      if (outcome) break;
    }
    hush();
    // a hold that clipped, or that the microphone barely heard, is no use: say so and ask again
    const rms = Math.sqrt(sumSq / Math.max(1, frames));
    // and a clip must open on the face at rest. Said once a note: a guide leaking too quietly for
    // the headphone check to catch would be heard as a voice every time.
    const restless = rest[1] - rest[0] < REST && state.leak !== true && !warned.has(id);
    if (outcome === "kept" && restless && peak < CLIP && rms >= quiet) warned.add(id);
    if (outcome === "kept" && (peak >= CLIP || rms < quiet || restless)) {
      note(
        peak >= CLIP ? "THAT ONE CLIPPED: TOO LOUD FOR THE MICROPHONE. A LITTLE SOFTER, OR FURTHER BACK."
        : rms < quiet ? "THAT ONE WAS TOO QUIET TO USE. COME CLOSER, OR SING OUT."
        : `WAIT FOR THE NOTE TO END BEFORE YOU ${verb}: THE CLIP OPENS ON YOUR FACE AT REST.`,
        C.bad,
        8,
      );
      outcome = "again";
    }
    if (outcome === "kept") {
      ctx.fillStyle = C.bg;
      ctx.fillRect(X0, 500, PW, 46);
      text(practice ? "GOT IT" : "GOT IT: SAVING...", X0, 534, 26, C.good);
      buttons([]);
    }
    if (rec && rec.state !== "inactive") {
      if (outcome === "kept") await new Promise((r) => setTimeout(r, 300)); // a little after the hold, to cut in
      rec.stop();
      await stopped;
    }
    if (signal.aborted) throw new Left();
    if (outcome === "kept" && rec) {
      const file = `${id}.webm`, mean = count ? sumCents / count : 0;
      // the clip's own clock starts when the recorder did, a moment after it was asked to
      const zero = opened >= 0 ? opened - started : 0, r3 = (v: number) => Math.round(v * 1000) / 1000;
      // if it can't be saved and the person would rather sing it again, it is asked again
      if (!(await save(file, new Blob(chunks, { type: rec.mimeType || mime }), true))) return "again";
      takes[id] = { file, from: r3(Math.max(0, began - zero)), to: r3(last - zero), hz: r3(target * 2 ** (mean / 1200)), cents: Math.round(mean * 10) / 10, rms: Math.round(rms * 10000) / 10000, peak: r3(peak), rest: [r3(Math.max(0, rest[0] - zero)), r3(Math.max(0, rest[1] - zero))] };
      skipped.delete(id);
      await keep();
    } else if (outcome === "skipped" && !practice) {
      skipped.add(id);
      delete takes[id];
      await keep();
    }
    return outcome;
  }

  // ---- the setup: the level, the headphones, a practice note
  async function levels() {
    state.screen = "levels";
    pressed = "";
    buttons([{ label: "Go on", key: "enter", cap: "Enter", main: true }, { label: "Next microphone", key: "m", cap: "M" }]);
    const voiced: { t: number; rms: number }[] = [];
    let clipped = -1e9, peakHold = 0;
    for (;;) {
      await frame();
      if (pressed === "enter") return;
      if (pressed === "m") await nextMic();
      pressed = "";
      const t = performance.now() / 1000, { rms, peak } = hear(), p = listen("sung", heard, rate);
      if (peak >= CLIP) clipped = t;
      peakHold = Math.max(peak, peakHold * 0.97);
      if (p) voiced.push({ t, rms });
      while (voiced.length && voiced[0].t < t - 3) voiced.shift();
      const loud = Math.max(0, ...voiced.map((v) => v.rms));
      clear();
      camera(C.dim, 2);
      text("1 OF 3   THE MICROPHONE", X0, 72, 22, C.dim);
      text("HOW LOUD?", X0, 150, 48, C.text);
      text("SING ANY NOTE, AS LOUD AS YOU WILL SING.", X0, 196, 22, C.soft);
      const y = 240, mh = 40;
      ctx.fillStyle = C.badWash;
      ctx.fillRect(dbX(0.89, X0, PW), y, X0 + PW - dbX(0.89, X0, PW), mh);
      ctx.fillStyle = C.now;
      ctx.fillRect(X0, y, dbX(rms, X0, PW) - X0, mh);
      ctx.fillStyle = C.text;
      ctx.fillRect(dbX(peakHold, X0, PW) - 2, y - 4, 4, mh + 8);
      ctx.strokeStyle = C.dim;
      ctx.lineWidth = 2;
      ctx.strokeRect(X0, y, PW, mh);
      text("-60 DB", X0, y + mh + 22, 14, C.faint);
      text("0", X0 + PW, y + mh + 22, 14, C.faint, "right");
      const [hint, more, color] = t - clipped < 2
        ? ["CLIPPING", "MOVE BACK, OR TURN THE INPUT DOWN (SYSTEM SETTINGS > SOUND > INPUT).", C.bad]
        : !voiced.length
          ? ["SING A NOTE...", "THE BAR SHOWS HOW LOUD THE MICROPHONE HEARS YOU.", C.text]
          : loud < 0.02
            ? ["TOO QUIET", "COME CLOSER, OR TURN THE INPUT UP (SYSTEM SETTINGS > SOUND > INPUT).", C.bad]
            : ["GOOD LEVEL", "PRESS ENTER WHEN IT STAYS GOOD.", C.good];
      text(hint, X0, 380, 34, color);
      text(more, X0, 414, 18, C.soft);
      text(`MICROPHONE: ${micName()}`, X0, 480, 18, C.dim);
      if (/airpods|bluetooth|headset|hands-free|beats|buds/i.test(micName())) text("THAT IS A HEADSET'S MICROPHONE, AND POOR: PRESS M FOR ANOTHER.", X0, 506, 18, C.bad);
      drawNotice(540);
      text("PUT YOUR FACE IN THE MIDDLE OF THE SQUARE.", CAM.x, 640, 18, C.dim, "left", CAM.s);
    }
  }

  /** The guide notes, played while the microphone listens for them. True if it heard them. */
  async function leaks(): Promise<boolean> {
    state.screen = "leaks";
    buttons([]);
    const tones = [{ midi: 55, at: 0.6 }, { midi: 79, at: 1.8 }], seconds = 1.0, t0 = sound.currentTime;
    tones.forEach((k) => tone(hz(k.midi), seconds, "sung", t0 + k.at));
    const hits = tones.map(() => 0), looks = tones.map(() => 0);
    for (;;) {
      await frame();
      const t = sound.currentTime - t0;
      if (t > tones[tones.length - 1].at + seconds + 0.2) break;
      hear();
      tones.forEach((k, i) => {
        if (t < k.at + 0.2 || t > k.at + seconds) return;
        const p = pitchOf(heard.subarray(heard.length - WINDOW.sung), rate, 55, 1400);
        looks[i]++;
        if (p && Math.abs(1200 * Math.log2(p.hz / hz(k.midi))) < 60) hits[i]++;
      });
      clear();
      camera(C.faint, 2, [10, 8]);
      text("2 OF 3   THE HEADPHONES", X0, 72, 22, C.dim);
      text("LISTENING...", X0, 150, 48, C.now);
      text("STAY QUIET: TWO NOTES WILL PLAY IN YOUR HEADPHONES.", X0, 196, 22, C.soft);
      text("IF THE MICROPHONE HEARS THEM, THEY WOULD BE IN EVERY CLIP.", X0, 226, 22, C.soft);
    }
    return hits.some((h, i) => h > 0.3 * looks[i]);
  }
  async function headphones() {
    for (;;) {
      const leaking = await leaks();
      state.leak = kept.leak = leaking;
      pressed = "";
      buttons([{ label: leaking ? "Go on anyway" : "Go on", key: "enter", cap: "Enter", main: !leaking }, { label: "Check again", key: " ", cap: "Space", main: leaking }, ...VOLUME]);
      for (;;) {
        await frame();
        clear();
        camera(C.dim, 2);
        text("2 OF 3   THE HEADPHONES", X0, 72, 22, C.dim);
        if (leaking) {
          text("THE MICROPHONE HEARS", X0, 150, 44, C.bad);
          text("THE GUIDE NOTE", X0, 200, 44, C.bad);
          text("IT WOULD BE IN EVERY CLIP, AND COULD BE TAKEN FOR YOUR VOICE.", X0, 250, 20, C.soft);
          text("WEAR HEADPHONES, OR TURN THE VOLUME DOWN (DOWN ARROW).", X0, 280, 20, C.soft);
        } else {
          text("GOOD: THE MICROPHONE", X0, 150, 44, C.good);
          text("CAN'T HEAR IT", X0, 200, 44, C.good);
          text("DID YOU HEAR TWO NOTES? IF NOT, TURN IT UP (UP ARROW)", X0, 250, 20, C.soft);
          text("AND CHECK AGAIN.", X0, 280, 20, C.soft);
        }
        text(`GUIDE VOLUME ${Math.round(kept.guide * 100)}`, X0, 340, 20, C.dim);
        if (pressed === " ") break;
        if (pressed === "enter") return;
        pressed = "";
      }
    }
  }

  // ---- the session: every sung pitch outward from the middle, then the whistles
  const only = query.get("only"), start = Number(query.get("from") ?? 50);
  if (!query.has("nosetup") && !kept.setUp) {
    await levels();
    await headphones();
    state.screen = "practice intro";
    say(["3 OF 3   ONE FOR PRACTICE", "EVERY NOTE GOES LIKE THIS: LISTEN, THEN SING IT AND HOLD IT FOR TWO SECONDS.", "THIS ONE IS NOT SAVED.", "PRESS ANY KEY."]);
    await anyKey("Try the practice note");
    for (;;) {
      const got = await ask({ kind: "sung", midi: start }, [], true);
      if (got === "paused") {
        state.screen = "paused";
        say(["PAUSED", "PRESS ANY KEY TO GO ON."]);
        await anyKey("Go on");
      }
      if (got === "kept" || got === "skipped") break;
    }
    kept.setUp = true;
    state.screen = "ready";
    say(["THAT IS HOW IT GOES", "NOW FOR REAL: EACH NOTE YOU HOLD IS SAVED, AND THE NEXT COMES.", "S SKIPS A NOTE YOU CAN'T REACH. P PAUSES.", "PRESS ANY KEY TO BEGIN."]);
    await anyKey("Begin");
  }
  const plan = (): Ask[] => only
    ? [{ kind: (query.get("kind") as Kind) ?? "sung", midi: Number(only) }]
    : [...outward("sung", start, SUNG.low, SUNG.high, skipped), ...outward("whistle", Number(query.get("whistle") ?? 86), WHISTLED.low, WHISTLED.high, skipped)];
  // a note gone back to is asked again even though it is done; its old take stays until replaced
  let redo = "", told = false;
  for (let i = 0; ; ) {
    // the plan is drawn up again each time: where a direction ends depends on what was skipped
    const asks = plan();
    if (i >= asks.length) break;
    const a = asks[i], id = `${a.kind}-${a.midi}`;
    if ((takes[id] || skipped.has(id)) && id !== redo && !only) {
      i++;
      continue;
    }
    if (a.kind === "whistle" && !told && !only) {
      told = true;
      state.screen = "whistles";
      say(["NOW THE WHISTLES", "SAME THING, WHISTLED. THEY START AROUND THE TOP OF A SOPRANO'S RANGE AND GO UP.", "PRESS ANY KEY."]);
      await anyKey("Go on");
    }
    const got = await ask(a, asks);
    if (got === "back" && i > 0) {
      i--;
      redo = `${asks[i].kind}-${asks[i].midi}`;
    } else if (got === "kept" || got === "skipped") {
      i++;
      redo = "";
    } else if (got === "paused") {
      state.screen = "paused";
      say(["PAUSED", "PRESS ANY KEY TO GO ON. THE NOTE STARTS AGAIN."]);
      await anyKey("Go on");
    }
  }
  stream.getTracks().forEach((t) => t.stop());
  state.screen = "done";
  const sung = Object.keys(takes).filter((k) => k.startsWith("sung")).length, whistled = Object.keys(takes).length - sung;
  say([
    "THAT IS ALL OF YOU",
    `${sung} SUNG NOTES AND ${whistled} WHISTLED.`,
    "THEY ARE SAVED IN THE PROJECT, WITH takes.json.",
    "NEXT, GIVE IT A SONG.",
  ]);
  (window as unknown as { choirTakes: unknown }).choirTakes = { takes, skipped: [...skipped] };
  buttons([{ label: "Next: the song", key: "enter", cap: "Enter", main: true }]);
  await keyOf(["enter"]);
  next?.();
}
