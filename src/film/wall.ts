/**
 * The film: one person as a whole choir. Every pitch they recorded is a tile of their face, laid out
 * as a keyboard folded by octave (a column a note name, a row an octave, low at the bottom); a tile wakes
 * and plays its clip while its pitch sounds, edged in the colour of the instrument it is being.
 *
 * Nothing plays here and nothing runs in real time: the page is opened by src/capture.ts, which calls
 * `window.film.draw(i)` for each frame in turn and takes a picture. Every frame is drawn from its time
 * alone, so any frame can be drawn on its own.
 *
 * It reads data/wall.json, written by src/make.ts:
 *   width, height   the picture
 *   title           { hold, lines }: the first frames (what a feed shows before it plays), the wall at rest behind
 *   cold            [{ sheet, cols, frames, len, name, hz, kind, text }]: before the song, takes shown
 *                   whole and as they were recorded, one after another, `gap` apart
 *   settle          seconds for the wall to assemble after them
 *   length          the song's seconds; times below are the song's
 *   captions        [[start, end, text]]
 *   cuts            [[start, end, section, solo]]: solo 1 is that section alone (the others' notes
 *                   do not wake tiles then); solo 0 is a slow push in on the wall
 *   keys            [[start, end]]: the wall unfolds into one keyboard line and the notes fall to it
 *   end             { hold, lines }
 *   faces           the pictures: { size, fps, clips: { id: { rest, strip, frames } } }, beside faces/
 *   tiles           [{ id, midi }]: the takes on the wall
 *   voices          { midi: id }: which take sings each key (a key out of reach wakes the take that sings it)
 *   sections        [{ name, label, color, notes }], notes a file of { notes: [[on, off, midi, level]] }
 */
/** The film's lettering: whatever plain sans-serif the machine has, a little spaced. */
const font = (size: number) => `600 ${size}px "Helvetica Neue", "Inter", "Segoe UI", Arial, sans-serif`;

type Note = [on: number, off: number, midi: number, level: number];
interface Cold {
  sheet: string;
  cols: number;
  frames: number;
  len: number;
  name: string;
  hz: number;
  kind: string;
  text: string;
}
interface Wall {
  width: number;
  height: number;
  title: { hold: number; lines: string[] };
  cold: Cold[];
  gap: number;
  settle: number;
  length: number;
  captions: [number, number, string][];
  cuts: [number, number, number, number][];
  keys: [number, number][];
  end: { hold: number; lines: string[] };
  faces: Faces;
  tiles: { id: string; midi: number }[];
  voices: Record<string, string>;
  sections: { name: string; label?: string; alone?: string; color: string; notes: string }[];
}
interface Faces {
  size: number;
  fps: number;
  clips: Record<string, { rest: string; strip: string; frames: number }>;
}

const FPS = 30;
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = (x: number) => ((x = clamp(x)), x * x * (3 - 2 * x));
const mix = (a: number, b: number, k: number) => a + (b - a) * k;

