# AGENTS.md

## Project Info
**homebridge-tapo-camera** is a Homebridge plugin designed to integrate TP-Link TAPO security cameras into the Apple HomeKit ecosystem.

## Development & Publishing
- The project is written in TypeScript and uses `npm`.
- **Publishing to npm:** Do NOT run `npm publish` locally. Every non-automation commit pushed to `main` runs `.github/workflows/publish.yml`, which increments the patch version, publishes to npm through OIDC, pushes the version commit and tag, and creates a GitHub Release with generated notes.
- The workflow's own `chore: release` commit is intentionally excluded from starting another release.
