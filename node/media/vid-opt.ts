#!/usr/bin/env -S mise exec node@22 -- node

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  C,
  die,
  dim,
  error,
  errorMessage,
  formatBytes,
  formatDuration,
  heading,
  info,
  progressBar,
  prog,
  sizeChange,
  stat,
  success,
  warn,
} from "../lib/ui.ts";

const SUPPORTED = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"]);

const USAGE = `Usage:
  ${prog()} <input-file-or-folder> [output-file-or-folder] [options]

Examples:
  ${prog()} ./videos/big.mov
  ${prog()} ./videos/big.mov ./dist
  ${prog()} ./videos/big.mov --format both --width 1280 --crf 28 --max-fps 30
  ${prog()} ./videos ./videos/optimized --format mp4

Options:
  --format <mp4|webm|both>    Output format(s). Default: mp4
  --width <px>               Max output width (keeps aspect). Default: 1280
  --crf <n>                  Quality (lower = better, bigger). Default: 28
  --preset <name>            x264 preset. Default: slow
  --max-fps <n>              Limit FPS if source is higher. Default: 30
  --audio-bitrate <rate>     Audio bitrate for MP4. Default: 128k
  --poster                   Also generate a poster JPG. Default: on
  --no-poster                Disable poster generation
  --overwrite                Overwrite existing outputs. Default: off

Notes:
  - Requires ffmpeg + ffprobe on PATH. macOS: brew install ffmpeg
  - MP4 output uses H.264 + AAC with "faststart" for web playback.
`;

interface Options {
  inputPath: string | undefined;
  outputPath: string | undefined;
  format: string;
  width: number;
  crf: number;
  preset: string;
  maxFps: number;
  audioBitrate: string;
  poster: boolean;
  overwrite: boolean;
}

// The parts of ffprobe's JSON output this tool reads.
interface VideoStream {
  width?: number;
  height?: number;
  duration?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
}

interface Meta {
  video: VideoStream | undefined;
  duration: string | undefined;
}

interface Job {
  kind: string;
  outFile: string;
  run: () => Promise<number>;
}

interface Result {
  inputSize: number;
  outputBytes: number;
  written: number;
  skipped: number;
}

function parseArgs(argv: readonly string[]): Options {
  const args: Options = {
    inputPath: undefined,
    outputPath: undefined,
    format: "mp4",
    width: 1280,
    crf: 28,
    preset: "slow",
    maxFps: 30,
    audioBitrate: "128k",
    poster: true,
    overwrite: false,
  };

  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }

    const next = (): string | undefined => {
      const v = argv[i + 1];
      if (!v || v.startsWith("--")) return undefined;
      i++;
      return v;
    };

    switch (a) {
      case "--format": {
        const v = next();
        if (v) args.format = v;
        break;
      }
      case "--width": {
        const v = Number(next());
        if (Number.isFinite(v) && v > 0) args.width = Math.floor(v);
        break;
      }
      case "--crf": {
        const v = Number(next());
        if (Number.isFinite(v) && v >= 0 && v <= 51) args.crf = Math.floor(v);
        break;
      }
      case "--preset": {
        const v = next();
        if (v) args.preset = v;
        break;
      }
      case "--max-fps": {
        const v = Number(next());
        if (Number.isFinite(v) && v > 0) args.maxFps = Math.floor(v);
        break;
      }
      case "--audio-bitrate": {
        const v = next();
        if (v) args.audioBitrate = v;
        break;
      }
      case "--poster":
        args.poster = true;
        break;
      case "--no-poster":
        args.poster = false;
        break;
      case "--overwrite":
        args.overwrite = true;
        break;
      case "--help":
        console.log(USAGE);
        return process.exit(0);
      default:
        console.error(`Unknown option: ${a}\n`);
        console.error(USAGE);
        process.exit(1);
    }
  }

  args.inputPath = positionals[0];
  args.outputPath = positionals[1];
  return args;
}

function assertFfmpegAvailable(): void {
  const ffmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  const ffprobe = spawnSync("ffprobe", ["-version"], { stdio: "ignore" });
  if (ffmpeg.error || ffprobe.error || ffmpeg.status !== 0 || ffprobe.status !== 0) {
    error("ffmpeg/ffprobe not found on PATH.");
    dim("   Install on macOS with: brew install ffmpeg");
    process.exit(1);
  }
}

