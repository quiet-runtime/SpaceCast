import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkRelease } from "./check-release.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeFolders = ["js", "css", "html", "icon", "licenses"];
const documents = ["LICENSE", "README.md", "PRIVACY.md", "THIRD_PARTY_NOTICES.md"];

export function build(browser) {
  if (!["chrome", "firefox"].includes(browser)) throw new Error("Unknown browser target");
  checkRelease(root);
  const out = path.resolve(root, "build", browser);
  if (path.relative(root, out) !== path.join("build", browser)) throw new Error("Unsafe build path");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const folder of runtimeFolders) fs.cpSync(path.join(root, folder), path.join(out, folder), { recursive: true });
  for (const name of documents) fs.copyFileSync(path.join(root, name), path.join(out, name));

  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  if (browser === "firefox") {
    manifest.browser_specific_settings = {
      gecko: {
        id: "{27d681e6-1216-4f07-af0c-0e20d60f2ed1}",
        strict_min_version: "142.0",
        data_collection_permissions: { required: ["none"] },
      },
    };
  }
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Built ${path.relative(root, out)} — SpaceCast ${manifest.version}`);
}
