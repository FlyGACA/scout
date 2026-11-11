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
@@AGENT@@
SCOUT_AGENT_EOF
  cat >"$hook" <<'SCOUT_HOOK_EOF'
@@HOOK@@
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
