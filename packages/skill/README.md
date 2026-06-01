# @mizner/iris-skill

Portable agent skill for Iris.

The skill explains when to use Iris, how to choose between OpenCode, MCP, and CLI integration modes, and how to use the `browser_*` tools safely.

## Install

```bash
bash packages/skill/install.sh
```

The installer creates:

```text
~/.agents/skills/iris/SKILL.md -> <repo>/packages/skill/SKILL.md
```

The installer is idempotent and safe to rerun.

## Validation

```bash
bash packages/skill/install.sh
readlink ~/.agents/skills/iris/SKILL.md
```
