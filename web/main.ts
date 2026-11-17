/**
 * The app: three steps on one page. Record (the recorder, web/record.ts), Song (give it an
 * audio file and a few choices), Make (run the pipeline on the server and watch the film).
 *
 * `?project=name` picks the project (default "default"); `#record`, `#song`, `#make` the step.
 * The recorder's own URL settings (`nosetup`, `from`, ...) are read by it.
 */
import type { JobView, MakeRequest, ProjectView } from "./api.ts";
import { C, FACE } from "./look.ts";
import { Left, name, record } from "./record.ts";
import { scriptPanel } from "./script.ts";

const project = new URLSearchParams(location.search).get("project") || "default";
const api = `/api/projects/${encodeURIComponent(project)}`;
for (const [k, v] of Object.entries(C)) document.documentElement.style.setProperty(`--${k}`, v);
document.documentElement.style.setProperty("--face", FACE);

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
$("project").textContent = project === "default" ? "" : project;

/** the project as the server has it, fetched again whenever a step needs it */
let latest: ProjectView | null = null;
async function refresh(): Promise<ProjectView | null> {
  try {
    const r = await fetch(api);
    if (r.ok) latest = (await r.json()) as ProjectView;
  } catch {
    // the steps say what is missing; a server that is down shows as nothing known
  }
  return latest;
}

// ---- the steps

type Step = "record" | "song" | "make";
const STEPS: Step[] = ["record", "song", "make"];
let recording: AbortController | null = null;

function show(step: Step) {
  // leaving the recorder lets the camera and microphone go; coming back starts it again
  if (step !== "song") words.flush();
  if (step !== "record" && recording) {
    recording.abort();
    recording = null;
  }
  for (const s of STEPS) $(s).hidden = s !== step;
  for (const b of document.querySelectorAll<HTMLButtonElement>("nav button")) {
    if (b.dataset.step === step) b.setAttribute("aria-current", "step");
    else b.removeAttribute("aria-current");
  }
  if (location.hash !== `#${step}`) history.replaceState(null, "", `${location.pathname}${location.search}#${step}`);
  // a button left focused would be pressed again by the recorder's Enter and Space
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  if (step === "record" && !recording) startRecorder();
  if (step === "song") void songStep();
  if (step === "make") void makeStep();
}
for (const b of document.querySelectorAll<HTMLButtonElement>("nav button")) b.addEventListener("click", () => show(b.dataset.step as Step));
window.addEventListener("hashchange", () => {
  const s = location.hash.slice(1) as Step;
  if (STEPS.includes(s)) show(s);
});

function startRecorder() {
  const ac = new AbortController(), root = $("record");
  recording = ac;
  record(root, { project, signal: ac.signal, next: () => show("song") }).catch((err: unknown) => {
    if (ac.signal.aborted || err instanceof Left) return;
    console.error(err);
    const box = document.createElement("div");
    box.className = "page";
    box.innerHTML = `<h1>The recorder stopped</h1><p class="error"></p><div class="actions"><button type="button" class="main">Start it again</button></div>`;
    box.querySelector(".error")!.textContent = err instanceof Error ? err.message : String(err);
    box.querySelector("button")!.addEventListener("click", () => {
      recording = null;
      show("record");
    });
    root.replaceChildren(box);
  });
}

// ---- 2. the song

/** the words on the film and its colours: the panel at the foot of the step */
const words = scriptPanel(api, $);

interface SongForm {
  title: string;
  credit: string;
  start: number;
  length: number;
  stems: boolean;
  reach: boolean;
  /** the title was made from the file name, so a new file may replace it */
  auto: boolean;
}
const FORM_KEY = `choir-of-one:song:${project}`;
function readForm(): SongForm {
  const d: SongForm = { title: "", credit: "", start: 0, length: 90, stems: false, reach: false, auto: true };
  try {
    return { ...d, ...(JSON.parse(localStorage.getItem(FORM_KEY) ?? "{}") as Partial<SongForm>) };
  } catch {
    return d;
  }
}
function writeForm(f: SongForm) {
  try {
    localStorage.setItem(FORM_KEY, JSON.stringify(f));
  } catch {
    // only the convenience of remembering is lost
  }
}
const titleFrom = (file: string) => file.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;

const els = {
  drop: $("drop"),
  file: $<HTMLInputElement>("file"),
  dropMain: $("drop-main"),
  dropSub: $("drop-sub"),
  title: $<HTMLInputElement>("title"),
  credit: $<HTMLInputElement>("credit"),
  start: $<HTMLInputElement>("start"),
  length: $<HTMLInputElement>("length"),
  stems: $<HTMLInputElement>("stems"),
  reach: $<HTMLInputElement>("reach"),
};
let form = readForm();

