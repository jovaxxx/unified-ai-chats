# Architecture

How the app is put together. Statements that depend on how a platform behaves and were not confirmed on many real accounts are marked **Assumption**.

## Process layout

```
src/main        Electron main process: window, sign-in windows, IPC, media protocol, installer hooks.
src/preload     Exposes exactly the `Api` methods to the renderer through contextBridge.
src/renderer    React UI. Sandboxed, contextIsolation on, no Node access.
src/core        Database, migrations, repository, sync engine, action queue, validated API. No Electron imports.
src/connectors  One folder per source (claude-code, chatgpt, claude), the shared Connector interface and errors.
src/shared      Types, zod schemas and the `Api` / IPC contract used by both sides.
src/tools       The structure recorder.
```

`src/core` has no Electron dependency on purpose: the same code runs in the app and in Vitest, and the UI tests run the real renderer against a real in-memory database.

## Security posture

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; `require` and `process` are undefined in the renderer.
- Every IPC argument is validated with zod in `src/core/api.ts` before it reaches the repository. IPC handlers reject calls whose sender frame is not the app's own page.
- Production builds send a strict Content-Security-Policy (`default-src 'self'`, `connect-src 'none'`, `img-src 'self' data: uac-media:`). The renderer cannot make network requests. Fonts are bundled.
- Navigation and `window.open` are blocked. The only way out is `shell.openExternal`, and only for https URLs built by `src/core/platforms.ts`.
- Sign-in windows load remote sites, so they get no preload script and no access to the app's API: sandboxed, context-isolated, no Node, permission requests denied, https only.
- The app never sees a password. A profile's session lives in its own persistent browser partition; the access token used for requests is kept in memory only and never logged.
- No telemetry. The only network requests go to the platforms the user connected.

## Data

SQLite through `node:sqlite` (bundled with Node/Electron, no native build step) with FTS5. The schema version lives in `PRAGMA user_version`; migrations (`src/core/migrations.ts`) are append-only. Tables: `accounts`, `projects`, `conversations`, `messages`, `media`, `tags`, `conversation_tags`, `action_queue`, `sync_runs`, `settings`, `ignored_conversations`, and the FTS table `conversations_fts`.

- **Search text** is title + original title + summary + all message text, with diacritics folded. User input is turned into quoted prefix terms, so FTS syntax typed by the user cannot break a query.
- **Backup before migrating.** When a newer app is about to change an existing database, `openDatabase` first writes `unified-ai-chats.sqlite.backup-v<old>` (`VACUUM INTO`, once per version). If the copy fails the app does not migrate.
- **One data folder** whether the app runs from source or from an installer: `<appData>/unified-ai-chats` (`UAC_USER_DATA` overrides it, for tests). It holds the database, the sessions of the sign-in windows and the image previews. Uninstalling does not delete it. A second copy of the app cannot start on the same data (single-instance lock).
- **First run.** A new install starts empty and shows a welcome screen with the accounts that can be connected. The first sync of a new profile starts by itself.

## Local state and the Trash

Archive, rename and tag change **local** state. "Move to Trash" keeps a chat in the app's Trash for 14 days (`settings.trash_retention_days`) with a visible countdown; "Restore" brings it back; "Delete now" removes it from the app for good and remembers the exclusion in `ignored_conversations`, so a sync does not bring it back. Expired Trash items are removed when the app starts. None of these touch the platform.

Every bulk action returns the ids it actually changed, so **Undo** only reverts those.

## Profiles and the dashboard

- A **profile** is an account with a free-text name chosen by the user (a client, a project, "Personal"). There can be any number per platform; names are unique per platform ignoring case and can be renamed.
- Adding an account is **sign in first, then decide**: the app recognises an account that is already a profile (no duplicate) and only asks for a name when the account is new.
- Clicking a **platform** opens its dashboard (sync status, chats / projects / archived / images, chats per month, "to clean" suggestions); clicking a **profile** opens the list and reader for that profile. Each "to clean" row opens the list with the same filter, so the number on the dashboard equals what the list shows.

## Connectors

