// @vitest-environment jsdom
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi } from '../core/api';
import { openDatabase } from '../core/db';
import { ensureDemoData, seedFixtures } from '../core/fixtures';
import { Repo } from '../core/repo';
import { fakeWeb, writableConnector } from '../core/testing';
import { App } from './App';
import i18n from './i18n';

/** The whole renderer against a real in-memory database, through the same validated Api as IPC. */
let opened: string[];
let repo: Repo;

beforeEach(async () => {
  repo = new Repo(openDatabase());
  seedFixtures(repo);
  repo.setSetting('demo_data', '1');
  opened = [];
  window.api = createApi(repo, { openExternal: async (url) => void opened.push(url) });
  await i18n.changeLanguage('en');
});

afterEach(cleanup);

async function renderApp() {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText('Shopify theme structure: sections and metafields');
  return user;
}

describe('inbox shell', () => {
  it('shows the sidebar tree, the list and a demo-data notice', async () => {
    await renderApp();
    const nav = screen.getByRole('navigation', { name: 'Main views' });
    expect(within(nav).getByRole('button', { name: /All chats/ })).toHaveTextContent(
      String(repo.sidebar().totalChats),
    );
    expect(within(nav).getByRole('button', { name: /Trash/ })).toHaveTextContent('0');
    expect(screen.getByText(/Demo data: nothing here comes from a real account/)).toBeVisible();
    // The account needing attention is flagged, the others show a synced status.
    expect(screen.getByText('Verify')).toBeVisible();
    expect(screen.getAllByRole('img', { name: 'Synced' }).length).toBeGreaterThan(0);
  });

  it('opens a chat read-only with the original title and a local-only footer', async () => {
    const user = await renderApp();
    await user.click(screen.getByRole('button', { name: /Shopify theme structure/ }));
    const reader = await screen.findByRole('region', { name: 'Chat reader' });
    expect(
      within(reader).getByRole('heading', {
        name: 'Shopify theme structure: sections and metafields',
      }),
    ).toBeVisible();
    expect(within(reader).getByText(/Original title «Shopify theme help»/)).toBeVisible();
    expect(within(reader).getByText(/Read-only\. Changes stay on this device/)).toBeVisible();

    await user.click(within(reader).getByRole('button', { name: /Open on ChatGPT/ }));
    expect(opened).toEqual(['https://chatgpt.com/c/fx-chatgpt-0']);
  });

  it('opens a chat scrolled to its last message, and follows the end until the reader scrolls', async () => {
    // jsdom has no layout: give the reader a height so there is an end to scroll to.
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 1234,
    });
    try {
      const user = await renderApp();
      await user.click(screen.getByRole('button', { name: /Shopify theme structure/ }));
      const reader = await screen.findByRole('region', { name: 'Chat reader' });
      const body = reader.querySelector('.reader-body') as HTMLElement;
      await waitFor(() => expect(body.scrollTop).toBe(1234));

      // The reader scrolls up by themselves: the view stops following the end.
      body.scrollTop = 10;
      fireEvent.wheel(body);
      fireEvent.load(body);
      expect(body.scrollTop).toBe(10);

      // Opening another chat starts from its end again.
      await user.click(
        screen.getByRole('button', { name: /Liquid: looping over product variants/ }),
      );
      await waitFor(() =>
        expect((document.querySelector('.reader-body') as HTMLElement).scrollTop).toBe(1234),
      ); // a new reader is made for each chat
    } finally {
      if (desc) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', desc);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
    }
  });

  it('searches full text and clears back to the whole list', async () => {
    const user = await renderApp();
    await user.type(screen.getByRole('searchbox', { name: 'Search all chats' }), 'béchamel');
    await screen.findByText('Baked pasta recipe');
    await waitFor(() =>
      expect(screen.queryByText('Liquid: looping over product variants')).toBeNull(),
    );
    await user.clear(screen.getByRole('searchbox', { name: 'Search all chats' }));
    await screen.findByText('Liquid: looping over product variants');
  });

  it('filters from the sidebar tree: account, inbox and project', async () => {
    const user = await renderApp();
    await user.click(screen.getByRole('button', { name: 'ChatGPT Acme Store' }));
    await user.click(await screen.findByRole('button', { name: /Shopify and theme/ }));
    await screen.findByText('Liquid: looping over product variants');
    expect(screen.queryByText('Baked pasta recipe')).toBeNull();
  });
});

describe('bulk flow on fixtures', () => {
  it('select all N → archive → undo → move to Trash → restore', async () => {
    const user = await renderApp();

    const total = repo.sidebar().totalChats;
    const inbox = repo.listChats({ scope: 'inbox' }).total; // excludes chats inside projects
    const alreadyArchived = repo.listChats({ scope: 'archive' }).total;
    const archivable = total - alreadyArchived;
    expect(total).toBeGreaterThan(100); // more than one page of 100

    // Select one row, then "Select all N".
    await user.click(screen.getAllByRole('checkbox', { name: /Select chat/ })[0]!);
    expect(screen.getByText('1 selected')).toBeVisible();
    await user.click(screen.getByRole('button', { name: `Select all ${total}` }));
    expect(await screen.findByText(`${total} selected`)).toBeVisible();

    // Archive: chats that are already archived are skipped, and the toast says so.
    await user.click(screen.getByRole('button', { name: /^Archive$/ }));
    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent(
      `Archived ${archivable} chats on this device. Nothing changed on the platforms.`,
    );
    expect(toast).toHaveTextContent(`${alreadyArchived} skipped`);
    expect(repo.listChats({ scope: 'inbox' }).total).toBe(0);

    // Undo puts them back.
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(repo.listChats({ scope: 'inbox' }).total).toBe(inbox));

    // Delete two chats: they go to the app's own trash, nothing remote is touched.
    const boxes = screen.getAllByRole('checkbox', { name: /Select chat/ });
    await user.click(boxes[0]!);
    await user.click(boxes[1]!);
    await user.click(screen.getByRole('button', { name: /^Move to Trash$/ }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Moved 2 chats to the Trash. Nothing was deleted on the platforms.',
    );
    expect(opened).toEqual([]);

    const nav = screen.getByRole('navigation', { name: 'Main views' });
    await waitFor(() =>
      expect(within(nav).getByRole('button', { name: /Trash/ })).toHaveTextContent('2'),
    );
    await user.click(within(nav).getByRole('button', { name: /Trash/ }));
    const rows = await screen.findAllByText('Removed in 14 days');
    expect(rows).toHaveLength(2);

    // Restore from the trash view.
    await user.click(screen.getAllByRole('checkbox', { name: /Select chat/ })[0]!);
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(repo.sidebar().trashed).toBe(1));
  });

  it('renames a chat locally and keeps the original title visible', async () => {
    const user = await renderApp();
    await user.click(screen.getByRole('button', { name: /Baked pasta recipe/ }));
    const reader = await screen.findByRole('region', { name: 'Chat reader' });
    await user.click(within(reader).getByRole('button', { name: 'Rename' }));
    const input = within(reader).getByRole('textbox', { name: 'Chat title' });
    await user.clear(input);
    await user.type(input, 'Sunday lasagne{Enter}');
    await within(reader).findByRole('heading', { name: 'Sunday lasagne' });
    expect(within(reader).getByText(/Original title «Recipe»/)).toBeVisible();
  });
});