function fillForm() {
  els.title.value = form.title;
  els.credit.value = form.credit;
  els.start.value = String(form.start);
  els.length.value = String(form.length);
  els.reach.checked = form.reach;
  const stems = latest?.stems ?? false;
  els.stems.disabled = !stems;
  els.stems.checked = stems && form.stems;
  $("stems-row").classList.toggle("off", !stems);
  $("stems-hint").hidden = stems;
}
function takeForm() {
  const num = (el: HTMLInputElement, d: number) => (el.value.trim() === "" || !Number.isFinite(Number(el.value)) ? d : Number(el.value));
  const title = els.title.value;
  form = {
    title,
    credit: els.credit.value,
    start: Math.max(0, num(els.start, 0)),
    length: Math.max(1, num(els.length, 90)),
    stems: els.stems.checked,
    reach: els.reach.checked,
    auto: form.auto && (title === form.title || title === ""),
  };
  writeForm(form);
}
for (const el of [els.title, els.credit, els.start, els.length, els.stems, els.reach]) el.addEventListener("input", () => {
  if (el === els.title) form.auto = false;
  takeForm();
});

function showSong(song: ProjectView["song"], message?: string, bad = false) {
  els.drop.classList.toggle("has", !!song && !message);
  els.dropMain.textContent = message ?? (song ? song.name : "Drop a song here, or click to choose one");
  els.dropSub.textContent = message ? "" : song ? `${mb(song.bytes)}. Click or drop another to change it.` : "mp3, wav, m4a, or anything else that plays";
  els.dropMain.style.color = bad ? C.bad : "";
}

async function songStep() {
  const v = await refresh();
  form = readForm();
  if (!form.title && v?.song) form.title = titleFrom(v.song.name);
  fillForm();
  showSong(v?.song ?? null);
  await words.load();
}

/** sends the song up, showing how far it has got (fetch can't tell how much is sent) */
function upload(file: File) {
  const xhr = new XMLHttpRequest();
  xhr.open("PUT", `${api}/song?name=${encodeURIComponent(file.name)}`);
  xhr.upload.onprogress = (e) => e.lengthComputable && showSong(null, `Uploading ${file.name}... ${Math.round((100 * e.loaded) / e.total)}%`);
  xhr.onload = async () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      if (form.auto || !form.title.trim()) {
        form.title = titleFrom(file.name);
        form.auto = true;
        writeForm(form);
        els.title.value = form.title;
      }
      const v = await refresh();
      showSong(v?.song ?? null);
    } else {
      let why = xhr.statusText;
      try {
        why = (JSON.parse(xhr.responseText) as { error: string }).error;
      } catch {
        // not JSON: the status will do
      }
      showSong(null, `That song didn't upload (${why}). Choose it again to retry.`, true);
    }
  };
  xhr.onerror = () => showSong(null, "That song didn't upload: the app isn't answering. Is it still running? Choose it again to retry.", true);
  showSong(null, `Uploading ${file.name}...`);
  xhr.send(file);
}
els.file.addEventListener("change", () => {
  const f = els.file.files?.[0];
  if (f) upload(f);
  els.file.value = "";
});
els.drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  els.drop.classList.add("over");
});
els.drop.addEventListener("dragleave", () => els.drop.classList.remove("over"));
els.drop.addEventListener("drop", (e) => {
  e.preventDefault();
  els.drop.classList.remove("over");
  const f = e.dataTransfer?.files[0];
  if (f) upload(f);
});
// a file dropped anywhere else would open it in the tab and leave the app
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());
$("to-make").addEventListener("click", () => {
  takeForm();
  show("make");
});

// ---- 3. make the film

const secs = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
let job: JobView | null = null;

/** what the takes are: how many of each, from lowest to highest */
function range(v: ProjectView | null, kind: "sung" | "whistle") {
  const midis = Object.keys(v?.takes?.takes ?? {})
    .filter((id) => id.startsWith(`${kind}-`) && v!.files.includes(`${id}.webm`))
    .map((id) => Number(id.slice(kind.length + 1)))
    .sort((a, b) => a - b);
  return { count: midis.length, text: midis.length ? `${midis.length} ${kind === "sung" ? "sung" : "whistled"} (${name(midis[0])} to ${name(midis[midis.length - 1])})` : "" };
}

