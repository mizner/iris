import { readFile } from "node:fs/promises";

const pluginPath = new URL("../packages/opencode/src/plugin.ts", import.meta.url);
const skillPath = new URL("../packages/skill/SKILL.md", import.meta.url);

const pluginSource = await readFile(pluginPath, "utf8");
const skillSource = await readFile(skillPath, "utf8");

const toolPattern = /^\s*(browser_[a-z0-9_]+)\s*:\s*tool\s*\(/gm;
const pluginTools = new Set(
  [...pluginSource.matchAll(toolPattern)].map((match) => match[1]),
);

if (pluginTools.size === 0) {
  console.error(`No browser tools found in ${pluginPath.pathname}`);
  process.exitCode = 1;
} else {
  const documentedTools = new Set(
    skillSource.match(/\bbrowser_[a-z0-9_]+\b/g) ?? [],
  );
  const missingTools = [...pluginTools].filter(
    (toolName) => !documentedTools.has(toolName),
  );

  if (missingTools.length > 0) {
    console.error("Missing browser tools in packages/skill/SKILL.md:");
    for (const toolName of missingTools) {
      console.error(`- ${toolName}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`Skill documents all ${pluginTools.size} browser tools.`);
  }
}
