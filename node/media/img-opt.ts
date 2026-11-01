#!/usr/bin/env -S mise exec node@22 -- node

import fs from "fs";
import { spawnSync } from "child_process";
import os from "os";
import path from "path";
import sharp from "sharp";
import {
  C, die, dim, error, formatBytes, formatDuration, heading, info, prog, sizeChange, stat, success, warn, withSpinner,
} from "../lib/ui.ts";

const SUPPORTED_INPUT_FORMATS = [
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
const SUPPORTED_OUTPUT_FORMATS = ["jpg", "jpeg", "png", "tiff", "webp", "avif", "gif"];

function normalizeFormat(value) {
  return value.replace(/^\./, "").toLowerCase();
}

function getFileExt(filePath) {
  return path.extname(filePath).toLowerCase().replace(/^\./, "");
}

function convertHeifToTempPng(sourcePath) {
  const tempPath = path.join(
    os.tmpdir(),
    `img-opt-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
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

function parseArgs(argv) {
  let inputPath = null;
  let outputDir = null;
  let outputFormat = "webp";
  let quality = 75;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--input") {
      inputPath = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--output-dir") {
      outputDir = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--output-fmt") {
      outputFormat = normalizeFormat(argv[i + 1] ?? "");
      i += 1;
      continue;
    }

    if (arg === "--quality") {
      quality = Number.parseInt(argv[i + 1] ?? "", 10);
      i += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
  }

  return {
    inputPath,
    outputDir,
    outputFormat,
    quality,
  };
}

const { inputPath, outputDir: outputDirArg, outputFormat, quality } = parseArgs(
  process.argv.slice(2),
);
let outputDir = outputDirArg;

if (!inputPath) {
  console.error(USAGE);
  process.exit(1);
}

if (!fs.existsSync(inputPath)) die(`Input not found: ${inputPath}`);

if (!outputDir) {
  const baseDir = fs.statSync(inputPath).isDirectory()
    ? inputPath
    : path.dirname(inputPath);
  outputDir = path.join(baseDir, "optimized");
}

const MAX_WIDTH = 3000;

if (!SUPPORTED_OUTPUT_FORMATS.includes(outputFormat)) {
  die(`Unsupported output format: ${outputFormat} (supported: ${SUPPORTED_OUTPUT_FORMATS.join(", ")})`);
}

if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
  die(`Invalid quality value: ${quality} — must be an integer between 1 and 100.`);
}

fs.mkdirSync(outputDir, { recursive: true });

const stats = fs.statSync(inputPath);
const files = stats.isDirectory()
  ? fs.readdirSync(inputPath).filter((file) => {
      const ext = getFileExt(file);
      return SUPPORTED_INPUT_FORMATS.includes(ext);
    })
  : [path.basename(inputPath)].filter((file) => {
      const ext = getFileExt(file);
      return SUPPORTED_INPUT_FORMATS.includes(ext);
    });

heading(`${prog()} · optimising images`, "🖼️ ");
info(`Input:    ${C.bold}${inputPath}${C.reset}`);
info(`Output:   ${C.bold}${outputDir}${C.reset}`);
info(`Settings: ${outputFormat} · quality ${quality} · max width ${MAX_WIDTH}px`);

if (files.length === 0) {
  warn("No supported images found.");
  dim(`   Supported: ${SUPPORTED_INPUT_FORMATS.join(", ")}`);
  process.exit(0);
}

info(`Found ${files.length} image(s)`, "🔍");
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
  let tempSourcePath = null;

  try {
    await withSpinner(`${file}`, async () => {
      const processingPath = isHeifInput ? convertHeifToTempPng(sourcePath) : sourcePath;
      tempSourcePath = isHeifInput ? processingPath : null;

      const pipeline = sharp(processingPath).resize({
        width: MAX_WIDTH,
        withoutEnlargement: true,
      });

      if (outputFormat === "jpeg") {
        pipeline.jpeg({ quality });
      } else if (outputFormat === "png") {
        pipeline.png({ quality });
      } else if (outputFormat === "tiff") {
        pipeline.tiff({ quality });
      } else if (outputFormat === "webp") {
        pipeline.webp({ quality });
      } else if (outputFormat === "avif") {
        pipeline.avif({ quality });
      } else if (outputFormat === "gif") {
        pipeline.gif();
      }

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
    error(`   ${err.message}`, " ");
  } finally {
    if (tempSourcePath && fs.existsSync(tempSourcePath)) {
      fs.unlinkSync(tempSourcePath);
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
  error(`Finished with ${failed} failure(s) in ${formatDuration(Date.now() - started)}.`);
  process.exit(1);
}
success(`Done in ${formatDuration(Date.now() - started)}. 🎉`);
