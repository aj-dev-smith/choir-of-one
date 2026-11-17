/**
 * The words on the film and how it looks: <project>/script.json. It is written with the defaults the
 * first time a film is made (or by `bun cli/script.ts`), and is the person's to change: every film should
 * not say the same thing.
 *
 * In any line, {N} is how many notes there are, {SUNG} and {WHISTLED} how many of each, {TITLE} the
 * film's title, {CREDIT} its credit line, and (in `solo`) {PART} the instrument heard alone. A line that
 * comes out empty is left off, so "" removes one.
 */
import { join } from "node:path";

export interface Script {
  /** the first frame, which is what a feed shows before the film plays: the big line, then smaller ones */
  title: string[];
  /** before the song, a few takes are shown whole, as they were recorded */
  opening: {
    /** how many (0 to 3; 0 starts straight on the wall) */
    takes: number;
    /** which, by id ("sung-55"); empty lets the film choose one from the middle, a whistle and the lowest */
    ids: string[];
    /** a line under each, in order ("" for none) */
    lines: string[];
  };
  captions: {
    /** as the song starts, one voice at a time */
    start: string;
    /** a few seconds in, once the words can be heard */
    words: string;
    /** just before each instrument is heard alone (only when the song is split into instruments) */
    band: string;
    /** as the wall unfolds into a keyboard and the notes fall onto it */
    keys: string;
    /** after the keyboard, back on the wall */
    after: string;
  };
  /** under the wall while one instrument is heard alone */
  solo: string;
  /** the last frames: the big line, then smaller ones */
  end: string[];
  /** the colour of the vocals (or of everything, when the song is not split) and of the end card: "#rrggbb" */
  accent: string;
  /** what the wall stands on: "#rrggbb". Dark or light both work; the lettering turns to suit. */
  background: string;
}

export const defaultScript = (): Script => ({
  title: ["{TITLE}", "{N} notes. One voice."],
  opening: { takes: 3, ids: [], lines: ["", "", ""] },
  captions: {
    start: "Each tile is one note I recorded.",
    words: "Nobody sings the words. You hear them anyway.",
    band: "",
    keys: "",
    after: "",
  },
  solo: "{PART}",
  end: ["{N} notes. No song was played.", "{CREDIT}"],
  accent: "#ffb340",
  background: "#000000",
});

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Anything read from a file or sent by a page, made into a script: what is missing takes its default, what is wrong is said. */
export function checkScript(raw: unknown): Script {
  const d = defaultScript();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("the script must be an object (see script.json)");
  const r = raw as Record<string, unknown>;
  const text = (v: unknown, what: string, fallback: string) => {
    if (v === undefined) return fallback;
    if (typeof v !== "string") throw new Error(`${what} must be text`);
    if (v.length > 200) throw new Error(`${what} is too long to fit (200 characters at most)`);
    return v;
  };
  const texts = (v: unknown, what: string, fallback: string[], most: number) => {
    if (v === undefined) return fallback;
    if (!Array.isArray(v)) throw new Error(`${what} must be a list of lines`);
    if (v.length > most) throw new Error(`${what} has room for ${most} lines`);
    return v.map((l, i) => text(l, `${what} line ${i + 1}`, ""));
  };
  const colour = (v: unknown, what: string, fallback: string) => {
    if (v === undefined) return fallback;
    if (typeof v !== "string" || !HEX.test(v)) throw new Error(`${what} must be a colour like "#ffb340"`);
    return v;
  };
  const o = (r.opening ?? {}) as Record<string, unknown>, c = (r.captions ?? {}) as Record<string, unknown>;
  if (typeof o !== "object" || typeof c !== "object") throw new Error("opening and captions must be objects");
  const takes = o.takes === undefined ? d.opening.takes : Number(o.takes);
  if (!Number.isInteger(takes) || takes < 0 || takes > 3) throw new Error("opening.takes must be 0, 1, 2 or 3");
  const ids = o.ids === undefined ? [] : o.ids;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !/^(sung|whistle)-\d+$/.test(id))) throw new Error('opening.ids must be a list of take ids like "sung-55"');
  return {
    title: texts(r.title, "title", d.title, 3),
    opening: { takes, ids: ids as string[], lines: texts(o.lines, "opening.lines", d.opening.lines, 3) },
    captions: {
      start: text(c.start, "captions.start", d.captions.start),
      words: text(c.words, "captions.words", d.captions.words),
      band: text(c.band, "captions.band", d.captions.band),
      keys: text(c.keys, "captions.keys", d.captions.keys),
      after: text(c.after, "captions.after", d.captions.after),
    },
    solo: text(r.solo, "solo", d.solo),
    end: texts(r.end, "end", d.end, 4),
    accent: colour(r.accent, "accent", d.accent),
    background: colour(r.background, "background", d.background),
  };
}

/** The project's script; if it has none yet, the defaults are written there and returned. */
export async function readScript(project: string): Promise<Script> {
  const file = Bun.file(join(project, "script.json"));
  if (!(await file.exists())) {
    const d = defaultScript();
    await writeScript(project, d);
    return d;
  }
  let raw: unknown;
  try {
    raw = await file.json();
  } catch (e) {
    throw new Error(`script.json is not valid JSON (${(e as Error).message}): fix it, or delete it to get the defaults back`);
  }
  try {
    return checkScript(raw);
  } catch (e) {
    throw new Error(`script.json: ${(e as Error).message}`);
  }
}

export async function writeScript(project: string, s: Script): Promise<void> {
  await Bun.write(join(project, "script.json"), JSON.stringify(checkScript(s), null, 2) + "\n");
}

/** A line with its {NAMES} filled in, tidied; "" if nothing is left. */
export function fill(line: string, values: Record<string, string | number>): string {
  return line.replace(/\{([A-Z]+)\}/g, (all, k: string) => (k in values ? String(values[k]) : all)).replace(/\s+/g, " ").trim();
}
