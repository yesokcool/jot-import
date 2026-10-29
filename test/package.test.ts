import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json")) as { version: string; devDependencies: Record<string, string> };
const lock = JSON.parse(read("package-lock.json")) as {
  version: string;
  packages: Record<string, { version?: string; devDependencies?: Record<string, string> }>;
};

test("no builtin-modules package: Obsidian's review rejects it, Node's own list does the job", () => {
  // The review bot's depend/ban-dependencies rule; `npm run lint` runs it on package.json too.
  assert.ok(!("builtin-modules" in pkg.devDependencies));
  assert.ok(!("node_modules/builtin-modules" in lock.packages));
  assert.match(read("esbuild.config.mjs"), /import \{ builtinModules \} from "node:module";/);
  assert.doesNotMatch(read("esbuild.config.mjs"), /builtin-modules/);
});

test("package-lock.json agrees with package.json, as npm ci requires", () => {
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.deepEqual(lock.packages[""].devDependencies, pkg.devDependencies);
  for (const name of Object.keys(pkg.devDependencies)) assert.ok(`node_modules/${name}` in lock.packages, name);
});

test("one version everywhere: manifest, versions.json, package.json, package-lock.json", () => {
  // Obsidian reads manifest.json; the release tag must equal its version.
  const manifest = JSON.parse(read("manifest.json")) as { version: string; minAppVersion: string };
  const versions = JSON.parse(read("versions.json")) as Record<string, string>;
  assert.equal(pkg.version, manifest.version);
  assert.equal(lock.version, manifest.version);
  assert.equal(versions[manifest.version], manifest.minAppVersion);
});