describe('i18n', () => {
  it('switches to Italian and back', async () => {
    const user = await renderApp();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'it');
    expect(await screen.findByRole('button', { name: /Tutte le chat/ })).toBeVisible();
    expect(screen.getByText(/Dati demo/)).toBeVisible();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Lingua' }), 'en');
    expect(await screen.findByRole('button', { name: /All chats/ })).toBeVisible();
  });
});

describe('connecting Claude Code sessions', () => {
  it('imports local sessions, drops the demo data and shows them read-only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uac-ui-'));
    try {
      // Synthetic session: no real content.
      mkdirSync(join(root, '-work-demo-app'), { recursive: true });
      const line = (o: object) => JSON.stringify(o);
      writeFileSync(
        join(root, '-work-demo-app', 's1.jsonl'),
        [
          line({
            type: 'user',
            uuid: 'u1',
            parentUuid: null,
            timestamp: '2026-09-10T10:00:00.000Z',
            cwd: '/work/demo-app',
            message: { role: 'user', content: 'Explain the frobnicate step' },
          }),
          line({
            type: 'assistant',
            uuid: 'a1',
            parentUuid: 'u1',
            timestamp: '2026-09-10T10:00:02.000Z',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Frobnicate joins the two parts.' }],
            },
          }),
          line({ type: 'ai-title', aiTitle: 'Frobnicate explained' }),
        ].join('\n'),
      );
      window.api = createApi(repo, { openExternal: async () => {}, claudeCodeRoot: root });

      const user = await renderApp();
      await user.click(screen.getByRole('button', { name: 'Add account' }));
      await user.click(screen.getByRole('menuitem', { name: /Claude Code sessions/ }));
      // The profile is named when it is created.
      const dialog = await screen.findByRole('dialog', { name: 'Name this profile' });
      const nameInput = within(dialog).getByRole('textbox', { name: 'Profile name' });
      await user.clear(nameInput);
      await user.type(nameInput, 'Side project');
      await user.click(within(dialog).getByRole('button', { name: 'Connect and import' }));

      expect(await screen.findByText('Frobnicate explained')).toBeVisible();
      expect(await screen.findByRole('status')).toHaveTextContent('Imported 1 session.');
      expect(screen.queryByText(/Demo data/)).toBeNull();
      expect(screen.queryByText('Baked pasta recipe')).toBeNull();
      expect(screen.getByRole('button', { name: 'Claude Code Side project' })).toBeVisible();

      await user.click(screen.getByRole('button', { name: /Frobnicate explained/ }));
      const reader = await screen.findByRole('region', { name: 'Chat reader' });
      expect(within(reader).getByText('Frobnicate joins the two parts.')).toBeVisible();
      expect(within(reader).getByText(/session files are never modified/)).toBeVisible();
      // There is no web page to open: the button copies the command that resumes the session.
      expect(within(reader).queryByRole('button', { name: /Open on/ })).toBeNull();
      await user.click(within(reader).getByRole('button', { name: 'Copy resume command' }));
      expect(await navigator.clipboard.readText()).toBe(
        "cd '/work/demo-app' && claude --resume s1",
      );
      expect(await within(reader).findByRole('status')).toHaveTextContent(
        /Paste it into a terminal/,
      );
      // Once connected, the source cannot be added twice; it can be synced instead.
      await user.click(screen.getByRole('button', { name: 'Add account' }));
      expect(screen.getByRole('menuitem', { name: /Claude Code sessions/ })).toBeDisabled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('platform dashboard vs column view', () => {
  const platformHead = (name: string) =>
    screen
      .getAllByRole('button')
      .find((b) => b.className.includes('platform-head') && b.textContent?.startsWith(name))!;

  it('the platform opens the dashboard; a profile opens the columns', async () => {
    const user = await renderApp();
    await user.click(platformHead('ChatGPT'));

    const dash = await screen.findByRole('main', { name: 'ChatGPT' });
    expect(within(dash).getByRole('heading', { name: 'ChatGPT' })).toBeVisible();
    // Stats, chart and cleanup are there; the list and reader are not.
    expect(within(dash).getByText('Chats')).toBeVisible();
    expect(within(dash).getByRole('img', { name: /Chats created per month/ })).toBeVisible();
    expect(within(dash).getByText('To clean')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Chat list' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Chat reader' })).toBeNull();

    // The number in the "All profiles" tab is the platform total.
    const total = repo.dashboard('chatgpt').stats.chats;
    expect(within(dash).getByRole('button', { name: `All profiles · ${total}` })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Clicking a profile in the sidebar leaves the dashboard for the column view of that profile.
    await user.click(screen.getByRole('button', { name: 'ChatGPT Acme Store' }));
    expect(await screen.findByRole('region', { name: 'Chat list' })).toBeVisible();
    expect(screen.queryByRole('main', { name: 'ChatGPT' })).toBeNull();
    const acme = repo.filterOptions().accounts.find((a) => a.label === 'Acme Store')!;
    await waitFor(() =>
      expect(screen.getAllByRole('checkbox', { name: /Select chat/ }).length).toBeGreaterThan(0),
    );
    expect(repo.listChats({ accountId: acme.id }).total).toBeGreaterThan(0);
  });

  it('switches between the profiles of a platform (several clients)', async () => {
    const user = await renderApp();
    await user.click(platformHead('ChatGPT'));
    const dash = await screen.findByRole('main', { name: 'ChatGPT' });
    for (const name of ['Personal', 'Acme Store', 'Bluewave Studio']) {
      expect(
        within(dash).getByRole('button', { name: new RegExp(`^${name} · \\d+$`) }),
      ).toBeVisible();
    }
    await user.click(within(dash).getByRole('button', { name: /^Bluewave Studio · / }));
    const bluewave = repo.dashboard('chatgpt').accounts.find((a) => a.label === 'Bluewave Studio')!;
    await within(dash).findByText(/profile Bluewave Studio/);
    expect(within(dash).getByText(String(bluewave.total), { selector: '.stat-num' })).toBeVisible();
  });

  it('renames a profile from the dashboard and shows clashes', async () => {
    const user = await renderApp();
    await user.click(platformHead('ChatGPT'));
    const dash = await screen.findByRole('main', { name: 'ChatGPT' });
    await user.click(within(dash).getByRole('button', { name: /^Bluewave Studio · / }));
    await user.click(within(dash).getByRole('button', { name: 'Rename profile' }));
    const input = within(dash).getByRole('textbox', { name: 'Profile name' });

    await user.clear(input);
    await user.type(input, 'personal{Enter}'); // already exists on ChatGPT
    expect(await within(dash).findByRole('alert')).toHaveTextContent(/already have a profile/);

    await user.clear(input);
    await user.type(input, 'Client: Bluewave 2026{Enter}');
    await within(dash).findByRole('button', { name: /^Client: Bluewave 2026 · / });
    expect(
      await screen.findByRole('button', { name: 'ChatGPT Client: Bluewave 2026' }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'ChatGPT Bluewave Studio' })).toBeNull();
  });

  it('"to clean" rows open the inbox already filtered, and the filter can be cleared', async () => {
    const user = await renderApp();
    await user.click(platformHead('ChatGPT'));
    const dash = await screen.findByRole('main', { name: 'ChatGPT' });
    const generic = repo.dashboard('chatgpt').clean.generic;
    await user.click(
      within(dash).getByRole('button', {
        name: new RegExp(`Generic titles to rename\\s*${generic}`),
      }),
    );

    const list = await screen.findByRole('region', { name: 'Chat list' });
    expect(within(list).getByText('To clean: Generic titles to rename')).toBeVisible();
    await waitFor(() => expect(within(list).getByText(String(generic))).toBeVisible());
    await user.click(within(list).getByRole('button', { name: 'Clear filter' }));
    await waitFor(() => expect(within(list).queryByText(/To clean:/)).toBeNull());
  });

  it('Sync now is off while only demo data exists; Open ChatGPT works', async () => {
    const user = await renderApp();
    await user.click(platformHead('ChatGPT'));
    const dash = await screen.findByRole('main', { name: 'ChatGPT' });
    expect(within(dash).getByRole('button', { name: 'Sync now' })).toBeDisabled();
    await user.click(within(dash).getByRole('button', { name: /Open ChatGPT/ }));
    expect(opened).toEqual(['https://chatgpt.com/']);
  });
});