export async function wall(root: HTMLElement): Promise<void> {
  const dir = "data/";
  const json = async <T>(name: string) => {
    const r = await fetch(dir + name);
    if (!r.ok) throw new Error(`${dir}${name}: ${r.status}`);
    return (await r.json()) as T;
  };
  const image = (name: string) =>
    new Promise<HTMLImageElement>((done, fail) => {
      const im = new Image();
      im.onload = () => done(im);
      im.onerror = () => fail(new Error(`${dir}${name} did not load`));
      im.src = dir + name;
    });
  const cfg = await json<Wall>("wall.json");
  const W = cfg.width, H = cfg.height;
  const faces = cfg.faces, faceDir = "faces/";
  const parts = await Promise.all(cfg.sections.map(async (s) => (await json<{ notes: Note[] }>(s.notes)).notes));
  const sheets = await Promise.all(cfg.cold.map((c) => image(c.sheet)));

  // ---- the tiles: a take each, and the notes that wake it (a pitch out of reach wakes the take that sings it)
  const order = [...cfg.tiles].sort((a, b) => a.midi - b.midi);
  const tileOf = new Map(order.map((t, i) => [t.id, i]));
  const tiles = await Promise.all(
    order.map(async (t) => {
      const c = faces.clips[t.id];
      return { ...t, rest: await image(faceDir + c.rest), strip: await image(faceDir + c.strip), frames: c.frames, notes: [] as [number, number, number, number][] };
    }),
  );
  parts.forEach((notes, si) => {
    const sorted = [...notes].map((n) => n[3]).sort((a, b) => a - b), top = sorted[Math.floor(0.9 * (sorted.length - 1))] || 1;
    for (const [on, off, midi, level] of notes) {
      const i = tileOf.get(cfg.voices[String(midi)]);
      if (i !== undefined) tiles[i].notes.push([on, off, clamp(level / top), si]);
    }
  });
  for (const t of tiles) t.notes.sort((a, b) => a[0] - b[0]);

  // ---- where a tile sits: on the wall, and in the keyboard line
  const MX = 60, TOP = 36, FOOT = 150;
  const octs = order.map((t) => Math.floor(t.midi / 12)), oct0 = Math.min(...octs), rows = Math.max(...octs) - oct0 + 1;
  const cell = Math.min((W - 2 * MX) / 12, (H - TOP - FOOT) / rows), gx = (W - 12 * cell) / 2, gy = TOP + (H - TOP - FOOT - rows * cell) / 2;
  const lineW = (W - 2 * MX) / order.length, LINE_Y = H - 96, LOOK = 2.6, FALL = (LINE_Y - 60 - TOP) / LOOK;
  const grid = order.map((t) => ({ x: gx + ((t.midi % 12) + 0.5) * cell, y: gy + (rows - 1 - (Math.floor(t.midi / 12) - oct0) + 0.5) * cell, d: cell - 8 }));
  const line = order.map((_, i) => ({ x: MX + (i + 0.5) * lineW, y: LINE_Y, d: lineW - 2 }));

  // ---- the times: the title, the takes shown whole, the wall assembling, the song, the end
  const tTitle = cfg.title.hold, coldAt: number[] = [];
  let tc = tTitle;
  for (const c of cfg.cold) {
    coldAt.push(tc);
    tc += c.len + cfg.gap;
  }
  const t0 = tc + cfg.settle, total = t0 + cfg.length + cfg.end.hold;

  const canvas = document.createElement("canvas");
  canvas.id = "film";
  canvas.width = W;
  canvas.height = H;
  canvas.style.cssText = "display:block;background:#000";
  root.replaceChildren(canvas);
  document.body.style.cssText = "margin:0;background:#000;overflow:hidden";
  const ctx = canvas.getContext("2d")!;

  function lines(text: string[], sizes: number[], y: number, color: string, band = 0.8) {
    const high = sizes.slice(0, text.length).reduce((a, b) => a + b * 1.5, 0);
    if (band > 0) {
      ctx.fillStyle = `rgba(0,0,0,${band})`;
      ctx.fillRect(0, y - high / 2 - 20, W, high + 40);
    }
    ctx.textAlign = "center";
    ctx.fillStyle = color;
    let at = y - high / 2;
    text.forEach((l, i) => {
      const size = sizes[Math.min(i, sizes.length - 1)];
      ctx.font = font(size);
      ctx.fillText(l, W / 2, at + size * 0.75);
      at += size * 1.5;
    });
    ctx.textAlign = "left";
  }

  /** Is this section heard at song time s? (Not while the film has cut to another alone.) */
  const heard = (si: number, s: number) => !cfg.cuts.some(([a, b, who, solo]) => solo && s >= a && s < b && who !== si);
  const solo = (s: number) => cfg.cuts.find(([a, b, , one]) => one && s >= a && s < b);
  /** How far the wall has unfolded into the keyboard line at song time s. */
  const unfolded = (s: number) => Math.max(0, ...cfg.keys.map(([a, b]) => Math.min(ease((s - a) / 1.2), ease((b - s) / 1.2))));
  /** How awake a tile is, as what, and for how long it has been singing. */
  function wake(ti: number, s: number) {
    let lit = 0, si = -1, since = 0;
    for (const [on, off, level, sec] of tiles[ti].notes) {
      if (on > s) break;
      if (off < s - 0.5 || !heard(sec, on)) continue;
      const l = (0.45 + 0.55 * level) * (s <= off ? Math.min(1, (s - on) / 0.04 + 0.4) : Math.exp(-(s - off) / 0.09));
      if (l > lit) [lit, si, since] = [l, sec, s - on];
    }
    return { lit, si, since };
  }

  function tile(ti: number, x: number, y: number, d: number, lit: number, si: number, since: number, alpha: number, label: boolean) {
    const t = tiles[ti], size = d * (1 + 0.14 * lit), r = size * 0.12;
    ctx.save();
    ctx.globalAlpha = alpha * mix(0.3, 1, clamp(lit * 1.6));
    ctx.beginPath();
    ctx.roundRect(x - size / 2, y - size / 2, size, size, r);
    ctx.clip();
    if (lit > 0.05) {
      const span = Math.max(1, 2 * t.frames - 2), step = Math.floor(since * faces.fps) % span, f = step < t.frames ? step : span - step;
      ctx.drawImage(t.strip, f * faces.size, 0, faces.size, faces.size, x - size / 2, y - size / 2, size, size);
    } else ctx.drawImage(t.rest, x - size / 2, y - size / 2, size, size);
    ctx.restore();
    if (lit > 0.05 && si >= 0) {
      ctx.globalAlpha = alpha * clamp(lit * 1.5);
      ctx.strokeStyle = cfg.sections[si].color;
      ctx.lineWidth = Math.max(2, size * 0.035);
      ctx.beginPath();
      ctx.roundRect(x - size / 2, y - size / 2, size, size, r);
      ctx.stroke();
    }
    if (label && d > 70) {
      ctx.globalAlpha = alpha * 0.75;
      ctx.font = font(16);
      ctx.fillStyle = "#fff";
      ctx.fillText(`${NAMES[t.midi % 12]}${Math.floor(t.midi / 12) - 1}`, x - size / 2 + 7, y + size / 2 - 8);
    }
    ctx.globalAlpha = 1;
  }

  /** The wall at song time s (before 0, all at rest), `built` of it assembled, low notes first. */
  function drawWall(s: number, built: number, rest = 0.3) {
    const k = unfolded(s);
    // a slow push in, where the film asks for a look
    const look = cfg.cuts.find(([a, b, , one]) => !one && s >= a - 0.5 && s < b + 0.5);
    let z = 1, fx = W / 2, fy = H / 2;
    if (look && k === 0) {
      const [a, b] = look, u = clamp((s - a) / (b - a));
      z = 1 + 0.75 * Math.min(ease((s - a + 0.5) / 1.5), ease((b + 0.5 - s) / 1.5));
      fx = mix(gx + 3.2 * cell, gx + 8.8 * cell, ease(u));
      fy = gy + rows * cell * mix(0.62, 0.42, u);
    }
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(z, z);
    ctx.translate(-mix(W / 2, fx, clamp((z - 1) / 0.75)), -mix(H / 2, fy, clamp((z - 1) / 0.75)));
    if (k > 0.02) {
      // the notes on their way down to the keys, in their instruments' colours
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, TOP, W, LINE_Y - 34 - TOP);
      ctx.clip();
      tiles.forEach((t, ti) => {
        for (const [on, off, level, sec] of t.notes) {
          if (on > s + LOOK) break;
          if (off < s || !heard(sec, on)) continue;
          const y1 = LINE_Y - 34 - (on - s) * FALL, y0 = LINE_Y - 34 - (off - s) * FALL;
          ctx.globalAlpha = k * (0.25 + 0.75 * level) * (on <= s ? 1 : 0.75);
          ctx.fillStyle = cfg.sections[sec].color;
          ctx.fillRect(line[ti].x - lineW / 2 + 2, y0, lineW - 4, Math.max(3, y1 - y0));
        }
      });
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    const drawn = tiles.map((_, ti) => ({ ti, ...wake(ti, s) })).sort((a, b) => a.lit - b.lit);
    for (const { ti, lit, si, since } of drawn) {
      const show = ease((built * (tiles.length + 14) - ti) / 14);
      if (show <= 0) continue;
      const g = grid[ti], l = line[ti];
      // in the line a singing tile stands up out of it, large enough to be seen
      const d = mix(g.d, l.d * (1 + 2.6 * clamp(lit * 1.4)), k), y = mix(g.y, l.y - (l.d * 2.6 * clamp(lit * 1.4)) / 2, k);
      tile(ti, mix(g.x, l.x, k), mix(g.y + (1 - show) * 40, y, k), d * mix(0.6, 1, show), lit, si, since, show * mix(1, rest / 0.3, lit > 0.05 ? 0 : 1), k < 0.3);
    }
    ctx.restore();
  }

  function legend(alpha: number) {
    ctx.font = font(20);
    let x = MX;
    for (const s of cfg.sections) {
      const name = (s.label ?? s.name).toUpperCase();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = s.color;
      ctx.fillRect(x, H - 34, 16, 16);
      ctx.fillText(name, x + 26, H - 19);
      x += 26 + ctx.measureText(name).width + 34;
    }
    ctx.globalAlpha = 1;
  }

  function draw(frame: number): number {
    const began = performance.now(), t = frame / FPS, s = t - t0;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    if (t < tTitle) {
      // the poster: everyone, waiting
      drawWall(-10, 1, 0.62);
      const [song, ...under] = cfg.title.lines;
      lines([song, ...under], [150, 44, 30], H / 2 - 10, "#fff", 0.72);
    } else if (t < t0 - cfg.settle) {
      // a take, whole, as it was recorded
      const k = coldAt.reduce((at, a, i) => (t >= a ? i : at), 0), c = cfg.cold[k], u = t - coldAt[k];
      if (u < c.len) {
        const f = Math.min(c.frames - 1, Math.floor(u * FPS)), sheet = sheets[k], w = sheet.width / c.cols;
        ctx.drawImage(sheet, (f % c.cols) * w, Math.floor(f / c.cols) * w, w, w, (W - H) / 2, 0, H, H);
        const left = (W - H) / 2;
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.font = font(170);
        ctx.fillText(c.name, left / 2, H / 2);
        ctx.font = font(38);
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        ctx.fillText(`${c.hz.toFixed(0)} HZ`, left / 2, H / 2 + 70);
        ctx.fillText(c.kind.toUpperCase(), left / 2, H / 2 + 126);
        ctx.fillText(`TAKE ${k + 1}`, W - left / 2, H / 2 - 14);
        ctx.fillText(`OF ${tiles.length}`, W - left / 2, H / 2 + 42);
        ctx.textAlign = "left";
        lines(c.text.split("\n"), [42], H - 90, "#fff", 0.6);
      }
    } else if (s < cfg.length) {
      drawWall(s, s < 0 ? ease((s + cfg.settle) / cfg.settle) : 1);
      const k = unfolded(s), one = solo(s);
      if (cfg.sections.length > 1) legend(0.85);
      const said = cfg.captions.find(([a, b]) => s >= a && s < b);
      if (one) {
        const sec = cfg.sections[one[2]];
        lines([sec.alone ?? `JUST ${(sec.label ?? sec.name).toUpperCase()}. STILL ME.`], [44], H - 96, sec.color, 0);
      } else if (said) {
        const fade = Math.min(ease((s - said[0]) / 0.3), ease((said[1] - s) / 0.3));
        ctx.globalAlpha = fade;
        // on the wall the words go under it; over the falling notes, above them
        lines(said[2].split("\n"), [40], k > 0.5 ? TOP + 90 : H - 96, "#fff", k > 0.5 ? 0.7 : 0);
        ctx.globalAlpha = 1;
      }
    } else {
      lines(cfg.end.lines, [110, 44, 32, 24], H / 2, "#ffb340", 0);
    }
    return performance.now() - began;
  }

  (window as unknown as { film: object }).film = { frames: Math.round(total * FPS), fps: FPS, width: W, height: H, draw };
  draw(0);
}

wall(document.getElementById("root")!).catch((e: unknown) => {
  document.getElementById("root")!.textContent = `The film could not load: ${e instanceof Error ? e.message : String(e)}`;
});
