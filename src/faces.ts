/**
 * The pictures: for each take on the wall, the person's face at rest and a strip of them holding the
 * note, framed on the face itself, since nobody sits in the same place for seventy takes.
 */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./audio.ts";
import { midiOf, type Voices } from "./voices.ts";

export const FACE = 256, FACE_FPS = 30, FACE_FRAMES = 36;
type Box = [x: number, y: number, w: number, h: number];

export interface Faces {
  size: number;
  fps: number;
  clips: Record<string, { rest: string; strip: string; frames: number }>;
}

/**
 * Where the face is in each picture, as fractions of it. macOS has a face finder built in (Vision, run
 * through `swift`); elsewhere, or if it fails, nothing is found and takes are framed on their middle.
 */
async function find(pictures: string[]): Promise<Record<string, Box | null>> {
  if (process.platform !== "darwin" || !Bun.which("swift")) return {};
  try {
    return JSON.parse(new TextDecoder().decode(await run(["swift", join(import.meta.dir, "faces.swift"), ...pictures], "finding faces")));
  } catch {
    return {};
  }
}

/** The frame round a face: twice the face tall, the lips a fifth of it below the middle, kept in the picture. */
function frameOf(b: Box) {
  const side = Math.min(1, 2 * b[3]), x = b[0] + b[2] / 2 - side / 2, y = b[1] + 0.35 * b[3] - side / 2;
  return { side, x: Math.min(1 - side, Math.max(0, x)), y: Math.min(1 - side, Math.max(0, y)) };
}

/**
 * Cut the pictures for the takes in `used` into `dir`. `seenAs` says whose picture a take shows where it is
 * not its own; `standIn` is the take shown, whole, for takes with nobody in the picture (leaning in to the
 * microphone for a low note, say). Without one they borrow the nearest take with a face in it.
 */
export async function cutFaces(v: Voices, used: string[], dir: string, seenAs: Map<string, string>, standIn: string | undefined, on: (done: number, of: number) => void = () => {}): Promise<{ faces: Faces; notes: string[] }> {
  await mkdir(dir, { recursive: true });
  const looks = join(dir, "look"), look = (id: string, when: string) => join(looks, `${id}-${when}.jpg`);
  await mkdir(looks, { recursive: true });
  const restAt = (id: string) => {
    const t = v.takes[id];
    return t.rest ? (t.rest[0] + t.rest[1]) / 2 : Math.max(0, t.from - 0.45);
  };
  const looked = [...new Set([...used, ...[...seenAs.values()], ...(standIn ? [standIn] : [])].filter((id) => v.takes[id]))];
  const grab = (id: string, at: number, to: string, vf?: string) =>
    run(["ffmpeg", "-v", "error", "-y", "-ss", String(at), "-i", join(v.dir, v.takes[id].file), "-frames:v", "1", ...(vf ? ["-vf", vf] : []), "-q:v", "3", to], `${v.takes[id].file} (picture)`);
  for (const id of looked) {
    await grab(id, (v.takes[id].from + v.takes[id].to) / 2, look(id, "held"));
    await grab(id, restAt(id), look(id, "rest"));
  }
  const boxes = await find(looked.flatMap((id) => [look(id, "held"), look(id, "rest")]));
  const found = Object.values(boxes).some(Boolean);
  const seen = used.filter((id) => boxes[look(id, "held")]);
  const clips: Faces["clips"] = {}, notes: string[] = [], lent: string[] = [];
  for (const [i, voice] of used.entries()) {
    on(i, used.length);
    // a take with nobody in the picture keeps its sound and borrows a picture
    const swapped = seenAs.has(voice) && !!v.takes[seenAs.get(voice)!];
    const empty = found && !swapped && !boxes[look(voice, "held")];
    const whole = empty && !!standIn && !!v.takes[standIn];
    const id = swapped ? seenAs.get(voice)! : whole ? standIn! : empty && seen.length ? seen.reduce((a, b) => (Math.abs(midiOf(b) - midiOf(voice)) < Math.abs(midiOf(a) - midiOf(voice)) ? b : a)) : voice;
    if (empty) lent.push(voice);
    const t = v.takes[id], frames = Math.max(2, Math.min(FACE_FRAMES, Math.floor((t.to - t.from - 0.15) * FACE_FPS)));
    const held = whole ? null : boxes[look(id, "held")], rest = boxes[look(id, "rest")];
    const f = held ? frameOf(held) : null;
    const square = f
      ? `crop='min(iw,ih)':'min(iw,ih)',crop=iw*${f.side.toFixed(4)}:ih*${f.side.toFixed(4)}:iw*${f.x.toFixed(4)}:ih*${f.y.toFixed(4)},scale=${FACE}:${FACE}`
      : `crop='min(iw,ih)':'min(iw,ih)',scale=${FACE}:${FACE}`;
    // the still is of them waiting, unless they were somewhere else then: then it is the note's first moment
    const there = whole ? false : !held || (!!rest && Math.hypot(rest[0] + rest[2] / 2 - held[0] - held[2] / 2, rest[1] + rest[3] / 2 - held[1] - held[3] / 2) < 0.6 * held[3]);
    await grab(id, there ? restAt(id) : t.from + 0.05, join(dir, `${voice}-rest.jpg`), square);
    await grab(id, t.from + 0.05, join(dir, `${voice}.jpg`), `fps=${FACE_FPS},${square},tile=${frames}x1`);
    clips[voice] = { rest: `${voice}-rest.jpg`, strip: `${voice}.jpg`, frames };
  }
  await rm(looks, { recursive: true, force: true });
  if (!found) notes.push(process.platform === "darwin" ? "No faces were found, so each take is framed on the middle of its picture." : "Faces are only looked for on macOS; each take is framed on the middle of its picture.");
  if (lent.length) notes.push(`Nobody was in the picture for ${lent.join(", ")}: ${lent.length > 1 ? "they keep their" : "it keeps its"} sound and ${standIn ? `show${lent.length > 1 ? "" : "s"} ${standIn}'s picture` : "borrow the nearest take's picture"}.`);
  return { faces: { size: FACE, fps: FACE_FPS, clips }, notes };
}

/** A take shown whole: `seconds` of it from the start of its held note, as a sheet of frames `cols` wide. */
export async function cutWhole(v: Voices, id: string, seconds: number, to: string, size = 720, cols = 8): Promise<{ cols: number; frames: number }> {
  const t = v.takes[id], frames = Math.floor(seconds * 30);
  await run(["ffmpeg", "-v", "error", "-y", "-ss", String(t.from + 0.12), "-i", join(v.dir, t.file), "-frames:v", "1", "-vf", `fps=30,crop='min(iw,ih)':'min(iw,ih)',scale=${size}:${size},tile=${cols}x${Math.ceil(frames / cols)}`, "-q:v", "3", to], `${t.file} (whole)`);
  return { cols, frames };
}
