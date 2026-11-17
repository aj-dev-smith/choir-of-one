# For agents

You have probably been handed this repository and asked to "make one of these". Here is the whole job.

## What you can do and what you cannot

Making the film needs a person's recorded takes. **You cannot record them: a person has to sing into a
browser.** Everything else you can do yourself.

1. `bun install`, then `bun cli/doctor.ts --json`. If `ok` is false, each failed check has a `fix`: run it
   if you are allowed to install software, otherwise tell the person. Checks with `"needed": false` only add
   features; do not block on them.
2. Look for takes: `projects/default/takes/takes.json`. If it is there, go to step 4.
3. If not, start the app (`bun run start`, it stays running; serve it in the background) and ask the person
   to open http://127.0.0.1:4173 in Chrome, **wearing headphones**, and work through the Record step. It takes
   about fifteen minutes and they can stop and resume. Wait for them: do not invent takes, and do not try to
   drive the recorder with a synthetic voice unless you are testing the recorder itself.
4. Ask for the song file if you do not have one (any audio format). Do not fetch a song from the internet
   on your own initiative: it is theirs to supply.
5. Make it theirs. The words on the film and its colours are in `projects/default/script.json`
   (`bun cli/script.ts` writes it with the defaults and prints it; README, "Make it yours", says what each
   field is). The defaults are deliberately plain. Ask the person what they want it to say, or draft a title,
   captions and an end line in their voice and show them before you render; then edit the file and run
   `bun cli/script.ts` again to check it. Do not copy another person's film word for word.
6. Check the sound first; it takes seconds:
   `bun cli/make.ts --song <file> --sound-only --json`
   Read the `notes` in the result: they say how many notes there are, which pitches were out of reach, and
   which takes may squeal (offer to `--skip` those if the person hears it). Play `work/mix.wav` to the person if they want to hear it before the film.
7. Make the film: `bun cli/make.ts --song <file> --title "<title>" --stems --json`
   (drop `--stems` if the doctor said the splitter is not available). It takes about five minutes for 90
   seconds of song; with `--stems` the first run also downloads about 2 GB. The result line is
   `{"done": {"file": ".../film.mp4", "notes": [...]}}`. On failure the last line is `{"error": "..."}` and
   the exit code is 1; the message says what to do.
8. Tell the person where the film is and pass on the notes. You cannot judge the sound: say so, and let them
   listen.

Things people ask for next, and the flag for each: a different part of the song (`--start`, `--length`); a
take that sounds bad (`--skip sung-80`); a take that looks bad (`--picture sung-78=sung-77`); takes where they
leaned out of shot (`--stand-in <a take where part of them is visible>`); notes they could not reach
(`--reach`); different words or colours (edit `script.json` and make it again).

## Layout

```
server.ts          the app's server: serves web/, saves takes and the song, runs make()
web/               the app (three steps: record, song, make); web/record.ts is the recorder
cli/make.ts        make() from the command line
cli/doctor.ts      what is installed, what is missing
cli/script.ts      write, check and print a project's script.json
src/make.ts        the whole process, top to bottom; start reading here
src/transcribe.ts  a song as notes on piano keys
src/stems.ts       the song split into instruments (optional, Demucs)
src/arrange.ts     the film's shape: voices coming in, solos, the keyboard stretch, when words show
src/script.ts      the words and colours: script.json, its defaults and its checks
src/voices.ts      takes -> loops -> sound
src/faces.ts       takes -> pictures, framed on the face (faces.swift: macOS Vision)
src/film/wall.ts   the film itself, drawn in a browser one frame at a time
src/capture.ts     opens the film page headless and pipes its frames to ffmpeg
tests/             the pitch detector's tests
projects/          people's takes and films; never committed
```

Files the recorder writes, which everything else reads: `takes/<sung|whistle>-<midi>.webm`, and
`takes/takes.json`:

```json
{ "takes": { "sung-57": { "file": "sung-57.webm", "from": 2.5, "to": 4.5, "hz": 220.4, "cents": 3.1,
                          "rms": 0.03, "peak": 0.2, "rest": [0.1, 2.4] } },
  "skipped": ["sung-37"] }
```

`from`/`to` are where the held note is in the file (seconds), `hz` the pitch measured, `rest` a quiet stretch
before it. The number in a take's name is the MIDI key it was asked for (60 is middle C).

## Conventions

- Bun and TypeScript only; no framework, no bundler config. `bunx tsc --noEmit` and `bun test tests` stay clean.
- Comments say why, in plain words.
- Nothing that is somebody's music or somebody's face goes in git. `projects/` is ignored; keep it so.
- Error messages are for the person at the keyboard: say what went wrong and what to do about it.
- You cannot hear. When you change anything about the sound, measure it, say what you measured, and say that
  a person needs to listen.
