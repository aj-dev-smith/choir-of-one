#!/usr/bin/env bun
/**
 * The film's words and look, before a film is made: `bun cli/script.ts [--project projects/default]` writes
 * script.json with the defaults if the project has none, checks it if it has, and prints it. Edit the file,
 * run this again to check it, then make the film. `--reset` puts the defaults back.
 */
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { defaultScript, readScript, writeScript } from "../src/script.ts";

const argv = process.argv.slice(2), at = argv.indexOf("--project");
const project = resolve(at < 0 ? "projects/default" : argv[at + 1]);
try {
  await mkdir(project, { recursive: true });
  if (argv.includes("--reset")) await writeScript(project, defaultScript());
  const script = await readScript(project);
  console.error(`${project}/script.json`);
  console.log(JSON.stringify(script, null, 2));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
