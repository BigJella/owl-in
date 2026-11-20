#!/usr/bin/env node
/**
 * Builds the hackathon presentation into ONE self-contained HTML file (for Google Drive / judges):
 *
 *   node scripts/build-presentation.mjs        (npm run present:build)
 *
 * presentation/src/deck.html is the template. This inlines deck.css, deck.js, sample-data.js, the vendored QR encoder
 * and the Inter / Oswald fonts (as data: URIs), fills in repo stats ({{commits}}, {{tests}}, {{tsLines}}, {{files}})
 * and dependency versions ({{v:react}}, ...), and writes presentation/owl-in.html.
 * The game server serves that file at http://localhost:3000/present (same origin as the API = live data).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "presentation", "src");
const OUT = join(ROOT, "presentation", "owl-in.html");
const read = (path) => readFileSync(path, "utf8");
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

// ---------- fonts (same files the owl-live page uses, from @fontsource) ----------
const FONTS = [
  ["Inter", 400, "inter-latin-400-normal.woff2"],
  ["Inter", 500, "inter-latin-500-normal.woff2"],
  ["Inter", 600, "inter-latin-600-normal.woff2"],
  ["Oswald", 400, "oswald-latin-400-normal.woff2"],
  ["Oswald", 500, "oswald-latin-500-normal.woff2"],
  ["Oswald", 600, "oswald-latin-600-normal.woff2"],
];
const fontCss = FONTS.map(([family, weight, file]) => {
  const data = readFileSync(join(ROOT, "it", "owl-live", "fonts", file)).toString("base64");
  return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${data}) format("woff2")}`;
}).join("\n");

// ---------- stats ----------
const tracked = git("ls-files").split("\n").filter(Boolean);
const tsFiles = tracked.filter((f) => /\.(ts|tsx)$/.test(f));
const tsLines = tsFiles.reduce((sum, f) => sum + read(join(ROOT, f)).split("\n").length, 0);
const testFiles = tracked.filter((f) => /\.test\.ts$/.test(f));
const tests = testFiles.reduce((sum, f) => sum + (read(join(ROOT, f)).match(/^\s*(it|test)(\.each\([^)]*\))?\(/gm) ?? []).length, 0);
const commits = Number(git("rev-list", "--count", "HEAD"));
const round = (n, to) => `${Math.floor(n / to) * to}+`;
const stats = {
  commits: String(commits),
  tests: round(tests, 10),
  tsLines: `${Math.round(tsLines / 1000)}k`,
  files: String(tracked.length),
};

// ---------- versions (from the lockfile) ----------
const lock = JSON.parse(read(join(ROOT, "package-lock.json"))).packages;
const version = (name) => {
  if (name === "node") return process.versions.node.split(".")[0];
  const v = lock[`node_modules/${name}`]?.version;
  if (!v) throw new Error(`No version for ${name} in package-lock.json`);
  return v.split(".").slice(0, 2).join(".");
};

// ---------- assemble ----------
const scripts = {
  qrcode: read(join(SRC, "vendor", "qrcode.js")),
  sample: read(join(SRC, "sample-data.js")),
  deck: read(join(SRC, "deck.js")),
};
for (const [name, code] of Object.entries(scripts)) {
  if (/<\/script/i.test(code)) throw new Error(`${name} contains "</script", which would end the inline script early`);
}

// Fill the template's own placeholders first, then inline the code (so nothing inside the code is mistaken for one).
const template = read(join(SRC, "deck.html"))
  .replace(/\{\{v:([^}]+)\}\}/g, (_, name) => version(name))
  .replace(/\{\{(\w+)\}\}/g, (match, key) => stats[key] ?? match);
const leftover = template.match(/\{\{[^}]*\}\}/);
if (leftover) throw new Error(`Unfilled placeholder: ${leftover[0]}`);

// Function replacers: the inlined code contains "$" sequences that String.replace would otherwise interpret.
const html = template
  .replace("/*@fonts*/", () => fontCss)
  .replace("/*@css*/", () => read(join(SRC, "deck.css")))
  .replace("/*@qrcode*/", () => scripts.qrcode)
  .replace("/*@sample*/", () => scripts.sample)
  .replace("/*@deck*/", () => scripts.deck);
writeFileSync(OUT, html);
console.log(`Wrote ${OUT} (${Math.round(html.length / 1024)} kB): ${stats.commits} commits, ${tests} tests, ${tsLines} TS lines, ${stats.files} files.`);