// runFfmpeg(args, label, durationSec) — run ffmpeg quietly, drawing a progress
// bar from its -progress output. Resolves with the elapsed ms; rejects with
// ffmpeg's error text on failure.
function runFfmpeg(args: readonly string[], label: string, durationSec: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const bar = progressBar(label);
    const child = spawn(
      "ffmpeg",
      ["-loglevel", "error", "-nostats", "-progress", "pipe:1", ...args],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let err = "";
    let buf = "";
    let speed = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const [key, value = ""] = line.split("=");
        if (key === "speed") speed = value.trim();
        if (key === "out_time_us" && durationSec > 0) {
          const fraction = Number(value) / 1e6 / durationSec;
          const elapsed = Date.now() - started;
          const eta = fraction > 0.02 ? formatDuration(elapsed / fraction - elapsed) : "…";
          bar.update(fraction, `${speed && speed !== "N/A" ? `${speed} · ` : ""}ETA ${eta}`);
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString("utf8");
    });
    child.on("error", (e) => {
      bar.done();
      reject(e);
    });
    child.on("close", (code) => {
      bar.done();
      if (code === 0) resolve(Date.now() - started);
      else {
        const detail = err.trim() ? `: ${err.trim()}` : "";
        reject(new Error(`ffmpeg exited with code ${String(code)}${detail}`));
      }
    });
  });
}

