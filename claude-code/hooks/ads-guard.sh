#!/bin/sh
# scout ads guard: a Claude Code PreToolUse hook for every ad-platform connector.
#
# Runs on every MCP tool call (matcher "^mcp__"). For a server whose name looks
# like an ad platform (Meta, Google Ads, TikTok, Snapchat, LinkedIn, X, ...):
#   - read tools (get/list/search/report...)          -> silent, normal flow
#   - delete/remove                                     -> deny
#   - audience/customer-list writes (personal data)     -> deny (PDPL review first)
#   - pixel/conversion/tracking writes                  -> deny (privacy review first)
#   - any other write, or a tool it can't classify      -> ask (you approve each one)
# In bypassPermissions mode an "ask" becomes "deny", so nothing spends money unseen.
#
# The tool name is split into words (snake_case, kebab-case and camelCase), and
# words are matched whole, so "asset" is not "set" and "dataset" is not "data".
#
# POSIX sh, no dependencies. Override the server pattern with SCOUT_ADS_SERVERS
# (an extended regex, matched case-insensitively against the server name).

input=$(cat)
flat=$(printf '%s' "$input" | tr '\n' ' ')
tool=$(printf '%s' "$flat" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
mode=$(printf '%s' "$flat" | sed -n 's/.*"permission_mode"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

case $tool in
mcp__*__*) ;;
*) exit 0 ;;
esac

rest=${tool#mcp__}
server=${rest%%__*}
action=${rest#*__}

servers=${SCOUT_ADS_SERVERS:-'ads|adwords|advertis|facebook|meta|instagram|tiktok|snap|linkedin|twitter|reddit|pinterest|bing'}
printf '%s' "$server" | grep -Eiq -- "$servers" || exit 0

# "createCustomAudience" / "create-custom_audience" -> " create custom audience "
words=$(printf '%s' "$action" | sed 's/\([a-z0-9]\)\([A-Z]\)/\1 \2/g' | tr 'A-Z' 'a-z' | tr -c 'a-z0-9' ' ')
words=" $(echo $words) "
first=$(echo $words | sed 's/ .*//')

has() { printf '%s' "$words" | grep -Eq -- " ($1) "; }
is() { printf '%s' "$first" | grep -Eqx -- "$1"; }

emit() {
  # $1 = deny|ask, $2 = reason (no double quotes or backslashes)
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"%s","permissionDecisionReason":"%s"}}\n' "$1" "$2"
  exit 0
}

read_verbs='get|list|read|search|query|fetch|describe|report|reports|insight|insights|stat|stats|metric|metrics|preview|estimate|validate|diagnose|diagnostics|check|lookup|find|show|view|count|download|export|summarize|analyze|compare|forecast'
write_verbs='create|creates|add|adds|update|updates|edit|set|change|modify|mutate|patch|upsert|pause|resume|enable|disable|activate|deactivate|launch|publish|start|stop|duplicate|copy|clone|upload|import|archive|submit|apply|schedule|send|post|manage|attach|assign|link|replace|rename|approve|boost|promote|delete|remove|destroy|erase|purge'
delete_verbs='delete|deletes|remove|removes|destroy|erase|purge'
people_nouns='audience|audiences|customer|customers|user|users|userlist|lookalike|lookalikes|hashed|email|emails|phone|phones|contact|contacts|segment|segments|crm|offline|lead|leads'
tracking_nouns='pixel|pixels|conversion|conversions|capi|dataset|datasets|event|events|gtag|tracking'

if is "$read_verbs"; then exit 0; fi
if ! has "$write_verbs" && has "$read_verbs"; then exit 0; fi

where="$server / $action"

if has "$delete_verbs"; then
  emit deny "scout ads guard: deletes are blocked ($where). Delete in the platform UI yourself. الحذف ممنوع عبر Claude."
fi
if has "$people_nouns" && has "$write_verbs"; then
  emit deny "scout ads guard: audience and customer-data changes are blocked ($where). Uploading learner data needs a PDPL review first. رفع بيانات العملاء يحتاج مراجعة PDPL."
fi
if has "$tracking_nouns" && has "$write_verbs"; then
  emit deny "scout ads guard: tracking changes are blocked ($where). Pixels and conversion tracking need a privacy review first. تغيير التتبع يحتاج مراجعة خصوصية."
fi

if [ "$mode" = bypassPermissions ]; then
  emit deny "scout ads guard: ad-account changes are not allowed in bypassPermissions mode ($where). Switch modes so you can approve it."
fi
emit ask "scout ads guard: this changes an ad account ($where). Check the platform, account, amount and that new items stay paused. هذا يغيّر حساب إعلانات، راجع المبلغ والحالة قبل الموافقة."
