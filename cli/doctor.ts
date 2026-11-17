#!/usr/bin/env bun
/**
 * Is everything here that the film needs? `bun cli/doctor.ts` says what is missing and how to get it;
 * `--json` prints one object: { ok, checks: [{ name, ok, needed, detail, fix? }] }. Exit code 1 if
 * something needed is missing.
 */
import { chromium } from "playwright-core";

interface Check {
  name: string;
  ok: boolean;
  /** without it nothing can be made (otherwise it only adds something) */
  needed: boolean;
  detail: string;
  fix?: string;
}
const mac = process.platform === "darwin";
const out = async (cmd: string[]) => {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const text = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
    return (await p.exited) === 0 ? text : null;
  } catch {
    return null;
  }
};
const checks: Check[] = [];

const ff = await out(["ffmpeg", "-hide_banner", "-encoders"]);
checks.push({
  name: "ffmpeg",
  ok: !!ff && ff.includes("libx264") && / aac /.test(ff),
  needed: true,
  detail: !ff ? "not found" : ff.includes("libx264") ? "found, with H.264 and AAC" : "found, but without libx264",
  fix: mac ? "brew install ffmpeg" : "install ffmpeg with libx264 from your package manager (apt install ffmpeg) or https://ffmpeg.org/download.html",
});

let browser = "";
for (const channel of ["chrome", "msedge", "chromium"]) {
  try {
    const b = await chromium.launch({ channel, headless: true });
    browser = `${channel} ${b.version()}`;
    await b.close();
    break;
  } catch {}
}
checks.push({ name: "browser", ok: !!browser, needed: true, detail: browser || "no Chrome, Edge or Chromium found", fix: "install Google Chrome: https://www.google.com/chrome/ (the film is drawn in it; recording also works best in it)" });

const demucs = Bun.which("demucs"), uvx = Bun.which("uvx");
checks.push({
  name: "instrument splitter",
  ok: !!(demucs || uvx),
  needed: false,
  detail: demucs ? "demucs found" : uvx ? "uvx found: demucs is fetched the first time --stems is used (about 2 GB)" : "neither demucs nor uv found: --stems (a choir per instrument) is not available",
  fix: mac ? "brew install uv" : "install uv: https://docs.astral.sh/uv/",
});

const swift = mac && !!Bun.which("swift");
checks.push({
  name: "face finder",
  ok: swift,
  needed: false,
  detail: swift ? "found (macOS Vision, through swift)" : mac ? "swift not found: each take is framed on the middle of its picture" : "macOS only: each take is framed on the middle of its picture, so keep your face in the middle",
  fix: mac ? "xcode-select --install" : undefined,
});

const ok = checks.every((c) => c.ok || !c.needed);
if (process.argv.includes("--json")) console.log(JSON.stringify({ ok, checks }, null, 1));
else {
  for (const c of checks) console.log(`${c.ok ? "ok     " : c.needed ? "MISSING" : "without"}  ${c.name}: ${c.detail}${c.ok || !c.fix ? "" : `\n         to get it: ${c.fix}`}`);
  console.log(ok ? "\nReady." : "\nNot ready: see MISSING above.");
}
process.exit(ok ? 0 : 1);
