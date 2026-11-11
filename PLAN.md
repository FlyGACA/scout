# Plan

**Goal:** get more out of Claude across FlyGACA's work for less money, and run paid ads on any platform without Claude spending money, publishing claims or moving learner data that the owner has not approved.

## What changed from the original post

| The post | This plan |
| --- | --- |
| Sonnet main, Fable advisor, Haiku for all subagents, an Opus checker | **Opus main + Fable advisor.** About 100 repo agents inherit the main model and do compliance and review work, so the main model stays strong. Haiku runs only `repo-scout`, which reads and never judges. The advisor already checks before "done", so no separate checker is needed. |
| "Paste one line so Sonnet knows when to call Fable" | **Already built into Claude Code.** Nothing to add. |
| "3.4× cheaper" | **Not in Anthropic's published material.** Anthropic's published result is 11.9% cheaper per task with a 2.7-point higher score (Sonnet with an Opus advisor). Each advisor call re-reads the whole conversation at Fable rates, so `/clear` between tasks matters more than the pairing. |
| Meta Ads "with your approval before changes go live" | **The approval comes from the guardrails in this repo, not from the connector,** and it applies to every ad platform, not only Meta. |
| User-level settings on one computer | **The same installer works in cloud sessions,** through the environment setup script, and on a computer. |

## Principles

1. **Measure before spending.** Neither flygaca.com nor captadel.com records which ad a signup came from today: there is no UTM capture and no analytics in either codebase. Fixing that comes first, or no channel can be judged.
2. **Advertise only what exists today.** Start with the free entry points: the GACAR library on flygaca.com and the Captain Adel free tier.
   - FlightBag's shop waits for its own go-live checklist.
   - The ELPT and AIP iOS apps wait until they leave TestFlight.
   - Paid plans wait for confirmed prices in `ads/approved-facts.json`.
3. **Guardrails in layers, each able to stop a mistake on its own:**
   1. a spending cap on every ad account;
   2. a read-only login until a phase needs more;
   3. the ads guard hook;
   4. the copy checker;
   5. a person publishes.
4. **One policy for every platform.** Connectors differ; the rules don't.
5. **Strong models for judgment, cheap models for bulk.**

## Phases

| Phase | Who | What | Done when |
| --- | --- | --- | --- |
| **0. Set up** | Owner, about an hour | Install scout (cloud setup script and computer). Set a spending cap on every ad account. Decide the test budget and the first 2–3 channels. | `/advisor` shows Fable 5.2, and each account has a cap |
| **1. Measure** | Claude drafts, owner approves | Separate draft PRs in FlyGACA and Captain-Adel to store the first-touch `utm_*` values with each new account. This stays first-party: no pixel and no third-party script. Define three conversions: signup, first question or first study session, and mock exam started. | A test signup from a tagged link shows its campaign |
| **2. Read-only** | Claude | Connect read-only: Google's official server is read-only, and Snapchat's is reported read-only. Meta uses a view-only login. Claude writes a weekly report across channels: spend, clicks, signups, activated learners, cost per activated learner. | Two weekly reports match the platform dashboards |
| **3. Small tests** | Claude drafts, owner publishes | 2–3 channels, the same budget each, a fixed window (for example 14 days). Copy goes through the checker, then the owner reviews it and publishes in the platform UI. | Each channel has a cost per activated learner |
| **4. Scale or stop** | Owner | Keep the channels under the owner's target cost per activated learner and stop the rest. Only then consider letting Claude make paused drafts through a write-enabled login. | A written decision |

## Channels and why

These are hypotheses to test, not conclusions:
- **Google Search** (and Microsoft) reaches people already searching for exam prep, in Arabic and English. Start from the keyword research in `iflygaca/Office/07-gtm/seo/flygaca-keyword-research.md`.
- **Snapchat, TikTok and Instagram** are for discovery among younger, Arabic-first audiences: student pilots and ELPT candidates.
- **X** is where Saudi aviation conversation happens. It may work better as organic posting than as ads.
- **LinkedIn** is mainly for the schools (B2B) motion. Ads there are expensive. The 14-day pilot and warm intros in `iflygaca/Office/07-gtm/gtm-schools.md` come first.

The details are in [ads/PLAYBOOK.md](ads/PLAYBOOK.md).

## Owner decisions

- [ ] Test budget per channel and total cap. No figure is written anywhere in this repo on purpose.
- [ ] The first 2–3 channels.
- [ ] Approval of the phase 1 UTM-capture PRs in FlyGACA and Captain-Adel.
- [ ] Confirmed prices, before any ad for a paid plan.
- [ ] A PDPL review (`ksa-compliance` / `privacy-dpia`) before any pixel, Conversions API or customer-list upload.
- [ ] Influencer or creator ads, if wanted: check Saudi media-licensing rules with counsel first.

## Open items

- `ads/platform-limits.json` is written from general knowledge (`verified: false`). Check each platform's docs.
- Connector facts for Meta, TikTok and Snapchat come from third-party guides. Meta's own docs page returned 404 on 2026-11-11.
- The hook is tested end-to-end against a fake connector, not yet against a real one. Confirm its decisions the first time each real connector is used.
- The installer is tested in throwaway directories, not yet in a fresh cloud session.
