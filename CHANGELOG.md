# Changelog

## 0.1.2

### Fixed

- `Invalid Date` in `/truncate status` and in the panel status line. `anchorMs` was renamed to `lastActiveMs` in 0.1.1, but `describeEntry()` and the `on` / `off` / `now` branches still read the old field, so `new Date(undefined + hours * 3600000)` produced `NaN`. All reads and writes now use `lastActiveMs`.
- The panel's «立即截断» button answering «该会话当前未加载，无法立即截断». The plugin never injected the `sessions` / `agents` services, so `liveSession()` could not resolve a session and the request always ended in 409. `inject` now lists both services, `liveSession()` also scans `ctx.sessions.list()`, and an unresolvable session queues the cut instead of failing: the cut runs on the next step of that session.

### Changed

- Panel status line shows the next scheduled cut and a queued-cut notice.
- Timestamps are formatted as `YYYY-MM-DD HH:mm` instead of locale output.
- Log prefix is `session-turncate:` everywhere.

## 0.1.1

- Added the «上下文截断» tab above the conversation (idle switch + 0–24 hour number input).
- Idle semantics: the clock is refreshed by every input, the cut fires after `hours` of silence.

## 0.1.0

- First release: per-session idle-time context truncation, four-event compaction transaction, `/truncate on|off|now|status` command.
