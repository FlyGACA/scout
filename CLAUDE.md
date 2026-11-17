# CLAUDE.md — FlyGACA/scout

FlyGACA's Claude Code setup (advisor, `repo-scout` agent, ads guard hook, installer), the ads playbook with its copy checker, and the FlyGACA content gate for Markdown, which Qoder also runs. See `README.md`, `PLAN.md`, `ads/PLAYBOOK.md` and, for the content policies, `AGENTS.md` and `.qoder/rules/`.

## Commands

| Task | Command |
| --- | --- |
| Local checks and the test workflow | `npm run check` (installer up to date, copy checker, content gate, tests) |
| Regenerate the installer and the site | `npm run build` (after editing `claude-code/agents/`, `claude-code/hooks/`, `claude-code/install.template.sh`, the data files the dashboard reads, `PLAN.md` or `tools/site/`) |
| Check ad copy | `node tools/ad-copy-lint.mjs [file]` |
| Check Markdown content | `node scripts/gate.mjs` (`--strict` also fails on warnings; `--only links --external` fetches external links) |
| Count the tests | `npm test` (the `tests` summary line) |
| Extend the Qoder scheduled tasks | `node scripts/regenerate-scheduled-tasks.mjs` |

No dependencies. Node 20 or later, POSIX `sh`, `python3`.

## Rules

- **Generated file:** never edit `claude-code/install.sh` by hand. `npm run check` fails when it is stale.
- **`site/` is generated** by `tools/build-site.mjs` and never hand-edited; change `tools/site/` (stylesheet, script) or the generator, then `npm run build`. Only `site/ufuq/` is copied by hand from FlyGACA/UFUQ (see its `SOURCE.txt`; never edited here). The Cloudflare Worker `scout` serves `site/` (`wrangler.jsonc`); its build runs `npm run build`, so the build must need no dependency and no network, and must not fail on checker findings. Never copy `ads/approved-facts.json` values or the ad copy files into `site/`. Who may open it: `docs/ACCESS.md`.
- **The hook is POSIX `sh`** and has to run on macOS and Linux (`dash`). Keep it dependency-free.
  - Add a test in `test/ads-guard.test.mjs` for every new decision rule.
  - A change that loosens a deny or an ask needs the owner's approval.
- **`ads/approved-facts.json` is the owner's.** Never add prices, offers or domains to it without the owner confirming them in the conversation.
- **`ads/platform-limits.json`:**
  - Set `verified: true` only with a `source` URL to the platform's own docs.
  - Mark third-party claims as such everywhere.
- **Ad copy:**
  - No claim of GACA affiliation, approval or official status.
  - No unconfirmed prices.
  - Arabic and English together.
  - Every copy file passes the checker before review.
- **Content policies:** before editing Markdown, read `AGENTS.md` (the shared baseline) and the matching `.qoder/rules/*.mdc` file; where they conflict, the more specific `.qoder/rules` file wins. `scripts/gate.config.json` decides which checks the gate runs and with what limits.
  - Never edit `scripts/gate.mjs` or `test/gate.test.mjs` to make a finding disappear. Fix the content, or leave the finding for the owner.
  - Never invent a GACAR citation, part number or `source-verified` date.
- **Qoder scheduled tasks** (`.qoder/scheduled_tasks.json`, prompts in `.qoder/prompts/`) stop at `expiresAt`. Extending them is `node scripts/regenerate-scheduled-tasks.mjs`; the separate, non-expiring weekly external-link check is in `.github/workflows/qoder-gate.yml`.
- **Branches and publishing:** work on a new branch per task and open draft PRs. Never merge to `main`. Never connect, publish or change a live ad account, and never deploy, without the owner's explicit approval.
- **Other repositories:** do not modify them (FlyGACA, Captain-Adel, Office, …) without the owner's permission. The UTM-capture work in PLAN.md phase 1 is separate PRs there.
- **Secrets:** never commit them. Ad-platform credentials belong in the connectors, not in this repo.