describe('adding a ChatGPT account (sign in first)', { timeout: 20_000 }, () => {
  // The dialog polls every 1.5s, so waiting for the next state takes a little while.
  const SLOW = { timeout: 6000 };

  const openSignIn = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: 'Add account' }));
    await user.click(screen.getByRole('menuitem', { name: /ChatGPT/ }));
    return screen.findByRole('dialog', { name: 'Sign in to ChatGPT' });
  };

  /** A ChatGPT with nothing in it: enough for the sync that starts right after signing in. */
  const emptyChatGpt = (): import('../connectors/types').HttpJson => async (path) => {
    if (path.startsWith('/api/auth/session'))
      return {
        status: 200,
        json: { accessToken: 'tok-' + 'x'.repeat(20), user: { id: 'user-AAA', name: 'X' } },
      };
    if (path.startsWith('/backend-api/conversations'))
      return { status: 200, json: { items: [], total: 0, limit: 28, offset: 0 } };
    if (path.startsWith('/backend-api/gizmos/snorlax'))
      return { status: 200, json: { items: [], cursor: null } };
    if (path.startsWith('/backend-api/pins')) return { status: 200, json: [] };
    return { status: 404, json: undefined };
  };

  it('does not ask for a name up front: sign in first, name the profile only if the account is new', async () => {
    const web = fakeWeb();
    web.setHttp(emptyChatGpt());
    window.api = createApi(repo, { openExternal: async () => {}, web: web.host });
    const user = await renderApp();

    const dialog = await openSignIn(user);
    expect(within(dialog).getByText(/never sees your password/)).toBeVisible();
    expect(within(dialog).queryByRole('textbox')).toBeNull(); // no name field while waiting
    expect(repo.filterOptions().accounts.some((a) => a.label === 'Client: Rossi')).toBe(false);

    web.signedInAs('user-AAA', 'Mario Rossi');
    const name = await within(dialog).findByRole('textbox', { name: 'Profile name' }, SLOW);
    expect(name).toHaveValue('Mario Rossi'); // suggested from the account, editable
    await user.clear(name);
    await user.type(name, 'Client: Rossi');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));

    const dash = await screen.findByRole('main', { name: 'ChatGPT' });
    await within(dash).findByText(/profile Client: Rossi/);
    // The first import starts by itself, with this profile's own session: nobody presses Sync.
    await waitFor(() => expect(web.httpPartitions.length).toBeGreaterThan(0));
    expect(screen.queryByText(/Demo data/)).toBeNull();
    expect(repo.profilesOf('chatgpt')).toMatchObject([
      { label: 'Client: Rossi', identity: 'user-AAA' },
    ]);
  });

  it('recognises an account that is already a profile: no name, no duplicate', async () => {
    const web = fakeWeb();
    web.setHttp(emptyChatGpt());
    window.api = createApi(repo, { openExternal: async () => {}, web: web.host });
    // A real profile exists already (this removes the demo, so render without waiting for it).
    web.signedInAs('user-AAA');
    const first = await window.api.signInStart('chatgpt');
    await window.api.signInStatus(first.attemptId);
    await window.api.signInFinish(first.attemptId, { type: 'new', label: 'Acme Store' });

    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: 'Add account' });
    const dialog = await openSignIn(user);

    // Signs in as the same account: the dialog closes by itself and says nothing needs to be created.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), SLOW);
    const dash = await screen.findByRole('main', { name: 'ChatGPT' });
    await within(dash).findByText(/profile Acme Store/);
    expect(repo.profilesOf('chatgpt')).toHaveLength(1);
    void dialog;
  });

  it('asks which profile it is when the platform does not say who signed in', async () => {
    const web = fakeWeb();
    window.api = createApi(repo, { openExternal: async () => {}, web: web.host });
    web.signedInAs('user-AAA');
    const first = await window.api.signInStart('chatgpt');
    await window.api.signInStatus(first.attemptId);
    await window.api.signInFinish(first.attemptId, { type: 'new', label: 'Acme Store' });

    web.signedInAs(null);
    web.onlyAfterUserSaysSo();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: 'Add account' });
    const dialog = await openSignIn(user);

    await user.click(within(dialog).getByRole('button', { name: 'I’ve signed in' }));
    await within(dialog).findByText(/did not say which account this is/);
    const cont = within(dialog).getByRole('button', { name: 'Continue' });
    expect(cont).toBeDisabled(); // never guesses: the user has to choose
    await user.click(within(dialog).getByRole('radio', { name: /my profile “Acme Store”/ }));
    await user.click(cont);
    await screen.findByRole('main', { name: 'ChatGPT' });
    expect(repo.profilesOf('chatgpt')).toHaveLength(1);
  });

  it('cancelling closes the window and forgets the session', async () => {
    const web = fakeWeb();
    window.api = createApi(repo, { openExternal: async () => {}, web: web.host });
    const user = await renderApp();
    const dialog = await openSignIn(user);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(web.wiped).toHaveLength(1));
    expect(repo.sidebar().demo).toBe(true); // nothing was created, the demo is untouched
  });

  it('offers a retry when the window is closed before signing in', async () => {
    const web = fakeWeb();
    window.api = createApi(repo, { openExternal: async () => {}, web: web.host });
    const user = await renderApp();
    const dialog = await openSignIn(user);
    web.windowClosed();
    await within(dialog).findByText(/closed before you signed in/, undefined, SLOW);
    web.signedInAs('user-AAA');
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
    await within(dialog).findByRole('textbox', { name: 'Profile name' }, SLOW);
  });
});

