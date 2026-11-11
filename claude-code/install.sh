#!/bin/sh
# scout installer for Claude Code (generated from claude-code/install.template.sh
# by tools/build-install.mjs; edit the template or the source files, not this file).
#
# Installs, into ~/.claude (or $CLAUDE_CONFIG_DIR):
#   - advisorModel = fable           (only if you have not set an advisor yourself)
#   - agents/repo-scout.md           (Haiku 5.5, read-only search)
#   - hooks/scout-ads-guard.sh       (approval gate for every ad-platform connector)
#   - a PreToolUse hook entry for it (matcher ^mcp__)
# Backs up settings.json first and prints the diff.
#
# Use:
#   cloud sessions: paste this whole file at the end of the environment's setup script
#   your computer:  sh install.sh
# Options (environment variables):
#   SCOUT_ADVISOR=fable|opus|sonnet|off   advisor to set when none is set (default fable)
#   SCOUT_DRY_RUN=1                       show the settings diff, change nothing
#   SCOUT_UNINSTALL=1                     remove the agent, the hook and its settings entry
# Safe to paste into a longer script: it sets no shell options and never exits.

dir=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
agent="$dir/agents/repo-scout.md"
hook="$dir/hooks/scout-ads-guard.sh"

if [ "${SCOUT_UNINSTALL:-}" != 1 ] && [ "${SCOUT_DRY_RUN:-}" != 1 ]; then
  mkdir -p "$dir/agents" "$dir/hooks"
  cat >"$agent" <<'SCOUT_AGENT_EOF'
---
name: repo-scout
description: Fast, low-cost, read-only search across many files or repositories when only locations, counts or short excerpts are needed, such as where a term, setting or function appears, which files mention a GACAR Part, or what a directory holds. Not for judgment work. Never use it for PDPL or compliance review, GACAR citation checks, code review, Arabic translation, pricing, ad copy, legal or financial content, or any edit.
tools: Read, Grep, Glob
model: claude-haiku-5-5
---

You are a read-only search helper. Find things and report where they are. Do not judge them.

- Return file paths with line numbers and short verbatim excerpts.
- Do not interpret regulations, assess compliance, review code or recommend changes. If the task asks for that, say it needs the main session and stop.
- Do not call the advisor tool.
- Keep the reply short: the locations and excerpts, then one line on anything you could not find.
SCOUT_AGENT_EOF
  cat >"$hook" <<'SCOUT_HOOK_EOF'
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
SCOUT_HOOK_EOF
  chmod +x "$hook"
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "scout: python3 not found, so settings.json was not changed." >&2
  echo "scout: run /advisor fable in Claude Code, and add the hook from claude-code/settings.example.json." >&2
else
SCOUT_DIR="$dir" SCOUT_HOOK="$hook" python3 - <<'SCOUT_PY_EOF'
import json, os, shutil, subprocess, sys, tempfile, time

d = os.environ["SCOUT_DIR"]
hook = os.environ["SCOUT_HOOK"]
path = os.path.join(d, "settings.json")
advisor = os.environ.get("SCOUT_ADVISOR", "fable")
dry = os.environ.get("SCOUT_DRY_RUN") == "1"
uninstall = os.environ.get("SCOUT_UNINSTALL") == "1"

try:
    with open(path) as f:
        old_text = f.read()
    s = json.loads(old_text)
except FileNotFoundError:
    old_text, s = "", {}
except ValueError:
    print("scout: settings.json is not valid JSON; left unchanged", file=sys.stderr)
    sys.exit(0)

def is_ours(group):
    return any("scout-ads-guard" in str(h.get("command", "")) for h in group.get("hooks", []))

pre = s.get("hooks", {}).get("PreToolUse", [])
if uninstall:
    kept = [g for g in pre if not is_ours(g)]
    if pre and not kept:
        del s["hooks"]["PreToolUse"]
        if not s["hooks"]:
            del s["hooks"]
    elif pre:
        s["hooks"]["PreToolUse"] = kept
else:
    if advisor != "off" and "advisorModel" not in s:
        s["advisorModel"] = advisor
    if not any(is_ours(g) for g in pre):
        s.setdefault("hooks", {}).setdefault("PreToolUse", []).append({
            "matcher": "^mcp__",
            "hooks": [{"type": "command", "command": 'sh "%s"' % hook, "timeout": 10}],
        })

new_text = json.dumps(s, indent=2, ensure_ascii=False) + "\n"
if new_text == old_text:
    print("scout: settings.json already up to date")
else:
    fd, tmp = tempfile.mkstemp(dir=d if os.path.isdir(d) else None)
    with os.fdopen(fd, "w") as f:
        f.write(new_text)
    before = path if old_text else os.devnull
    subprocess.call(["diff", "-u", before, tmp])
    if dry:
        os.remove(tmp)
        print("scout: dry run, nothing written")
    else:
        if old_text:
            backup = "%s.bak-%s" % (path, time.strftime("%Y%m%d%H%M%S"))
            shutil.copy2(path, backup)
            print("scout: backup saved to " + backup)
        os.replace(tmp, path)
        print("scout: settings.json updated")
SCOUT_PY_EOF
fi

if [ "${SCOUT_UNINSTALL:-}" = 1 ]; then
  rm -f "$agent" "$hook"
  echo "scout: removed repo-scout and the ads guard. The advisor is unchanged; run /advisor off to stop it."
elif [ "${SCOUT_DRY_RUN:-}" != 1 ]; then
  echo "scout: installed repo-scout and the ads guard in $dir"
fi
