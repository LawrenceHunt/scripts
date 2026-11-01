#!/usr/bin/env -S mise exec node@22 -- node

import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { C, die, formatBytes, formatDuration, info, heading, prog, sizeChange, stat, success, withSpinner } from "../lib/ui.ts";

/**
 * Compress a PDF using Ghostscript
 * @param {string} inputFile
 * @param {string} outputFile
 * @param {string} quality - /screen | /ebook | /printer | /prepress
 */
function resolveGhostscriptCommand() {
  const candidates = ["ghostscript", "gs"];

  for (const cmd of candidates) {
    const probe = spawnSync(cmd, ["--version"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) continue;

    const versionText = `${probe.stdout || ""}${probe.stderr || ""}`;
    if (/\bghostscript\b/i.test(versionText) || /^\d+(\.\d+)+\s*$/m.test(versionText.trim())) {
      return cmd;
    }
  }

  return null;
}

export function compressPDF(inputFile, outputFile, quality = "/ebook") {
  return new Promise((resolve, reject) => {
    const gsCommand = resolveGhostscriptCommand();
    if (!gsCommand) {
      reject(
        new Error(
          "Ghostscript CLI not found. Install it (macOS: brew install ghostscript) or ensure `ghostscript`/`gs` points to Ghostscript.",
        ),
      );
      return;
    }

    const args = [
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.4",
      `-dPDFSETTINGS=${quality}`,
      "-dNOPAUSE",
      "-dQUIET",
      "-dBATCH",
      `-sOutputFile=${outputFile}`,
      inputFile,
    ];

    const gs = spawn(gsCommand, args);

    gs.on("error", (err) => {
      reject(new Error(`Failed to start Ghostscript: ${err.message}`));
    });

    gs.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Ghostscript exited with code ${code}`));
      }
    });
  });
}

const QUALITY_PRESETS = new Set(["/screen", "/ebook", "/printer", "/prepress"]);

const USAGE = `Usage:
  ${prog()} <input-file> [output-file] [--quality <preset>]
  ${prog()} --input <input-file> [--output <output-file>] [--quality <preset>]

Quality presets:
  /screen   Lowest file size, lowest quality
  /ebook    Good quality for on-screen use (default)
  /printer  Better quality for printing
  /prepress Highest quality
`;

function parseArgs(argv) {
  const parsed = {
    inputFile: undefined,
    outputFile: undefined,
    quality: "/ebook",
  };
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) return undefined;
      i += 1;
      return value;
    };

    if (arg === "--input") {
      parsed.inputFile = next();
      continue;
    }

    if (arg === "--output") {
      parsed.outputFile = next();
      continue;
    }

    if (arg === "--quality") {
      const value = next();
      if (value) parsed.quality = value.startsWith("/") ? value : `/${value}`;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }

    console.error(`Unknown option: ${arg}\n`);
    console.error(USAGE);
    process.exit(1);
  }

  if (!parsed.inputFile) parsed.inputFile = positionals[0];
  if (!parsed.outputFile) parsed.outputFile = positionals[1];

  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.inputFile) {
    console.error(USAGE);
    process.exit(1);
  }

  if (!QUALITY_PRESETS.has(args.quality)) {
    die(`Invalid quality preset: ${args.quality} (supported: ${Array.from(QUALITY_PRESETS).join(", ")})`);
  }

  if (!fs.existsSync(args.inputFile)) die(`Input not found: ${args.inputFile}`);

  const outputFile =
    args.outputFile ||
    path.join(
      path.dirname(args.inputFile),
      `${path.basename(args.inputFile, path.extname(args.inputFile))} (compressed)${path.extname(
        args.inputFile,
      ) || ".pdf"}`,
    );

  heading(`${prog()} · compressing PDF`, "📄");
  info(`Input:    ${C.bold}${args.inputFile}${C.reset}`);
  info(`Output:   ${C.bold}${outputFile}${C.reset}`);
  info(`Settings: Ghostscript ${args.quality} preset`);
  console.log();

  const started = Date.now();
  const name = path.basename(args.inputFile);
  let before = 0;
  let after = 0;
  await withSpinner(name, async () => {
    await compressPDF(args.inputFile, outputFile, args.quality);
    before = fs.statSync(args.inputFile).size;
    after = fs.statSync(outputFile).size;
    return { label: `${name} → ${path.basename(outputFile)}  ${sizeChange(before, after)}` };
  });

  console.log();
  stat("compressed", 1);
  if (before > after) info(`Saved ${C.bold}${formatBytes(before - after)}${C.reset}`, "💾");
  success(`Done in ${formatDuration(Date.now() - started)}. 🎉`);
}

const isCliEntrypoint =
  // Resolve symlinks: the tool is run via a link in ~/.local/bin.
  process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (isCliEntrypoint) {
  main().catch((err) => {
    die(err.message);
  });
}