describe('ChatGPT structure recorder', () => {
  const profile = async (web: ReturnType<typeof fakeWeb>) => {
    window.api = createApi(repo, { openExternal: async () => {}, web: web.host });
    web.signedInAs('user-AAA');
    const a = await window.api.signInStart('chatgpt');
    await window.api.signInStatus(a.attemptId);
    return (await window.api.signInFinish(a.attemptId, { type: 'new', label: 'Acme Store' }))
      .accountId;
  };
  const openDashboard = async (user: ReturnType<typeof userEvent.setup>) => {
    render(<App />);
    let head: HTMLElement | undefined;
    await waitFor(() => {
      head = screen
        .getAllByRole('button')
        .find((b) => b.className.includes('platform-head') && b.textContent?.startsWith('ChatGPT'));
      expect(head).toBeTruthy();
    });
    await user.click(head!);
    return screen.findByRole('main', { name: 'ChatGPT' });
  };

  it('start → recording → stop → report saved → show in Finder', async () => {
    const web = fakeWeb();
    await profile(web);
    const user = userEvent.setup();
    const dash = await openDashboard(user);
    await user.click(within(dash).getByRole('button', { name: /^Acme Store · / }));

    expect(within(dash).getByText(/never titles, messages, tokens, cookies or ids/)).toBeVisible();
    await user.click(within(dash).getByRole('button', { name: 'Start recording' }));
    expect(
      await within(dash).findByText('Recording: 7 calls, 3 different endpoints'),
    ).toBeVisible();
    await user.click(within(dash).getByRole('button', { name: 'Stop and save report' }));
    expect(await within(dash).findByText('Report saved: 7 calls, 3 endpoints.')).toBeVisible();
    expect(within(dash).getByText('/tmp/structure-chatgpt-test.json')).toBeVisible();
    await user.click(within(dash).getByRole('button', { name: 'Show in Finder' }));
    expect(web.calls.map((c) => c.fn).slice(-3)).toEqual([
      'recorderStart',
      'recorderStop',
      'revealReport',
    ]);
  });

  it('tells you what to do next: a signed-in profile with no chats yet can be synced', async () => {
    const web = fakeWeb();
    await profile(web);
    const user = userEvent.setup();
    const dash = await openDashboard(user);
    expect(within(dash).getByRole('note')).toHaveTextContent(
      /Signed in\. Ready to import your chats\./,
    );
    expect(within(dash).getByRole('note')).toHaveTextContent(/Click “Sync now”/);
    expect(within(dash).getByRole('button', { name: 'Sync now' })).toBeEnabled(); // a real profile now
  });

  it('needs a selected profile for the recorder; the Add account menu lists Claude', async () => {
    const web = fakeWeb();
    await profile(web);
    const user = userEvent.setup();
    const dash = await openDashboard(user);
    expect(within(dash).getByText('Select a profile above to use the recorder.')).toBeVisible();
    expect(within(dash).queryByRole('button', { name: 'Start recording' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Add account' }));
    expect(screen.getByRole('menuitem', { name: 'Claude' })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: /Gemini.*Coming soon/ })).toBeDisabled();
  });
});

describe('appearance and layout', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'innerWidth', {
      value: 1440,
      configurable: true,
      writable: true,
    });
    delete document.documentElement.dataset.theme;
  });

  it('dark mode toggles the colours of the whole UI and is remembered', async () => {
    const user = await renderApp();
    expect(document.documentElement.dataset.theme).toBe('light');
    const toggle = screen.getByRole('button', { name: 'Switch to dark mode' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('theme')).toBe('dark');
    expect(screen.getByRole('button', { name: /Switch to (dark|light) mode/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: /Switch to (dark|light) mode/ }));
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('starts in the saved theme', async () => {
    localStorage.setItem('theme', 'dark');
    await renderApp();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('the Projects folder of an account can be closed and opened, and stays that way', async () => {
    const user = await renderApp();
    await user.click(screen.getByRole('button', { name: 'ChatGPT Acme Store' })); // opens the account
    const folder = await screen.findByRole('button', { name: /^Projects Acme Store/ });
    expect(folder).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /Shopify and theme/ })).toBeVisible();

    await user.click(folder);
    expect(screen.getByRole('button', { name: /^Projects Acme Store/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByRole('button', { name: /Shopify and theme/ })).toBeNull();
    expect(JSON.parse(localStorage.getItem('uac.closedProjects') ?? '[]')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /^Projects Acme Store/ }));
    expect(screen.getByRole('button', { name: /Shopify and theme/ })).toBeVisible();
  });

  it('the columns can be resized with the keyboard, within limits, reset, and are remembered', async () => {
    const user = await renderApp();
    const app = document.querySelector('.app') as HTMLElement;
    expect(app.style.getPropertyValue('--sidebar-w')).toBe('264px');
    expect(app.style.getPropertyValue('--list-w')).toBe('420px');

    const list = screen.getByRole('separator', { name: 'Resize the chat list' });
    list.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(app.style.getPropertyValue('--list-w')).toBe('452px');
    expect(list).toHaveAttribute('aria-valuenow', '452');
    await user.keyboard('{Home}');
    expect(app.style.getPropertyValue('--list-w')).toBe('300px'); // the minimum, not smaller
    await user.keyboard('{End}');
    const max = Number(list.getAttribute('aria-valuemax'));
    expect(max).toBeLessThanOrEqual(720);
    expect(1440 - 264 - max).toBeGreaterThanOrEqual(380); // the reader keeps a usable width

    const sidebar = screen.getByRole('separator', { name: 'Resize the sidebar' });
    sidebar.focus();
    await user.keyboard('{ArrowLeft}');
    expect(app.style.getPropertyValue('--sidebar-w')).toBe('248px');
    expect(JSON.parse(localStorage.getItem('uac.layout') ?? '{}')).toMatchObject({ sidebar: 248 });

    await user.dblClick(sidebar); // double-click puts it back
    expect(app.style.getPropertyValue('--sidebar-w')).toBe('264px');
  });

  it('there is no list splitter on a dashboard (there is no list)', async () => {
    const user = await renderApp();
    const head = screen
      .getAllByRole('button')
      .find((b) => b.className.includes('platform-head') && b.textContent?.startsWith('ChatGPT'))!;
    await user.click(head);
    await screen.findByRole('main', { name: 'ChatGPT' });
    expect(screen.queryByRole('separator', { name: 'Resize the chat list' })).toBeNull();
    expect(screen.getByRole('separator', { name: 'Resize the sidebar' })).toBeVisible();
  });
});

