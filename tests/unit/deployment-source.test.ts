import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];

function repository() {
  const root = mkdtempSync(join(tmpdir(), "envoy-deployment-source-"));
  fixtures.push(root);
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git("init", "-q");
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "src"));
  copyFileSync(new URL("../../scripts/check-deployment-source.sh", import.meta.url), join(root, "scripts/check-deployment-source.sh"));
  writeFileSync(join(root, ".gitignore"), ".env.production\ndocker-compose.yml\n");
  writeFileSync(join(root, "src/current.ts"), "export const current = true;\n");
  git("add", ".");
  git("-c", "user.name=Deployment Test", "-c", "user.email=deployment@example.test", "-c", "commit.gpgsign=false", "commit", "-qm", "Initial source");
  return { root, git, check: () => spawnSync("sh", ["scripts/check-deployment-source.sh"], { cwd: root, encoding: "utf8" }) };
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("deployment source preflight", () => {
  it("accepts a clean commit with ignored server configuration", () => {
    const fixture = repository();
    writeFileSync(join(fixture.root, ".env.production"), "SERVER_CONFIGURATION=local\n");
    writeFileSync(join(fixture.root, "docker-compose.yml"), "services: {}\n");
    const result = fixture.check();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Deployment source verified:");
  });

  it("rejects an untracked retired route without deleting or changing it", () => {
    const fixture = repository();
    const path = "src/app/api/v1/inbound-messages/[id]/document-reprojection/route.ts";
    mkdirSync(join(fixture.root, path, ".."), { recursive: true });
    writeFileSync(join(fixture.root, path), "export const retired = true;\n");
    const result = fixture.check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`?? ${path}`);
    expect(existsSync(join(fixture.root, path))).toBe(true);
    expect(result.stderr).toContain("No files were changed or deleted");
  });

  it("rejects tracked edits and staged deletions before building", () => {
    const fixture = repository();
    writeFileSync(join(fixture.root, "src/current.ts"), "export const current = false;\n");
    expect(fixture.check().status).toBe(1);
    fixture.git("rm", "-f", "src/current.ts");
    const result = fixture.check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("D  src/current.ts");
  });
});
