#!/usr/bin/env bun
/**
 * Make the film from the command line (the app's Make button does the same thing).
 *
 *   bun cli/make.ts --song song.mp3 [--project projects/default] [--title "..."] [--credit '"Song" by Artist']
 *                   [--start 0] [--length 90] [--stems] [--reach] [--skip sung-80,sung-79]
 *                   [--picture sung-78=sung-77,...] [--stand-in sung-41] [--no-captions] [--sound-only] [--json]
 *
 * Progress goes to stderr, a line at a time. With --json every line (stdout) is one JSON object:
 * {"progress": {step, detail, fraction?}}, then {"done": {file, notes}} or {"error": "..."}; exit code 1 on error.
 */
import { basename, resolve } from "node:path";
import { make, type MakeOptions } from "../src/make.ts";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? undefined : argv.splice(i, 2)[1];
};
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv.splice(i, 1).length > 0;
};
const list = (s: string | undefined) => (s ?? "").split(",").filter(Boolean);
const json = flag("json"), song = opt("song");
const say = (o: object) => console.log(JSON.stringify(o));
if (!song || flag("help")) {
  console.error("usage: bun cli/make.ts --song <file> [--project projects/default] [--title T] [--credit C] [--start s] [--length s]\n       [--stems] [--reach] [--skip id,id] [--picture id=id,...] [--stand-in id] [--no-captions] [--sound-only] [--json]");
  process.exit(song ? 0 : 1);
}
const o: MakeOptions = {
  project: resolve(opt("project") ?? "projects/default"),
  song: resolve(song),
  title: opt("title") ?? basename(song).replace(/\.[^.]*$/, "").replace(/[_-]+/g, " "),
  credit: opt("credit"),
  start: Number(opt("start") ?? 0),
  length: Number(opt("length") ?? 90),
  stems: flag("stems"),
  reach: flag("reach"),
  skip: list(opt("skip")),
  pictures: Object.fromEntries(list(opt("picture")).map((p) => p.split("=") as [string, string])),
  standIn: opt("stand-in"),
  noCaptions: flag("no-captions"),
  soundOnly: flag("sound-only"),
};
if (argv.length) {
  console.error(`not understood: ${argv.join(" ")}`);
  process.exit(1);
}
try {
  let last = "";
  const made = await make(o, (p) => {
    if (json) return say({ progress: p });
    // a line when the wording changes, not one for every frame
    const line = p.detail.replace(/\(\d+ of \d+( s)?\)/, "").trim();
    if (line !== last) console.error((last = line));
  });
  if (json) say({ done: made });
  else {
    for (const n of made.notes) console.error(`  ${n}`);
    console.log(made.file);
  }
} catch (e) {
  if (json) say({ error: (e as Error).message });
  else console.error(`It did not work: ${(e as Error).message}`);
  process.exit(1);
}
