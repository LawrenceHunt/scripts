// ui.mjs — shared styling, output and prompt helpers for node tools.
//
// Mirrors bash/lib/common.sh so every tool feels like the same family:
//
//   import { heading, info, success, withSpinner } from "../lib/ui.mjs";
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

const NO_COLOR = Boolean(process.env.NO_COLOR);

function palette(stream) {
  const on = stream.isTTY && !NO_COLOR;
  const c = (code) => (on ? `\x1b[${code}m` : "");
  return {
    reset: c(0), bold: c(1), dim: c(2), red: c(31), green: c(32),
    yellow: c(33), blue: c(34), magenta: c(35), cyan: c(36),
  };
}

export const C = palette(process.stdout);
const E = palette(process.stderr);

// ----- Output helpers ------------------------------------------------------

export const heading = (text, emoji = "›") =>
  console.log(`\n${C.bold}${C.cyan}${emoji} ${text}${C.reset}`);
export const info = (text, emoji = "•") => console.log(`${C.blue}${emoji}${C.reset} ${text}`);
export const success = (text, emoji = "✅") => console.log(`${C.green}${emoji}${C.reset} ${text}`);
export const warn = (text, emoji = "⚠️ ") => console.error(`${E.yellow}${emoji}${E.reset} ${text}`);
export const error = (text, emoji = "❌") => console.error(`${E.red}${emoji}${E.reset} ${text}`);
export const dim = (text) => console.log(`${C.dim}${text}${C.reset}`);
export const stat = (label, value) =>
  console.log(`${C.magenta}📊 ${C.bold}${value}${C.reset}${C.magenta} ${label}${C.reset}`);

// die(message, code) — print an error and exit.
export function die(message, code = 1) {
  error(message);
  process.exit(code);
}

// prog() — the command name as typed (tools run via symlinks/aliases).
export const prog = () => path.basename(process.argv[1] || "tool");

// ----- Formatting ----------------------------------------------------------

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${Math.round((bytes / 1024 ** i) * 100) / 100} ${units[i]}`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  if (m < 60) return `${m}m ${String(rest).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

// sizeChange(before, after) — "1.2 MB → 300 KB (−75.0%)", coloured.
export function sizeChange(before, after) {
  const pct = before > 0 ? (1 - after / before) * 100 : 0;
  const colour = pct >= 0 ? C.green : C.yellow;
  const sign = pct >= 0 ? "−" : "+";
  return `${formatBytes(before)} → ${formatBytes(after)} ${colour}(${sign}${Math.abs(pct).toFixed(1)}%)${C.reset}`;
}

// ----- Activity feedback ---------------------------------------------------

const FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

// withSpinner(label, fn) — run an async fn with a spinner on stderr.
// fn may return { label } to replace the completion line's text.
// On success prints "✅ label (elapsed)"; on failure "❌ label" and rethrows.
export async function withSpinner(label, fn) {
  const started = Date.now();
  const tty = process.stderr.isTTY;
  let timer;
  if (tty) {
    let i = 0;
    process.stderr.write("\x1b[?25l");
    timer = setInterval(() => {
      process.stderr.write(`\r\x1b[2K${E.cyan}${FRAMES[i++ % FRAMES.length]}${E.reset} ${label}`);
    }, 80);
  } else {
    console.error(`⏳ ${label}`);
  }
  const clear = () => {
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

// progressBar(label) — returns { update(fraction, extra), done() } that draws
// "label ━━━━━━──── 42% extra" on stderr (TTY only; otherwise silent).
export function progressBar(label, width = 28) {
  const tty = process.stderr.isTTY;
  if (tty) process.stderr.write("\x1b[?25l");
  return {
    update(fraction, extra = "") {
      if (!tty) return;
      const f = Math.max(0, Math.min(1, fraction || 0));
      const filled = Math.round(f * width);
      const bar = `${E.magenta}${"━".repeat(filled)}${E.reset}${E.dim}${"━".repeat(width - filled)}${E.reset}`;
      const pct = `${(f * 100).toFixed(0).padStart(3)}%`;
      process.stderr.write(`\r\x1b[2K   ${label} ${bar} ${pct}${extra ? ` ${E.dim}${extra}${E.reset}` : ""}`);
    },
    done() {
      if (tty) process.stderr.write("\r\x1b[2K\x1b[?25h");
    },
  };
}

// ----- Prompts -------------------------------------------------------------

const HAVE_GUM = spawnSync("gum", ["--version"], { stdio: "ignore" }).status === 0;

function ttyOk() {
  try {
    fs.closeSync(fs.openSync("/dev/tty", "r"));
    return true;
  } catch {
    return false;
  }
}

function askLine(question) {
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
export async function confirm(question, defaultYes = false) {
  if (!ttyOk()) return defaultYes;
  if (HAVE_GUM) {
    const r = spawnSync("gum", ["confirm", question, `--default=${defaultYes}`], { stdio: "inherit" });
    return r.status === 0;
  }
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  for (;;) {
    const reply = (await askLine(`${E.yellow}❓${E.reset} ${question} ${hint} `)).trim().toLowerCase();
    if (!reply) return defaultYes;
    if (["y", "yes"].includes(reply)) return true;
    if (["n", "no"].includes(reply)) return false;
    warn("Please answer y or n.");
  }
}

// choose(header, options) — single select. Returns the index, or -1 if
// cancelled or there is no terminal.
export async function choose(header, options) {
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
  options.forEach((o, i) => console.error(`   ${E.cyan}${i + 1}${E.reset}) ${o}`));
  const reply = (await askLine(`   Choose 1-${options.length} (blank to cancel): `)).trim();
  const n = Number.parseInt(reply, 10);
  return n >= 1 && n <= options.length ? n - 1 : -1;
}
