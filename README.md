# scout

FlyGACA's Claude Code setup and ad-operations guardrails. It covers four jobs:

1. **Better and cheaper Claude sessions.** Opus 5.5 stays the main model, Fable 5.2 advises at decision points, and a Haiku agent does cheap read-only searches.
2. **Paid ads on any platform without Claude spending money or touching learner data unseen.** This works for Meta, Google, TikTok, Snapchat, X, LinkedIn and Microsoft.
3. **Ad copy that is checked before a person reviews it.** The checks cover the disclaimer, prices, claims, length limits and tracking links.
4. **Markdown that is checked against FlyGACA's content policies.** The [content gate](#content-gate) runs locally, in CI and in Qoder.

العربية: [README.ar.md](README.ar.md) · The plan: [PLAN.md](PLAN.md) · Ads playbook: [ads/PLAYBOOK.md](ads/PLAYBOOK.md) · Content policies: [AGENTS.md](AGENTS.md)

## From ad draft to review

Use the [ads playbook](ads/PLAYBOOK.md) for the review process. Run `npm run check` after changing the hook or copy checks. The hook checks the draft against repository rules before human review.

```mermaid
flowchart LR
    N0["Ad draft"]
    N1["Copy checks"]
    N2["Human review"]
    N0 --> N1
    N1 --> N2
```

## Install

**Cloud sessions** (claude.ai/code and the Claude app):
1. Open a session's environment menu, choose **Edit**, then **Setup script**.
2. Paste the whole of [`claude-code/install.sh`](claude-code/install.sh) at the end and save.
3. Start a new session. You should see `Advisor Tool (experimental) is on`, and `/advisor` should print `Advisor: Fable 5.2`.

**Your computer:**

```sh
SCOUT_DRY_RUN=1 sh claude-code/install.sh   # preview the settings diff
sh claude-code/install.sh                   # install, with a backup of settings.json
```

If Claude Code asks for consent to bill Fable to usage credits, follow these steps:
1. Run `/model fable` and accept.
2. Run `/model opus` to put the main model back.
3. Run `/advisor fable`.

**Uninstall:** run `SCOUT_UNINSTALL=1 sh claude-code/install.sh`, then `/advisor off`.

## What gets installed

| Piece | File | What it does |
| --- | --- | --- |
| Advisor | `advisorModel: "fable"` in `~/.claude/settings.json` | Fable 5.2 reviews the plan before work starts, when an error repeats, and before "done". It is set only if you have no advisor configured. |
| `repo-scout` | [`claude-code/agents/repo-scout.md`](claude-code/agents/repo-scout.md) | Haiku 5.5 with Read, Grep and Glob only. It finds and quotes, and never judges compliance, GACAR, code or copy. |
| Ads guard | [`claude-code/hooks/ads-guard.sh`](claude-code/hooks/ads-guard.sh) | Applies to any ad-platform connector. Reads pass. Writes need your approval. Deletes, audience or customer-list uploads, and pixel or conversion changes are blocked. In bypass mode every write is blocked. |

The installer backs up `settings.json`, prints the diff, keeps your existing settings and hooks, and is safe to run twice.

## Deliberately not installed

- **Sonnet as the main model.** About 100 agents in Captain-Adel, FlyGACA, Office and iOS set no model of their own, so they run on the main model. Switching to Sonnet would downgrade `ksa-compliance`, `code-reviewer` and the rest. Use `/model sonnet` per session for routine work.
- **`CLAUDE_CODE_SUBAGENT_MODEL=haiku`.** It would put those same agents on Haiku.
- **A CLAUDE.md "when to call the advisor" block.** Claude Code already injects Anthropic's version. The "one line nobody tells you" from the post is built in.

## Ad copy checks

```sh
node tools/ad-copy-lint.mjs            # every ads/copy/*.json
```

The checker runs these checks:
- The "not affiliated with GACA" disclaimer appears in English or Arabic, using approved product wording.
- No "official", "approved" or "guaranteed" claims, or their Arabic equivalents (رسمي، معتمد، مضمون).
- No price unless it is listed in [`ads/approved-facts.json`](ads/approved-facts.json), and "free" only on free offers.
- Offers come only from the approved list.
- Text fits each platform's limits ([`ads/platform-limits.json`](ads/platform-limits.json), not yet verified).
- Links are https, go to flygaca.com or captadel.com, and carry the UTM tags.

## Content gate

The content gate ([`scripts/gate.mjs`](scripts/gate.mjs)) checks the Markdown in this repository against FlyGACA's content policies. The policies are written twice, for people and for agents:

- [AGENTS.md](AGENTS.md) is the shared baseline.
- [`.qoder/rules/`](.qoder/rules/) holds the detailed policy rules. Where it and AGENTS.md disagree, the more specific rule wins. Qoder reads both.

