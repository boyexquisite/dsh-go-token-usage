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
| Panel (chat details › Plugins, All features, chat-page Plugins sheet) | Five coloured cards in the order **All time → This chat → Today → Last 7 days → Last 30 days** (blue, green, orange, teal, violet). Each card keeps title, total and unit on one line, then one small line that runs hit rate · calls · input total · output side by side (plus daily average and days covered for 7/30 days); Today adds one line of models, Last 7 days adds a bar chart, Last 30 days adds two breakdown lines. Everything is inline text rather than column layout, so narrow screens and large font scales never split it into a vertical stack. Copy summary and refresh at the bottom |

Numbers follow the engine's own accounting:

- `tokens = uncached input + cache reads + cache writes + output`;
- cache hit rate = cache reads ÷ (uncached input + cache reads + cache writes);
- "This chat" counts the current session only; the windows count every session on this host (subagents included);
- Day boundaries follow the host's local calendar;
- Numbers use three significant digits (`8.82k` / `1.25M` / `3.59B`); each metric carries its unit (tokens / calls);
- Type is one step smaller (16 for titles and numbers, 13 for notes); values and units share one line, metrics run inline instead of in columns, so narrow screens and large font scales never split them;
- “Daily avg” divides by the days that actually have calls and shows the day count, instead of spreading over 30 days;
- Reasoning shows an em dash when the engine does not report it, never a fake 0;
- Hit rates keep one decimal, so 99.7% never reads as 100%.

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

## Uninstall

```sh
dsh plugin --profile web remove dsh-go-token-usage
rm -rf "$DSH_HOME/cache/dsh-go-token-usage"
```

The bridge is separate: `dsh plugin --profile web remove dsh-go-bridge`, then delete
`$DSH_HOME/dsh-go/plugins/dsh-go-bridge`.

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