describe('Trash, sorting and searching everywhere', () => {
  const nav = () => screen.getByRole('navigation', { name: 'Main views' });

  it('the Trash has a Delete now that asks first, says nothing changes on the platform, and removes for good', async () => {
    const user = await renderApp();
    const victims = repo.chatIds({ platform: 'chatgpt' }).slice(0, 2);
    repo.bulk(victims, { type: 'trash' });
    const other = repo.chatIds({ platform: 'claude' })[0]!;
    repo.bulk([other], { type: 'trash' });
    await user.click(within(nav()).getByRole('button', { name: /Trash/ }));
    expect(await screen.findByText(/Chats stay in the Trash for 14 days/)).toBeVisible();

    // Select everything in the Trash and delete it now.
    await user.click(
      await screen.findByRole('button', { name: 'Select all 3' }).catch(async () => {
        await user.click(screen.getAllByRole('checkbox', { name: /Select chat/ })[0]!);
        return screen.findByRole('button', { name: 'Select all 3' });
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Delete now' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Delete 3 chats now?' });
    expect(within(dialog).getByText(/2 from ChatGPT ·/)).toBeVisible();
    expect(within(dialog).getByText(/1 from Claude ·/)).toBeVisible();
    expect(within(dialog).getByText(/Nothing is deleted on the platform/)).toBeVisible();
    // Cancelling leaves everything in place.
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(repo.sidebar().trashed).toBe(3);

    await user.click(screen.getByRole('button', { name: 'Delete now' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete now' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Deleted 3 chats from this app for good.',
    );
    expect(repo.sidebar().trashed).toBe(0);
    expect(victims.every((id) => repo.getChat(id) === null)).toBe(true);
    expect(within(nav()).getByRole('button', { name: /Trash/ })).toHaveTextContent('0');
  });

  it('a chat opened from the Trash can be restored or deleted from the reader', async () => {
    const user = await renderApp();
    const id = repo.chatIds({ platform: 'gemini' })[0]!;
    repo.bulk([id], { type: 'trash' });
    await user.click(within(nav()).getByRole('button', { name: /Trash/ }));
    await user.click(
      await screen.findByRole('button', { name: new RegExp(repo.getChat(id)!.title) }),
    );
    const reader = await screen.findByRole('region', { name: 'Chat reader' });
    expect(within(reader).getByRole('button', { name: 'Restore' })).toBeVisible();
    await user.click(within(reader).getByRole('button', { name: 'Delete now' }));
    expect(await screen.findByRole('alertdialog', { name: 'Delete 1 chat now?' })).toBeVisible();
  });

  it('sorts the list, and remembers the choice', async () => {
    const user = await renderApp();
    const first = () =>
      screen.getAllByRole('checkbox', { name: /Select chat/ })[0]!.getAttribute('aria-label');
    const before = first();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), 'title_asc');
    await waitFor(() => expect(first()).not.toBe(before));
    const az = repo.listChats({ sort: 'title_asc' }).items[0]!.title;
    expect(first()).toContain(az);
    expect(JSON.parse(localStorage.getItem('uac.sort') ?? 'null')).toBe('title_asc');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), 'messages_desc');
    await waitFor(() =>
      expect(first()).toContain(repo.listChats({ sort: 'messages_desc' }).items[0]!.title),
    );
  });

  it('search stays inside the current profile unless you ask for everywhere (and ⌘K always searches everywhere)', async () => {
    const user = await renderApp();
    await user.click(screen.getByRole('button', { name: 'Gemini Personal' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search all chats' }), 'sample');
    const scopedTotal = repo.listChats({ search: 'sample', platform: 'gemini' }).total;
    const globalTotal = repo.listChats({ search: 'sample' }).total;
    expect(globalTotal).toBeGreaterThan(scopedTotal);
    expect(await screen.findByText('Searching in this view')).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByText(String(scopedTotal), { selector: '.selection-info span' }),
      ).toBeVisible(),
    );

    await user.click(screen.getByRole('button', { name: 'Search everywhere' }));
    expect(await screen.findByText('Searching everywhere')).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByText(String(globalTotal), { selector: '.selection-info span' }),
      ).toBeVisible(),
    );
    await user.click(screen.getByRole('button', { name: 'Only this view' }));
    await waitFor(() =>
      expect(
        screen.getByText(String(scopedTotal), { selector: '.selection-info span' }),
      ).toBeVisible(),
    );

    // ⌘K from inside a profile: back to everything, search box focused.
    await user.keyboard('{Meta>}k{/Meta}');
    await waitFor(() =>
      expect(screen.getByRole('searchbox', { name: 'Search all chats' })).toHaveFocus(),
    );
    expect(screen.queryByText(/Searching in this view/)).toBeNull(); // no longer scoped
  });
});

describe('ordering profiles and platforms in the sidebar', () => {
  const chatgptOrder = () =>
    repo
      .sidebar()
      .platforms.find((p) => p.platform === 'chatgpt')!
      .accounts.map((a) => a.label);
  const platformOrder = () => repo.sidebar().platforms.map((p) => p.platform);
  const rowOrder = () =>
    screen
      .getAllByRole('button')
      .filter(
        (b) =>
          b.className.includes('account') && b.getAttribute('aria-label')?.startsWith('ChatGPT '),
      )
      .map((b) => b.getAttribute('aria-label'));

  it('Alt+Arrow moves a profile up or down within its platform, and the sidebar follows', async () => {
    const user = await renderApp();
    expect(rowOrder()).toEqual([
      'ChatGPT Personal',
      'ChatGPT Acme Store',
      'ChatGPT Bluewave Studio',
    ]);
    screen.getByRole('button', { name: 'ChatGPT Personal' }).focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await waitFor(() =>
      expect(chatgptOrder()).toEqual(['Acme Store', 'Personal', 'Bluewave Studio']),
    );
    await waitFor(() =>
      expect(rowOrder()).toEqual([
        'ChatGPT Acme Store',
        'ChatGPT Personal',
        'ChatGPT Bluewave Studio',
      ]),
    );
    expect(screen.getByRole('button', { name: 'ChatGPT Personal' })).toHaveFocus(); // focus stays on the moved item

    // Cannot move past the ends.
    screen.getByRole('button', { name: 'ChatGPT Acme Store' }).focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(chatgptOrder()).toEqual(['Acme Store', 'Personal', 'Bluewave Studio']);
  });

  it('dragging a profile onto another puts it before or after it', async () => {
    await renderApp();
    const grab = (name: string) => screen.getByRole('button', { name });
    const rect = (top: number) => ({
      top,
      height: 30,
      bottom: top + 30,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: top,
      toJSON: () => ({}),
    });
    const target = grab('ChatGPT Bluewave Studio').closest('.platform') as HTMLElement;
    // jsdom sends no pointer position with drag events (clientY is 0): move the element instead.
    // Its middle is at -85, so a drop at 0 is in the lower half.
    target.getBoundingClientRect = () => rect(-100) as DOMRect;

    fireEvent.dragStart(grab('ChatGPT Personal'), { dataTransfer: { setData: () => undefined } });
    fireEvent.dragOver(target); // lower half: after
    expect(target.className).toContain('drop-after');
    fireEvent.drop(target);
    await waitFor(() =>
      expect(chatgptOrder()).toEqual(['Acme Store', 'Bluewave Studio', 'Personal']),
    );

    fireEvent.dragStart(grab('ChatGPT Personal'), { dataTransfer: { setData: () => undefined } });
    const first = grab('ChatGPT Acme Store').closest('.platform') as HTMLElement;
    first.getBoundingClientRect = () => rect(10) as DOMRect;
    fireEvent.dragOver(first); // upper half: before (its middle is at 25, the drop at 0)
    expect(first.className).toContain('drop-before');
    fireEvent.drop(first);
    await waitFor(() =>
      expect(chatgptOrder()).toEqual(['Personal', 'Acme Store', 'Bluewave Studio']),
    );
  });

  it('a profile cannot be dropped into another platform, and platforms can be reordered', async () => {
    const user = await renderApp();
    const claudeGroup = screen
      .getByRole('button', { name: 'Claude Personal' })
      .closest('.platform') as HTMLElement;
    fireEvent.dragStart(screen.getByRole('button', { name: 'ChatGPT Personal' }), {
      dataTransfer: { setData: () => undefined },
    });
    fireEvent.dragOver(claudeGroup, { clientY: 5 });
    expect(claudeGroup.className).not.toContain('drop-'); // not a valid target
    fireEvent.drop(claudeGroup);
    expect(chatgptOrder()).toEqual(['Personal', 'Acme Store', 'Bluewave Studio']);

    expect(platformOrder()).toEqual(['chatgpt', 'claude', 'gemini']);
    const head = screen
      .getAllByRole('button')
      .find((b) => b.className.includes('platform-head') && b.textContent?.startsWith('Claude'))!;
    head.focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    await waitFor(() => expect(platformOrder()).toEqual(['claude', 'chatgpt', 'gemini']));
  });
});

