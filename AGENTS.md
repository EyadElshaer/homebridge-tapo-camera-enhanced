# AGENTS.md

## Project Info
**homebridge-tapo-camera** is a Homebridge plugin designed to integrate TP-Link TAPO security cameras into the Apple HomeKit ecosystem.

## Development & Publishing
- The project is written in TypeScript and uses `npm`.
- **Publishing to npm:** Do NOT run `npm publish` locally. The project uses a GitHub Actions workflow (`.github/workflows/publish.yml`) that automatically publishes to npm via OIDC when a new version tag (e.g., `v2.9.0`) is pushed to GitHub. 
- To release a new version, simply use `npm version <major|minor|patch>` and push the resulting commit and tag to GitHub (`git push --follow-tags`).