Every connector validates every response with zod; a response that no longer matches raises `EndpointChanged`, the profile is marked "needs attention" and the sync stops instead of guessing. Other errors: `SessionExpired`, `RateLimited`, `NotFound`. Requests are sequential, paced with jitter, with growing back-off on 429/5xx. Connectors share one interface (`src/connectors/types.ts`). The three shipped today are read-only.

### Claude Code sessions

Reads the JSONL files Claude Code keeps in `~/.claude/projects/<project>/<session>.jsonl`. Local only: no login, no network, nothing in that folder is modified.

- The conversation chain runs through non-message lines (`attachment`, `system`, and after compaction a boundary whose `parentUuid` is null and whose `logicalParentUuid` points back); the parser walks all of them.
- The Reader offers "Copy resume command" (`cd '<folder>' && claude --resume <session id>`), with the folder quoted for the shell.
- Only the active branch is shown. Tool calls appear as one short line; reasoning and tool output are not shown or indexed. Sub-agent transcripts are skipped.
- Titles: the source's own title, else the first prompt (kept as «was …»); a title renamed in the app is never overwritten by a later sync.
- Projects: named after the last segment of the working directory. Sessions started in the home folder, or directly in Documents, Desktop or Downloads, belong to no project.
- **Assumption:** the file format is not documented; field names were observed on one installation and may differ between Claude Code versions.

### ChatGPT

Built from a structure report recorded on a real account (52 endpoints). It reads through the profile's own browser session (`src/main/chatgptHttp.ts`).

- Endpoints: `GET /api/auth/session` (account id and short-lived token), `GET /backend-api/conversations` (paged, active and archived), the project sidebar and each project's conversation list, `GET /backend-api/pins`, `GET /backend-api/conversation/<id>`, `GET /backend-api/files/download/<id>`.
- A chat is a tree (`mapping` and `current_node`); the active branch is kept. Voice, tool and reasoning messages are handled; content the importer leaves out is counted by kind in the sync report.
- Projects are `g-p-…` ids; other `g-…` ids are custom GPTs and are not folders. Pinned chats and folders come from `/backend-api/pins` and are imported even if the main list does not show them.
- A profile signed in as a different account than it was created for is refused before anything is read.
- **Assumptions:** that `is_archived=true` on the list endpoint returns the archive, the exact shape of the pin items, and the real host of image links.

### Claude

Built from a structure report recorded on a real account.

- `GET /api/organizations/<org>/chat_conversations_v2` (active, archived, starred), `…/chat_conversations/<id>?tree=True&rendering_mode=messages&render_all_tools=true`, `…/projects_v2`.
- The active branch is kept (from `current_leaf_message_uuid` up through `parent_message_uuid`). Text is kept; thinking, tool calls and results, files and attachments are counted in the sync report, not shown.
- **Assumptions:** `GET /api/organizations` (organization ids) and `GET /api/account` (account id) were not in the report and come from calls unofficial clients are known to use; whether `starred=true` lists starred chats; whether the session cookie alone is enough.

## Sign-in windows and the structure recorder

Each profile has its own persistent partition (`persist:<platform>-<id>`), so several accounts of one platform stay signed in at once. The account id is read from the platform's own page from inside its window; only the id and a display name leave the page, never the token.

The **structure recorder** (opt-in, per profile, only while "Start recording" is on; `src/tools/recorder.ts`) attaches the Chrome DevTools debugger to that window and reduces every JSON response to its **shape**: field names and types, never values. Ids, locale and hex are masked; analytics and bot-check calls are skipped; only the platform's own hosts are considered. The report is saved to `<userData>/captures/` and is only sent anywhere if the user sends it.

## Sync

