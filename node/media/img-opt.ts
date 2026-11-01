#!/usr/bin/env -S mise exec node@22 -- node

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
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
  prog,
  sizeChange,
  stat,
  success,
  warn,
  withSpinner,
} from "../lib/ui.ts";

const SUPPORTED_INPUT_FORMATS: readonly string[] = [
  "jpg",
  "jpeg",
  "png",
  "tiff",
  "webp",
  "avif",
  "gif",
  "heic",
  "heif",
];
const SUPPORTED_OUTPUT_FORMATS: readonly string[] = [
  "jpg",
  "jpeg",
  "png",
  "tiff",
  "webp",
  "avif",
  "gif",
];

interface Options {
  inputPath: string | undefined;
  outputDir: string | undefined;
  outputFormat: string;
  quality: number;
}

function normalizeFormat(value: string): string {
  return value.replace(/^\./, "").toLowerCase();
}

function getFileExt(filePath: string): string {
  return path.extname(filePath).toLowerCase().replace(/^\./, "");
}

function convertHeifToTempPng(sourcePath: string): string {
  const tempPath = path.join(
    os.tmpdir(),
    `img-opt-${String(Date.now())}-${Math.random().toString(36).slice(2)}.png`,
  );
  const result = spawnSync("sips", ["-s", "format", "png", sourcePath, "--out", tempPath], {
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const errorText = result.stderr || result.stdout || "Unknown sips error";
    throw new Error(`HEIC/HEIF decode failed: ${errorText.trim()}`);
  }

  return tempPath;
}

const USAGE = `Usage:
  ${prog()} --input <file-or-folder> [--output-dir <folder>] [--output-fmt <format>] [--quality <1-100>]

Options:
  --input <path>        Image file, or a folder of images
  --output-dir <dir>    Where to write (default: an "optimized" folder next to the input)
  --output-fmt <fmt>    ${SUPPORTED_OUTPUT_FORMATS.join(" | ")} (default: webp)
  --quality <1-100>     Encoder quality (default: 75)

Images wider than 3000px are scaled down. HEIC/HEIF is decoded with macOS sips.`;

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    inputPath: undefined,
    outputDir: undefined,
    outputFormat: "webp",
    quality: 75,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];

    if (arg === "--input") {
      options.inputPath = value;
      i += 1;
      continue;
    }

    if (arg === "--output-dir") {
      options.outputDir = value;
      i += 1;
      continue;
    }

    if (arg === "--output-fmt") {
      options.outputFormat = normalizeFormat(value ?? "");
      i += 1;
      continue;
    }

    if (arg === "--quality") {
      options.quality = Number.parseInt(value ?? "", 10);
      i += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
  }

  return options;
}

// encodeAs(pipeline, format, quality) — set the output encoder for a format.
function encodeAs(pipeline: sharp.Sharp, format: string, quality: number): void {
  switch (format) {
    case "jpeg":
      pipeline.jpeg({ quality });
      break;
    case "png":
      pipeline.png({ quality });
      break;
    case "tiff":
      pipeline.tiff({ quality });
      break;
    case "webp":
      pipeline.webp({ quality });
      break;
    case "avif":
      pipeline.avif({ quality });
      break;
    case "gif":
      pipeline.gif();
      break;
    default:
      // "jpg" (and anything else) is left to sharp to infer from the extension.
      break;
  }
}

const {
  inputPath,
  outputDir: outputDirArg,
  outputFormat,
  quality,
} = parseArgs(process.argv.slice(2));

if (!inputPath) {
  console.error(USAGE);
  process.exit(1);
}

if (!fs.existsSync(inputPath)) die(`Input not found: ${inputPath}`);

const outputDir =
  outputDirArg ??
  path.join(
    fs.statSync(inputPath).isDirectory() ? inputPath : path.dirname(inputPath),
    "optimized",
  );

const MAX_WIDTH = 3000;

if (!SUPPORTED_OUTPUT_FORMATS.includes(outputFormat)) {
  die(
    `Unsupported output format: ${outputFormat} (supported: ${SUPPORTED_OUTPUT_FORMATS.join(", ")})`,
  );
}

if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
  die(`Invalid quality value: ${String(quality)} — must be an integer between 1 and 100.`);
}

fs.mkdirSync(outputDir, { recursive: true });

const isSupportedInput = (file: string): boolean =>
  SUPPORTED_INPUT_FORMATS.includes(getFileExt(file));

const stats = fs.statSync(inputPath);
const files = stats.isDirectory()
  ? fs.readdirSync(inputPath).filter(isSupportedInput)
  : [path.basename(inputPath)].filter(isSupportedInput);

heading(`${prog()} · optimising images`, "🖼️ ");
info(`Input:    ${C.bold}${inputPath}${C.reset}`);
info(`Output:   ${C.bold}${outputDir}${C.reset}`);
info(`Settings: ${outputFormat} · quality ${String(quality)} · max width ${String(MAX_WIDTH)}px`);

if (files.length === 0) {
  warn("No supported images found.");
  dim(`   Supported: ${SUPPORTED_INPUT_FORMATS.join(", ")}`);
  process.exit(0);
}

info(`Found ${String(files.length)} image(s)`, "🔍");
console.log();

const started = Date.now();
let done = 0;
let failed = 0;
let totalIn = 0;
let totalOut = 0;

for (const file of files) {
  const sourcePath = stats.isDirectory() ? path.join(inputPath, file) : inputPath;
  const outputPath = path.join(outputDir, file.replace(/\.\w+$/, `.${outputFormat}`));
  const sourceExt = getFileExt(sourcePath);
  const isHeifInput = sourceExt === "heic" || sourceExt === "heif";
  // Set inside the spinner callback, cleaned up in `finally`.
  const temp: { path: string | null } = { path: null };

  try {
    await withSpinner(file, async () => {
      const processingPath = isHeifInput ? convertHeifToTempPng(sourcePath) : sourcePath;
      temp.path = isHeifInput ? processingPath : null;

      const pipeline = sharp(processingPath).resize({
        width: MAX_WIDTH,
        withoutEnlargement: true,
      });
      encodeAs(pipeline, outputFormat, quality);

      await pipeline.toFile(outputPath);

      const before = fs.statSync(sourcePath).size;
      const after = fs.statSync(outputPath).size;
      totalIn += before;
      totalOut += after;
      done += 1;
      return { label: `${file} → ${path.basename(outputPath)}  ${sizeChange(before, after)}` };
    });
  } catch (err) {
    failed += 1;
    error(`   ${errorMessage(err)}`, " ");
  } finally {
    if (temp.path && fs.existsSync(temp.path)) {
      fs.unlinkSync(temp.path);
    }
  }
}

console.log();
stat("optimised", done);
if (failed) stat("failed", failed);
if (done) {
  info(`Total: ${sizeChange(totalIn, totalOut)}`, "📦");
  if (totalIn > totalOut) info(`Saved ${C.bold}${formatBytes(totalIn - totalOut)}${C.reset}`, "💾");
}
if (failed) {
  error(`Finished with ${String(failed)} failure(s) in ${formatDuration(Date.now() - started)}.`);
  process.exit(1);
}
success(`Done in ${formatDuration(Date.now() - started)}. 🎉`);
