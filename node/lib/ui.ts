// ui.ts — shared styling, output and prompt helpers for node tools.
//
// Mirrors bash/lib/common.sh so every tool feels like the same family:
//
//   import { heading, info, success, withSpinner } from "../lib/ui.ts";
//
// Informational output goes to stdout; warnings, errors, spinners and progress
// bars go to stderr. Colours are dropped when a stream isn't a TTY or NO_COLOR
// is set. Prompts use gum (https://github.com/charmbracelet/gum) when it is
// installed and fall back to plain readline otherwise; with no terminal they
// return the default instead of blocking.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

// ----- Colour palette ------------------------------------------------------

export interface Palette {
  reset: string;
  bold: string;
  dim: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
}

const NO_COLOR = Boolean(process.env.NO_COLOR);

function palette(stream: NodeJS.WriteStream): Palette {
  const on = stream.isTTY && !NO_COLOR;
  const c = (code: number): string => (on ? `\x1b[${String(code)}m` : "");
  return {
    reset: c(0),
    bold: c(1),
    dim: c(2),
    red: c(31),
    green: c(32),
    yellow: c(33),
    blue: c(34),
    magenta: c(35),
    cyan: c(36),
  };
}

export const C = palette(process.stdout);
const E = palette(process.stderr);

// ----- Output helpers ------------------------------------------------------

export function heading(text: string, emoji = "›"): void {
  console.log(`\n${C.bold}${C.cyan}${emoji} ${text}${C.reset}`);
}
export function info(text: string, emoji = "•"): void {
  console.log(`${C.blue}${emoji}${C.reset} ${text}`);
}
export function success(text: string, emoji = "✅"): void {
  console.log(`${C.green}${emoji}${C.reset} ${text}`);
}
export function warn(text: string, emoji = "⚠️ "): void {
  console.error(`${E.yellow}${emoji}${E.reset} ${text}`);
}
export function error(text: string, emoji = "❌"): void {
  console.error(`${E.red}${emoji}${E.reset} ${text}`);
}
export function dim(text: string): void {
  console.log(`${C.dim}${text}${C.reset}`);
}
export function stat(label: string, value: number | string): void {
  console.log(`${C.magenta}📊 ${C.bold}${String(value)}${C.reset}${C.magenta} ${label}${C.reset}`);
}

// die(message, code) — print an error and exit.
export function die(message: string, code = 1): never {
  error(message);
  process.exit(code);
}

// errorMessage(err) — the message of anything thrown.
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// prog() — the command name as typed (tools run via symlinks/aliases).
export function prog(): string {
  return path.basename(process.argv[1] ?? "tool");
}

// ----- Formatting ----------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${String(Math.round((bytes / 1024 ** i) * 100) / 100)} ${units[i] ?? "B"}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  if (m < 60) return `${String(m)}m ${String(rest).padStart(2, "0")}s`;
  return `${String(Math.floor(m / 60))}h ${String(m % 60).padStart(2, "0")}m`;
}

// sizeChange(before, after) — "1.2 MB → 300 KB (−75.0%)", coloured.
export function sizeChange(before: number, after: number): string {
  const pct = before > 0 ? (1 - after / before) * 100 : 0;
  const colour = pct >= 0 ? C.green : C.yellow;
  const sign = pct >= 0 ? "−" : "+";
  return `${formatBytes(before)} → ${formatBytes(after)} ${colour}(${sign}${Math.abs(pct).toFixed(1)}%)${C.reset}`;
}

// ----- Activity feedback ---------------------------------------------------

const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

// What a withSpinner callback may return: `label` replaces the completion text.
export interface SpinnerResult {
  label?: string;
}

