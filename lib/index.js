/**
 * Permanent Session deletion — Host half.
 *
 * A Session is durable only as a per-Session directory under the JSONL
 * persistence root (`<root>/<projectKey(cwd)>/<sessionId>/session.v4.jsonl.zstd`
 * plus whatever the Session owns beside it). No service exposes a delete
 * verb — `SessionPersistence` is open/read/close, `SessionStore` has no
 * per-id dispose, and `WorkspaceRegistry.delete()` drops a *workspace* and
 * keeps its logs. So deleting a Session means undoing all three surfaces it
 * lives on:
 *
 *  1. the runtime — the SessionStore entry and the AgentRegistry entry, so
 *     nothing keeps writing to the files about to disappear. Eviction goes
 *     through `detachEntered`, which emits the stock `session/disposed`; the
 *     api-session-controller forwards that as `api-session/removed` and the
 *     row disappears by itself. A Session that is not live raises no event,
 *     which is why the browser half also drops the row locally.
 *  2. the Workspace accounting — `Workspace.detachSession` per workspace plus
 *     the registry-global archive and pin sets, all through the public
 *     registry API. `workspace.json` is never edited directly.
 *  3. the files — the Session directory (and any duplicate project
 *     directories) under the persistence root, plus the projection-cache row
 *     that holds its title and first-message preview.
 *
 * An actively working Session is refused (`session-active`): a rejected
 * delete is recoverable, a Session whose files vanish underneath a running
 * agent is not. The `workspace/session-activity` waterfall is the same gate
 * the built-in archive uses.
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** Route family this plugin owns. */
const ROUTE = '/session-delete'
/** Session ids are generated as `session-<uuid>`; anything else is refused. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u
/** Request bodies are one session id; anything larger is not ours. */
const BODY_LIMIT_BYTES = 8 * 1024
/** How long the projection-cache purge waits for the disposal checkpoint to land. */
const CACHE_PURGE_DELAY_MS = 500

export const name = 'session-delete'
export const inject = ['webServer', 'connection']

/** A refusal the browser half can tell apart from a transport failure. */
class SessionDeleteError extends Error {
  /**
   * @param code - stable machine code (`session-active`, `unavailable`, ...).
   * @param message - operator-facing detail.
   */
  constructor(code, message) {
    super(message)
    this.name = 'SessionDeleteError'
    this.code = code
  }
}

/**
 * Mount the delete route.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: (req, res) => {
      void route(ctx, req, res)
    },
  }), 'session-delete: routes')
}

/**
 * Fence, dispatch, and answer one request.
 * @param ctx - the plugin context.
 * @param req - the Host request.
 * @param res - the Host response.
 */
