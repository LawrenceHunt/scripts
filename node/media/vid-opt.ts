#!/usr/bin/env -S mise exec node@22 -- node

import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";
import {
  C, die, dim, error, formatBytes, formatDuration, heading, info, progressBar, prog, sizeChange, stat,
  success, warn,
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

function parseArgs(argv) {
  const args = {
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

  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }

    const next = () => {
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
      case "-h":
        console.log(USAGE);
        process.exit(0);
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

function assertFfmpegAvailable() {
  const ffmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  const ffprobe = spawnSync("ffprobe", ["-version"], { stdio: "ignore" });
  if (
    ffmpeg.error ||
    ffprobe.error ||
    ffmpeg.status !== 0 ||
    ffprobe.status !== 0
  ) {
    error("ffmpeg/ffprobe not found on PATH.");
    dim("   Install on macOS with: brew install ffmpeg");
    process.exit(1);
  }
}

// runFfmpeg(args, label, durationSec) — run ffmpeg quietly, drawing a progress
// bar from its -progress output. Rejects with ffmpeg's error text on failure.
function runFfmpeg(args, label, durationSec) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const bar = progressBar(label);
    const child = spawn(
      "ffmpeg",
      ["-loglevel", "error", "-nostats", "-progress", "pipe:1", ...args],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let err = "";
    let buf = "";
    let speed = "";
    child.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const [key, value] = line.split("=");
        if (key === "speed") speed = value.trim();
        if (key === "out_time_us" && durationSec > 0) {
          const fraction = Number(value) / 1e6 / durationSec;
          const elapsed = Date.now() - started;
          const eta = fraction > 0.02 ? formatDuration(elapsed / fraction - elapsed) : "…";
          bar.update(fraction, `${speed && speed !== "N/A" ? `${speed} · ` : ""}ETA ${eta}`);
        }
      }
    });
    child.stderr.on("data", (d) => (err += d.toString("utf8")));
    child.on("error", (e) => {
      bar.done();
      reject(e);
    });
    child.on("close", (code) => {
      bar.done();
      if (code === 0) resolve(Date.now() - started);
      else reject(new Error(`ffmpeg exited with code ${code}${err.trim() ? `: ${err.trim()}` : ""}`));
    });
  });
}

