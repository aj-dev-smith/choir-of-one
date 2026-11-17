/**
 * The song split into its instruments (vocals, drums, bass, everything else) by Demucs, so each can be a
 * choir of its own and be heard alone. Optional: without it the whole song is one choir.
 * Demucs is run from the PATH if it is there, else through `uvx`, which fetches it the first time (about 2 GB).
 */
import { join } from "node:path";
import { run } from "./audio.ts";

export const STEMS = ["vocals", "drums", "bass", "other"] as const;

async function how(): Promise<string[] | null> {
  if (Bun.which("demucs")) return ["demucs"];
  if (Bun.which("uvx")) return ["uvx", "--python", "3.11", "--from", "demucs", "--with", "soundfile", "demucs"];
  return null;
}

export async function stemsAvailable(): Promise<boolean> {
  return (await how()) !== null;
}

/** Split `wav` into four files under `dir`; their paths, in the order of STEMS. */
export async function split(wav: string, dir: string): Promise<string[]> {
  const cmd = await how();
  if (!cmd) throw new Error("splitting the song into instruments needs demucs, or uv to fetch it: https://docs.astral.sh/uv/ (or leave stems off)");
  await run([...cmd, "-n", "htdemucs", "-o", dir, wav], "splitting the song into instruments");
  const name = wav.split("/").pop()!.replace(/\.[^.]*$/, "");
  return STEMS.map((s) => join(dir, "htdemucs", name, `${s}.wav`));
}