function summary() {
  const v = latest, sung = range(v, "sung"), whistled = range(v, "whistle");
  const rows: [string, string, boolean?][] = [
    ["Your notes", [sung.text, whistled.text].filter(Boolean).join(", ") || "None yet: record some first", !(sung.count + whistled.count)],
    ["Song", v?.song ? v.song.name : "None yet: give it one in step 2", !v?.song],
    ["Title", form.title.trim() || "None yet: give it one in step 2", !form.title.trim()],
    ["Uses", `the song from ${secs(form.start)}, for up to ${secs(form.length)}`],
  ];
  const extras = [form.stems && v?.stems ? "split into instruments" : "", form.reach ? "notes out of reach pitch-shifted" : ""].filter(Boolean);
  if (extras.length) rows.push(["And", extras.join("; ")]);
  const dl = $("summary");
  dl.replaceChildren(
    ...rows.flatMap(([k, val, missing]) => {
      const dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = k;
      dd.textContent = val;
      if (missing) dd.className = "missing";
      return [dt, dd];
    }),
  );
  return { ready: sung.count + whistled.count > 0 && !!v?.song && !!form.title.trim() };
}

function render() {
  const { ready } = summary();
  const mine = job?.project === project ? job : null, busy = job?.state === "running";
  const go = $<HTMLButtonElement>("go");
  go.disabled = !ready || busy;
  go.textContent = mine?.state === "running" ? "Making the film..." : latest?.film || mine?.state === "done" ? "Make it again" : "Make the film";
  $("why").textContent = busy && !mine ? `Another project (${job!.project}) is being made. One at a time.` : !ready ? "Fill in what's missing above first." : "";

  $("progress").hidden = mine?.state !== "running";
  if (mine?.state === "running") {
    const p = mine.progress;
    $("p-step").textContent = p?.step ?? "Starting";
    $("p-detail").textContent = p?.detail ?? "";
    const known = typeof p?.fraction === "number";
    $("p-meter").classList.toggle("unknown", !known);
    $("p-bar").style.width = known ? `${Math.round(100 * Math.max(0, Math.min(1, p!.fraction!)))}%` : "";
  }
  $("error").hidden = mine?.state !== "failed";
  if (mine?.state === "failed") $("error").textContent = `The film couldn't be made: ${mine.error ?? "unknown error"}`;

  // the film: the one just made, or the last one made before
  const film = mine?.state === "done" || (latest?.film && mine?.state !== "running");
  $("film").hidden = !film;
  if (film) {
    const v = $<HTMLVideoElement>("video"), stamp = mine?.finished ?? latest?.film?.modified ?? 0;
    const src = `${api}/film.mp4?v=${stamp}`;
    if (v.getAttribute("src") !== src) v.src = src;
    const a = $<HTMLAnchorElement>("download");
    a.href = src;
    a.download = `${form.title.replace(/[\\/:*?"<>|]+/g, "").trim() || "film"}.mp4`;
    const notes = mine?.state === "done" ? (mine.notes ?? []) : [];
    $("notes").replaceChildren(
      ...notes.map((n) => {
        const li = document.createElement("li");
        li.textContent = n;
        return li;
      }),
    );
  }
}

async function makeStep() {
  form = readForm();
  await refresh();
  if (!form.title.trim() && latest?.song) form = { ...form, title: titleFrom(latest.song.name), auto: true };
  if (latest?.job) job = latest.job;
  render();
}

$("go").addEventListener("click", async () => {
  const go = $<HTMLButtonElement>("go");
  go.disabled = true;
  const body: MakeRequest = { title: form.title.trim(), credit: form.credit.trim() || undefined, start: form.start, length: form.length, stems: form.stems && !!latest?.stems, reach: form.reach };
  try {
    const r = await fetch(`${api}/make`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) {
      const why = ((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.statusText;
      job = { project, state: "failed", progress: null, started: Date.now(), error: why };
      render();
      return;
    }
    // the events take it from here; until the first arrives, show it as starting
    job = { project, state: "running", progress: null, started: Date.now() };
    render();
  } catch {
    job = { project, state: "failed", progress: null, started: Date.now(), error: "the app isn't answering. Is it still running?" };
    render();
  }
});
$("more").addEventListener("click", () => show("record"));
$("change-song").addEventListener("click", () => show("song"));

// the make's progress, as the server sends it; EventSource reconnects by itself if the server restarts
const events = new EventSource("/api/make/events");
events.onmessage = async (e) => {
  const was = job?.state;
  job = JSON.parse(e.data) as JobView | null;
  // a film just finished: the project's film has changed
  if (job?.project === project && job.state !== "running" && was === "running") await refresh();
  if (!$("make").hidden) render();
};

// ---- start on the step in the address, or the first
const first = location.hash.slice(1) as Step;
show(STEPS.includes(first) ? first : "record");
