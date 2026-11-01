#!/usr/bin/env -S mise exec node@22 -- node

import fs from "node:fs";
import path from "node:path";
import { Logger, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import {
  dedup,
  textureCompress,
  prune,
  quantize,
  simplify,
  meshopt,
  weld,
  reorder,
} from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import {
  C,
  die,
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

const USAGE = `Usage:
  ${prog()} <input-file-or-folder> [output-file-or-folder]

Shrinks .glb models: prune, dedup, weld, reorder, quantize, simplify to 20% of
triangles, meshopt compression, and webp textures resized to 1024px.

  ${prog()} model.glb                  writes model.optimized.glb
  ${prog()} model.glb out.glb
  ${prog()} ./models                   writes ./models/optimized/*.glb
  ${prog()} ./models ./dist`;

const [, , inputPath, outputPath] = process.argv;

if (inputPath === "-h" || inputPath === "--help") {
  console.log(USAGE);
  process.exit(0);
}

if (!inputPath) {
  console.error(USAGE);
  process.exit(1);
}

if (!fs.existsSync(inputPath)) die(`Input not found: ${inputPath}`);

// Register every glTF extension so the ones the transforms add (meshopt
// compression, quantization, webp textures) are actually written, and inputs
// that already use them can be read. Without this they're silently dropped.
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "meshopt.decoder": MeshoptDecoder,
  "meshopt.simplifier": MeshoptSimplifier,
  "meshopt.encoder": MeshoptEncoder,
});

interface Result {
  inputSize: number;
  outputSize: number;
}

async function optimizeGLB(inputFile: string, outputFile: string): Promise<Result> {
  const name = path.basename(inputFile);
  const result: Result = { inputSize: 0, outputSize: 0 };
  await withSpinner(name, async () => {
    // Read the GLB file
    const document = await io.read(inputFile);
    // Keep gltf-transform's per-step info logs from breaking the spinner line.
    document.setLogger(new Logger(Logger.Verbosity.WARN));

    // Apply optimizations
    await document.transform(
      // Remove unused data (materials, meshes, nodes, etc.)
      prune(),
      // Remove duplicate data
      dedup(),
      // Weld vertices to improve compression
      weld(),
      // Reorder mesh data for better compression
      reorder({ encoder: MeshoptEncoder }),
      // Quantize vertex attributes to reduce precision (saves significant space)
      // More aggressive quantization for better compression
      quantize({
        quantizePosition: 13, // More aggressive: 13 bits instead of 14
        quantizeNormal: 9, // More aggressive: 9 bits instead of 10
        quantizeTexcoord: 11, // More aggressive: 11 bits instead of 12
        quantizeColor: 8, // 8 bits for colors
        quantizeWeight: 8, // 8 bits for skin weights
      }),
      // Simplify meshes (reduces polygon count) - extremely aggressive
      simplify({
        simplifier: MeshoptSimplifier,
        ratio: 0.2, // Keep only 20% of triangles (extremely aggressive for max reduction)
        error: 0.003, // Higher error threshold for maximum reduction
      }),
      // Use meshopt compression (often better compression than Draco)
      meshopt({
        encoder: MeshoptEncoder,
        level: "high", // "high" = best compression, "medium" = balanced, "low" = faster
      }),
      // Compress textures more aggressively (matches CLI --texture-compress webp --texture-resize 2048)
      textureCompress({
        targetFormat: "webp",
        quality: 0.4, // Extremely aggressive compression for maximum size reduction
        resize: [1024, 1024], // Even smaller textures: 1024x1024 instead of 2048x2048
      }),
    );

    // Write the optimized GLB
    await io.write(outputFile, document);

    result.inputSize = fs.statSync(inputFile).size;
    result.outputSize = fs.statSync(outputFile).size;
    return {
      label: `${name} → ${path.basename(outputFile)}  ${sizeChange(result.inputSize, result.outputSize)}`,
    };
  });
  return result;
}

function printHeader(input: string, output: string, count: number): void {
  heading(`${prog()} · optimising 3D models`, "🧊");
  info(`Input:    ${C.bold}${input}${C.reset}`);
  info(`Output:   ${C.bold}${output}${C.reset}`);
  info("Settings: simplify 20% · quantize · meshopt high · webp textures ≤1024px");
  info(`Found ${String(count)} model(s)`, "🔍");
  console.log();
}

const started = Date.now();

async function processPath(inputPath: string, outputPath: string | undefined): Promise<Result[]> {
  const stats = fs.statSync(inputPath);

  if (stats.isFile()) {
    // Single file
    if (!inputPath.toLowerCase().endsWith(".glb")) {
      die("Input file must be a .glb file");
    }

    const output = outputPath ?? inputPath.replace(/\.glb$/i, ".optimized.glb");
    printHeader(inputPath, output, 1);
    const result = await optimizeGLB(inputPath, output);
    return [result];
  } else if (stats.isDirectory()) {
    // Directory of files
    const files = fs
      .readdirSync(inputPath)
      .filter((file) => file.toLowerCase().endsWith(".glb"))
      .map((file) => path.join(inputPath, file));

    if (files.length === 0) {
      warn("No .glb files found in directory.");
      process.exit(0);
    }

    const outputDir = outputPath ?? path.join(inputPath, "optimized");
    fs.mkdirSync(outputDir, { recursive: true });
    printHeader(inputPath, outputDir, files.length);

    const results: Result[] = [];
    for (const file of files) {
      const outputFile = path.join(outputDir, path.basename(file));
      results.push(await optimizeGLB(file, outputFile));
    }
    return results;
  } else {
    die("Input path must be a file or directory");
  }
}

processPath(inputPath, outputPath)
  .then((results) => {
    const totalIn = results.reduce((sum, r) => sum + r.inputSize, 0);
    const totalOut = results.reduce((sum, r) => sum + r.outputSize, 0);
    console.log();
    stat("optimised", results.length);
    info(`Total: ${sizeChange(totalIn, totalOut)}`, "📦");
    if (totalIn > totalOut)
      info(`Saved ${C.bold}${formatBytes(totalIn - totalOut)}${C.reset}`, "💾");
    success(`Done in ${formatDuration(Date.now() - started)}. 🎉`);
  })
  .catch((err: unknown) => {
    die(errorMessage(err));
  });
