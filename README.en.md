# dsh-go-token-usage

[中文](README.md) | English

Native token usage for the [dsh-go](https://github.com/ccch1mneyyy/dsh-Go) phone app: a status strip above the composer, a panel in the chat's Plugins tab, a note under every reply, and an exported usage card. Every number comes from this host's own session logs — no network, no estimates.

![Usage card (sample data)](docs/preview.png)

## Features

| Where | What |
|---|---|
| Status strip | `Chat 8.8M · today 245M`; tap to open the panel |
| Panel | All time / this chat / today / last 7 days / last 30 days, hit rate, daily average, days covered, today's models labelled official / relay / subscription |
| Turn note | Tokens and cache hits of each reply |
| Export image | Draws a portrait card on the host and shows it in the panel — screenshot to share (needs `python3` + Pillow) |
| Verify | Re-counts the raw logs and compares with the panel |

## Install

```sh
npx dsh-go-token-usage install
```

or straight into a profile:

```sh
dsh plugin --profile web add dsh-go-token-usage@0.1.0
```

Then switch hosts (or reopen the app) once so it re-reads the plugin inventory.

## Compatibility

- DSH `0.2.1-rc.2` – `0.2.x`;
- the host needs the dsh-go bridge: the phone's own engine ships it, the installer adds it to a remote host;
- native surfaces do not show over DSH Remote connections (app limitation).

## Privacy

No account, key or credential is read, and nothing is sent over the network at runtime. It only reads the `usage` counters and model names from `$DSH_HOME/sessions` (never message bodies); exported images stay on this host.

<details>
<summary>Details and known limits</summary>

- Totals: `tokens = uncached input + cache reads + cache writes + output`, matching the engine; hit rate = cache reads ÷ prompt tokens;
- "This chat" counts the session itself; subagent calls count in the windows and the total;
- Fork/seed logs skip the inherited prefix (the `session/end-seed` marker), so nothing is counted twice;
- A relay that omits cache counters shows a dash instead of a fake 0%; unreported reasoning shows a dash too;
- The first run scans existing sessions (~5 s), then only changed files are read; the cache in `$DSH_HOME/cache/dsh-go-token-usage/index.json` holds numbers, model names and local session-file paths only;
- Verify re-counts every log: `Verified · …` when it matches, `Diff N calls` for calls not yet flushed to disk.

</details>

## Uninstall

```sh
dsh plugin --profile web remove dsh-go-token-usage
```

<details>
<summary>Development / releasing</summary>

```sh
npm test
node "$DSH_HOME/skills/dsh-go-plugin/kit/bin/check.mjs" "$PWD" --load
node scripts/release.mjs 0.1.1   # bump + tag + push; Actions publishes to npm and creates the release
```

</details>

## License

MIT. The installer downloads `dsh-go-bridge` on demand from the upstream [ccch1mneyyy/dsh-Go](https://github.com/ccch1mneyyy/dsh-Go); this repository does not redistribute it.
