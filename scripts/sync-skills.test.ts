import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseSkill, readSharedSkills, SHARED_DIR, staleFiles } from "./sync-skills";

const root = resolve(import.meta.dir, "..");

describe("shared agent skills", () => {
  test("every shared skill has valid, portable frontmatter", () => {
    const skills = readSharedSkills(root);
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      // Only the fields every agent understands, so no tool needs its own copy.
      const keys = skill.frontmatter.split("\n").map((line) => line.match(/^([a-z-]+):/)?.[1]).filter(Boolean);
      expect(keys.every((key) => ["name", "description", "license", "compatibility", "metadata"].includes(key!))).toBe(true);
    }
  });

  test("Claude pointers match the shared skills", () => {
    // Fix with `bun run scripts/sync-skills.ts`.
    expect(staleFiles(root)).toEqual([]);
  });

  test("relative links inside shared skills resolve", () => {
    const broken: string[] = [];
    for (const skill of readSharedSkills(root)) {
      const folder = join(root, SHARED_DIR, skill.dir);
      const files = ["SKILL.md", ...listMarkdown(join(folder, "references")).map((f) => join("references", f))];
      for (const file of files) {
        const text = readFileSync(join(folder, file), "utf8");
        for (const [, target = ""] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
          if (/^[a-z]+:/i.test(target)) continue;
          if (!existsSync(resolve(dirname(join(folder, file)), target))) broken.push(`${skill.dir}/${file} -> ${target}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test("rejects a name that does not match its folder", () => {
    expect(() => parseSkill("battle-scene", "---\nname: maps\ndescription: x\n---\n")).toThrow();
  });
});

function listMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md"));
}