```sh
node scripts/gate.mjs                           # report; exit 1 on errors
node scripts/gate.mjs --strict                  # warnings also fail
node scripts/gate.mjs --only links --external   # also fetch external links (network)
```

- The gate knows six checks: disclaimer, GACAR citations, bilingual parity, repository register, links and source freshness. [`scripts/gate.config.json`](scripts/gate.config.json) decides which of them run, on which files and with what limits. Today it turns on the citation, link and freshness checks. Disclaimer, bilingual parity and register checks are not configured, so a passing gate does not replace manual review of those policies.
- `npm run check` runs the gate. So does the [content gate workflow](.github/workflows/qoder-gate.yml) on every pull request and push to `main`. The same workflow checks external links every Monday, and runs an optional Qoder review on pull requests when the `QODER_API_KEY` secret is set and the `qoder` CLI is on the runner; otherwise that job skips itself.
- Never edit the gate or its tests to make a finding disappear. Fix the content, or leave the finding for a person.

**Qoder scheduled tasks.** [`.qoder/scheduled_tasks.json`](.qoder/scheduled_tasks.json) defines a weekday gate triage, a weekly source refresh and a weekly repository-register audit. Their prompts are in [`.qoder/prompts/`](.qoder/prompts/). The tasks stop at the file's `expiresAt` date; `node scripts/regenerate-scheduled-tasks.mjs` extends them by seven days from today.

## What is where

| Path | What it is |
| --- | --- |
| [`claude-code/`](claude-code/) | The `repo-scout` agent, the ads guard hook, the installer template and the generated `install.sh`. [`settings.example.json`](claude-code/settings.example.json) shows the settings the installer adds, for a manual install. |
| [`tools/`](tools/) | `build-install.mjs` builds `install.sh` (`npm run build`). `ad-copy-lint.mjs` is the copy checker. |
| [`site/`](site/) | The Scout dashboard for `scout.flygaca.com`: generated by `tools/build-site.mjs` (`npm run build`), deployed as the Cloudflare Worker `scout` through [`wrangler.jsonc`](wrangler.jsonc). Who may open it: [docs/ACCESS.md](docs/ACCESS.md). |
| [`ads/`](ads/) | The playbook, the owner's approved facts, the platform text limits, and copy drafts in `ads/copy/`. |
| [`scripts/`](scripts/) | The content gate, its config, and the scheduled-task regenerator. |
| [AGENTS.md](AGENTS.md), [`.qoder/`](.qoder/) | Content policies, Qoder rules, scheduled tasks and their prompts. |
| [`test/`](test/) | Tests for the hook, the copy checker, the installer and the gate (`npm test`). |
| [`.github/workflows/`](.github/workflows/) | `test.yml` runs `npm run check`. `qoder-gate.yml` runs the gate, the weekly link check and the optional Qoder review. |
| [CLAUDE.md](CLAUDE.md) | Instructions for Claude Code in this repository. |
| [`package.json`](package.json) | The npm scripts. There are no dependencies. |

## The dashboard

`site/` is a read-only, bilingual dashboard of the guardrails: the status of the approved facts, the platform limits, the copy checker's result for each file, the content gate's findings, the Qoder scheduled tasks with their days left, and the plan. Open it with `python3 -m http.server 8000 -d site`, or at `scout.flygaca.com` for members.

- It reads the files named on each panel and runs the copy checker and the content gate when it is built. The build date is on every page.
- It does not show the values of `ads/approved-facts.json`, and it does not copy the ad copy files. It connects to no ad account and makes no network call.
- The days left on the scheduled tasks are worked out in the browser from `expiresAt`.
- `site/` is generated: `npm run build` writes it and `npm run check` fails when it is stale. Only `site/ufuq/` is copied by hand from FlyGACA/UFUQ (see `site/ufuq/SOURCE.txt`).

## Develop

```sh
npm run check     # install.sh and site/ up to date + copy lint + content gate + tests
npm run build     # regenerate claude-code/install.sh and site/ (after editing the agent, hook, template, data files or PLAN.md)
npm test          # the tests alone; the tests summary line is the current count
```

No dependencies. Needs Node 20 or later, POSIX `sh` and `python3` (the installer uses it to merge JSON).

## What is verified

- **The unit tests pass.** `npm test` prints the current count on its `tests` summary line. They cover hook decisions, copy-checker rules, the content gate's checks, and installer fresh, repeat, merge, dry-run, uninstall and broken-file cases.
- **End-to-end in Claude Code 2.1.322.** With the hook on and a fake `meta_ads` connector, `get_insights` ran, and `create_campaign` was blocked with the guard's reason, even though it was pre-allowed. The connector recorded only the read.
- **Not yet tested:**
  - a real ad connector;
  - a fresh cloud session built from the setup script;
  - the platform text limits.
