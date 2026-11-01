#!/usr/bin/env -S mise exec node@22 -- node

// pdf-opt — compress PDFs with Ghostscript.

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import {
  C,
  die,
  errorMessage,
  formatBytes,
  formatDuration,
  info,
  heading,
  prog,
  sizeChange,
  stat,
  success,
  withSpinner,
} from "../lib/ui.ts";

interface Options {
  inputFile: string | undefined;
  outputFile: string | undefined;
  quality: string;
}

// resolveGhostscriptCommand() — "ghostscript" or "gs", whichever is really Ghostscript.
function resolveGhostscriptCommand(): string | null {
  const candidates = ["ghostscript", "gs"];

  for (const cmd of candidates) {
    const probe = spawnSync(cmd, ["--version"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) continue;

    const versionText = `${probe.stdout}${probe.stderr}`;
    if (/\bghostscript\b/i.test(versionText) || /^\d+(\.\d+)+\s*$/m.test(versionText.trim())) {
      return cmd;
    }
  }

  return null;
}

// compressPDF(input, output, quality) — quality: /screen | /ebook | /printer | /prepress
export function compressPDF(
  inputFile: string,
  outputFile: string,
  quality = "/ebook",
): Promise<void> {
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
        reject(new Error(`Ghostscript exited with code ${String(code)}`));
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

function parseArgs(argv: readonly string[]): Options {
  const parsed: Options = {
    inputFile: undefined,
    outputFile: undefined,
    quality: "/ebook",
  };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const next = (): string | undefined => {
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

  parsed.inputFile ??= positionals[0];
  parsed.outputFile ??= positionals[1];

  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const inputFile = args.inputFile;
  if (!inputFile) {
    console.error(USAGE);
    process.exit(1);
  }

  if (!QUALITY_PRESETS.has(args.quality)) {
    die(
      `Invalid quality preset: ${args.quality} (supported: ${Array.from(QUALITY_PRESETS).join(", ")})`,
    );
  }

  if (!fs.existsSync(inputFile)) die(`Input not found: ${inputFile}`);

  const ext = path.extname(inputFile);
  const outputFile =
    args.outputFile ??
    path.join(
      path.dirname(inputFile),
      `${path.basename(inputFile, ext)} (compressed)${ext || ".pdf"}`,
    );

  heading(`${prog()} · compressing PDF`, "📄");
  info(`Input:    ${C.bold}${inputFile}${C.reset}`);
  info(`Output:   ${C.bold}${outputFile}${C.reset}`);
  info(`Settings: Ghostscript ${args.quality} preset`);
  console.log();

  const started = Date.now();
  const name = path.basename(inputFile);
  let before = 0;
  let after = 0;
  await withSpinner(name, async () => {
    await compressPDF(inputFile, outputFile, args.quality);
    before = fs.statSync(inputFile).size;
    after = fs.statSync(outputFile).size;
    return { label: `${name} → ${path.basename(outputFile)}  ${sizeChange(before, after)}` };
  });

  console.log();
  stat("compressed", 1);
  if (before > after) info(`Saved ${C.bold}${formatBytes(before - after)}${C.reset}`, "💾");
  success(`Done in ${formatDuration(Date.now() - started)}. 🎉`);
}

// Resolve symlinks: the tool is run via a link in ~/.local/bin.
const entry = process.argv[1];
const isCliEntrypoint =
  entry !== undefined && fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));

if (isCliEntrypoint) {
  main().catch((err: unknown) => {
    die(errorMessage(err));
  });
}
