/**
 * The "Words and look" panel in the Song step: every line on the film and its two colours, kept in
 * <project>/script.json (see src/script.ts for what each one is). It saves itself as the person
 * types, a moment after they stop, and at once when they leave a field.
 */
import type { Script } from "../src/script.ts";

type Field = HTMLInputElement | HTMLSelectElement;

export function scriptPanel(api: string, $: (id: string) => HTMLElement) {
  const box = $("script-fields"), state = $("script-status"), reset = $("script-reset") as HTMLButtonElement;
  const fields = new Map<string, Field>();

  // ---- the fields, built from a short list rather than written out in the page
  const group = (title: string, when: string, inline = false) => {
    const h = document.createElement("h3"), p = document.createElement("p"), grid = document.createElement("div");
    h.textContent = title;
    p.className = "when";
    p.textContent = when;
    grid.className = inline ? "fields inline" : "fields";
    box.append(h, p, grid);
    return grid;
  };
  const label = (into: HTMLElement, text: string, el: HTMLElement, wide = true) => {
    const l = document.createElement("label");
    if (wide) l.className = "wide";
    l.append(text, el);
    into.append(l);
  };
  const line = (into: HTMLElement, key: string, text: string, wide = true) => {
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 200;
    input.autocomplete = "off";
    input.dataset.key = key;
    fields.set(key, input);
    label(into, text, input, wide);
  };

  let g = group("First frame", "What a feed shows before the film plays: a big line, then smaller ones.", true);
  ["Big line", "Second line", "Third line"].forEach((t, i) => line(g, `title.${i}`, t));

  g = group("Before the song", "A few takes are shown whole, as they were recorded, before the wall.", true);
  const takes = document.createElement("select");
  takes.dataset.key = "opening.takes";
  for (const [v, t] of [["0", "None: start straight on the wall"], ["1", "1 take"], ["2", "2 takes"], ["3", "3 takes"]]) takes.append(new Option(t, v));
  fields.set("opening.takes", takes);
  label(g, "How many takes", takes);
  [1, 2, 3].forEach((n) => line(g, `opening.lines.${n - 1}`, `Under take ${n}`));

  g = group("Captions", "Each shows once, under the wall.");
  line(g, "captions.start", "As the song starts, one voice at a time");
  line(g, "captions.words", "A few seconds in, once the words can be heard");
  line(g, "captions.band", "Just before each instrument is heard alone (only when the song is split)");
  line(g, "captions.keys", "As the wall unfolds into a keyboard and the notes fall onto it");
  line(g, "captions.after", "After the keyboard, back on the wall");
  line(g, "solo", "Under the wall while one instrument is heard alone");

  g = group("Last frames", "The end card: a big line, then smaller ones.", true);
  ["Big line", "Second line", "Third line", "Fourth line"].forEach((t, i) => line(g, `end.${i}`, t));

  g = group("Colours", "Dark or light backgrounds both work: the lettering turns to suit.");
  for (const [key, text] of [["accent", "Accent: the vocals (or everything, when the song isn't split) and the end card"], ["background", "Background: what the wall stands on"]]) {
    const wrap = document.createElement("span"), input = document.createElement("input"), code = document.createElement("code");
    wrap.className = "colour";
    input.type = "color";
    input.dataset.key = key;
    input.addEventListener("input", () => (code.textContent = input.value));
    wrap.append(input, code);
    fields.set(key, input);
    label(g, text, wrap, false);
  }

  // ---- between the fields and a script
  /** opening.ids is for the command line and agents: never shown, always kept */
  let ids: string[] = [];
  const v = (key: string) => fields.get(key)!.value;
  /** empty lines at the end say nothing, so they are not kept (and the defaults stay the defaults) */
  const lines = (prefix: string, n: number) => {
    const out = Array.from({ length: n }, (_, i) => v(`${prefix}.${i}`));
    while (out.length && out[out.length - 1] === "") out.pop();
    return out;
  };
  const collect = (): Script => ({
    title: lines("title", 3),
    opening: { takes: Number(v("opening.takes")), ids, lines: Array.from({ length: 3 }, (_, i) => v(`opening.lines.${i}`)) },
    captions: { start: v("captions.start"), words: v("captions.words"), band: v("captions.band"), keys: v("captions.keys"), after: v("captions.after") },
    solo: v("solo"),
    end: lines("end", 4),
    accent: v("accent"),
    background: v("background"),
  });
  const set = (key: string, value: string | number) => {
    const f = fields.get(key)!;
    f.value = String(value);
    // the colour's code beside it (set here, not by an input event, which would count as an edit)
    if (f instanceof HTMLInputElement && f.type === "color" && f.nextElementSibling) f.nextElementSibling.textContent = f.value;
  };
  /** the lines under takes that won't be shown are greyed, but kept */
  const shown = () => [0, 1, 2].forEach((i) => (fields.get(`opening.lines.${i}`)!.disabled = !usable || i >= Number(v("opening.takes"))));
  const fill = (s: Script) => {
    s.title.slice(0, 3).forEach((l, i) => set(`title.${i}`, l));
    for (let i = s.title.length; i < 3; i++) set(`title.${i}`, "");
    set("opening.takes", s.opening.takes);
    for (let i = 0; i < 3; i++) set(`opening.lines.${i}`, s.opening.lines[i] ?? "");
    for (const k of ["start", "words", "band", "keys", "after"] as const) set(`captions.${k}`, s.captions[k]);
    set("solo", s.solo);
    for (let i = 0; i < 4; i++) set(`end.${i}`, s.end[i] ?? "");
    set("accent", s.accent);
    set("background", s.background);
    ids = s.opening.ids;
    shown();
  };
  const say = (text: string, tone: "" | "good" | "bad" = "") => {
    state.textContent = text;
    state.className = `saved ${tone}`;
  };
  /** the fields can be used: off until the project's script has been read, so a broken file isn't written over by blanks */
  let usable = false;
  const use = (yes: boolean) => {
    usable = yes;
    for (const f of fields.values()) f.disabled = !yes;
    shown();
  };
  use(false);

  // ---- saving: a moment after typing stops, at once on leaving a field; the last answer wins
  let timer: ReturnType<typeof setTimeout> | null = null, sent = 0, inFlight = 0;
  async function save() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!usable) return;
    const mine = ++sent;
    inFlight++;
    say("Saving...");
    try {
      const r = await fetch(`${api}/script`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(collect()) });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (mine === sent) r.ok ? say("Saved", "good") : say(`Not saved: ${j.error ?? r.statusText}`, "bad");
    } catch {
      if (mine === sent) say("Not saved: the app isn't answering. Is it still running?", "bad");
    } finally {
      inFlight--;
    }
  }
  for (const f of fields.values()) {
    f.addEventListener("input", () => {
      if (f === fields.get("opening.takes")) shown();
      if (timer) clearTimeout(timer);
      timer = setTimeout(save, 600);
      say("Not saved yet");
    });
    f.addEventListener("change", () => void save());
  }

  // ---- back to the defaults: asked twice, since it throws away the person's words
  let sure: ReturnType<typeof setTimeout> | null = null;
  reset.addEventListener("click", async () => {
    if (!sure) {
      reset.textContent = "Sure? Click again to reset every line";
      reset.classList.add("sure");
      sure = setTimeout(() => {
        sure = null;
        reset.textContent = "Back to the defaults";
        reset.classList.remove("sure");
      }, 4000);
      return;
    }
    clearTimeout(sure);
    sure = null;
    reset.textContent = "Back to the defaults";
    reset.classList.remove("sure");
    if (timer) clearTimeout(timer);
    timer = null;
    const mine = ++sent;
    try {
      const r = await fetch(`${api}/script`, { method: "DELETE" });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.statusText);
      const s = (await r.json()) as Script;
      if (mine !== sent) return;
      use(true);
      fill(s);
      say("Back to the defaults", "good");
    } catch (err) {
      if (mine === sent) say(`Not reset: ${err instanceof Error ? err.message : "the app isn't answering"}`, "bad");
    }
  });

  return {
    /** read the project's script into the fields, unless the person has changes on the way */
    async load() {
      if (timer || inFlight) return;
      try {
        const r = await fetch(`${api}/script`);
        const j = (await r.json().catch(() => ({}))) as Script & { error?: string };
        if (!r.ok) {
          use(false);
          return say(`${j.error ?? r.statusText}. "Back to the defaults" starts it afresh.`, "bad");
        }
        if (timer || inFlight) return;
        use(true);
        fill(j);
        if (state.classList.contains("bad")) say("");
      } catch {
        use(false);
        say("Couldn't read the words: the app isn't answering.", "bad");
      }
    },
    /** leaving the step: what was typed is saved now, not in a moment */
    flush() {
      if (timer) void save();
    },
  };
}
