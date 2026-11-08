# Changelog

## 0.1.4

### Changed

- `engines.dsh` is now `>=0.2.1-rc.3` (was `>=0.2.1-rc.5`). The old range made DSH 0.2.1-rc.3 report the package as `incompatible-version`, so the plugin and its «上下文截断» tab were never loaded on that runtime.
- No runtime code change: `lib/index.js` and `client.js` are byte-identical to 0.1.2. Verified against DSH 0.2.1-rc.3 that every host API this plugin uses is present (`sessions`, `agents`, `commands`, `webServer`, the `compaction/*` events, the `compact-checkpoint` source and the `surfaceOp` replace op).

## 0.1.2

### Fixed

- `Invalid Date` in `/truncate status` and in the panel status line. `anchorMs` was renamed to `lastActiveMs` in 0.1.1, but `describeEntry()` and the `on` / `off` / `now` branches still read the old field, so `new Date(undefined + hours * 3600000)` produced `NaN`. All reads and writes now use `lastActiveMs`.
- The panel's «立即截断» button answering «该会话当前未加载，无法立即截断». The plugin never injected the `sessions` / `agents` services, so `liveSession()` could not resolve a session and the request always ended in 409. `inject` now lists both services, `liveSession()` also scans `ctx.sessions.list()`, and an unresolvable session queues the cut instead of failing: the cut runs on the next step of that session.

### Changed

- Panel status line shows the next scheduled cut and a queued-cut notice.
- Timestamps are formatted as `YYYY-MM-DD HH:mm` instead of locale output.
- Log prefix is `session-turncate:` everywhere.
- Published to npm as `dsh-session-turncate@0.1.2` (`dist-tag latest`).

## 0.1.1

- Added the «上下文截断» tab above the conversation (idle switch + 0–24 hour number input).
- Idle semantics: the clock is refreshed by every input, the cut fires after `hours` of silence.

## 0.1.0

- First release: per-session idle-time context truncation, four-event compaction transaction, `/truncate on|off|now|status` command.
