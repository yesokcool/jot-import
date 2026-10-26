import { readFileSync, writeFileSync } from "fs";

// `npm version x.y.z` runs this: copy the new version into manifest.json and
// record its minAppVersion in versions.json. The git tag has no "v" prefix
// (.npmrc) because Obsidian requires the tag to equal the manifest version.
const targetVersion = process.env.npm_package_version;

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
if (!(targetVersion in versions)) {
  versions[targetVersion] = minAppVersion;
  writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");
}