function runCapture(cmd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited with code ${String(code)}\n${err}`.trim()));
    });
  });
}

// ----- ffprobe JSON, narrowed at the boundary --------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const optionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;

function toVideoStream(s: Record<string, unknown>): VideoStream {
  const stream: VideoStream = {};
  const width = optionalNumber(s.width);
  const height = optionalNumber(s.height);
  const duration = optionalString(s.duration);
  const avg = optionalString(s.avg_frame_rate);
  const r = optionalString(s.r_frame_rate);
  if (width !== undefined) stream.width = width;
  if (height !== undefined) stream.height = height;
  if (duration !== undefined) stream.duration = duration;
  if (avg !== undefined) stream.avg_frame_rate = avg;
  if (r !== undefined) stream.r_frame_rate = r;
  return stream;
}

async function probe(inputFile: string): Promise<Meta> {
  const raw = await runCapture("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    inputFile,
  ]);
  const json: unknown = JSON.parse(raw);
  const root = isRecord(json) ? json : {};
  const streams = Array.isArray(root.streams) ? root.streams.filter(isRecord) : [];
  const format = isRecord(root.format) ? root.format : {};
  const video = streams.find((s) => s.codec_type === "video");
  return {
    video: video ? toVideoStream(video) : undefined,
    duration: optionalString(format.duration),
  };
}

function parseFps(rate: string | undefined): number | undefined {
  if (!rate) return undefined;
  const [n, d] = rate.split("/").map(Number);
  if (n === undefined || d === undefined || !Number.isFinite(n) || !Number.isFinite(d) || d === 0) {
    return undefined;
  }
  return n / d;
}

function durationOf(meta: Meta): number {
  return Number(meta.duration) || Number(meta.video?.duration) || 0;
}

function makeOutputName(inputFile: string, suffix: string, ext: string): string {
  const base = path.basename(inputFile, path.extname(inputFile));
  return `${base}.${suffix}.${ext}`;
}

// canWrite(outFile, overwrite) — false (skip) if the output exists and
// --overwrite wasn't given.
function canWrite(outFile: string, overwrite: boolean): boolean {
  return overwrite || !fs.existsSync(outFile);
}

// cappedFps(meta, opts) — the fps to force when the source exceeds --max-fps.
function cappedFps(meta: Meta, opts: Options): number | undefined {
  const srcFps = parseFps(meta.video?.avg_frame_rate) ?? parseFps(meta.video?.r_frame_rate);
  return srcFps && srcFps > opts.maxFps ? opts.maxFps : undefined;
}

// scaleFilter(opts, fps) — scale down to max width, keep aspect ratio, ensure even dimensions.
function scaleFilter(opts: Options, fps: number | undefined): string {
  const vfParts = [`scale=w='min(${String(opts.width)},iw)':h=-2:flags=lanczos`];
  if (fps) vfParts.push(`fps=${String(fps)}`);
  return vfParts.join(",");
}

function encodeMp4(inputFile: string, outFile: string, opts: Options, meta: Meta): Promise<number> {
  const fps = cappedFps(meta, opts);
  const g = fps ? fps * 2 : opts.maxFps * 2; // ~2s GOP

  const args = [
    "-hide_banner",
    "-y",
    "-i",
    inputFile,
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-vf",
    scaleFilter(opts, fps),
    "-c:v",
    "libx264",
    "-preset",
    opts.preset,
    "-crf",
    String(opts.crf),
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-g",
    String(g),
    "-keyint_min",
    String(g),
    "-sc_threshold",
    "0",
    "-c:a",
    "aac",
    "-b:a",
    opts.audioBitrate,
    "-ac",
    "2",
    outFile,
  ];

  return runFfmpeg(args, "🎞️  mp4 ", durationOf(meta));
}

function encodeWebmVp9(
  inputFile: string,
  outFile: string,
  opts: Options,
  meta: Meta,
): Promise<number> {
  const args = [
    "-hide_banner",
    "-y",
    "-i",
    inputFile,
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-vf",
    scaleFilter(opts, cappedFps(meta, opts)),
    "-c:v",
    "libvpx-vp9",
    "-b:v",
    "0",
    "-crf",
    "33",
    "-row-mt",
    "1",
    "-threads",
    "0",
    "-c:a",
    "libopus",
    "-b:a",
    "96k",
    outFile,
  ];

  return runFfmpeg(args, "🎞️  webm", durationOf(meta));
}

function makePoster(inputFile: string, outFile: string, opts: Options): Promise<number> {
  const args = [
    "-hide_banner",
    "-y",
    "-ss",
    "00:00:01.000",
    "-i",
    inputFile,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    "-vf",
    scaleFilter(opts, undefined),
    outFile,
  ];

  return runFfmpeg(args, "🖼️  poster", 0);
}

async function optimizeOne(
  inputFile: string,
  outputHint: string | undefined,
  opts: Options,
): Promise<Result> {
  const inputSize = fs.statSync(inputFile).size;
  const meta = await probe(inputFile);

  const outDir =
    outputHint && fs.existsSync(outputHint) && fs.statSync(outputHint).isDirectory()
      ? outputHint
      : undefined;

  const outBaseDir = outDir ?? path.dirname(outputHint ?? inputFile);
  fs.mkdirSync(outBaseDir, { recursive: true });

  // If the user gave a file path (not a directory), respect it.
  const baseOutputFile = outputHint && !outDir && path.extname(outputHint) ? outputHint : undefined;

  const format = opts.format.toLowerCase();
  const wantMp4 = format === "mp4" || format === "both";
  const wantWebm = format === "webm" || format === "both";

  const jobs: Job[] = [];
  if (wantMp4) {
    const outFile =
      baseOutputFile && path.extname(baseOutputFile).toLowerCase() === ".mp4"
        ? baseOutputFile
        : path.join(outBaseDir, makeOutputName(inputFile, "web", "mp4"));
    jobs.push({ kind: "MP4", outFile, run: () => encodeMp4(inputFile, outFile, opts, meta) });
  }
  if (wantWebm) {
    const outFile = path.join(outBaseDir, makeOutputName(inputFile, "web", "webm"));
    jobs.push({
      kind: "WebM",
      outFile,
      run: () => encodeWebmVp9(inputFile, outFile, opts, meta),
    });
  }
  if (opts.poster) {
    const outFile = path.join(outBaseDir, makeOutputName(inputFile, "poster", "jpg"));
    jobs.push({ kind: "Poster", outFile, run: () => makePoster(inputFile, outFile, opts) });
  }

  const name = path.basename(inputFile);
  const width = meta.video?.width !== undefined ? String(meta.video.width) : "?";
  const height = meta.video?.height !== undefined ? String(meta.video.height) : "?";
  console.log(
    `${C.bold}${C.cyan}🎬 ${name}${C.reset} ${C.dim}${formatBytes(inputSize)} · ` +
      `${width}×${height} · ${formatDuration(durationOf(meta) * 1000)}${C.reset}`,
  );

  const outputs: string[] = [];
  let skipped = 0;
  for (const job of jobs) {
    if (!canWrite(job.outFile, opts.overwrite)) {
      warn(`${job.kind}: ${path.basename(job.outFile)} already exists — skipped (use --overwrite)`);
      skipped += 1;
      continue;
    }
    const ms = await job.run();
    const size = fs.statSync(job.outFile).size;
    success(
      `${job.kind}: ${path.basename(job.outFile)} ${C.dim}${formatBytes(size)} · ${formatDuration(ms)}${C.reset}`,
    );
    outputs.push(job.outFile);
  }

  const outputBytes = outputs.reduce((sum, p) => sum + fs.statSync(p).size, 0);
  if (outputs.length) info(`${name}: ${sizeChange(inputSize, outputBytes)} total`, "📦");
  console.log();
  return { inputSize, outputBytes, written: outputs.length, skipped };
}

function printHeader(inputPath: string, outLabel: string, opts: Options, count: number): void {
  heading(`${prog()} · optimising video for the web`, "🎥");
  info(`Input:    ${C.bold}${inputPath}${C.reset}`);
  info(`Output:   ${C.bold}${outLabel}${C.reset}`);
  info(
    `Settings: ${opts.format} · max ${String(opts.width)}px · crf ${String(opts.crf)} · ${opts.preset} · ` +
      `≤${String(opts.maxFps)}fps · audio ${opts.audioBitrate}${opts.poster ? " · poster" : ""}` +
      (opts.overwrite ? " · overwrite" : ""),
  );
  info(`Found ${String(count)} video(s)`, "🔍");
  console.log();
}

async function processPath(
  inputPath: string,
  outputPath: string | undefined,
  opts: Options,
): Promise<Result[]> {
  if (!fs.existsSync(inputPath)) die(`Input not found: ${inputPath}`);
  const stats = fs.statSync(inputPath);

  if (stats.isFile()) {
    if (!SUPPORTED.has(path.extname(inputPath).toLowerCase())) {
      throw new Error(`Unsupported input extension: ${path.extname(inputPath)}`);
    }
    printHeader(inputPath, outputPath ?? path.dirname(inputPath), opts, 1);
    return [await optimizeOne(inputPath, outputPath, opts)];
  }

  if (!stats.isDirectory()) {
    throw new Error("Input path must be a file or directory");
  }

  const files = fs
    .readdirSync(inputPath)
    .filter((file) => SUPPORTED.has(path.extname(file).toLowerCase()))
    .map((file) => path.join(inputPath, file));

  if (files.length === 0) {
    warn("No supported videos found in directory.");
    return [];
  }

  const outDir = outputPath ?? path.join(inputPath, "optimized");
  fs.mkdirSync(outDir, { recursive: true });

  printHeader(inputPath, outDir, opts, files.length);
  const results: Result[] = [];
  for (const f of files) {
    results.push(await optimizeOne(f, outDir, opts));
  }
  return results;
}

const args = parseArgs(process.argv.slice(2));
if (!args.inputPath) {
  console.error(USAGE);
  process.exit(1);
}

assertFfmpegAvailable();

const started = Date.now();
processPath(args.inputPath, args.outputPath, args)
  .then((results) => {
    if (!results.length) return;
    const totalIn = results.reduce((sum, r) => sum + r.inputSize, 0);
    const totalOut = results.reduce((sum, r) => sum + r.outputBytes, 0);
    const written = results.reduce((sum, r) => sum + r.written, 0);
    const skipped = results.reduce((sum, r) => sum + r.skipped, 0);
    stat("video(s) processed", results.length);
    stat("output file(s) written", written);
    if (skipped) stat("skipped (already exist)", skipped);
    if (written) {
      info(`Total: ${sizeChange(totalIn, totalOut)}`, "📦");
      if (totalIn > totalOut)
        info(`Saved ${C.bold}${formatBytes(totalIn - totalOut)}${C.reset}`, "💾");
    }
    success(`Done in ${formatDuration(Date.now() - started)}. 🎉`);
  })
  .catch((err: unknown) => {
    console.log();
    die(errorMessage(err));
  });
