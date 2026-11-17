/**
 * The film, captured: the film page is served from here, opened in a headless browser, and every frame
 * is drawn in order and piped to ffmpeg with the sound.
 * Needs a Chromium-family browser installed (Chrome, Edge or Chromium) and ffmpeg with libx264 and aac.
 */
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";

const PAGE = `<!doctype html><meta charset="utf-8"><title>film</title><div id="root"></div><script type="module" src="film.js"></script>`;

async function open(): Promise<Browser> {
  const args = ["--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"];
  let last: unknown;
  // the installed browser, not a downloaded one: nothing extra to fetch
  for (const channel of ["chrome", "msedge", "chromium"]) {
    try {
      return await chromium.launch({ channel, headless: true, args });
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`no browser to draw the film in: install Google Chrome, Microsoft Edge or Chromium (${(last as Error).message.split("\n")[0]})`);
}

/**
 * Draw the film whose data is in `dir` (wall.json and what it names) and write it to `out` with `sound`.
 * `still` instead writes one frame, at that many seconds, as a PNG.
 */
export async function capture(dir: string, sound: string, out: string, on: (done: number, of: number) => void = () => {}, still?: number): Promise<void> {
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, "film/wall.ts")], target: "browser", minify: true });
  if (!built.success) throw new Error(`the film page did not build: ${built.logs.join("; ")}`);
  const script = await built.outputs[0].text();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      if (path === "/") return new Response(PAGE, { headers: { "content-type": "text/html" } });
      if (path === "/film.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
      if (path.startsWith("/data/") && !path.includes("..")) {
        const file = Bun.file(join(dir, path.slice(6)));
        if (await file.exists()) return new Response(file);
      }
      return new Response("not found", { status: 404 });
    },
  });
  const browser = await open();
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const said: string[] = [];
    page.on("pageerror", (e) => said.push(e.message));
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForFunction("window.film || document.getElementById('root')?.textContent?.includes('could not load')", undefined, { timeout: 120000 });
    const film = (await page.evaluate("window.film && { frames: film.frames, fps: film.fps, width: film.width, height: film.height }")) as { frames: number; fps: number; width: number; height: number } | null;
    if (!film) throw new Error(`${await page.textContent("#root")} ${said.join("; ")}`);
    await page.setViewportSize({ width: film.width, height: film.height });
    if (still !== undefined) {
      await page.evaluate(`film.draw(${Math.min(film.frames - 1, Math.round(still * film.fps))})`);
      await page.locator("#film").screenshot({ path: out });
      return;
    }
    const ff = Bun.spawn(
      ["ffmpeg", "-v", "error", "-y", "-f", "image2pipe", "-c:v", "mjpeg", "-r", String(film.fps), "-i", "-", "-i", sound, "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-crf", "17", "-preset", "medium",
        "-g", String(film.fps * 2), "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-shortest", "-movflags", "+faststart", out],
      { stdin: "pipe", stdout: "ignore", stderr: "pipe" },
    );
    // each frame comes back from the page as a JPEG: much quicker than a screenshot, and at this quality
    // the difference is gone once the film is encoded
    const shot = `(i) => { film.draw(i); return document.getElementById("film").toDataURL("image/jpeg", 0.95).slice(23); }`;
    for (let i = 0; i < film.frames; i++) {
      const jpeg = Buffer.from((await page.evaluate(`(${shot})(${i})`)) as string, "base64");
      ff.stdin.write(jpeg);
      if (i % 15 === 0) {
        await ff.stdin.flush();
        on(i, film.frames);
      }
    }
    await ff.stdin.end();
    const [code, err] = await Promise.all([ff.exited, new Response(ff.stderr).text()]);
    if (code !== 0) throw new Error(`the film could not be encoded: ${err.trim().split("\n").pop()}`);
  } finally {
    await browser.close();
    server.stop(true);
  }
}
