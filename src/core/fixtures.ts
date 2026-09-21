import type { ContentBlock, Platform } from '../shared/types';
import type { Repo } from './repo';

/**
 * Synthetic demo data. Nothing here comes from a real account or a real chat.
 * Deterministic for a given `now`, so tests can assert on exact counts.
 */

interface Topic {
  account: 'gpt-personal' | 'gpt-acme' | 'gpt-bluewave' | 'claude' | 'claude-bluewave' | 'gemini';
  project?: 'shopify' | 'seo' | 'social';
  state?: 'inbox' | 'archived';
  remoteTitle: string;
  title: string;
  summary: string;
  tags: string[];
  question: string;
  answer: string;
  code?: { lang: string; text: string };
}

const TOPICS: Topic[] = [
  {
    account: 'gpt-acme',
    project: 'shopify',
    remoteTitle: 'Shopify theme help',
    title: 'Shopify theme structure: sections and metafields',
    summary:
      'Compares sections with alternate collection templates and explains when metafields fit per-product data.',
    tags: ['Shopify', 'Development'],
    question:
      'I need collections with different filters per category. Should I use sections or alternate templates?',
    answer:
      'For structural differences between categories, an alternate collection template is cleaner. For content variations, sections with their settings are enough. Metafields fit data that changes from product to product, such as materials or sizes.',
    code: {
      lang: 'text',
      text: 'templates/collection.apparel.json\nsections/collection-filters.liquid',
    },
  },
  {
    account: 'gpt-acme',
    project: 'shopify',
    remoteTitle: 'Liquid loop question',
    title: 'Liquid: looping over product variants',
    summary: 'How to loop over variants and show only those in stock.',
    tags: ['Shopify', 'Development'],
    question: 'How do I loop over variants and skip the ones that are sold out?',
    answer:
      'Use a for loop over product.variants and guard the output with variant.available. Keep the loop light on collection pages.',
    code: {
      lang: 'liquid',
      text: '{% for variant in product.variants %}\n  {% if variant.available %}{{ variant.title }}{% endif %}\n{% endfor %}',
    },
  },
  {
    account: 'gpt-acme',
    project: 'seo',
    remoteTitle: 'SEO checklist',
    title: 'Client SEO: title tag rules',
    summary: 'Length, keyword placement and brand suffix rules for title tags.',
    tags: ['SEO'],
    question: 'Give me rules for writing title tags for an online store.',
    answer:
      'Keep titles under about 60 characters, lead with the main keyword, add the brand at the end, and keep every title unique across the site.',
  },
  {
    account: 'gpt-acme',
    project: 'social',
    remoteTitle: 'Post ideas',
    title: 'Social: recurring content series',
    summary: 'Four recurring series with a weekly cadence.',
    tags: ['Social'],
    question: 'Suggest recurring content series for a small brand account.',
    answer:
      'Try a weekly behind-the-scenes post, a monthly product deep dive, a customer story on Fridays and a short tips reel.',
  },
  {
    account: 'gpt-acme',
    remoteTitle: 'Translate',
    title: 'Client email translated to English',
    summary: 'Formal English version of a client email, ready to send.',
    tags: ['Client'],
    question: 'Translate this short client email into formal English.',
    answer:
      'Here is a formal English version: thank you for your message, we will send the updated quote by Friday.',
  },
  {
    account: 'gpt-acme',
    state: 'archived',
    remoteTitle: 'Invoice template',
    title: 'Invoice template wording',
    summary: 'Neutral wording for invoice notes and payment terms.',
    tags: ['Admin'],
    question: 'Write neutral wording for payment terms on an invoice.',
    answer:
      'Payment is due within 30 days of the invoice date. Late payments may incur a fee as agreed in the contract.',
  },
  {
    account: 'gpt-personal',
    remoteTitle: 'Recipe',
    title: 'Baked pasta recipe',
    summary: 'Quantities for four people with a light béchamel.',
    tags: ['Personal'],
    question: 'How much pasta for four people for a baked dish?',
    answer: 'About 400 g of pasta and a light béchamel. Bake for 25 minutes at 200 degrees.',
  },
  {
    account: 'gpt-personal',
    remoteTitle: 'Trip',
    title: 'Weekend trip packing list',
    summary: 'Short packing list for a two-day city trip.',
    tags: ['Personal', 'Travel'],
    question: 'Give me a packing list for a two-day city trip.',
    answer:
      'Comfortable shoes, one layer for evenings, chargers, a small umbrella and a printed copy of your booking.',
  },
  {
    account: 'gpt-personal',
    state: 'archived',
    remoteTitle: 'Birthday message',
    title: 'Birthday message for a friend',
    summary: 'Three tones for a short birthday message.',
    tags: ['Personal'],
    question: 'Write a short birthday message for a friend.',
    answer: 'Happy birthday! Wishing you a year full of good coffee, long walks and small wins.',
  },
  {
    account: 'claude',
    remoteTitle: 'Content plan',
    title: 'Instagram content plan: 4 weeks',
    summary: 'A four-week grid with four recurring series and a posting calendar.',
    tags: ['Social'],
    question: 'Build a four-week Instagram content plan.',
    answer:
      'Here is a grid with four recurring series and a calendar: Monday tips, Wednesday behind the scenes, Friday customer stories, Sunday recap.',
  },
  {
    account: 'claude',
    remoteTitle: 'SEO audit',
    title: 'SEO audit: fix plan',
    summary: 'Priorities are redirects, duplicate titles and category structure.',
    tags: ['SEO'],
    question: 'Turn these audit findings into a prioritized fix plan.',
    answer:
      'Start with redirects, then duplicate titles, then category structure. Re-crawl after each step to confirm.',
  },
  {
    account: 'claude',
    remoteTitle: 'Prompt test',
    title: 'Prompt test: article summary',
    summary: 'Quick test of a summarisation prompt on sample text.',
    tags: ['Test'],
    question: 'Summarise this sample article in three bullet points.',
    answer: 'Three bullets: the main claim, the supporting evidence, and the practical takeaway.',
  },
  {
    account: 'claude',
    remoteTitle: 'Regex help',
    title: 'Regex: match dates in text',
    summary: 'A pattern for ISO dates with a note on validation.',
    tags: ['Development'],
    question: 'Regex to match ISO dates like 2026-09-20?',
    answer:
      'A simple pattern works for matching; validate the actual date separately, since the regex cannot know month lengths.',
    code: { lang: 'regex', text: '\\b\\d{4}-\\d{2}-\\d{2}\\b' },
  },
  {
    account: 'gemini',
    remoteTitle: 'Logo help',
    title: 'Logo brief: naming variants',
    summary: 'Three naming directions and how they read in a compact version.',
    tags: ['Branding'],
    question: 'Help me with naming variants for a logo brief.',
    answer:
      'Start from three directions and check how each reads in a compact, single-line version.',
  },
  {
    account: 'gemini',
    remoteTitle: 'Copy ideas',
    title: 'Product page copy ideas',
    summary: 'Three tones for a product description, from plain to narrative.',
    tags: ['Copy'],
    question: 'Ideas for product page copy for a linen shirt.',
    answer:
      'Three tones: plain and factual, warm and practical, and a short narrative about the fabric.',
  },
  {
    account: 'gemini',
    state: 'archived',
    remoteTitle: 'Old brainstorm',
    title: 'Brainstorm: workshop names',
    summary: 'A list of workshop names grouped by mood.',
    tags: ['Branding'],
    question: 'Brainstorm names for a small design workshop.',
    answer: 'Grouped by mood: calm (Still Room), playful (Odd Studio), direct (Plain Works).',
  },
  {
    account: 'gpt-bluewave',
    remoteTitle: 'Brand voice',
    title: 'Brand voice: three tone options',
    summary: 'Three tone-of-voice directions for a small studio website.',
    tags: ['Copy'],
    question: 'Suggest three tone-of-voice options for a small design studio site.',
    answer:
      'Calm and precise, warm and conversational, or bold and minimal. Test each on the home page headline first.',
  },
  {
    account: 'gpt-bluewave',
    remoteTitle: 'Newsletter',
    title: 'Newsletter structure for a studio',
    summary: 'A simple monthly newsletter layout with one featured project.',
    tags: ['Social'],
    question: 'Outline a monthly newsletter for a design studio.',
    answer:
      'One featured project, two short notes from the studio, a link worth reading and a single call to action.',
  },
  {
    account: 'claude-bluewave',
    remoteTitle: 'Color palette',
    title: 'Color palette for a coastal brand',
    summary: 'A restrained palette with one accent, and contrast checks.',
    tags: ['Branding'],
    question: 'Propose a restrained color palette for a coastal brand.',
    answer:
      'Sand, deep navy and a single coral accent. Check body text contrast at least 4.5:1 on the sand background.',
  },
];

