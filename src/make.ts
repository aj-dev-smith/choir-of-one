/**
 * The whole process, start to finish: a folder of takes and a song in, a film out.
 * (The contract between the app's server, the command line and the pipeline.)
 *
 * A project is a folder:
 *   <project>/takes/takes.json   what the recorder wrote (see web/record.ts)
 *   <project>/takes/*.webm       the takes
 *   <project>/work/              everything made on the way (safe to delete)
 *   <project>/film.mp4           the film
 */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { arrange, type Part } from "./arrange.ts";
import { decode, noteName, rms, writeWav } from "./audio.ts";
import { capture } from "./capture.ts";
import { cutFaces, cutWhole } from "./faces.ts";
import { split, STEMS, stemsAvailable as canSplit } from "./stems.ts";
import { transcribe, TRANSCRIBE_FS, type Note, type TranscribeOptions } from "./transcribe.ts";
import { FS, isSung, loadVoices, midiOf, mixDown, sing } from "./voices.ts";

export interface MakeOptions {
  /** the project folder */
  project: string;
  /** the song: any file ffmpeg reads */
  song: string;
  /** shown on the film's first frame */
  title: string;
  /** a last line for the end card, e.g. `"Song" by Artist` */
  credit?: string;
  /** where in the song to start (s, default 0) and how much of it to use (s, default 90) */
  start?: number;
  length?: number;
  /** split the song into vocals, drums, bass and the rest first (needs demucs; see stemsAvailable) */
  stems?: boolean;
  /** also play the pitches the person could not reach, on their nearest take moved in pitch */
  reach?: boolean;
  /** takes to leave out, by id (`sung-80`) */
  skip?: string[];
  /** takes to show with another take's picture: { "sung-78": "sung-77" } */
  pictures?: Record<string, string>;
  /** the take whose picture stands in for takes with nobody in shot */
  standIn?: string;
  /** stop after the sound (<project>/work/mix.wav): no film */
  soundOnly?: boolean;
  /** leave the explaining words off the film (the title and end card stay) */
  noCaptions?: boolean;
}
export interface Progress {
  /** a short name for what is happening: "song", "stems", "notes", "voices", "faces", "film" */
  step: string;
  /** a line a person can read */
  detail: string;
  /** how far through this step, 0..1, where it is known */
  fraction?: number;
}
export interface Made {
  /** the film (or, with soundOnly, the sound) */
  file: string;
  /** what a person should know: how many notes, what was left out and why */
  notes: string[];
}

/** Can the song be split into instruments here? (Is demucs installed, or uvx to run it?) */
export const stemsAvailable = canSplit;

/** How each part of a song is listened to, and how it is shown. */
const PARTS: Record<string, { color: string; label: string; alone: string; listen: TranscribeOptions }> = {
  song: { color: "#ffb340", label: "the song", alone: "", listen: {} },
  vocals: { color: "#ffb340", label: "vocals", alone: "JUST THE VOCALS. STILL ME.", listen: {} },
  // a drum hit is over in less than a long spectrum: short ones, and more of each
  drums: { color: "#ff5d40", label: "drums", alone: "JUST THE DRUMS. STILL ME.", listen: { window: 512, hop: 128, peaks: 24 } },
  // a bass's notes are closer together than a short spectrum can tell apart, and lower than the rest
  bass: { color: "#5be381", label: "bass", alone: "JUST THE BASS. STILL ME.", listen: { window: 4096, hop: 512, low: 28, high: 76, peaks: 10 } },
  other: { color: "#ff73cf", label: "everything else", alone: "JUST EVERYTHING ELSE. STILL ME.", listen: {} },
};

