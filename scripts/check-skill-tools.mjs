import { readFile } from "node:fs/promises";

const read = (rel) => readFile(new URL(`../${rel}`, import.meta.url), "utf8");

const PLUGIN = "packages/opencode/src/plugin.ts";
const PORTABLE_SKILL = "packages/skill/SKILL.md";
const TEMPLATE_SKILL = "packages/core/templates/skills/browser-automation/SKILL.md";
const OPENCODE_SKILL = ".opencode/skills/browser-automation/SKILL.md";

const pluginSource = await read(PLUGIN);
const pluginTools = new Set([...pluginSource.matchAll(/^\s*(browser_[a-z0-9_]+)\s*:\s*tool\s*\(/gm)].map((m) => m[1]));
const problems = [];

if (pluginTools.size === 0) problems.push(`No browser tools found in ${PLUGIN}`);

const mentioned = (source) => new Set(source.match(/\bbrowser_[a-z0-9_]+\b/g) ?? []);

// The portable skill is the full reference: every tool must be documented there.
const portable = await read(PORTABLE_SKILL);
for (const name of pluginTools) {
  if (!mentioned(portable).has(name)) problems.push(`${PORTABLE_SKILL} does not document ${name}`);
}

// No skill copy may reference a tool that does not exist.
const template = await read(TEMPLATE_SKILL);
const opencode = await read(OPENCODE_SKILL);
for (const [file, source] of [[PORTABLE_SKILL, portable], [TEMPLATE_SKILL, template], [OPENCODE_SKILL, opencode]]) {
  for (const name of mentioned(source)) {
    if (!pluginTools.has(name)) problems.push(`${file} mentions ${name}, which is not a tool`);
  }
}

// The checked-in OpenCode skill is a copy of the template.
if (template !== opencode) problems.push(`${OPENCODE_SKILL} differs from ${TEMPLATE_SKILL}; copy the template over it`);

if (problems.length) {
  for (const problem of problems) console.error(`- ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`Skills document all ${pluginTools.size} browser tools; skill copies are in sync.`);
}
