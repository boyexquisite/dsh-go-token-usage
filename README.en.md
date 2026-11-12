# dsh-go-token-usage

[中文](README.md) | English

Native token usage for the [dsh-go](https://github.com/ccch1mneyyy/dsh-Go) phone app: a status strip above the composer, a panel in the chat's Plugins tab, a note under every reply, and a generated usage card. Every number comes from this host's own session logs — no network, no estimates.

<p align="center">
  <img src="https://raw.githubusercontent.com/boyexquisite/dsh-go-token-usage/main/docs/panel.jpg" width="300" alt="The panel in the app's Plugins tab">
</p>

The generated usage card (sample data):

<p align="center">
  <img src="https://raw.githubusercontent.com/boyexquisite/dsh-go-token-usage/main/docs/preview.png" width="260" alt="Generated usage card (sample data)">
</p>

## Features

| Where | What |
|---|---|
| Status strip | `Chat 8.8M · today 245M`; tap to open the panel |
| Panel | All time / this chat / today / last 7 days / last 30 days, hit rate, daily average, days covered, today's models labelled official / relay / subscription |
| Turn note | Tokens and cache hits of each reply |
| Generate image | Draws a portrait card on the host and shows it at the bottom of the panel (a placeholder until you export) — screenshot to share (needs `python3` + Pillow) |
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

## Notes

- **Needs the dsh-go bridge**: native surfaces only render on hosts that serve it — the phone's own engine ships it; for a remote host run `npx dsh-go-token-usage install` (the installer downloads the bridge from upstream GitHub). **DSH Remote** connections do not show them.
- **Re-read after install**: switch hosts in the app (or reopen it). Manifest changes are picked up automatically; changes under `lib/` need an engine restart.
- **Generate image**: needs `python3` + Pillow on the host (it tells you when missing). The picture shows at the bottom of the panel; the PNG stays in the package's `assets/` (latest three kept). There is no long-press save in the app, so screenshot it.
- **This host only**: counts this `$DSH_HOME`; other hosts count separately. Subagents count in the windows and total, not in "this chat".
- **First run takes a few seconds**: the initial scan of existing sessions is about 5 s; numbers appear shortly after.
- **Dashes**: a relay that does not report cache counters shows "—" for the hit rate; unreported reasoning shows "—".
- **History depends on logs**: deleting session logs or switching `$DSH_HOME` loses the history; days follow the host's local time zone.

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