// withSpinner(label, fn) — run an async fn with a spinner on stderr.
// fn may return { label } to replace the completion line's text.
// On success prints "✅ label (elapsed)"; on failure "❌ label" and rethrows.
export async function withSpinner<T extends SpinnerResult | undefined>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  const tty = process.stderr.isTTY;
  let timer: NodeJS.Timeout | undefined;
  if (tty) {
    let i = 0;
    process.stderr.write("\x1b[?25l");
    timer = setInterval(() => {
      const frame = FRAMES[i++ % FRAMES.length] ?? "";
      process.stderr.write(`\r\x1b[2K${E.cyan}${frame}${E.reset} ${label}`);
    }, 80);
  } else {
    console.error(`⏳ ${label}`);
  }
  const clear = (): void => {
    if (!tty) return;
    clearInterval(timer);
    process.stderr.write("\r\x1b[2K\x1b[?25h");
  };
  try {
    const result = await fn();
    clear();
    const text = result?.label ?? label;
    success(`${text} ${C.dim}(${formatDuration(Date.now() - started)})${C.reset}`);
    return result;
  } catch (err) {
    clear();
    error(label);
    throw err;
  }
}

export interface ProgressBar {
  update(fraction: number, extra?: string): void;
  done(): void;
}

// progressBar(label) — returns { update(fraction, extra), done() } that draws
// "label ━━━━━━──── 42% extra" on stderr (TTY only; otherwise silent).
export function progressBar(label: string, width = 28): ProgressBar {
  const tty = process.stderr.isTTY;
  if (tty) process.stderr.write("\x1b[?25l");
  return {
    update(fraction: number, extra = ""): void {
      if (!tty) return;
      const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
      const filled = Math.round(f * width);
      const bar = `${E.magenta}${"━".repeat(filled)}${E.reset}${E.dim}${"━".repeat(width - filled)}${E.reset}`;
      const pct = `${(f * 100).toFixed(0).padStart(3)}%`;
      const tail = extra ? ` ${E.dim}${extra}${E.reset}` : "";
      process.stderr.write(`\r\x1b[2K   ${label} ${bar} ${pct}${tail}`);
    },
    done(): void {
      if (tty) process.stderr.write("\r\x1b[2K\x1b[?25h");
    },
  };
}

// ----- Prompts -------------------------------------------------------------

const HAVE_GUM = spawnSync("gum", ["--version"], { stdio: "ignore" }).status === 0;

function ttyOk(): boolean {
  try {
    fs.closeSync(fs.openSync("/dev/tty", "r"));
    return true;
  } catch {
    return false;
  }
}

function askLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const input = fs.createReadStream("/dev/tty");
    const rl = readline.createInterface({ input, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      input.destroy();
      resolve(answer);
    });
  });
}

// confirm(question, defaultYes) — yes/no. Returns the default with no terminal.
export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  if (!ttyOk()) return defaultYes;
  if (HAVE_GUM) {
    const r = spawnSync("gum", ["confirm", question, `--default=${String(defaultYes)}`], {
      stdio: "inherit",
    });
    return r.status === 0;
  }
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  for (;;) {
    const reply = (await askLine(`${E.yellow}❓${E.reset} ${question} ${hint} `))
      .trim()
      .toLowerCase();
    if (!reply) return defaultYes;
    if (["y", "yes"].includes(reply)) return true;
    if (["n", "no"].includes(reply)) return false;
    warn("Please answer y or n.");
  }
}

// choose(header, options) — single select. Returns the index, or -1 if
// cancelled or there is no terminal.
export async function choose(header: string, options: readonly string[]): Promise<number> {
  if (!ttyOk() || options.length === 0) return -1;
  if (HAVE_GUM) {
    const r = spawnSync("gum", ["choose", "--header", header, "--cursor", "❯ "], {
      input: options.join("\n"),
      stdio: ["pipe", "pipe", "inherit"],
      encoding: "utf8",
    });
    if (r.status !== 0) return -1;
    return options.indexOf(r.stdout.trim());
  }
  console.error(`${E.yellow}❓${E.reset} ${header}`);
  options.forEach((o, i) => {
    console.error(`   ${E.cyan}${String(i + 1)}${E.reset}) ${o}`);
  });
  const reply = (await askLine(`   Choose 1-${String(options.length)} (blank to cancel): `)).trim();
  const n = Number.parseInt(reply, 10);
  return n >= 1 && n <= options.length ? n - 1 : -1;
}
