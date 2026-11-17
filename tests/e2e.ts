/**
 * The whole app, driven in Chrome with no one at the keys: `bun tests/e2e.ts`.
 *
 * Chrome is given a fake camera and a fake microphone that "sings" a steady D3, the first note
 * the recorder asks for. The script starts the server on a spare port with a throwaway project,
 * records one take (making the first save fail on purpose, to see it can be tried again), checks
 * what lands on disk, reloads to see the session carry on past that note, gives it a song too
 * short to use, presses Make and expects the pipeline's refusal to be shown. Then it deletes the
 * project. `SHOTS=<dir>` saves a screenshot of each step there; `FULL=1` also makes a real film
 * from a 20 s song and waits for it.
 *
 * Not part of `bun test`: it needs Chrome and ffmpeg, and takes a minute.
 */
import { $ } from "bun";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { defaultScript } from "../src/script.ts";

const ROOT = join(import.meta.dir, "..");
const PORT = 4100 + Math.floor(Math.random() * 800);
const PROJECT = `e2e-${Date.now().toString(36)}`;
const DIR = join(ROOT, "projects", PROJECT);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS;
const tmp = await mkdtemp(join(tmpdir(), "choir-e2e-"));

let failures = 0;
function check(what: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
}
const shot = async (page: Page, file: string) => SHOTS && (await page.screenshot({ path: join(SHOTS, file) }));
const until = async (page: Page, fn: string, ms: number) => page.waitForFunction(fn, null, { timeout: ms, polling: 100 });

// a steady D3 for the microphone, and songs: one too short for the pipeline, one long enough
const voice = join(tmp, "d3.wav"), short = join(tmp, "Short Test Song.wav"), long = join(tmp, "Long Test Song.wav");
await $`ffmpeg -loglevel error -y -f lavfi -i sine=frequency=146.83:sample_rate=48000 -t 30 ${voice}`;
await $`ffmpeg -loglevel error -y -f lavfi -i sine=frequency=146.83:sample_rate=44100 -t 5 ${short}`;
if (process.env.FULL) await $`ffmpeg -loglevel error -y -f lavfi -i sine=frequency=146.83:sample_rate=44100 -t 20 ${long}`;

