# dsh-session-delete

Permanent **Session** deletion for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH).

DSH ships *archive* but no real *delete*: a Session is durable as a per-Session
directory under the JSONL persistence root, and no service exposes a delete verb.
This plugin adds a `Delete session…` row to the Session `"..."` menu that removes
the Session from **all three** surfaces it lives on, behind a confirmation dialog.

## What it removes

| Surface | What happens |
| --- | --- |
| Runtime | The `AgentRegistry` entry is detached, then the `SessionStore` entry is evicted through `detachEntered` — so nothing keeps writing to the files about to disappear. The stock `session/disposed` event is emitted, which the API session controller forwards. |
| Workspace accounting | `Workspace.detachSession` for every workspace that lists the Session, plus the registry-global archive and pin sets — all through the public registry API. `workspace.json` is never edited by hand. |
| Files | The Session directory (and any duplicate project directories) under the persistence root — `session.v4.jsonl.zstd` and everything the Session owns beside it — plus the projection-cache row that holds its title and first-message preview. |

The browser half only owns the menu row, the confirmation dialog, and dropping
the row locally (a Session that was not live raises no `session/disposed` event
for the row to follow). It never touches storage.

## Safety

* **Irreversible** — hence the confirmation dialog, not a one-click menu action.
* An **actively working Session is refused** (`session-active`, HTTP 409). The
  `workspace/session-activity` waterfall — the same gate the built-in archive
  uses — is checked before anything is removed. A rejected delete is
  recoverable; a Session whose files vanish under a running agent is not.
* The route is fenced with `connection.requestRejection`, the body is capped at
  8 KB, and the Session id must match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/`.
* Unknown routes answer `404`, non-`POST` answers `405`, a missing Session
  answers `session-missing` / `404`.

## Install

The package is a DSH **bundle** plugin: the Host half rides `cordis.patch.yml`
(one `insert`), the browser half rides `dsh.client` in `package.json`.

In a DSH profile directory (for the desktop profile that is
`~/.dsh/profiles/desktop`):

```bash
# 1. put the package where the profile can resolve it
git clone https://github.com/<you>/dsh-session-delete.git plugins/dsh-session-delete

# 2. link it and register the bundle
#    package.json  dependencies:  "dsh-session-delete": "link:plugins/dsh-session-delete"
#    package.json  dsh.profile.bundles:  "dsh-session-delete"
# 3. install and restart the app
pnpm install
```

Because the bundle stack must list every mounted package, a hand-installed
(`link:`) package has to be added to `dsh.profile.bundles` manually. When the
package is installed through `dsh plugin --profile <name> add`, that list is
reconciled for you.

## Usage

1. Hover a Session in the sidebar and open its `"..."` menu.
2. Choose **Delete session…** (删除会话…) — the row sits at order 500, after
   pin / rename / fork / archive / session id.
3. Confirm in the dialog. The row disappears from the sidebar.

Refusals are shown in the dialog: `This session is still running. Stop it first,
then delete.` / `This session no longer exists.` / `Delete failed: <detail>`.

## Routes

| Route | Meaning |
| --- | --- |
| `GET  /session-delete/health` | `{ ok: true }` — liveness probe. |
| `POST /session-delete/delete` | Body `{ "sessionId": "session-…" }`. Returns the deletion report: `{ sessionId, live, directories, workspaces, archived, pinned, cached }`. |

Error codes: `forbidden`, `bad-request`, `invalid-session-id`, `session-missing`
(404), `session-active` (409), `unavailable` (503), `delete-failed` (500).

## Layout

```
lib/index.js        Host half — the delete route and the three-surface teardown
lib/client.js       Browser half — menu row, confirmation dialog, local row drop
cordis.patch.yml    Bundle patch — inserts the plugin row
package.json        `dsh.bundle.patch` + `dsh.client.inject`
```

## License

MIT
