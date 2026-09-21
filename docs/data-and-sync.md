# Your data and how sync works

## Where your chats are stored

The app keeps a **full local copy of the text of every chat** it imports. Nothing is read from the platform when you open, search or browse a chat.

| What                                                 | Where                                          |
| ---------------------------------------------------- | ---------------------------------------------- |
| Chats, messages, projects, tags, Trash, sync history | one SQLite database: `unified-ai-chats.sqlite` |
| Image previews (small JPEGs)                         | `thumbs/`                                      |
| Sign-in sessions of each profile                     | the app's browser partitions (`Partitions/`)   |
| Reports of the structure recorder                    | `captures/` (only if you use the recorder)     |
| Safety copies made before deleting on a platform     | `Documents/Unified AI Chats/Exports/`          |

All of these live in the app's data folder, **outside the app**:

- macOS: `~/Library/Application Support/unified-ai-chats`
- Windows: `%APPDATA%\unified-ai-chats`
- Linux: `~/.config/unified-ai-chats`

The same folder is used whether you run the installed app or the app from source. Nothing is uploaded anywhere: there is no telemetry and no cloud copy.

## What is stored, and what is not

- **Stored:** the text of the messages (the active branch of each conversation), titles, projects, archive state, pins, your tags and local renames, and the Trash.
- **Not stored:** images and files. Generated images are shown from the platform's own link when you look at them; only small previews are kept, in `thumbs/`, so an image is not fetched again every time. **Save image…** saves one image where you choose. Images and files you uploaded, attachments, and the reasoning or tool output of a chat are not shown.
- **Claude Code** sessions are read from `~/.claude/projects` and copied into the database; your Claude Code files are never modified.

## How sync works

Sync is the only thing that talks to a platform, using the session of the profile you signed in with.

- **The first sync of a new profile starts by itself** right after you sign in. It imports every chat once, newest first, and can take a while on a large account because the platform limits how fast chats can be read. A progress line shows how far it is, and says when the platform asks the app to slow down.
- **After that, sync is incremental.** The app lists your chats newest first and stops at the first one that has not changed since the last sync; only new or changed chats are read again.
- **Chats not changed for 60 days** are not read again unless the platform reports a change.
- **In the background:** while the app is open it refreshes recent chats every 3 minutes and when the window comes back into focus, and shows a small note when something was updated. Every fifth refresh also looks through your projects.
- **Sync now** does the same incremental refresh on demand, for one platform or one profile. Profiles sync independently and at the same time, so a slow one never holds another back.
- **It is safe to interrupt.** A chat already stored and unchanged is skipped, so an import that was stopped resumes where it stopped.
- **Read-only:** sync never changes anything on a platform.

A change on the platform shows up at the next refresh, at most about three minutes later, or at once with **Sync now**.

## Upgrading the app

Installing a newer version over an old one keeps everything: it uses the same data folder, so your profiles, chats and sessions are still there and **nothing is imported again**. If a new version changes the database structure, the app first saves a copy next to it (`unified-ai-chats.sqlite.backup-v<old version>`, made once per version) and does not upgrade if that copy cannot be made.

Uninstalling the app does not delete your data.

## Backing up, moving or resetting

- **Back up:** quit the app and copy the data folder (or at least `unified-ai-chats.sqlite`).
- **Start from scratch:** quit the app and delete the data folder. The next start is a new install: it shows the welcome screen and asks you to connect an account.
- **Two copies at once are not possible** on the same data: a second copy of the app brings the first one to the front instead of starting.
