# claude-skills

Claude Code skills, packaged as a plugin marketplace so they can be installed with `/plugin`, or copied by hand.

## Skills

| Skill | What it does |
|---|---|
| [`recording-browser-walkthroughs`](plugins/recording-browser-walkthroughs/skills/recording-browser-walkthroughs/SKILL.md) | Records internal walkthrough videos of any app running locally in a browser. You hand it a case (base URL, steps, what to show); it drives the browser and draws the caption bar, click and type boxes, callouts, chapter cards, "jump" markers for things that happen outside the app, title and recap cards; out as a 1920×1080 MP4 with chapters. App specifics (navigation, login, data changes, fixed chrome) come in as adapter hooks; a plain-SPA and a Filament adapter ship with it. [Requirements](plugins/recording-browser-walkthroughs/skills/recording-browser-walkthroughs/REQUIREMENTS.md). |

## Install

### As a plugin (recommended)

The repository is private: your machine needs read access to it through git (`gh auth login`, an SSH key, or a credential helper), the same as for `git clone`.

```sh
claude plugin marketplace add afkrul/claude-skills
claude plugin install recording-browser-walkthroughs@afkrul-skills
```

Renamed from `recording-panel-videos` (2.0.0, now app-agnostic): `claude plugin uninstall recording-panel-videos@afkrul-skills` first if you had it.

Or inside a session: `/plugin marketplace add afkrul/claude-skills`, then `/plugin install recording-browser-walkthroughs@afkrul-skills`. `claude plugin marketplace update afkrul-skills` pulls new versions.

### By copying

Each skill is a self-contained folder; copy it into your personal skills or a project's:

```sh
gh repo clone afkrul/claude-skills                       # with the GitHub CLI (gh auth login), or
git clone git@github.com:afkrul/claude-skills.git        # with an SSH key on your GitHub account
cp -r claude-skills/plugins/recording-browser-walkthroughs/skills/recording-browser-walkthroughs "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/"
# or, for one project only:  cp -r … <repo>/.claude/skills/
```

### Then, for `recording-browser-walkthroughs`

The kit needs its dependencies once (and again after a plugin update, which installs a new version folder):

Installed as a plugin, the skill folder is the `installPath` that `claude plugin list --json` reports,
plus `/skills/recording-browser-walkthroughs`; or the newest version in the cache, which lives under
`CLAUDE_CONFIG_DIR` when that is set (default `~/.claude`):

```sh
SKILL=$(ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/afkrul-skills/recording-browser-walkthroughs/*/skills/recording-browser-walkthroughs | sort -V | tail -1)
```

```sh
cd <skill folder>/kit     # e.g. cd "$SKILL/kit"
npm ci
npx playwright-core install chromium     # or set CHROMIUM=/path/to/chrome
```

and `ffmpeg` on `PATH` (or Python 3, from which the kit fetches one). Check the install with the bundled example, which serves its own local app: `node <skill folder>/examples/static-app/record.mjs /tmp/walkthrough-test`. Everything else, including adapters and how login works, is in [REQUIREMENTS.md](plugins/recording-browser-walkthroughs/skills/recording-browser-walkthroughs/REQUIREMENTS.md).

## Layout

```
.claude-plugin/marketplace.json          the marketplace: one entry per plugin
plugins/<plugin>/.claude-plugin/plugin.json
plugins/<plugin>/skills/<skill>/SKILL.md the skill, plus its supporting files
```

Check changes with `claude plugin validate .` and `claude plugin validate plugins/<plugin>`.
