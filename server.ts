/**
 * The app's local server: the page, and a small API that keeps each project's takes, song and
 * film in a folder under projects/, and runs the pipeline (src/make.ts) one job at a time.
 *
 *   bun server.ts            http://127.0.0.1:4173   (PORT=… to change it)
 *   DEV=1 bun server.ts      the page is bundled again on every load
 */
import { copyFile, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { make, stemsAvailable, type MakeOptions, type Progress } from "./src/make.ts";
import { checkScript, defaultScript, readScript, writeScript } from "./src/script.ts";
import type { JobView, MakeRequest, ProjectView, TakesFile } from "./web/api.ts";

const ROOT = import.meta.dir;
const PROJECTS = join(ROOT, "projects");
const PORT = Number(process.env.PORT ?? 4173);
const HOST = "127.0.0.1";
const DEV = process.env.DEV === "1";

const PROJECT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const TAKE = /^(sung|whistle)-\d+\.webm$/;
const ID = /^(sung|whistle)-\d+$/;

// ---- the page: an HTML shell and one bundled script

async function bundle(): Promise<string> {
  try {
    const out = await Bun.build({ entrypoints: [join(ROOT, "web/main.ts")], target: "browser", minify: !DEV, sourcemap: DEV ? "inline" : "none" });
    if (!out.success) throw new AggregateError(out.logs, "the page did not build");
    return await out.outputs[0].text();
  } catch (err) {
    // shown in the page rather than only in the terminal, so a broken edit is obvious
    const why = err instanceof AggregateError ? err.errors.map(String).join("\n") : String(err);
    console.error(why);
    return `document.body.textContent = ${JSON.stringify(`The page did not build:\n${why}`)}; document.body.style.whiteSpace = "pre-wrap";`;
  }
}
const shell = () => Bun.file(join(ROOT, "web/index.html")).text();
let built = { js: await bundle(), html: await shell() };

// ---- projects

/** a project's folder, or null for a name that could reach outside projects/ */
function folder(name: string): string | null {
  return PROJECT.test(name) ? join(PROJECTS, name) : null;
}
/** `file` in `dir`, only if it really is in it */
function within(dir: string, file: string): string | null {
  const path = resolve(dir, file);
  return path.startsWith(resolve(dir) + sep) ? path : null;
}
/** written whole or not at all: a half-written takes.json would lose a session */
async function writeWhole(path: string, data: Blob | string) {
  const part = `${path}.part-${crypto.randomUUID().slice(0, 8)}`;
  await Bun.write(part, data);
  await rename(part, path);
}
const exists = (path: string) => stat(path).then((s) => s.isFile(), () => false);

/** the song as uploaded: its own name, and the file it is kept in */
async function songOf(dir: string): Promise<ProjectView["song"]> {
  try {
    const meta = (await Bun.file(join(dir, "song.json")).json()) as { name: string; file: string };
    const path = within(dir, meta.file);
    if (!path) return null;
    return { name: meta.name, file: meta.file, bytes: (await stat(path)).size };
  } catch {
    return null;
  }
}

async function view(name: string, dir: string): Promise<ProjectView> {
  const takesDir = join(dir, "takes");
  const files = (await readdir(takesDir).catch(() => [] as string[])).filter((f) => TAKE.test(f)).sort();
  let takes: TakesFile | null = null, unreadable = false;
  const raw = await Bun.file(join(takesDir, "takes.json")).text().catch(() => null);
  if (raw !== null) {
    try {
      takes = JSON.parse(raw) as TakesFile;
    } catch {
      unreadable = true;
    }
  }
  const film = await stat(join(dir, "film.mp4")).then((s) => ({ bytes: s.size, modified: s.mtimeMs }), () => null);
  return { name, takes, unreadable, files, song: await songOf(dir), film, stems: await stemsAvailable().catch(() => false), job: job?.project === name ? job : null };
}

/** null if `j` is a takes.json the pipeline can read, otherwise what is wrong with it */
function badTakes(j: unknown): string | null {
  if (!j || typeof j !== "object") return "takes.json must be an object";
  const { takes, skipped } = j as Partial<TakesFile>;
  if (!takes || typeof takes !== "object" || Array.isArray(takes)) return "takes must be an object";
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  for (const [id, t] of Object.entries(takes)) {
    if (!ID.test(id)) return `bad take id ${id}`;
    if (!t || typeof t !== "object") return `take ${id} must be an object`;
    if (t.file !== `${id}.webm`) return `take ${id} must be in ${id}.webm`;
    if (![t.from, t.to, t.hz, t.cents].every(num)) return `take ${id} needs numbers from, to, hz, cents`;
    if ((t.rms !== undefined && !num(t.rms)) || (t.peak !== undefined && !num(t.peak))) return `take ${id}: rms and peak must be numbers`;
    if (t.rest !== undefined && !(Array.isArray(t.rest) && t.rest.length === 2 && t.rest.every(num))) return `take ${id}: rest must be [a, b]`;
  }
  if (!Array.isArray(skipped) || !skipped.every((s) => typeof s === "string" && ID.test(s))) return "skipped must be a list of take ids";
  return null;
}

// ---- the make: one at a time, followed by server-sent events

let job: JobView | null = null;
const followers = new Set<(j: JobView | null) => void>();
let pending: ReturnType<typeof setTimeout> | null = null;
/** progress can come thick and fast: followers hear at most ten times a second, and always the last */
function publish(now = false) {
  const send = () => {
    pending = null;
    for (const f of followers) f(job);
  };
  if (now) {
    if (pending) clearTimeout(pending);
    return send();
  }
  pending ??= setTimeout(send, 100);
}

async function start(name: string, dir: string, body: MakeRequest): Promise<Response> {
  if (job?.state === "running") return json({ error: `A film is already being made (project ${job.project}). One at a time.` }, 409);
  const song = await songOf(dir);
  if (!song) return json({ error: "Give it a song first." }, 400);
  if (!(await exists(join(dir, "takes", "takes.json")))) return json({ error: "Record some notes first." }, 400);
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return json({ error: "The film needs a title." }, 400);
  const startAt = body.start ?? 0, length = body.length ?? 90;
  if (!Number.isFinite(startAt) || startAt < 0) return json({ error: "Start must be 0 or more seconds." }, 400);
  if (!Number.isFinite(length) || length <= 0) return json({ error: "Length must be more than 0 seconds." }, 400);
  if (body.stems && !(await stemsAvailable().catch(() => false))) return json({ error: "Splitting into instruments needs uv or demucs on the PATH." }, 400);
  const options: MakeOptions = {
    project: dir,
    song: join(dir, song.file),
    title,
    credit: typeof body.credit === "string" && body.credit.trim() ? body.credit.trim() : undefined,
    start: startAt,
    length,
    stems: !!body.stems,
    reach: !!body.reach,
  };
  const running: JobView = { project: name, state: "running", progress: null, started: Date.now() };
  job = running;
  publish(true);
  console.log(`make: ${name} "${title}"`);
  const onProgress = (p: Progress) => {
    if (job !== running) return;
    running.progress = { step: p.step, detail: p.detail, fraction: p.fraction };
    publish();
  };
  // a promise first, so a make that throws at once is caught the same way as one that fails later
  Promise.resolve()
    .then(() => make(options, onProgress))
    .then(
      (made) => Object.assign(running, { state: "done", notes: made.notes, finished: Date.now() }),
      (err: unknown) => Object.assign(running, { state: "failed", error: err instanceof Error ? err.message : String(err), finished: Date.now() }),
    )
    .then(() => {
      console.log(`make: ${name} ${running.state}${running.error ? `: ${running.error}` : ""}`);
      publish(true);
    });
  return json({ ok: true }, 202);
}

function follow(req: Request): Response {
  const enc = new TextEncoder();
  let stop = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const send = (j: JobView | null) => c.enqueue(enc.encode(`data: ${JSON.stringify(j)}\n\n`));
      send(job);
      followers.add(send);
      // a comment now and then keeps the connection from being closed as idle
      const ping = setInterval(() => c.enqueue(enc.encode(": ping\n\n")), 15000);
      stop = () => {
        followers.delete(send);
        clearInterval(ping);
        try {
          c.close();
        } catch {
          // already closed
        }
      };
      req.signal.addEventListener("abort", () => stop());
    },
    cancel: () => stop(),
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

// ---- answers

const json = (j: unknown, status = 200) => Response.json(j, { status, headers: { "cache-control": "no-store" } });
const fail = (status: number, error: string) => json({ error }, status);

/** a file, with byte ranges, so a video can seek */
async function sendFile(req: Request, path: string, type: string): Promise<Response> {
  const s = await stat(path).catch(() => null);
  if (!s?.isFile()) return fail(404, "not found");
  const file = Bun.file(path), size = s.size;
  const headers = { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-cache", "last-modified": new Date(s.mtimeMs).toUTCString() };
  const range = req.headers.get("range");
  if (!range) return new Response(file, { headers });
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let from = 0, to = size - 1;
  if (m && m[1] === "" && m[2] !== "") from = Math.max(0, size - Number(m[2])); // the last n bytes
  else if (m && m[1] !== "") [from, to] = [Number(m[1]), m[2] === "" ? size - 1 : Math.min(size - 1, Number(m[2]))];
  if (!m || from > to || from >= size) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } });
  return new Response(file.slice(from, to + 1), { status: 206, headers: { ...headers, "content-range": `bytes ${from}-${to}/${size}` } });
}

