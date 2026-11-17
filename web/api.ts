/**
 * What the server and the page say to each other: the shapes of the JSON the endpoints return.
 * (Types only, so the server and the browser bundle can both import it.)
 */
import type { Progress } from "../src/make.ts";

/** one kept take, as takes.json holds it */
export interface Take {
  file: string;
  from: number;
  to: number;
  hz: number;
  cents: number;
  rms?: number;
  peak?: number;
  /** the quiet stretch before `from` (s): the face at rest */
  rest?: [number, number];
}
export interface TakesFile {
  takes: Record<string, Take>;
  skipped: string[];
}

/** GET /api/projects/:name */
export interface ProjectView {
  name: string;
  /** takes.json as it is on disk, or null when there is none (or it could not be read) */
  takes: TakesFile | null;
  /** takes.json is there but is not JSON: the next write keeps a copy of it first */
  unreadable: boolean;
  /** the take files actually in <project>/takes/ */
  files: string[];
  /** the song, if one was given: the name it was uploaded with, and where it is kept */
  song: { name: string; file: string; bytes: number } | null;
  /** the film, if one was made */
  film: { bytes: number; modified: number } | null;
  /** can the song be split into instruments here */
  stems: boolean;
  /** the make running or last finished, if it was this project's */
  job: JobView | null;
}

/** what the server knows about a make, sent on GET /api/make and as each server-sent event */
export interface JobView {
  project: string;
  state: "running" | "done" | "failed";
  progress: Progress | null;
  started: number;
  finished?: number;
  /** when done: what a person should know about the film */
  notes?: string[];
  /** when failed: the error's message */
  error?: string;
}

/** POST /api/projects/:name/make */
export interface MakeRequest {
  title: string;
  credit?: string;
  start?: number;
  length?: number;
  stems?: boolean;
  reach?: boolean;
}