function runCapture(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (err += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited with code ${code}\n${err}`.trim()));
    });
  });
}

async function probe(inputFile) {
  const raw = await runCapture("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_format",
    inputFile,
  ]);
  const json = JSON.parse(raw);
  const v = (json.streams || []).find((s) => s.codec_type === "video");
  const a = (json.streams || []).find((s) => s.codec_type === "audio");
  return { video: v, audio: a, format: json.format || {} };
}

function parseFps(rate) {
  if (!rate || typeof rate !== "string") return undefined;
  const [n, d] = rate.split("/").map(Number);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return undefined;
  return n / d;
}

function durationOf(meta) {
  return Number(meta?.format?.duration) || Number(meta?.video?.duration) || 0;
}

function makeOutputName(inputFile, suffix, ext) {
  const base = path.basename(inputFile, path.extname(inputFile));
  return `${base}.${suffix}.${ext}`;
}

// canWrite(outFile, overwrite) — false (skip) if the output exists and
// --overwrite wasn't given.
function canWrite(outFile, overwrite) {
  return overwrite || !fs.existsSync(outFile);
}

async function encodeMp4(inputFile, outFile, opts, meta) {
  const srcFps =
    parseFps(meta?.video?.avg_frame_rate) ??
    parseFps(meta?.video?.r_frame_rate);
  const fps = srcFps && srcFps > opts.maxFps ? opts.maxFps : undefined;
  const g = fps ? fps * 2 : opts.maxFps * 2; // ~2s GOP

  // scale down to max width, keep aspect ratio, ensure even dimensions
  const vfParts = [`scale=w='min(${opts.width},iw)':h=-2:flags=lanczos`];
  if (fps) vfParts.push(`fps=${fps}`);
  const vf = vfParts.join(",");

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
    vf,
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

async function encodeWebmVp9(inputFile, outFile, opts, meta) {
  const srcFps =
    parseFps(meta?.video?.avg_frame_rate) ??
    parseFps(meta?.video?.r_frame_rate);
  const fps = srcFps && srcFps > opts.maxFps ? opts.maxFps : undefined;

  const vfParts = [`scale=w='min(${opts.width},iw)':h=-2:flags=lanczos`];
  if (fps) vfParts.push(`fps=${fps}`);
  const vf = vfParts.join(",");

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
    vf,
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

async function makePoster(inputFile, outFile, opts) {
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
    `scale=w='min(${opts.width},iw)':h=-2:flags=lanczos`,
    outFile,
  ];

  return runFfmpeg(args, "🖼️  poster", 0);
}

async function optimizeOne(inputFile, outputHint, opts) {
  const inputSize = fs.statSync(inputFile).size;
  const meta = await probe(inputFile);

  const outDir =
    outputHint &&
    fs.existsSync(outputHint) &&
    fs.statSync(outputHint).isDirectory()
      ? outputHint
      : undefined;

  const outBaseDir = outDir || path.dirname(outputHint || inputFile);
  fs.mkdirSync(outBaseDir, { recursive: true });

  const baseOutputFile = () => {
    if (!outputHint) return undefined;
    if (outDir) return undefined;
    // If user gave a file path, respect it.
    if (path.extname(outputHint)) return outputHint;
    return undefined;
  };

  const format = String(opts.format || "mp4").toLowerCase();
  const wantMp4 = format === "mp4" || format === "both";
  const wantWebm = format === "webm" || format === "both";

  const jobs = [];
  if (wantMp4) {
    const outFile =
      baseOutputFile() &&
      path.extname(baseOutputFile()).toLowerCase() === ".mp4"
        ? baseOutputFile()
        : path.join(outBaseDir, makeOutputName(inputFile, "web", "mp4"));
    jobs.push({ kind: "MP4", outFile, run: () => encodeMp4(inputFile, outFile, opts, meta) });
  }
  if (wantWebm) {
    const outFile = path.join(outBaseDir, makeOutputName(inputFile, "web", "webm"));
    jobs.push({ kind: "WebM", outFile, run: () => encodeWebmVp9(inputFile, outFile, opts, meta) });
  }
  if (opts.poster) {
    const outFile = path.join(outBaseDir, makeOutputName(inputFile, "poster", "jpg"));
    jobs.push({ kind: "Poster", outFile, run: () => makePoster(inputFile, outFile, opts) });
  }

  const name = path.basename(inputFile);
  const v = meta.video || {};
  console.log(
    `${C.bold}${C.cyan}🎬 ${name}${C.reset} ${C.dim}${formatBytes(inputSize)} · ` +
      `${v.width ?? "?"}×${v.height ?? "?"} · ${formatDuration(durationOf(meta) * 1000)}${C.reset}`
  );

  const outputs = [];
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
      `${job.kind}: ${path.basename(job.outFile)} ${C.dim}${formatBytes(size)} · ${formatDuration(ms)}${C.reset}`
    );
    outputs.push(job.outFile);
  }

  const outputBytes = outputs.reduce((sum, p) => sum + fs.statSync(p).size, 0);
  if (outputs.length) info(`${name}: ${sizeChange(inputSize, outputBytes)} total`, "📦");
  console.log();
  return { inputSize, outputBytes, written: outputs.length, skipped };
}

function printHeader(inputPath, outLabel, opts, count) {
  heading(`${prog()} · optimising video for the web`, "🎥");
  info(`Input:    ${C.bold}${inputPath}${C.reset}`);
  info(`Output:   ${C.bold}${outLabel}${C.reset}`);
  info(
    `Settings: ${opts.format} · max ${opts.width}px · crf ${opts.crf} · ${opts.preset} · ` +
      `≤${opts.maxFps}fps · audio ${opts.audioBitrate}${opts.poster ? " · poster" : ""}` +
      `${opts.overwrite ? " · overwrite" : ""}`
  );
  info(`Found ${count} video(s)`, "🔍");
  console.log();
}

async function processPath(inputPath, outputPath, opts) {
  if (!fs.existsSync(inputPath)) die(`Input not found: ${inputPath}`);
  const stats = fs.statSync(inputPath);

  if (stats.isFile()) {
    if (!SUPPORTED.has(path.extname(inputPath).toLowerCase())) {
      throw new Error(
        `Unsupported input extension: ${path.extname(inputPath)}`
      );
    }
    printHeader(inputPath, outputPath || path.dirname(inputPath), opts, 1);
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

  const outDir = outputPath || path.join(inputPath, "optimized");
  fs.mkdirSync(outDir, { recursive: true });

  printHeader(inputPath, outDir, opts, files.length);
  const results = [];
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
      if (totalIn > totalOut) info(`Saved ${C.bold}${formatBytes(totalIn - totalOut)}${C.reset}`, "💾");
    }
    success(`Done in ${formatDuration(Date.now() - started)}. 🎉`);
  })
  .catch((err) => {
    console.log();
    die(err.message);
  });
