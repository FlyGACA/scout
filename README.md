# scout

FlyGACA's Claude Code setup and ad-operations guardrails. It covers three jobs:

1. **Better and cheaper Claude sessions.** Opus 5.5 stays the main model, Fable 5.2 advises at decision points, and a Haiku agent does cheap read-only searches.
2. **Paid ads on any platform without Claude spending money or touching learner data unseen.** This works for Meta, Google, TikTok, Snapchat, X, LinkedIn and Microsoft.
3. **Ad copy that is checked before a person reviews it.** The checks cover the disclaimer, prices, claims, length limits and tracking links.

العربية: [README.ar.md](README.ar.md) · The plan: [PLAN.md](PLAN.md) · Ads playbook: [ads/PLAYBOOK.md](ads/PLAYBOOK.md)

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

## Develop

```sh
npm run check     # install.sh up to date + copy lint + tests
npm run build     # regenerate claude-code/install.sh after editing the agent, hook or template
```

No dependencies. Needs Node 20 or later, POSIX `sh` and `python3` (the installer uses it to merge JSON).

## What is verified

- **51 unit tests pass.** They cover hook decisions, copy-checker rules, and installer fresh, repeat, merge, dry-run, uninstall and broken-file cases.
- **End-to-end in Claude Code 2.1.322.** With the hook on and a fake `meta_ads` connector, `get_insights` ran, and `create_campaign` was blocked with the guard's reason, even though it was pre-allowed. The connector recorded only the read.
- **Not yet tested:**
  - a real ad connector;
  - a fresh cloud session built from the setup script;
  - the platform text limits.
