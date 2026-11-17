/**
 * The app's look, shared by the canvas recorder and the page around it: a warm dark ground,
 * cream text, and a few plain colours that each mean one thing.
 */
export const C = {
  /** the ground */
  bg: "#17151a",
  /** raised things: panels, buttons */
  panel: "#221f26",
  /** thin lines and empty keys */
  line: "#3b3641",
  /** the main text */
  text: "#f5efe4",
  /** text that explains */
  soft: "#cfc6b8",
  /** labels and hints */
  dim: "#968d82",
  /** the quietest labels */
  faint: "#6a635c",
  /** now: the note being asked, the hold, listening */
  now: "#ffb84d",
  nowWash: "rgba(255,184,77,0.18)",
  /** kept, good */
  good: "#7fd492",
  /** off, refused, clipped, failed */
  bad: "#ff7a68",
  badWash: "rgba(255,122,104,0.25)",
};

/** the system's own rounded face where there is one (a Mac's), otherwise its plain one */
export const FACE = `ui-rounded, "SF Pro Rounded", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;

/** a canvas font at `size` px */
export const font = (size: number, weight = 600) => `${weight} ${size}px ${FACE}`;