- **Incremental.** The chat lists are read newest first and stop at the first chat that has not changed since the last sync; only new or changed chats are read, most recent first. A chat not changed for 60 days is only read again if the platform reports a change. A full listing is made when the first import is unfinished or a recent chat came out empty.
- **Resumable.** A chat already stored and unchanged is skipped, so an interrupted import resumes where it stopped. Each conversation records which version of the importer read it (`parse_version`); recent ones read by an older importer are read again once.
- **Each profile syncs on its own**, at the same time as the others, with its own lock, progress line and rate-limit wait (`syncProfiles`). Asking again for a profile that is already syncing joins the run in progress.
- **Rate limits.** A 429 waits (3 s, 10 s, 30 s, 1 min, 2 min, or `Retry-After`), slows the rest of the run, and the UI shows "waiting N s".
- **Background refresh.** Every 3 minutes and when the window comes back into focus after more than a minute, the app quietly refreshes recent chats (`syncRecent`), with a small "N chats updated" note when something changed. It walks every project's list only every fifth refresh.
- **Reports** carry counts only (chats seen, imported, failed, kinds skipped, listing numbers), never content.

## Images (ChatGPT)

Images are **not downloaded**. When an image is looked at, the app asks ChatGPT for a fresh signed link and fetches it with that profile's session (one request at a time, spaced out); the bytes stay in memory (up to 80 images / 120 MB) and are served to the window through `uac-media://m/<id>`, only for image types and only by database id. Only `https` links on `chatgpt.com`, `oaiusercontent.com` and `openaiusercontent.com` are followed.

- **Previews:** the chat, the gallery and the dashboard show a small JPEG (240 px on the long side, a few KB) served as `uac-media://t/<id>` and kept in `<userData>/thumbs/<id>.jpg`, so an image is fetched once. They are removed when the chat is deleted for good.
- **Save image…** writes one image where the user chooses.
- **Gallery:** per profile and general; search with completion (project names and chat titles that have images), a project filter and a sort by date; more images load as the end comes into view.
- References containing `#` are thumbnails of web results, not files of the account, and are not listed.

## Actions on a platform

The machinery for changing something on a platform is in the code: a per-profile "allow changes" switch (off by default), a durable queue (`action_queue`, `src/core/actions.ts`) that runs one change at a time with pauses, back-off and resume after a restart, a verified local copy taken before a delete (`src/core/exporter.ts`), a confirmation that separates "on the platform" from "only here", and an Activity view. It acts only through connector operations; the connectors shipped today are read-only (`capabilities.rename/archive/delete` are `false`), so nothing is ever sent to a platform that changes data.

## Interface

- **Sorting:** most/least recently updated, newest/oldest created, title A–Z / Z–A, most/fewest messages.
- **Search:** inside the current profile by default, with a "Search everywhere" switch; ⌘K focuses it.
- **Order of profiles and platforms:** drag, or Alt+↑/↓; saved.
- **Layout:** sidebar and list widths are draggable and saved. **Dark mode** swaps a palette of colour tokens; it starts from the system setting and is remembered.
- **Reader:** assistant messages are rendered as Markdown (GitHub flavour), raw HTML is shown as text, `javascript:` links are dropped and links open in the user's browser.
- **Shared controls** (`src/renderer/components/Controls.tsx`): one search field, one filter pill and one sort menu are used in every view.
- English by default with an Italian translation (i18next).

## Packaging

`electron-builder` (`electron-builder.yml`, icon in `assets/icon/`) builds a `.dmg` (arm64 and x64), an NSIS `.exe` (x64), and `AppImage` and `.deb` (x64). There are no native modules to rebuild. Only `out/` and `package.json` ship.

- **Self-test:** `UAC_SELFTEST=1 UAC_USER_DATA=<dir> "<app>/Contents/MacOS/Unified AI Chats"` opens the database, runs a search, prints `SELFTEST ok … schema=N chats=N` and exits.
- **macOS signing:** the app is not signed or notarized by Apple; `mac.identity` is `"-"` (ad-hoc), because without any signature the bundle does not verify and Apple Silicon refuses to run it.
- **Verified** on macOS 26.5 (Apple Silicon): both `.dmg` files build, `codesign --verify --deep --strict` passes, `spctl` reports the app as rejected (expected for an app not notarized), a copy taken from the `.dmg` runs, creates and migrates its database and answers a search, and an older database (schema 8) is upgraded with a `.backup-v8` copy. Windows and Linux builds are produced by CI and have not been run.
- A release is made by pushing a version tag (`v*`): `.github/workflows/release.yml` builds on macOS, Windows and Linux and attaches the installers and `SHA256SUMS.txt`.