async function route(ctx, req, res) {
  const rejection = ctx.connection.requestRejection(req)
  if (rejection !== void 0) {
    writeJson(res, rejection, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
    return
  }
  const pathname = pathOf(req)
  if (pathname === `${ROUTE}/health`) {
    writeJson(res, 200, { ok: true })
    return
  }
  if (pathname !== `${ROUTE}/delete`) {
    writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown route ${pathname}` } })
    return
  }
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: `method not allowed: ${String(req.method)}` } })
    return
  }
  let body
  try {
    body = await readJson(req)
  } catch (error) {
    writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: messageOf(error) } })
    return
  }
  const sessionId = body !== null && typeof body === 'object' ? body.sessionId : undefined
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    writeJson(res, 400, { ok: false, error: { code: 'invalid-session-id', message: 'sessionId must be a Session id' } })
    return
  }
  try {
    const result = await deleteSession(ctx, sessionId)
    if (result === null) {
      writeJson(res, 404, { ok: false, error: { code: 'session-missing', message: `session "${sessionId}" is neither live nor persisted` } })
      return
    }
    writeJson(res, 200, { ok: true, result })
  } catch (error) {
    const code = error instanceof SessionDeleteError ? error.code : 'delete-failed'
    const status = code === 'session-active' ? 409 : code === 'unavailable' ? 503 : 500
    ctx.logger?.warn?.(`session-delete: ${sessionId}: ${messageOf(error)}`)
    writeJson(res, status, { ok: false, error: { code, message: messageOf(error) } })
  }
}

/**
 * Delete one Session from every surface it lives on.
 * @param ctx - the plugin context.
 * @param sessionId - the Session to delete.
 * @returns the report, or `null` when the Session never existed.
 */
async function deleteSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  const registry = ctx.get('workspaceRegistry')
  if (sessions === void 0 || persistence === void 0) {
    throw new SessionDeleteError('unavailable', 'the session store or its persistence service is not available')
  }

  const directories = await sessionDirectories(persistence, sessionId)
  const live = sessions.get(sessionId)
  if (live === void 0 && directories.length === 0) return null
  await assertIdle(ctx, sessionId)

  const report = {
    sessionId,
    live: live !== void 0,
    directories,
    workspaces: [],
    archived: false,
    pinned: false,
    cached: false,
  }

  // Stop the writers before their files go: the agent first (its registry
  // entry outlives the Session entry in the UI surfaces), then the store.
  if (live !== void 0) {
    detachAgent(ctx, sessionId)
    sessions.detachEntered(sessions.liveEntryFor(live))
  }

  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }

  if (registry !== void 0) {
    report.workspaces = registry.list().filter((workspace) => workspace.sessionIds.includes(sessionId)).map((workspace) => workspace.id)
    for (const workspace of registry.list()) {
      if (!workspace.sessionIds.includes(sessionId)) continue
      await workspace.detachSession(sessionId)
    }
    report.archived = registry.archivedSessionIds.includes(sessionId)
    report.pinned = registry.pinnedSessionIds.includes(sessionId)
    if (report.archived) await registry.unarchiveSession(sessionId)
    if (report.pinned) await registry.unpinSession(sessionId)
  }
  report.cached = purgeProjectionCache(ctx, sessionId)
  return report
}

/**
 * Drop the projection-cache row this Session leaves behind.
 *
 * The cache checkpoints a disposing Session (`session/disposed` flushes it), and
 * that write reaches the domain's FIFO chain after this call, so the row is
 * dropped once now and once after the checkpoint has had time to land. A
 * leftover row is never served — the store guards every read with the log
 * identity — but it still holds the title and the first-message preview, which
 * a permanent delete must not leave on disk.
 * @param ctx - the plugin context.
 * @param sessionId - the Session being deleted.
 * @returns whether a row existed when the purge started.
 */
function purgeProjectionCache(ctx, sessionId) {
  const table = ctx.get('sessionProjectionCache')?.table
  if (table === void 0 || typeof table.delete !== 'function') return false
  let existed = false
  if (typeof table.get === 'function') {
    try {
      existed = table.get(sessionId) !== void 0
    } catch {
      existed = false
    }
  }
  const drop = () => {
    try {
      Promise.resolve(table.delete(sessionId)).catch((error) => {
        ctx.logger?.warn?.(`session-delete: projection cache purge failed: ${messageOf(error)}`)
      })
    } catch (error) {
      ctx.logger?.warn?.(`session-delete: projection cache purge failed: ${messageOf(error)}`)
    }
  }
  drop()
  const timer = setTimeout(drop, CACHE_PURGE_DELAY_MS)
  timer.unref?.()
  return existed
}

/**
 * Refuse a Session that still has reported activity.
 * @param ctx - the plugin context.
 * @param sessionId - the Session to check.
 */
async function assertIdle(ctx, sessionId) {
  const activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
  if (activity.length > 0) {
    throw new SessionDeleteError('session-active', `session "${sessionId}" is still running`)
  }
}

/**
 * Drop a live Agent registry entry (best effort: the registry is optional).
 * @param ctx - the plugin context.
 * @param sessionId - the Session whose agent to detach.
 */
function detachAgent(ctx, sessionId) {
  const agents = ctx.get('agents')
  if (agents === void 0 || typeof agents.detachEntered !== 'function') return
  const entry = agents.store?.get?.(sessionId)
  if (entry === void 0) return
  try {
    agents.detachEntered(entry)
  } catch (error) {
    ctx.logger?.warn?.(`session-delete: agent detach failed: ${messageOf(error)}`)
  }
}

/**
 * Locate every on-disk directory that belongs to one Session.
 *
 * Session ids are safe ASCII, so the persistence encoder leaves them verbatim
 * and the directory name is the id itself.
 * @param persistence - the JSONL persistence service.
 * @param sessionId - the Session to locate.
 * @returns absolute Session directories, newest project order first-seen.
 */
export async function sessionDirectories(persistence, sessionId) {
  const root = typeof persistence?.root === 'string' ? persistence.root : undefined
  if (root === void 0) return []
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const found = []
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const directory = join(root, project.name, sessionId)
    try {
      if ((await stat(directory)).isDirectory()) found.push(directory)
    } catch {
      // Not in this project directory.
    }
  }
  return found
}

/**
 * Read the request path.
 * @param req - the Host request.
 * @returns the decoded pathname.
 */
function pathOf(req) {
  const raw = req.url ?? '/'
  try {
    return new URL(raw, 'http://session-delete.invalid').pathname
  } catch {
    return raw
  }
}

/**
 * Read one small JSON body.
 * @param req - the Host request.
 * @returns the parsed body.
 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT_BYTES) {
        reject(new Error(`request body exceeds ${BODY_LIMIT_BYTES} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(null)
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${messageOf(error)}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Answer with JSON.
 * @param res - the Host response.
 * @param status - the status code.
 * @param body - the JSON body.
 */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * Render one error message.
 * @param error - anything thrown.
 * @returns a message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