/** the page and API are for this machine only: refuse other hosts (DNS rebinding) and other sites' pages */
function foreign(req: Request): boolean {
  const ok = [`${HOST}:${PORT}`, `localhost:${PORT}`];
  const host = req.headers.get("host");
  if (host && !ok.includes(host)) return true;
  const origin = req.headers.get("origin");
  return req.method !== "GET" && req.method !== "HEAD" && origin !== null && !ok.some((o) => origin === `http://${o}`);
}

async function handle(req: Request): Promise<Response> {
  if (foreign(req)) return fail(403, "this app only answers its own page");
  const url = new URL(req.url), path = url.pathname, method = req.method === "HEAD" ? "GET" : req.method;

  if (path === "/" && method === "GET") {
    if (DEV) built.html = await shell();
    return new Response(built.html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  }
  if (path === "/app.js" && method === "GET") {
    if (DEV) built.js = await bundle();
    return new Response(built.js, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" } });
  }
  if (path === "/api/make" && method === "GET") return json(job);
  if (path === "/api/make/events" && method === "GET") return follow(req);

  const m = /^\/api\/projects\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (!m) return fail(404, "not found");
  const name = decodeURIComponent(m[1]), rest = m[2] ?? "", dir = folder(name);
  if (!dir) return fail(400, "a project name is letters, digits, - and _");
  const takesDir = join(dir, "takes");

  if (rest === "" && method === "GET") return json(await view(name, dir));

  const t = /^takes\/([^/]+)$/.exec(rest);
  if (t) {
    const file = t[1];
    if (file !== "takes.json" && !TAKE.test(file)) return fail(400, "a take is <sung|whistle>-<midi>.webm");
    const target = within(takesDir, file);
    if (!target) return fail(400, "bad file name");
    if (method === "GET") return sendFile(req, target, file.endsWith(".json") ? "application/json" : "video/webm");
    if (method !== "PUT") return fail(405, "GET or PUT");
    await mkdir(takesDir, { recursive: true });
    if (file === "takes.json") {
      const text = await req.text();
      if (text.length > 4_000_000) return fail(413, "takes.json is too big");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return fail(400, "takes.json must be JSON");
      }
      const bad = badTakes(parsed);
      if (bad) return fail(400, bad);
      // one that could not be read is kept aside, not written over
      const old = await Bun.file(target).text().catch(() => null);
      if (old !== null) {
        try {
          JSON.parse(old);
        } catch {
          await copyFile(target, join(takesDir, `takes-unreadable-${Date.now()}.json`));
        }
      }
      await writeWhole(target, text);
      return json({ ok: true });
    }
    const blob = await req.blob();
    if (!blob.size) return fail(400, "the take is empty");
    await writeWhole(target, blob);
    console.log(`take: ${name}/${file} ${(blob.size / 1e6).toFixed(2)} MB`);
    return json({ ok: true, bytes: blob.size });
  }

  if (rest === "song" && method === "PUT") {
    const given = (url.searchParams.get("name") ?? "song").slice(0, 200);
    let ext = extname(given).toLowerCase();
    // the extension only helps a person see what it is; ffmpeg reads the file itself
    if (!/^\.[a-z0-9]{1,8}$/.test(ext) || ext === ".json") ext = ".audio";
    const blob = await req.blob();
    if (!blob.size) return fail(400, "the song is empty");
    await mkdir(dir, { recursive: true });
    const file = `song${ext}`;
    await writeWhole(join(dir, file), blob);
    // a song given earlier in another format goes, so there is only ever one
    for (const f of await readdir(dir)) if (f.startsWith("song.") && f !== file && f !== "song.json") await unlink(join(dir, f)).catch(() => {});
    await writeWhole(join(dir, "song.json"), JSON.stringify({ name: given, file }));
    console.log(`song: ${name}/${file} (${given}) ${(blob.size / 1e6).toFixed(2)} MB`);
    return json({ name: given, file, bytes: blob.size });
  }

  if (rest === "make" && method === "POST") {
    if (!req.headers.get("content-type")?.startsWith("application/json")) return fail(415, "send JSON");
    let body: MakeRequest;
    try {
      body = (await req.json()) as MakeRequest;
    } catch {
      return fail(400, "send JSON");
    }
    return start(name, dir, body ?? ({} as MakeRequest));
  }

  if (rest === "script") {
    // the words on the film and its two colours; readScript writes the defaults the first time
    const said = (err: unknown) => (err instanceof Error ? err.message : String(err));
    if (method === "GET") {
      await mkdir(dir, { recursive: true });
      // a script.json broken by hand is the person's to fix (or to reset): say what is wrong with it
      return readScript(dir).then((s) => json(s), (err) => fail(422, said(err)));
    }
    if (method === "PUT") {
      const text = await req.text();
      if (text.length > 64_000) return fail(413, "the script is too big");
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return fail(400, "the script must be JSON");
      }
      let script;
      try {
        script = checkScript(raw);
      } catch (err) {
        return fail(400, said(err));
      }
      await mkdir(dir, { recursive: true });
      await writeScript(dir, script);
      return json(script);
    }
    if (method === "DELETE") {
      await mkdir(dir, { recursive: true });
      await writeScript(dir, defaultScript());
      return json(defaultScript());
    }
    return fail(405, "GET, PUT or DELETE");
  }

  if (rest === "film.mp4" && method === "GET") return sendFile(req, join(dir, "film.mp4"), "video/mp4");

  return fail(404, "not found");
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  // a take or a song arrives whole; songs can be long
  maxRequestBodySize: 2 * 1024 ** 3,
  idleTimeout: 60,
  fetch: handle,
  error(err) {
    console.error(err);
    return fail(500, err instanceof Error ? err.message : String(err));
  },
});
console.log(`choir of one: ${server.url}${DEV ? " (DEV: the page is rebuilt on every load)" : ""}`);