describe('generated images', () => {
  /** A chat with images in every state, created through the same repository the app uses. */
  function addImageChat() {
    const account = repo
      .filterOptions()
      .accounts.find((a) => a.platform === 'chatgpt' && a.label === 'Acme Store')!;
    const now = new Date().toISOString();
    const id = repo.upsertConversation({
      accountId: account.id,
      remoteId: 'img-chat',
      remoteTitle: 'Bull posters',
      createdAt: now,
      remoteUpdatedAt: now,
      images: [
        { ref: 'ref-done', kind: 'generated', alt: 'a red bull, pixel art' },
        { ref: 'ref-wait', kind: 'generated' },
        { ref: 'ref-up', kind: 'uploaded' },
      ],
      messages: [
        {
          role: 'user',
          createdAt: now,
          blocks: [
            { type: 'text', text: 'Draw me a bull' },
            { type: 'image', ref: 'ref-up' },
          ],
        },
        {
          role: 'assistant',
          createdAt: now,
          blocks: [
            { type: 'image', ref: 'ref-done', alt: 'a red bull, pixel art' },
            { type: 'image', ref: 'ref-wait' },
            { type: 'text', text: 'Here are your bulls.' },
          ],
        },
      ],
    });
    const done = repo.pendingImages(account.id, 10).find((m) => m.ref === 'ref-done')!;
    repo.markImageDone(done.id, {
      path: `${account.id}/ab/x.png`,
      sha256: 'x',
      mime: 'image/png',
      bytes: 10,
    });
    return { id, account, mediaId: done.id };
  }

  it('shows a downloaded image in the chat, and says why the others are missing', async () => {
    const { id, mediaId } = addImageChat();
    const user = await renderApp();
    await user.type(screen.getByRole('searchbox', { name: 'Search all chats' }), 'Bull posters');
    await user.click(await screen.findByRole('button', { name: /Bull posters/ }));
    const reader = await screen.findByRole('region', { name: 'Chat reader' });

    const img = await within(reader).findByRole('img', { name: 'a red bull, pixel art' });
    expect(img).toHaveAttribute('src', `uac-media://t/${mediaId}`); // a small preview, through the app's own scheme, never a file path
    expect(within(reader).getByText('An image you uploaded (not shown here).')).toBeVisible();
    void id;

    // Click opens it large; Esc closes it.
    await user.click(within(reader).getByRole('button', { name: 'a red bull, pixel art' }));
    const box = await screen.findByRole('dialog', { name: 'Image' });
    expect(within(box).getByText('a red bull, pixel art')).toBeVisible();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Image' })).toBeNull());
  });

  it('the sidebar has an Images folder per profile and a general one, with counts', async () => {
    addImageChat();
    const user = await renderApp();
    const nav = screen.getByRole('navigation', { name: 'Main views' });
    expect(within(nav).getByRole('button', { name: /Images/ })).toHaveTextContent('2');
    await user.click(screen.getByRole('button', { name: 'ChatGPT Acme Store' }));
    // Two entries are called Images: the general one above and this profile's folder in the tree.
    const folder = await waitFor(() => {
      const f = screen
        .getAllByRole('button', { name: /^Images2$/ })
        .find((b) => b.className.includes('tree-item'));
      expect(f).toBeTruthy();
      return f!;
    });
    await user.click(folder);
    const gallery = await screen.findByRole('main', { name: 'Generated images' });
    expect(within(gallery).getByText('2 images')).toBeVisible();
    expect(within(gallery).getAllByRole('button')).toHaveLength(2);
    expect(screen.queryByRole('region', { name: 'Chat list' })).toBeNull(); // the gallery replaces the list
  });

  it('the general gallery covers every profile; a profile with no images says so', async () => {
    addImageChat();
    const user = await renderApp();
    await user.click(
      within(screen.getByRole('navigation', { name: 'Main views' })).getByRole('button', {
        name: /Images/,
      }),
    );
    const all = await screen.findByRole('main', { name: 'Generated images' });
    await within(all).findByText('2 images');

    await user.click(screen.getByRole('button', { name: 'ChatGPT Personal' }));
    const empty = await waitFor(() => {
      const f = screen
        .getAllByRole('button', { name: /^Images0$/ })
        .find((b) => b.className.includes('tree-item'));
      expect(f).toBeTruthy();
      return f!;
    });
    await user.click(empty);
    await waitFor(() => expect(screen.getByText(/No generated images found yet/)).toBeVisible());
  });

  it('the gallery can be searched, filtered by project and sorted by date', async () => {
    addImageChat();
    const user = await renderApp();
    await user.click(
      within(screen.getByRole('navigation', { name: 'Main views' })).getByRole('button', {
        name: /Images/,
      }),
    );
    const gallery = await screen.findByRole('main', { name: 'Generated images' });
    await within(gallery).findByText('2 images');
    await user.type(within(gallery).getByRole('combobox', { name: 'Search images' }), 'zzzz');
    expect(await within(gallery).findByText(/No images match/)).toBeVisible();
    await user.clear(within(gallery).getByRole('combobox', { name: 'Search images' }));
    // Completions come in the app's own menu, not the browser's; picking one fills the box.
    await user.type(within(gallery).getByRole('combobox', { name: 'Search images' }), 'bul');
    const option = await screen.findByRole('option', { name: 'Bull posters' });
    await user.click(option);
    expect(within(gallery).getByRole('combobox', { name: 'Search images' })).toHaveValue(
      'Bull posters',
    );
    expect(document.querySelector('datalist')).toBeNull();
    await user.clear(within(gallery).getByRole('combobox', { name: 'Search images' }));
    await user.type(within(gallery).getByRole('combobox', { name: 'Search images' }), 'bull');
    await waitFor(() => expect(within(gallery).getByText('2 images')).toBeVisible());
    expect(within(gallery).getByRole('combobox', { name: 'Filter by project' })).toBeVisible();
    await user.selectOptions(
      within(gallery).getByRole('combobox', { name: 'Sort by date' }),
      'Oldest first',
    );
    await waitFor(() => expect(within(gallery).getByText('2 images')).toBeVisible());
  });

  it('opening an image from the gallery jumps to its chat', async () => {
    addImageChat();
    const user = await renderApp();
    await user.click(
      within(screen.getByRole('navigation', { name: 'Main views' })).getByRole('button', {
        name: /Images/,
      }),
    );
    const gallery = await screen.findByRole('main', { name: 'Generated images' });
    await user.click(await within(gallery).findByRole('button', { name: 'a red bull, pixel art' }));
    const box = await screen.findByRole('dialog', { name: 'Image' });
    expect(within(box).getByText(/Bull posters · ChatGPT Acme Store/)).toBeVisible();
    await user.click(within(box).getByRole('button', { name: 'Open chat' }));
    const reader = await screen.findByRole('region', { name: 'Chat reader' });
    expect(await within(reader).findByRole('heading', { name: 'Bull posters' })).toBeVisible();
    expect(screen.queryByRole('main', { name: 'Generated images' })).toBeNull();
  });

  it('the dashboard shows the latest images and links to the gallery', async () => {
    addImageChat();
    const user = await renderApp();
    const head = screen
      .getAllByRole('button')
      .find((b) => b.className.includes('platform-head') && b.textContent?.startsWith('ChatGPT'))!;
    await user.click(head);
    const dash = await screen.findByRole('main', { name: 'ChatGPT' });
    expect(
      await within(dash).findByRole('button', { name: 'a red bull, pixel art' }),
    ).toBeVisible();
    await user.click(within(dash).getByRole('button', { name: 'See all 2' }));
    expect(await screen.findByRole('main', { name: 'Generated images' })).toBeVisible();
  });
});

