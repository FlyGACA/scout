import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hook = join(dirname(fileURLToPath(import.meta.url)), '..', 'claude-code/hooks/ads-guard.sh');

export function decide(toolName, { mode = 'default', env = {}, raw } = {}) {
  const input = raw ?? JSON.stringify({
    session_id: 's',
    hook_event_name: 'PreToolUse',
    permission_mode: mode,
    tool_name: toolName,
    tool_input: { name: 'x' },
  });
  const r = spawnSync('sh', [hook], { input, encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(r.status, 0, r.stderr);
  if (!r.stdout.trim()) return { decision: 'silent' };
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  return {
    decision: out.hookSpecificOutput.permissionDecision,
    reason: out.hookSpecificOutput.permissionDecisionReason,
  };
}

const cases = [
  // not an ad platform: never touched
  ['Bash', 'silent'],
  ['mcp__Gmail__send_message', 'silent'],
  ['mcp__Supabase__execute_sql', 'silent'],
  ['mcp__Moda_-_Slides_and_Designs__canvas_create', 'silent'],
  ['mcp__Adobe__asset_add_file', 'silent'],
  // reads pass through to the normal permission flow
  ['mcp__Meta_Ads__get_insights', 'silent'],
  ['mcp__google_ads__search', 'silent'],
  ['mcp__google_ads__list_accessible_customers', 'silent'],
  ['mcp__snapchat_ads__get_ad_accounts', 'silent'],
  ['mcp__Meta_Ads__dataset_quality_report', 'silent'],
  ['mcp__TikTok_Ads__getCampaignStats', 'silent'],
  // writes ask
  ['mcp__Meta_Ads__create_campaign', 'ask'],
  ['mcp__Meta_Ads__update_ad_set_budget', 'ask'],
  ['mcp__Meta_Ads__create_asset', 'ask'],
  ['mcp__TikTok_Ads__campaign-create', 'ask'],
  ['mcp__X_Ads__pause_line_item', 'ask'],
  ['mcp__LinkedIn__create_post', 'ask'],
  ['mcp__plugin_marketing_meta_ads__updateCampaign', 'ask'],
  // unknown shape fails safe to ask
  ['mcp__Meta_Ads__campaigns', 'ask'],
  // deletes, people data and tracking are denied
  ['mcp__Meta_Ads__delete_campaign', 'deny'],
  ['mcp__TikTok_Ads__removeAdGroup', 'deny'],
  ['mcp__Meta_Ads__create_custom_audience', 'deny'],
  ['mcp__Meta_Ads__createCustomAudience', 'deny'],
  ['mcp__google_ads__upload_customer_list', 'deny'],
  ['mcp__snapchat_ads__add_users_to_segment', 'deny'],
  ['mcp__Meta_Ads__update_pixel', 'deny'],
  ['mcp__google_ads__create_conversion_action', 'deny'],
];

for (const [name, want] of cases) {
  test(`${name} -> ${want}`, () => {
    assert.equal(decide(name).decision, want);
  });
}

test('bypassPermissions turns ask into deny, reads stay silent', () => {
  assert.equal(decide('mcp__Meta_Ads__create_campaign', { mode: 'bypassPermissions' }).decision, 'deny');
  assert.equal(decide('mcp__Meta_Ads__get_insights', { mode: 'bypassPermissions' }).decision, 'silent');
});

test('reason names the server and tool', () => {
  const { reason } = decide('mcp__Meta_Ads__create_campaign');
  assert.match(reason, /Meta_Ads \/ create_campaign/);
});

test('SCOUT_ADS_SERVERS overrides the server pattern', () => {
  const env = { SCOUT_ADS_SERVERS: 'acme' };
  assert.equal(decide('mcp__acme__create_thing', { env }).decision, 'ask');
  assert.equal(decide('mcp__Meta_Ads__create_campaign', { env }).decision, 'silent');
});

test('pretty-printed input and garbage input', () => {
  const pretty = JSON.stringify({ tool_name: 'mcp__Meta_Ads__create_campaign', permission_mode: 'default' }, null, 2);
  assert.equal(decide(null, { raw: pretty }).decision, 'ask');
  assert.equal(decide(null, { raw: 'not json' }).decision, 'silent');
  assert.equal(decide(null, { raw: '' }).decision, 'silent');
});