const server = Bun.spawn(["bun", "server.ts"], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdout: "pipe", stderr: "inherit" });
for (let i = 0; i < 100; i++) {
  if (await fetch(BASE).then((r) => r.ok, () => false)) break;
  await Bun.sleep(100);
}
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${voice}`],
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("pageerror", (e) => check("no page errors", false, e.message));

  // ---- 1. record one take; the first save fails on purpose
  let refused = 0;
  await page.route("**/takes/sung-50.webm", (route) => (refused++ ? route.continue() : route.abort("connectionfailed")));
  await page.goto(`${BASE}/?project=${PROJECT}&nosetup#record`);
  await until(page, `window.choir?.screen === "start"`, 10000);
  await shot(page, "1-intro.png");
  await page.click(`.keys button:has-text("Start the camera")`);
  await until(page, `window.choir.screen === "ask" && window.choir.ask === "sung-50"`, 15000);
  await page.waitForTimeout(2000);
  await shot(page, "1-sing.png");
  await until(page, `window.choir.screen === "save failed"`, 30000);
  check("a failed save is said, and the take is held", true);
  await shot(page, "1-save-failed.png");
  await page.click(`.keys button:has-text("Try saving again")`);
  await until(page, `!!window.choir.takes["sung-50"] && window.choir.ask === "sung-51"`, 15000);
  check("the retry saved it", refused === 2, `${refused} attempts`);

  const files = await readdir(join(DIR, "takes"));
  check("the take and takes.json are in the project", files.includes("sung-50.webm") && files.includes("takes.json"), files.join(", "));
  const json = await Bun.file(join(DIR, "takes", "takes.json")).json();
  const t = json.takes?.["sung-50"];
  check("takes.json has the take in the recorder's format", !!t && Object.keys(t).join() === "file,from,to,hz,cents,rms,peak,rest" && t.file === "sung-50.webm" && Array.isArray(json.skipped), JSON.stringify(json));
  check("the take was heard as D3", !!t && Math.abs(t.hz - 146.83) < 1.5, `${t?.hz} Hz`);
  check("the take holds the note for two seconds", !!t && t.to - t.from >= 1.9, `${t?.from} to ${t?.to}`);
  const head = new Uint8Array(await Bun.file(join(DIR, "takes", "sung-50.webm")).slice(0, 4).arrayBuffer());
  check("the take is a webm", head.join() === "26,69,223,163");
  await page.waitForTimeout(1500);
  await shot(page, "1-advice.png");

  // ---- reload: it carries on past the note done
  await page.reload();
  await until(page, `window.choir?.screen === "start"`, 10000);
  await page.click(`.keys button:has-text("Start the camera")`);
  await until(page, `window.choir.screen === "welcome back"`, 15000);
  await shot(page, "1-welcome-back.png");
  await page.click(`.keys button:has-text("Carry on")`);
  await until(page, `window.choir.screen === "ask"`, 10000);
  check("after a reload it asks the next note", await page.evaluate(`window.choir.ask`) === "sung-51", String(await page.evaluate(`window.choir.ask`)));

  // ---- the setup screens, each passed by its button; a skip by its key; leaving and coming back
  await page.goto(`${BASE}/?project=${PROJECT}#record`);
  await until(page, `window.choir?.screen === "start"`, 10000);
  await page.click(`.keys button:has-text("Start the camera")`);
  await until(page, `window.choir.screen === "welcome back"`, 15000);
  await page.click(`.keys button:has-text("Carry on")`);
  await until(page, `window.choir.screen === "levels"`, 10000);
  await page.waitForTimeout(1500);
  await shot(page, "1-setup-levels.png");
  await page.click(`.keys button:has-text("Go on")`);
  await until(page, `window.choir.leak !== null`, 15000);
  check("the headphone check doesn't hear the guide in the fake microphone", (await page.evaluate(`window.choir.leak`)) === false);
  await shot(page, "1-setup-headphones.png");
  await page.click(`.keys button:has-text("Go on")`);
  await until(page, `window.choir.screen === "practice intro"`, 5000);
  await page.click(`.keys button:has-text("Try the practice note")`);
  await until(page, `window.choir.screen === "ready"`, 30000);
  check("the practice note is not saved", (await readdir(join(DIR, "takes"))).filter((f) => f.endsWith(".webm")).length === 1);
  await page.click(`.keys button:has-text("Begin")`);
  await until(page, `window.choir.screen === "ask" && window.choir.ask === "sung-51"`, 10000);
  await page.keyboard.press("s");
  await until(page, `window.choir.ask === "sung-52"`, 10000);
  const skippedOnDisk = (await Bun.file(join(DIR, "takes", "takes.json")).json()).skipped;
  check("S skips a note, and takes.json says so", JSON.stringify(skippedOnDisk) === `["sung-51"]`, JSON.stringify(skippedOnDisk));
  await page.click(`nav button[data-step="make"]`);
  await page.keyboard.press("s"); // not for the recorder any more
  await page.click(`nav button[data-step="record"]`);
  await until(page, `window.choir.screen === "welcome back"`, 15000);
  check("coming back to the recorder skips the setup", true);
  await page.click(`.keys button:has-text("Carry on")`);
  await until(page, `window.choir.screen === "ask"`, 10000);
  check("and carries on at the next note", (await page.evaluate(`window.choir.ask`)) === "sung-52", String(await page.evaluate(`window.choir.ask`)));

  // ---- 2. the song
  await page.click(`nav button[data-step="song"]`);
  await page.setInputFiles("#file", short);
  await page.waitForFunction(`document.getElementById("drop-main").textContent === "Short Test Song.wav"`, null, { timeout: 10000 });
  check("the title comes from the file name", (await page.inputValue("#title")) === "Short Test Song");
  check("the song is stored in the project", await Bun.file(join(DIR, "song.wav")).exists());
  check("the camera and microphone are let go when the recorder is left", await page.evaluate(`window.choir.screen === "left" && window.choir.live === 0`));
  await page.fill("#credit", `"Test Song" by Nobody`);
  await shot(page, "2-song.png");

  // where the song can't be split, the box is off and says how to get it (the server is told to say so)
  await page.route(`**/api/projects/${PROJECT}`, async (route) => {
    const r = await route.fetch();
    await route.fulfill({ response: r, json: { ...(await r.json()), stems: false } });
  });
  await page.click(`nav button[data-step="record"]`);
  await page.click(`nav button[data-step="song"]`);
  await page.waitForFunction(`document.getElementById("stems").disabled`, null, { timeout: 5000 });
  check("without the splitter the box is off and the hint shows", await page.isVisible("#stems-hint"));
  check("the form is remembered", (await page.inputValue("#credit")) === `"Test Song" by Nobody`);
  await shot(page, "2-song-no-stems.png");
  await page.unroute(`**/api/projects/${PROJECT}`);
  await page.click(`nav button[data-step="record"]`);
  await page.click(`nav button[data-step="song"]`);
  const splits = ((await (await fetch(`${BASE}/api/projects/${PROJECT}`)).json()) as { stems: boolean }).stems;
  await page.waitForFunction(`document.getElementById("stems").disabled === ${!splits}`, null, { timeout: 5000 });

  // ---- the words and look: saved as typed, read back after a reload, reset, and a bad one refused
  const scriptUrl = `${BASE}/api/projects/${PROJECT}/script`, scriptFile = join(DIR, "script.json");
  const onDisk = async () => (await Bun.file(scriptFile).json()) as ReturnType<typeof defaultScript>;
  // opening.ids isn't in the panel, but whatever it holds must survive the panel's saves
  const seeded = await fetch(scriptUrl, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ opening: { takes: 1, ids: ["sung-50"] } }) });
  check("a script can be put by hand", seeded.status === 200, String(seeded.status));
  await page.reload();
  await page.waitForFunction(`!document.getElementById("song").hidden`);
  check("the panel starts closed", !(await page.isVisible(`[data-key="captions.start"]`)));
  await page.click("#script summary");
  const field = (key: string) => `#script-fields [data-key="${key}"]`;
  await page.waitForFunction(`!document.querySelector('${field("captions.start")}').disabled`, null, { timeout: 5000 });
  check("the panel shows the script", (await page.inputValue(field("opening.takes"))) === "1" && (await page.inputValue(field("captions.start"))) === defaultScript().captions.start);
  check("lines under takes not shown are greyed", await page.isDisabled(field("opening.lines.1")));
  await page.fill(field("captions.start"), "Every square here is one held note.");
  await page.press(field("captions.start"), "Tab");
  await page.fill(field("accent"), "#3fa7ff");
  await page.waitForFunction(`document.getElementById("script-status").textContent === "Saved"`, null, { timeout: 5000 });
  let saved = await onDisk();
  check("the caption and colour are in script.json", saved.captions.start === "Every square here is one held note." && saved.accent === "#3fa7ff", JSON.stringify({ start: saved.captions.start, accent: saved.accent }));
  check("opening.ids is kept", JSON.stringify(saved.opening.ids) === `["sung-50"]`, JSON.stringify(saved.opening));
  check("unchanged lines stay as they were", JSON.stringify(saved.title) === JSON.stringify(defaultScript().title) && JSON.stringify(saved.end) === JSON.stringify(defaultScript().end));
  // the page scrolls inside itself, so a tall window shows the whole panel
  await page.setViewportSize({ width: 1280, height: 2300 });
  await shot(page, "2-words-open.png");
  await page.setViewportSize({ width: 390, height: 3200 });
  await shot(page, "2-words-narrow.png");
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.reload();
  await page.waitForFunction(`!document.getElementById("song").hidden`);
  await page.click("#script summary");
  await page.waitForFunction(`document.querySelector('${field("captions.start")}').value === "Every square here is one held note."`, null, { timeout: 5000 });
  check("after a reload the fields show what was saved", (await page.inputValue(field("accent"))) === "#3fa7ff");
  await page.click("#script-reset");
  await page.click("#script-reset");
  await page.waitForFunction(`document.getElementById("script-status").textContent === "Back to the defaults"`, null, { timeout: 5000 });
  saved = await onDisk();
  check("Back to the defaults writes the defaults", JSON.stringify(saved) === JSON.stringify(defaultScript()), JSON.stringify(saved));
  check("and the fields show them", (await page.inputValue(field("captions.start"))) === defaultScript().captions.start && (await page.inputValue(field("accent"))) === defaultScript().accent);
  const bad = await fetch(scriptUrl, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ accent: "red" }) });
  const badSays = ((await bad.json()) as { error?: string }).error ?? "";
  check("a bad script is refused with the reason", bad.status === 400 && badSays.includes("accent must be a colour"), `${bad.status} ${badSays}`);
  check("and the file is untouched", JSON.stringify(await onDisk()) === JSON.stringify(defaultScript()));
  const foreignPut = await fetch(scriptUrl, { method: "PUT", headers: { "content-type": "application/json", origin: "http://elsewhere.example" }, body: "{}" });
  check("another site's page can't change the script", foreignPut.status === 403, String(foreignPut.status));

  // ---- 3. make: the pipeline refuses a 5 s song, and the page says why
  await page.click("#to-make");
  await page.waitForFunction(`!document.getElementById("make").hidden && document.getElementById("summary").textContent.includes("Short Test Song.wav")`, null, { timeout: 10000 });
  const summary = await page.textContent("#summary");
  check("the summary shows the take", !!summary?.includes("1 sung (D3 to D3)"), summary ?? "");
  await page.click("#go");
  await page.waitForFunction(`!document.getElementById("error").hidden`, null, { timeout: 30000 });
  const error = await page.textContent("#error");
  check("the pipeline's error is shown", !!error && /15/.test(error), error ?? "");
  check("the Make button is ready again", !(await page.isDisabled("#go")));
  await shot(page, "3-make-error.png");

  if (process.env.FULL) {
    await page.click(`nav button[data-step="song"]`);
    await page.setInputFiles("#file", long);
    await page.waitForFunction(`document.getElementById("drop-main").textContent === "Long Test Song.wav"`, null, { timeout: 10000 });
    await page.click("#to-make");
    await page.click("#go");
    await page.waitForFunction(`!document.getElementById("progress").hidden`, null, { timeout: 10000 });
    await page.waitForTimeout(1500);
    await shot(page, "3-make-progress.png");
    await page.waitForFunction(`!document.getElementById("film").hidden || !document.getElementById("error").hidden`, null, { timeout: 15 * 60000 });
    const made = !(await page.isHidden("#film"));
    check("a film was made", made, made ? "" : ((await page.textContent("#error")) ?? ""));
    if (made) {
      await page.waitForFunction(`document.getElementById("video").readyState >= 1`, null, { timeout: 20000 });
      const r = await fetch(`${BASE}/api/projects/${PROJECT}/film.mp4`, { headers: { range: "bytes=0-99" } });
      const notes = await page.$$eval("#notes li", (li) => li.map((l) => l.textContent));
      check("the pipeline's notes are listed", notes.length > 0, notes.join(" | "));
      check("there is a download link", (await page.getAttribute("#download", "download")) === "Long Test Song.mp4");
      check("the film is served in ranges", r.status === 206 && (await r.arrayBuffer()).byteLength === 100, String(r.status));
      await page.evaluate(`document.getElementById("video").currentTime = 3`);
      await page.waitForTimeout(1000);
      await shot(page, "3-make-film.png");
    }
  }
} catch (err) {
  check("the run finished", false, err instanceof Error ? err.message : String(err));
} finally {
  await browser.close();
  server.kill();
  await rm(DIR, { recursive: true, force: true });
  await rm(tmp, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : "all good");
process.exit(failures ? 1 : 0);