describe('changes on the platform (rename, archive, delete)', { timeout: 30_000 }, () => {
  let exportRoot: string;
  beforeEach(() => {
    exportRoot = mkdtempSync(join(tmpdir(), 'uac-ui-exports-'));
  });
  afterEach(() => rmSync(exportRoot, { recursive: true, force: true }));

  /** An app with a connector that CAN change things, and one real ChatGPT profile with a few chats. */
  async function withWritableProfile(opts: { writable?: boolean } = {}) {
    const web = fakeWeb();
    const wc = writableConnector();
    const connectors = opts.writable === false ? {} : { chatgpt: wc.connector };
    window.api = createApi(repo, {
      openExternal: async () => {},
      web: web.host,
      exportDir: join(exportRoot, 'exports'),
      connectors,
      actions: { autoRun: false, sleep: async () => {}, paceMs: 0, jitterMs: 0 },
    });
    web.signedInAs('user-A');
    const { attemptId } = await window.api.signInStart('chatgpt');
    await window.api.signInStatus(attemptId);
    const accountId = (
      await window.api.signInFinish(attemptId, { type: 'new', label: 'Acme Store' })
    ).accountId;
    const now = new Date().toISOString();
    const ids = ['One', 'Two', 'Three'].map((n, i) =>
      repo.upsertConversation({
        accountId,
        remoteId: `remote-${n}`,
        remoteTitle: `Chat ${n}`,
        createdAt: now,
        remoteUpdatedAt: now,
        messages: [
          { role: 'user', createdAt: now, blocks: [{ type: 'text', text: `Question ${i}` }] },
          { role: 'assistant', createdAt: now, blocks: [{ type: 'text', text: 'Answer' }] },
        ],
      }),
    );
    return { web, wc, accountId, ids };
  }
  const openDash = async (user: ReturnType<typeof userEvent.setup>) => {
    render(<App />);
    let head: HTMLElement | undefined;
    await waitFor(() => {
      head = screen
        .getAllByRole('button')
        .find((b) => b.className.includes('platform-head') && b.textContent?.startsWith('ChatGPT'));
      expect(head).toBeTruthy();
    });
    await user.click(head!);
    const dash = await screen.findByRole('main', { name: 'ChatGPT' });
    await user.click(await within(dash).findByRole('button', { name: /^Acme Store · / }));
    return dash;
  };

  it('says honestly when the app cannot change things on the platform yet, and offers nothing', async () => {
    await withWritableProfile({ writable: false });
    const dash = await openDash(userEvent.setup());
    const card = within(dash).getByRole('region', { name: 'Changes on ChatGPT' });
    expect(within(card).getByText(/cannot rename, archive or delete on ChatGPT yet/)).toBeVisible();
    expect(within(card).getByRole('switch')).toBeDisabled();
  });

  it('turning changes on asks first (delete is permanent, a copy is saved, it may break terms)', async () => {
    const { accountId } = await withWritableProfile();
    const user = userEvent.setup();
    const dash = await openDash(user);
    const card = within(dash).getByRole('region', { name: 'Changes on ChatGPT' });
    const toggle = within(card).getByRole('switch');
    expect(toggle).not.toBeChecked(); // off by default
    expect(within(card).getByText('Rename · Archive · Delete')).toBeVisible();

    await user.click(toggle);
    const dialog = await screen.findByRole('alertdialog', { name: 'Allow changes on ChatGPT?' });
    expect(within(dialog).getByText(/Deleting on the platform is permanent there/)).toBeVisible();
    expect(within(dialog).getByText(join(exportRoot, 'exports'))).toBeVisible();
    expect(within(dialog).getByText(/may go against its terms/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(repo.allowsChanges(accountId)).toBe(false);

    await user.click(within(card).getByRole('switch'));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Turn on' }),
    );
    await waitFor(() => expect(repo.allowsChanges(accountId)).toBe(true));
    expect(
      await within(card).findByText(
        /renames, archives and deletes you make for this profile are sent/,
      ),
    ).toBeVisible();
    await user.click(within(card).getByRole('switch')); // and it can be turned off again, without a question
    await waitFor(() => expect(repo.allowsChanges(accountId)).toBe(false));
  });

  it('a rename is sent to the platform: the chat says it is waiting, then Activity shows it done', async () => {
    const { wc, accountId, ids } = await withWritableProfile();
    await window.api.allowChanges(accountId, true);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Chat One/ }));
    const reader = await screen.findByRole('region', { name: 'Chat reader' });
    await user.click(within(reader).getByRole('button', { name: 'Rename' }));
    const input = within(reader).getByRole('textbox', { name: 'Chat title' });
    await user.clear(input);
    await user.type(input, 'Better title{Enter}');
    expect(
      await within(reader).findByText('A change to this chat is being sent to ChatGPT.'),
    ).toBeVisible();

    await user.click(
      within(screen.getByRole('navigation', { name: 'Main views' })).getByRole('button', {
        name: /Activity/,
      }),
    );
    const activity = await screen.findByRole('main', { name: 'Activity' });
    expect(within(activity).getByRole('note')).toHaveTextContent('Available in the PRO version.');
    const row = await within(activity).findByRole('listitem');
    expect(within(row).getByText('Rename')).toBeVisible();
    expect(within(row).getByText('Waiting')).toBeVisible();
    await user.click(within(activity).getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(within(activity).getByText('Done')).toBeVisible());
    expect(wc.calls).toContain('rename remote-One -> Better title');
    expect(repo.getChat(ids[0]!)!.title).toBe('Better title');
  });

  it('Delete now in the Trash: delete on the platform (after a copy) or only here, clearly separated', async () => {
    const { wc, accountId, ids } = await withWritableProfile();
    await window.api.allowChanges(accountId, true);
    repo.bulk(ids, { type: 'trash' });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Trash/ }));
    await user.click((await screen.findAllByRole('checkbox', { name: /Select chat/ }))[0]!);
    await user.click(await screen.findByRole('button', { name: 'Select all 3' }));
    await user.click(screen.getByRole('button', { name: 'Delete now' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Delete 3 chats now?' });
    const remote = within(dialog).getByRole('region', { name: 'Delete on the platform' });
    expect(within(remote).getByText(/3 from ChatGPT · Acme Store/)).toBeVisible();
    expect(within(remote).getByText(/cannot be undone there/)).toBeVisible();
    expect(within(remote).getByText(join(exportRoot, 'exports'))).toBeVisible();
    const go = within(dialog).getByRole('button', { name: 'Delete 3 on the platform' });
    expect(go).toBeDisabled(); // needs the "I understand" box
    await user.click(
      within(remote).getByRole('checkbox', { name: /cannot be undone on the platform/ }),
    );
    expect(go).toBeEnabled();
    await user.click(go);

    expect(await screen.findByRole('status')).toHaveTextContent(
      '3 chats are queued for deletion on the platform. A full copy of each is saved first.',
    );
    expect(repo.sidebar().trashed).toBe(3); // still here until they are really deleted
    expect((await screen.findAllByText('Sending to the platform…')).length).toBe(3);
    expect(wc.calls.some((c) => c.startsWith('delete'))).toBe(false);

    await window.api.queueRun();
    expect(wc.calls.filter((c) => c.startsWith('delete')).sort()).toEqual([
      'delete remote-One',
      'delete remote-Three',
      'delete remote-Two',
    ]);
    expect(repo.sidebar().trashed).toBe(0);
    expect(readdirSync(join(exportRoot, 'exports', 'chatgpt', 'acme-store'))).toHaveLength(3);
  });

  it('a mixed selection shows both sections, and "Delete here only" touches no platform', async () => {
    const { wc, accountId, ids } = await withWritableProfile();
    await window.api.allowChanges(accountId, true);
    // A second profile that does NOT allow changes.
    const web = fakeWeb();
    void web;
    const other = repo.addAccount({
      platform: 'chatgpt',
      label: 'Bluewave Studio',
      partition: 'persist:chatgpt-other',
      identityHint: 'user-B',
    });
    const now = new Date().toISOString();
    const otherId = repo.upsertConversation({
      accountId: other,
      remoteId: 'remote-Other',
      remoteTitle: 'Other chat',
      createdAt: now,
      remoteUpdatedAt: now,
      messages: [],
    });
    repo.bulk([...ids, otherId], { type: 'trash' });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /Trash/ }));
    await user.click((await screen.findAllByRole('checkbox', { name: /Select chat/ }))[0]!);
    await user.click(await screen.findByRole('button', { name: 'Select all 4' }));
    await user.click(screen.getByRole('button', { name: 'Delete now' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete 4 chats now?' });
    expect(
      within(within(dialog).getByRole('region', { name: 'Delete on the platform' })).getByText(
        /3 from ChatGPT · Acme Store/,
      ),
    ).toBeVisible();
    const hereOnly = within(dialog).getByRole('region', { name: 'Only from this app' });
    expect(
      within(hereOnly).getByText(
        /1 from ChatGPT · Bluewave Studio — changes on this profile are off/,
      ),
    ).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Delete here only' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Deleted 4 chats from this app for good.',
    );
    expect(repo.sidebar().trashed).toBe(0);
    expect(wc.calls.some((c) => c.startsWith('delete'))).toBe(false); // nothing was sent anywhere
  });

  it('Activity: pause, a profile that must sign in again, and failed changes with a way to retry', async () => {
    const { wc, accountId, ids } = await withWritableProfile();
    await window.api.allowChanges(accountId, true);
    const user = userEvent.setup();
    render(<App />);
    await window.api.setTitle(ids[0]!, 'Will fail');
    wc.failWith('rename', ...Array.from({ length: 6 }, () => new Error('server said no')));
    await user.click(await screen.findByRole('button', { name: /Activity/ }));
    const activity = await screen.findByRole('main', { name: 'Activity' });

    await user.click(within(activity).getByRole('button', { name: 'Pause' }));
    expect(await within(activity).findByText(/Paused: nothing is being sent/)).toBeVisible();
    await user.click(within(activity).getByRole('button', { name: 'Resume' }));
    await user.click(within(activity).getByRole('button', { name: 'Run now' }));
    expect(await within(activity).findByText('server said no')).toBeVisible();
    expect(within(activity).getByText('Waiting')).toBeVisible(); // retried later, not lost
    await user.click(within(activity).getByRole('button', { name: 'Cancel waiting' }));
    await waitFor(() => expect(within(activity).getByText('Cancelled')).toBeVisible());
  });
});

