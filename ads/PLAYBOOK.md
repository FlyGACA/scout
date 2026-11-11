# Ads playbook (all platforms)

**Status: draft.** Nothing here is live. It describes how Claude and the owner run paid ads together. The plan and phases are in [../PLAN.md](../PLAN.md).

## 1. Connectors

What each platform offers Claude, as found on 2026-11-11. Lines marked *(3rd-party)* come from secondhand guides; check the platform's own docs when you connect.

| Platform | Official MCP server | Can write? | Notes |
| --- | --- | --- | --- |
| Google Ads | Yes: [`googleads/google-ads-mcp`](https://github.com/googleads/google-ads-mcp), self-hosted | **No, read-only** per [Google's docs](https://developers.google.com/google-ads/api/docs/developer-toolkit/mcp-server) | Three tools: `list_accessible_customers`, `search`, `get_resource_metadata`. Needs a Google Cloud project and OAuth. Developer tokens were sunset on 2026-09-09. |
| Meta (Facebook, Instagram) | Reported at `mcp.facebook.com/ads` *(3rd-party)* | Yes, 29 tools reported *(3rd-party)* | New items reportedly start paused, and edits to live campaigns reportedly apply at once *(3rd-party)*. Meta's own docs page returned 404. |
| TikTok | Announced May 2026 *(3rd-party)* | Reported read and write *(3rd-party)* | No published tool list was found. |
| Snapchat | Reported at `mcp.snapchat.com/ads`, August 2026 *(3rd-party, single source)* | Reported read-only *(3rd-party)* | Reportedly needs Organization Admin approval. |
| LinkedIn, X, Microsoft | None found | — | Third-party servers exist. Prefer reporting exports, or the platform UI, over unknown write-enabled servers. |

**Rule:** use only first-party servers, or a well-known reporting tool, for reads. Never connect a third-party server that can write to an ad account.

## 2. Guardrails, in the order they stop a mistake

1. **A spending cap on every ad account,** set in the platform's own billing settings before connecting. It holds whatever any tool does.
2. **A read-only login.** Connect with a view-only role until a phase needs more. The platform then refuses writes itself.
3. **The ads guard hook** (`claude-code/hooks/ads-guard.sh`, installed by scout):

   | Tool call | Decision |
   | --- | --- |
   | Reads (get, list, search, report, insights…) | Normal flow |
   | Deletes | **Blocked** |
   | Audience, customer-list, lookalike, email or phone writes | **Blocked** (PDPL review first) |
   | Pixel, conversion, CAPI or dataset writes | **Blocked** (privacy review first) |
   | Any other write, or a tool it can't classify | **You approve each one** |
   | Any write in bypassPermissions mode | **Blocked** |

4. **The copy checker** (`node tools/ad-copy-lint.mjs`). See section 5.
5. **A person publishes.** In phases 2–3, Claude drafts and the owner publishes in the platform UI.

Also set the connector's own tool permissions in claude.ai (Settings → Connectors) to require approval for write tools. It costs nothing and adds one more layer.

## 3. Measurement

**UTM convention.** The checker enforces it on every ad link:

| Tag | Value |
| --- | --- |
| `utm_source` | `google`, `bing`, `facebook`, `instagram`, `tiktok`, `snapchat`, `x`, `linkedin` |
| `utm_medium` | `cpc` for search, `paid_social` for social |
| `utm_campaign` | the campaign slug, the same as `campaign` in the copy file |
| `utm_content` | the variant id |

**Conversions,** defined once and used on every platform:
1. Signup (new account).
2. Activation: first question to Captain Adel, or first study session on FlyGACA.
3. Mock exam started.

The headline number is **cost per activated learner**. Clicks and signups alone reward the wrong ads.

**First-party only, to start.** Store the first-touch UTM values with the new account in our own database. This needs a small change in FlyGACA and in Captain-Adel; neither captures UTM today. No pixel and no third-party analytics script until a PDPL review says yes. captadel.com's CSP is hand-maintained, so any script there is a deliberate change anyway.

## 4. What to advertise

Only offers listed in [`approved-facts.json`](approved-facts.json):

| Offer | Landing | Status |
| --- | --- | --- |
| GACAR library, free | flygaca.com | Ready |
| Captain Adel free tier | captadel.com | Ready |
| Paid plans and study packs | — | Waiting for confirmed prices |
| ELPT and AIP iOS apps | — | Waiting until they leave TestFlight |
| FlightBag study pack | — | Waiting for the shop go-live checklist |
| Gallery originals | — | Not planned for ads yet |

Creatives can start from the Gallery's free aviation graphics, built in the Moda or Canva connectors, which are both connected. Never use GACA's logo or visual identity.

## 5. Copy rules (checked by `tools/ad-copy-lint.mjs`)

- **Disclaimer.** Every ad says it is not affiliated with GACA, in its own language, using approved product wording. Where the format has no room (for example a Snapchat headline), set `"disclaimer_in": "creative"` and make sure the image or video shows it. The checker then warns, so a person checks it.
- **No status claims:** no "official", "approved", "accredited" or "guaranteed", and no رسمي، معتمد، مضمون، مرخص. The approved disclaimers are exempt even though they contain "official".
- **Prices** only as listed in `approved-facts.json`, and "free" / "مجاني" only for free offers.
- **Arabic and English ship together.**
- **Length limits** per format, from `platform-limits.json`. They are not verified yet; check them against each platform's docs.

Write copy as `ads/copy/<campaign>.json`. See [`copy/captain-adel-free-test.json`](copy/captain-adel-free-test.json).

## 6. Working with Claude

**Weekly report** (phase 2 onward):
> Using only read tools on the connected ad platforms, report last week by channel: spend, impressions, clicks, CTR, signups and activated learners by `utm_campaign`, and cost per activated learner. Put platform numbers and our own signup numbers side by side and flag any gap over 10%. No changes.

**New copy:**
> Draft `ads/copy/<slug>.json` for offer `<offer>` on `<formats>`, Arabic first and English to match. Use only facts in `ads/approved-facts.json`. Run `node tools/ad-copy-lint.mjs` and fix every error. Then list the warnings that need my eye.

**Changes on a live account** (phase 4 and later only): one change per message, stating the account, campaign, field, old value and new value, and that the item stays paused if new. The guard will ask, and you approve or reject.

## 7. Before any of these, get a review

- Uploading learner emails or phones for audiences: PDPL (`ksa-compliance` / `privacy-dpia`). It is personal data leaving the Kingdom.
- Installing a pixel, Conversions API or SDK on flygaca.com, captadel.com or the iOS apps: privacy review, and for captadel.com a CSP change.
- Influencer or creator ads: check Saudi media-licensing rules with counsel.
- Any claim about pass rates, approvals or partnerships: owner and counsel.
