import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export function checkRelease(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (manifest.name !== "SpaceCast" || pkg.version !== manifest.version) throw new Error("Product metadata does not match");
  if (pkg.license !== "MIT") throw new Error("Missing MIT package declaration");
  const references = [manifest.action.default_popup, manifest.options_ui.page,
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap(entry => [...entry.js, ...entry.css]),
    ...manifest.web_accessible_resources.flatMap(entry => entry.resources),
    "LICENSE", "README.md", "PRIVACY.md", "THIRD_PARTY_NOTICES.md", "licenses/Apache-2.0.txt", "js/hls.js/LICENCE"];
  function localFile(relative) {
    const resolved = path.resolve(root, relative);
    const within = path.relative(root, resolved);
    if (!within || within.startsWith("..") || path.isAbsolute(within) || !fs.statSync(resolved).isFile()) {
      throw new Error(`Missing or unsafe file reference: ${relative}`);
    }
    return resolved;
  }
  for (const reference of references) localFile(reference);
  for (const file of ["html/popup.html", "html/options.html"]) {
    const text = fs.readFileSync(localFile(file), "utf8");
    if (!text.includes(manifest.version)) throw new Error(`UI version is out of sync: ${file}`);
    for (const match of text.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      if (/^(?:https?:|#|data:)/.test(match[1])) continue;
      localFile(path.join(path.dirname(file), match[1]));
    }
  }
  const scripts = [];
  function walk(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:js|cjs|mjs)$/.test(entry.name)) scripts.push(file);
    }
  }
  walk(path.join(root, "js"));
  walk(path.join(root, "tools"));
  for (const script of scripts) {
    const result = spawnSync(process.execPath, ["--check", script], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(result.stderr || `Syntax check failed: ${script}`);
  }
  console.log(`Release check passed: ${new Set(references).size} required files, ${scripts.length} JavaScript files`);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) checkRelease(root);