describe('sidebar tree', () => {
  it('lists Chats, Projects (with the projects under it), Images and, always last, the Archive; there is no search entry', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(screen.getByRole('button', { name: 'ChatGPT Acme Store' }));
    const items = await waitFor(() => {
      const tree = screen
        .getAllByRole('button')
        .filter((b) => b.className.includes('tree-item'))
        .map((b) => b.textContent ?? '');
      expect(tree.length).toBeGreaterThan(3);
      return tree;
    });
    expect(items[0]).toMatch(/^Chats\d+$/);
    expect(items[1]).toMatch(/^Projects\d+$/);
    expect(items.at(-2)).toMatch(/^Images\d+$/);
    expect(items.at(-1)).toMatch(/^Archive\d+$/);
    expect(items.some((x) => /^Inbox/.test(x))).toBe(false);
    const nav = screen.getByRole('navigation', { name: 'Main views' });
    expect(within(nav).queryByRole('button', { name: /^Search/ })).toBeNull();
  });
});

describe('a new install', () => {
  it('starts empty, with no demo data, and shows how to connect the first account', async () => {
    const emptyRepo = new Repo(openDatabase()); // nothing in it: what a fresh install has
    window.api = createApi(emptyRepo, { openExternal: async () => {} });
    render(<App />);
    const welcome = await screen.findByRole('main', { name: 'Welcome' });
    expect(
      within(welcome).getByRole('heading', { name: 'Welcome to Unified AI Chats' }),
    ).toBeVisible();
    for (const name of [/ChatGPT/, /Claude$/, /Claude Code/])
      expect(within(welcome).getByRole('button', { name })).toBeVisible();
    expect(screen.queryByText(/Demo data/)).toBeNull();
    expect(screen.queryByRole('region', { name: 'Chat list' })).toBeNull(); // no list of fake chats
    expect(emptyRepo.listChats({}).total).toBe(0);
  });

  it('removes demo data left by an earlier version, and never creates it', () => {
    const old = new Repo(openDatabase());
    ensureDemoData(old); // what an earlier version did on first start
    expect(old.listChats({}).total).toBeGreaterThan(0);
    expect(old.removeDemoData()).toBe(true);
    expect(old.listChats({}).total).toBe(0);
    expect(new Repo(openDatabase()).listChats({}).total).toBe(0); // a fresh database has nothing by itself
  });
});
