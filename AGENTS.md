# AGENTS.md

## Repository Overview
Concise architecture overview for AI Coding Agents.

## Critical Commands
- Install: `npm install`
- Build: `npm run build`
- Test: `npm test`
- Typecheck: `npm run typecheck`
- Lint: `npm run lint`
- Verify (opt-in, executes commands): `npx agentdoctor verify`
- Security audit: `npx agentdoctor audit`
- Fix loop: `npx agentdoctor fix --safe --shims --verify`
- Rollback last fix: `npx agentdoctor fix --rollback`

## Architecture & Conventions
- Source code is encapsulated in `src/`.
- Never manually edit generated files in `dist/`.
- Follow strict typing and modular architecture.
