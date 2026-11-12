# dsh-go-token-usage

[中文](README.md) | English

Native token usage for the [dsh-go](https://github.com/ccch1mneyyy/dsh-Go) phone app:
a status strip above the composer, a full native panel, and a one-line note on every reply.
Everything is counted from the host's own session logs — read-only, no network, no estimates.

## What you get

| Where | Content |
|---|---|
| Status strip above the composer | `Chat 19.8M · today 155M`; tap to open the panel |
| Turn note after each reply | Tokens and cache hits of that turn, e.g. `315k · cache 86%` |
| Panel (chat details › Plugins, All features, chat-page Plugins sheet) | Five coloured cards in the order **All time → This chat → Today → Last 7 days → Last 30 days** (blue, green, orange, teal, violet). Every card shares one skeleton: a headline with title + total + tokens, then left/right aligned rows for hit rate, calls, input total, output; the 7- and 30-day cards add daily average and days covered, and the 30-day card ends with uncached input / cache reads / cache writes / reasoning. Today ends with a 「Models today」 list (model + source + tokens); Last 7 days adds a bar chart. The five cards line up vertically with normal spacing; copy summary, export image, verify and refresh at the bottom |

Numbers follow the engine's own accounting:

- `tokens = uncached input + cache reads + cache writes + output`;
- cache hit rate = cache reads ÷ (uncached input + cache reads + cache writes);
- "This chat" counts the current session only; the windows count every session on this host (subagents included);
- Day boundaries follow the host's local calendar;
- Numbers use three significant digits (`8.82k` / `1.25M` / `3.59B`); each metric carries its unit (tokens / calls);
- Type: 20 for card titles, 16 for rows, 13 for notes; values and units share one line;
- All five cards use the same skeleton with left-aligned labels and right-aligned values, so long labels never push the numbers away;
- Model totals are keyed by provider and model, so the same model name from an official account and from a relay shows up as two separate sources;
- “Daily avg” divides by the days that actually have calls and shows the day count, instead of spreading over 30 days;
- Reasoning shows an em dash when the engine does not report it, never a fake 0;
- Hit rates keep one decimal, so 99.7% never reads as 100%;
- Models today are labelled by source: `official · account` (deepseek-account), `official · API key`, `subscription · command-code`, `relay · <name>` (custom-*), anything else as `third-party · <provider>`. Edit `sourceLabel` in `lib/view.js` to change the mapping.

## Install

```sh
npx dsh-go-token-usage install
```

It does two things:

1. Checks whether this host serves the **dsh-go bridge**. The phone's own engine ships it;
   a remote host (server, PC) needs it once — the installer downloads
   `dsh-go-bridge` from a pinned commit of the upstream dsh-Go repository (not mirrored,
   not modified) and runs `dsh plugin add`.
2. Installs this plugin into the default `web` profile.

Requirements: Node.js ≥ 22.19, `dsh` on PATH, and `pnpm` (what `dsh plugin` uses).

Other commands:

```sh
npx dsh-go-token-usage status                 # what is installed
npx dsh-go-token-usage bridge                 # bridge only
npx dsh-go-token-usage plugin --profile web   # plugin only
npx dsh-go-token-usage install --from ./dist.tgz
npx dsh-go-token-usage install --dry-run
```

Without npm:

```sh
dsh plugin --profile web add https://github.com/REPLACE_OWNER/dsh-go-token-usage/archive/refs/tags/v0.1.0.tar.gz
node "$DSH_HOME/profiles/web/node_modules/dsh-go-token-usage/bin/install.mjs" bridge
```

After installing, switch hosts (or reopen the app) once so the app re-reads the plugin
inventory: the strip appears above the composer, the panel under chat details › Plugins
and All features, and replies get their turn note (needs a recent app build; older apps
simply hide it).

Editing the `dshGo` manifest in `package.json` is picked up automatically; changes under
`lib/` need an engine restart.

## Compatibility

| Item | Requirement |
|---|---|
| DSH | `0.2.1-rc.2` ~ `0.2.x` (declared in `engines.dsh`) |
| dsh-go app | A build with native plugin protocol v1 (strip / panel); turn notes need a build with `turn.note` |
| Host | The phone's built-in engine (bridge included) or a remote host with the bridge |

> Native surfaces do not show over **DSH Remote** connections — that is an app limitation.
> An SSH-managed host works.

## Data and privacy

- Reads only `assistant/message.usage` from `$DSH_HOME/sessions/**/session.v*.jsonl.zstd`;
- No network requests, no uploads, no credentials;
- The first run scans existing sessions once (~5 s depending on how many); afterwards only
  changed files are read. The index lives in `$DSH_HOME/cache/dsh-go-token-usage/index.json`;
- No build step and no dependencies — the whole plugin is in this repository.

## Accuracy

Numbers are not estimated or sampled: they come from the engine's own billed events — `usage` on every `assistant/message` (uncached input, cache reads, cache writes, output, reasoning) — the same accounting the engine charges.

What has been checked:

- Independent recount: decompress the raw `$DSH_HOME/sessions` logs with `zstd` and sum them in a separate Python script; today's tokens, today's calls, all-time tokens and all-time calls match the panel exactly;
- Forked / seeded sessions start with a copy of the parent's events. Those were already billed on the parent log, so the plugin skips everything up to the `session/end-seed` marker with `inherited: true`; covered by a unit test;
- Live accounting is reconciled against the files by event `seq`: a call is counted once, first provisionally, then from the file once it lands;
- **Export image**: the host draws a portrait stats card (1080 px wide PNG) with Python + Pillow, stores it in the package's `assets/`, and the app opens the 「Usage image」 panel showing it — screenshot to keep or share. Served through the bridge at `/dsh-go/v1/assets/<pkg>/<file>`. Needs `python3` + Pillow on the host; without it the button explains instead of failing elsewhere. The latest three images are kept;
- The panel has a **Verify** button: it re-parses every raw session log on the host (bypassing the index cache) and compares the result with the panel numbers, then shows a line such as `Verified · 3.46B · 18.1k calls`. Calls that have not reached their file yet show as `Diff N calls` instead of a false mismatch;
- Tests cover day rollover, live de-duplication, file catch-up, fork prefixes and missing cache counters (`npm test`).

Known boundaries:

- Only this host's `$DSH_HOME`; other hosts count on their own;
- "This chat" counts the session itself; subagent calls are included in the windows and the total, not in "this chat";
- A relay that does not report cache counters shows "—" instead of a fake 0% hit rate;
- Days follow the host's local time zone;
- History depends on this host's session logs: deleted logs or a different `DSH_HOME` mean no history;
- The verify result lives in memory only and resets to "Not verified" after an engine restart.

## What image export needs

- `python3` on the host with `python3 -c "import PIL"` passing (`pip install pillow`);
- A CJK font: the script looks for Noto Sans CJK / WenQuanYi / PingFang / Microsoft YaHei and still draws if none is found;
- The PNG is written inside the package's `assets/` and served through the bridge assets route — no network, no upload;
- The app's plugin image view can only display the picture (no long-press save), so export means: draw it here, screenshot it.

## Uninstall

```sh
dsh plugin --profile web remove dsh-go-token-usage
rm -rf "$DSH_HOME/cache/dsh-go-token-usage"
```

The bridge is separate: `dsh plugin --profile web remove dsh-go-bridge`, then delete
`$DSH_HOME/dsh-go/plugins/dsh-go-bridge`.

## Privacy: it needs no personal information

- **No account, key or phone number**: the plugin never reads `~/.dsh/.credentials.yaml`, never reads token environment variables and never signs in anywhere;
- **No network at runtime**: `lib/` and `scripts/` contain no `fetch` / `http` / `https` calls; the only request lives in the installer, downloading the bridge from the upstream dsh-Go repository at a pinned commit, and it uploads nothing;
- **Only numbers from the local session logs**: it reads `usage` counters plus the provider and model names from each `assistant/message` in `$DSH_HOME/sessions`. Message bodies are not stored; the cache `index.json` holds dates, token counts, call counts, session UUIDs and model names only (no working-directory paths);
- **Exported images stay on this host**: the PNG is written into the package's `assets/` and served to the app through the bridge's credential-checked local route. It contains token numbers, model/source names and a timestamp — no hostname, user name, path or conversation text;
- **The published package carries no local data**: `.gitignore` excludes generated images and `prepack` deletes `assets/usage-*.png` before packing (verified: `npm pack` contains only `.gitkeep`).

Check it yourself:

```sh
grep -rnE "fetch\(|https?://|password|secret|bearer|api[_-]?key" lib/ scripts/
grep -rnE "credentials|DSH_HOME|sessions" lib/ scripts/
```

## Development

```sh
npm test
node "$DSH_HOME/skills/dsh-go-plugin/kit/bin/check.mjs" "$PWD" --load
```

| File | Role |
|---|---|
| `package.json` → `dshGo` | Declares the strip / panel / turn note |
| `lib/index.js` | Host half: watches model calls, feeds data, handles taps |
| `lib/ledger.js` | Cold-history scan + live accounting + seq-based reconciliation |
| `lib/tally.js` | Pure helpers: usage folds, formatting, days |
| `lib/view.js` | Panel view (JSON tree with `{ "$": "data.x" }` bindings) and the data model |
| `bin/install.mjs` | Installer: bridge + plugin |

## License

MIT for this repository. The installer downloads `dsh-go-bridge` on demand from
[ccch1mneyyy/dsh-Go](https://github.com/ccch1mneyyy/dsh-Go) (its `package.json` says MIT;
the repository also carries AGPL-3.0). This repository does not redistribute that code.
