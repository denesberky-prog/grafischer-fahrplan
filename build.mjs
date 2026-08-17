// Bundles src/main.jsx (+ App.jsx) and React/ReactDOM into a single inline
// <script>, then wraps it in the standalone HTML shell used for this tool.
// Run: npm install && node build.mjs  (outputs grafischer-fahrplan.html,
// the file actually opened in a browser)
import esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const result = await esbuild.build({
  entryPoints: [path.join(__dirname, "src/main.jsx")],
  bundle: true,
  write: false,
  minify: true,
  format: "iife",
  target: "es2019",
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".js": "jsx" },
});

const js = result.outputFiles[0].text;

const html = `<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Grafischer Fahrplan</title></head>
<body>
<div id="root"></div>
<script>
${js}
</script>
</body>
</html>
`;

const outPath = path.join(__dirname, "grafischer-fahrplan.html");
fs.writeFileSync(outPath, html);
console.log("Built grafischer-fahrplan.html (" + (html.length / 1024).toFixed(0) + " KB)");
