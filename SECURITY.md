# Security Policy

Iris is a local browser automation runtime. It can expose real browser state to whichever agent, harness, or MCP client you connect to it.

## Supported Versions

This repository tracks the current source version. Security fixes should target `main`.

## Reporting A Vulnerability

Open a private security advisory on GitHub if available, or contact the maintainer directly. Do not file a public issue with secrets, private URLs, screenshots, cookies, browser dumps, or exploit details.

## Local Risk Model

- The broker listens on a same-user Unix socket under `~/.iris`.
- Iris does not provide network authentication or multi-user isolation.
- Any local process that can access the socket may be able to control the connected browser.
- The extension can access broad browser APIs and `<all_urls>` because browser automation requires it.

Use Iris only with agent systems and local users you trust.

## What Not To Commit

- `~/.iris` runtime files.
- Browser profiles, cookies, auth files, or token stores.
- Captured tab lists, screenshots, downloads, or run evidence.
- Private machine names, private hostnames, internal URLs, or account-specific docs.
- `.sisyphus/`, `.codex-orchestrator.json`, and other local agent scratch files.