export async function make(o: MakeOptions, on: (p: Progress) => void = () => {}): Promise<Made> {
  const takes = join(o.project, "takes"), work = join(o.project, "work");
  const said: string[] = [];
  await rm(work, { recursive: true, force: true });
  await mkdir(join(work, "faces"), { recursive: true });

  // ---- the song: the stretch asked for, whole or split into its instruments
  on({ step: "song", detail: "Reading the song" });
  const clip = await decode(o.song, FS, o.start ?? 0, o.length ?? 90);
  const length = clip.length / FS;
  if (length < 15) throw new Error(`there are only ${length.toFixed(1)} s of song from ${o.start ?? 0} s: it needs at least 15`);
  let peak = 0;
  for (const s of clip) peak = Math.max(peak, Math.abs(s));
  if (peak < 1e-4) throw new Error("that stretch of the song is silent");
  await writeWav(join(work, "song.wav"), Int16Array.from(clip, (s) => Math.round((s / peak) * 0.9 * 32767)), FS);
  let files = [join(work, "song.wav")], names: string[] = ["song"];
  if (o.stems) {
    on({ step: "stems", detail: "Splitting the song into vocals, drums, bass and the rest (the first time, this downloads the splitter)" });
    files = await split(join(work, "song.wav"), join(work, "stems"));
    names = [...STEMS];
  }
  const heard: Part[] = [];
  for (const [i, name] of names.entries()) {
    on({ step: "notes", detail: `Finding the notes in ${PARTS[name].label}`, fraction: i / names.length });
    const sound = names.length > 1 ? await decode(files[i], FS) : clip;
    heard.push({ name, sound, fs: FS, notes: transcribe(await decode(files[i], TRANSCRIBE_FS), PARTS[name].listen).filter((n) => n[0] < length - 0.05) });
  }

  // ---- the person: their takes, and which of the song's notes they can sing
  on({ step: "voices", detail: "Reading the takes" });
  const v = await loadVoices(takes, o.skip ?? [], (done, of) => on({ step: "voices", detail: `Reading the takes (${done + 1} of ${of})`, fraction: (done / of) * 0.5 }));
  said.push(...v.notes);
  const own = new Set([...v.held.keys()].map(midiOf));
  const asked = new Set(heard.flatMap((p) => p.notes.map((n) => n[2])));
  const reachable = (n: Note) => o.reach || own.has(n[2]);
  const parts = heard.map((p) => ({ ...p, notes: p.notes.filter(reachable) }));
  if (parts.every((p) => p.notes.length === 0)) throw new Error("none of the song's notes are among the takes: record more notes, or turn on reach");
  const plan = arrange(parts, length, { captions: !o.noCaptions });
  const stems: Float32Array[] = [], sangBy = new Map<number, string>();
  for (const [i, p] of parts.entries()) {
    on({ step: "voices", detail: `Singing ${PARTS[p.name].label}`, fraction: 0.5 + (0.5 * i) / parts.length });
    const sung = sing(v, plan.notes[i], length, p.name === "drums");
    stems.push(sung.sound);
    for (const [midi, id] of sung.sangBy) sangBy.set(midi, id);
  }
  const mix = mixDown(stems, { levels: parts.map((p) => rms(p.sound)), solos: plan.solos, joining: plan.joining });
  const used = [...new Set(sangBy.values())].sort((a, b) => midiOf(a) - midiOf(b) || a.localeCompare(b));
  const usedSung = used.filter(isSung), usedWhistled = used.filter((id) => !isSung(id));
  const pitches = [...sangBy.keys()], moved = pitches.filter((m) => midiOf(sangBy.get(m)!) !== m);
  const span = (ids: string[]) => (ids.length ? `${ids.length} (${noteName(midiOf(ids[0]))} to ${noteName(midiOf(ids[ids.length - 1]))})` : "none");
  said.unshift(`${used.length} notes: ${span(usedSung)} sung, ${span(usedWhistled)} whistled.`);
  if (o.reach && moved.length) said.push(`${moved.length} of the song's ${asked.size} pitches were out of reach and are played on the nearest take, moved by up to ${Math.max(...moved.map((m) => Math.abs(m - midiOf(sangBy.get(m)!))))} semitones.`);
  else if (asked.size > pitches.length) said.push(`${asked.size - pitches.length} of the song's ${asked.size} pitches were out of reach and are left out (turn on reach to play them pitch-shifted).`);
  const swapped = [...v.strained].filter((id) => v.held.has(`whistle-${midiOf(id)}`) && used.includes(`whistle-${midiOf(id)}`));
  if (swapped.length) said.push(`${swapped.join(", ")}: sung so high that the sound is mostly a squeal, so the whistle of the same note is heard instead (the picture is still the sung take).`);
  const squeals = [...v.strained].filter((id) => used.includes(id));
  if (squeals.length) said.push(`${squeals.join(", ")} may squeal: sung so high that most of the sound is above 1.5 kHz. Whistle those notes too, or leave them out (skip).`);

  const pcm = Int16Array.from(mix, (s) => Math.round(s * 32767));
  if (o.soundOnly) {
    await writeWav(join(work, "mix.wav"), pcm, FS);
    return { file: join(work, "mix.wav"), notes: said };
  }

  // ---- before the song, three takes shown whole and as they were recorded: one from the middle of the
  // voice, one whistle, and the lowest (or the stand-in: whoever had to lean in)
  const SHOWN = 1.7, GAP = 0.25, SETTLE = 0.9, HOLD = 1.5, END = 3;
  const picks = [...new Set([usedSung[Math.floor(usedSung.length * 0.4)], usedWhistled[Math.floor(usedWhistled.length / 2)], o.standIn && v.held.has(o.standIn) ? o.standIn : usedSung[0]].filter((id): id is string => !!id))];
  const words = ["I RECORDED MYSELF HOLDING ONE NOTE.", "THEN ANOTHER.", o.standIn ? `${used.length} OF THEM. I HAD TO LEAN IN FOR THE LOW ONES.` : `${used.length} OF THEM.`];
  const loud = rms(pcm, Math.min(pcm.length - 1, Math.round((plan.joining + 1) * FS)));
  const open: number[] = new Array(Math.round(HOLD * FS)).fill(0);
  const cold = [];
  for (const [k, id] of picks.entries()) {
    const seg = v.held.get(id)!, len = Math.min(SHOWN, seg.length / FS - 0.05), n = Math.round(len * FS);
    // the take's own sound, untouched but for its level and its edges
    const g = (0.8 * loud) / (rms(seg, 0, n) || 1), edge = Math.round(0.03 * FS);
    for (let i = 0; i < n; i++) open.push(Math.max(-32767, Math.min(32767, Math.round(seg[i] * g * Math.min(1, i / edge, (n - i) / edge)))));
    for (let i = 0; i < Math.round(GAP * FS); i++) open.push(0);
    const sheet = `whole-${id}.jpg`;
    cold.push({ sheet, ...(await cutWhole(v, id, len, join(work, sheet))), len, name: noteName(midiOf(id)), hz: v.takes[id].hz, kind: isSung(id) ? "sung" : "whistled", text: words[Math.min(k, words.length - 1)] });
  }
  for (let i = 0; i < Math.round(SETTLE * FS); i++) open.push(0);
  const all = new Int16Array(open.length + pcm.length + Math.round((END + 1) * FS));
  all.set(open);
  all.set(pcm, open.length);
  await writeWav(join(work, "film.wav"), all, FS);

  // ---- the pictures
  on({ step: "faces", detail: "Framing each take on your face" });
  const seenAs = new Map<string, string>(swapped.map((id) => [`whistle-${midiOf(id)}`, id]));
  for (const [a, b] of Object.entries(o.pictures ?? {})) seenAs.set(a, b);
  const cut = await cutFaces(v, used, join(work, "faces"), seenAs, o.standIn, (done, of) => on({ step: "faces", detail: `Framing each take on your face (${done + 1} of ${of})`, fraction: done / of }));
  said.push(...cut.notes);

  // ---- the film
  for (const [i, p] of parts.entries()) await Bun.write(join(work, `${p.name}.json`), JSON.stringify({ notes: plan.notes[i] }));
  const wall = {
    width: 1920,
    height: 1080,
    title: { hold: HOLD, lines: [o.title.toUpperCase(), "SUNG BY ONE PERSON", `${used.length} NOTES, RECORDED ONE AT A TIME. NO SONG IS PLAYING.`] },
    cold,
    gap: GAP,
    settle: SETTLE,
    length,
    captions: plan.captions,
    cuts: [...plan.solos.map(([a, b, who]) => [a, b, who, 1]), ...plan.looks.map(([a, b]) => [a, b, 0, 0])].sort((a, b) => a[0] - b[0]),
    keys: plan.keys,
    end: {
      hold: END,
      lines: [`${used.length} NOTES. ONE PERSON.`, "NO SONG WAS PLAYED. YOUR BRAIN DID THE REST.", o.reach && moved.length ? `${moved.length} NOTES OUT OF REACH WERE MADE FROM THE NEAREST` : "NOTHING PITCH-SHIFTED", ...(o.credit ? [o.credit.toUpperCase()] : [])],
    },
    faces: cut.faces,
    tiles: used.map((id) => ({ id, midi: midiOf(id) })),
    voices: Object.fromEntries(sangBy),
    sections: parts.map((p) => ({ name: p.name, label: PARTS[p.name].label, alone: PARTS[p.name].alone || undefined, color: PARTS[p.name].color, notes: `${p.name}.json` })),
  };
  await Bun.write(join(work, "wall.json"), JSON.stringify(wall, null, 1));
  on({ step: "film", detail: "Drawing the film", fraction: 0 });
  const file = join(o.project, "film.mp4");
  await capture(work, join(work, "film.wav"), file, (done, of) => on({ step: "film", detail: `Drawing the film (${Math.round(done / 30)} of ${Math.round(of / 30)} s)`, fraction: done / of }));
  return { file, notes: said };
}
