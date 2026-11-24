// Bundles the browser client into dist/client/assets (served by Workers Assets).
// The output holds code and styles only: no data, no secrets.
import { build } from "esbuild";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";

const out = "dist/client";
await rm(out, { recursive: true, force: true });
await mkdir(`${out}/assets`, { recursive: true });

await build({
  entryPoints: ["client/main.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: false,
  legalComments: "none",
  outfile: `${out}/assets/app.js`,
  logLevel: "warning",
});

await build({
  entryPoints: ["client/styles.css"],
  bundle: true,
  minify: true,
  outfile: `${out}/assets/app.css`,
  logLevel: "warning",
});

await copyFile("client/login.css", `${out}/assets/login.css`);
await copyFile("client/favicon.svg", `${out}/assets/favicon.svg`);

// Headers for static files served directly by Workers Assets.
await writeFile(
  `${out}/_headers`,
  [
    "/assets/*",
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: same-origin",
    "  Cache-Control: no-cache",
    "",
  ].join("\n"),
);
console.log("client built -> dist/client/assets");
