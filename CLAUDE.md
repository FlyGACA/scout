# CLAUDE.md — FlyGACA/scout

FlyGACA's Claude Code setup (advisor, `repo-scout` agent, ads guard hook, installer) and the ads playbook with its copy checker. See `README.md`, `PLAN.md` and `ads/PLAYBOOK.md`.

## Commands

| Task | Command |
| --- | --- |
| Everything CI runs | `npm run check` |
| Regenerate the installer | `npm run build` (after editing `claude-code/agents/`, `claude-code/hooks/` or `claude-code/install.template.sh`) |
| Check ad copy | `node tools/ad-copy-lint.mjs [file]` |

No dependencies. Node 20 or later, POSIX `sh`, `python3`.

## Rules

- **Generated file:** never edit `claude-code/install.sh` by hand. `npm run check` fails when it is stale.
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
- **Branches and publishing:** work on a new branch per task and open draft PRs. Never merge to `main`. Never connect, publish or change a live ad account, and never deploy, without the owner's explicit approval.
- **Other repositories:** do not modify them (FlyGACA, Captain-Adel, Office, …) without the owner's permission. The UTM-capture work in PLAN.md phase 1 is separate PRs there.
- **Secrets:** never commit them. Ad-platform credentials belong in the connectors, not in this repo.