const FILLER_TITLES = ['New chat', 'Untitled', 'Quick question', 'Test', 'Hello', 'help'];
const ACCOUNT_KEYS: Topic['account'][] = [
  'gpt-personal',
  'gpt-acme',
  'gpt-bluewave',
  'claude',
  'claude-bluewave',
  'gemini',
];

/** Fills an empty database with demo data. Returns the number of chats created. */
export function seedFixtures(repo: Repo, now: Date = new Date()): number {
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();

  const acc: Record<Topic['account'], { id: number; platform: Platform }> = {
    'gpt-personal': {
      id: repo.addAccount({
        platform: 'chatgpt',
        label: 'Personal',
        partition: 'persist:chatgpt-personal',
        lastSyncAt: minutesAgo(2),
      }),
      platform: 'chatgpt',
    },
    'gpt-acme': {
      id: repo.addAccount({
        platform: 'chatgpt',
        label: 'Acme Store',
        partition: 'persist:chatgpt-acme-store',
        lastSyncAt: minutesAgo(2),
      }),
      platform: 'chatgpt',
    },
    'gpt-bluewave': {
      id: repo.addAccount({
        platform: 'chatgpt',
        label: 'Bluewave Studio',
        partition: 'persist:chatgpt-bluewave-studio',
        lastSyncAt: minutesAgo(2),
      }),
      platform: 'chatgpt',
    },
    claude: {
      id: repo.addAccount({
        platform: 'claude',
        label: 'Personal',
        partition: 'persist:claude-personal',
        lastSyncAt: minutesAgo(9),
      }),
      platform: 'claude',
    },
    'claude-bluewave': {
      id: repo.addAccount({
        platform: 'claude',
        label: 'Bluewave Studio',
        partition: 'persist:claude-bluewave-studio',
        lastSyncAt: minutesAgo(9),
      }),
      platform: 'claude',
    },
    gemini: {
      id: repo.addAccount({
        platform: 'gemini',
        label: 'Personal',
        partition: 'persist:gemini-personal',
        status: 'needs_attention',
        lastSyncAt: minutesAgo(60 * 24 * 3),
      }),
      platform: 'gemini',
    },
  };
  const projects = {
    shopify: repo.upsertProject(acc['gpt-acme'].id, 'p-shopify', 'Shopify and theme'),
    seo: repo.upsertProject(acc['gpt-acme'].id, 'p-seo', 'SEO audits'),
    social: repo.upsertProject(acc['gpt-acme'].id, 'p-social', 'Social editorial'),
  };

  let n = 0;
  const messagesFor = (
    t: { question: string; answer: string; code?: Topic['code']; followUp?: string },
    at: number,
  ) => {
    const blocks: ContentBlock[] = [{ type: 'text', text: t.answer }];
    if (t.code) blocks.push({ type: 'code', lang: t.code.lang, text: t.code.text });
    const exchange = [
      {
        role: 'user' as const,
        blocks: [{ type: 'text' as const, text: t.question }],
        createdAt: minutesAgo(at + 3),
      },
      { role: 'assistant' as const, blocks, createdAt: minutesAgo(at + 2) },
    ];
    // Real chats usually go on for a while; only the generic ones stay at two messages.
    if (!t.followUp) return exchange;
    return [
      ...exchange,
      {
        role: 'user' as const,
        blocks: [{ type: 'text' as const, text: 'Can you sum that up in one line?' }],
        createdAt: minutesAgo(at + 1),
      },
      {
        role: 'assistant' as const,
        blocks: [{ type: 'text' as const, text: t.followUp }],
        createdAt: minutesAgo(at),
      },
    ];
  };

  TOPICS.forEach((t, i) => {
    const at = 30 + i * 60 * 26; // about one chat every 26 hours, newest first
    const a = acc[t.account];
    repo.upsertConversation({
      accountId: a.id,
      remoteId: `fx-${a.platform}-${i}`,
      remoteTitle: t.remoteTitle,
      title: t.title,
      summary: t.summary,
      projectId: t.project ? projects[t.project] : null,
      state: t.state ?? 'inbox',
      createdAt: minutesAgo(at + 3),
      remoteUpdatedAt: minutesAgo(at),
      messages: messagesFor({ ...t, followUp: t.summary }, at),
      tags: t.tags,
    });
    n++;
  });

  // Untitled/very short chats: what the "to clean" suggestions will look for, and enough rows to
  // exercise paging and "select all N".
  for (let i = 0; i < 90; i++) {
    const key = ACCOUNT_KEYS[i % ACCOUNT_KEYS.length] as Topic['account'];
    const a = acc[key];
    const title = FILLER_TITLES[i % FILLER_TITLES.length] as string;
    const at = 60 * 24 * 20 + i * 60 * 38; // spread over about five months
    repo.upsertConversation({
      accountId: a.id,
      remoteId: `fx-filler-${i}`,
      remoteTitle: title,
      createdAt: minutesAgo(at + 2),
      remoteUpdatedAt: minutesAgo(at),
      messages: messagesFor(
        { question: `Sample question ${i + 1}`, answer: `Sample short answer ${i + 1}.` },
        at,
      ),
    });
    n++;
  }
  return n;
}

/** Bump when the demo data changes shape, so existing demo databases are rebuilt. */
export const DEMO_VERSION = 2;

/**
 * Makes sure an empty database shows the demo data, and that an OUTDATED demo is rebuilt.
 * Real data is never touched: removal only happens while the `demo_data` flag says the database
 * contains nothing but demo rows (it is cleared the moment a real source is connected).
 */
export function ensureDemoData(
  repo: Repo,
  now: Date = new Date(),
): 'seeded' | 'refreshed' | 'kept' {
  let refreshed = false;
  if (
    repo.getSetting('demo_data') === '1' &&
    repo.getSetting('demo_version') !== String(DEMO_VERSION)
  ) {
    refreshed = repo.removeDemoData();
  }
  if (repo.sidebar().platforms.length > 0) return 'kept';
  seedFixtures(repo, now);
  repo.setSetting('demo_data', '1');
  repo.setSetting('demo_version', String(DEMO_VERSION));
  return refreshed ? 'refreshed' : 'seeded';
}
