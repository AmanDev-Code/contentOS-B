/**
 * Default editable marketing copy blocks (Phase 1.5 GTM).
 *
 * Keys map to `site_content.section_key`. Code holds these defaults; the
 * `site_content` table overrides any key once an admin saves edits from
 * /admin/site-content. Public marketing pages read merged values.
 *
 * COMPLIANCE FRAMING (mandatory) is baked into all copy:
 *  - "Brand Voice from the examples YOU provide" / "bring your own examples"
 *  - never "learns from your LinkedIn posts", "scrape", "ingest", "trained on
 *    your social data".
 *  - affirm data ownership + consent + platform compliance.
 */

export const SITE_CONTENT_KEYS = [
  'landing_hero',
  'landing_backers',
  'landing_pillars',
  'landing_how',
  'landing_audiences',
  'landing_comparison',
  'landing_secondary_features',
  'landing_stats',
  'landing_integrations',
  'landing_trust',
  'landing_pricing_teaser',
  'landing_faq',
  'features_page',
  'features_roadmap',
] as const;

export type SiteContentKey = (typeof SITE_CONTENT_KEYS)[number];

export const DEFAULT_SITE_CONTENT: Record<SiteContentKey, Record<string, unknown>> = {
  landing_hero: {
    eyebrow: 'AI social content platform',
    title: "Run your brand's social presence on autopilot, with AI you control.",
    subtitle:
      "Trndinn turns the examples you provide into on-brand posts, then schedules and publishes them to the accounts you connect. You own your data; we comply with every platform's policies.",
    primaryCta: { label: 'Start free', href: '/auth' },
    secondaryCta: { label: 'See how it works', href: '/features' },
    trustLine: 'No card required. 150 free credits to start.',
  },
  landing_backers: {
    title: 'Backed by the programs building what comes next',
    subtitle:
      'Trndinn is a member of leading startup and AI programs that back early-stage builders.',
    items: [
      { key: 'nvidia', name: 'NVIDIA Inception', href: 'https://www.nvidia.com/en-us/startups/' },
      { key: 'google', name: 'Google for Startups', href: 'https://startup.google.com/' },
      { key: 'aws', name: 'AWS Activate', href: 'https://aws.amazon.com/activate/' },
      { key: 'elevenlabs', name: 'ElevenLabs Grants', href: 'https://elevenlabs.io/startup-grants' },
    ],
  },
  landing_pillars: {
    title: 'From prompt to published, one calm workflow',
    subtitle: 'Four pillars that take you from idea to impact without the busywork.',
    items: [
      {
        key: 'generate',
        title: 'Generate',
        body: 'Draft on-brand posts, images, and carousels. Your Brand Voice is built only from the examples you provide. It is never scraped from your feeds.',
      },
      {
        key: 'schedule',
        title: 'Schedule',
        body: 'Plan a week or a month on a drag-and-drop calendar. Recurring schedules keep you consistent automatically.',
      },
      {
        key: 'publish',
        title: 'Publish',
        body: 'Publish and schedule to the accounts you connect, with your consent. Reliable delivery, retries, and full history.',
      },
      {
        key: 'analyze',
        title: 'Analyze',
        body: 'See what actually moves your audience and turn insights into your next post.',
      },
    ],
  },
  landing_how: {
    title: 'Live in four steps, and you stay in control',
    subtitle:
      'You bring the examples and the accounts. Trndinn does the heavy lifting, with your consent at every step.',
    steps: [
      {
        key: 'connect',
        title: 'Connect your accounts',
        body: 'Securely connect the channels you own. LinkedIn is live today; you grant access and can disconnect anytime.',
      },
      {
        key: 'examples',
        title: 'Provide your examples',
        body: 'Bring your own posts and brand guidelines. Your Brand Voice is built only from the examples you give us, never from scraping your feeds.',
      },
      {
        key: 'generate',
        title: 'Generate and schedule',
        body: 'Turn an idea into on-brand drafts and variants, then plan them on a drag-and-drop calendar with recurring schedules.',
      },
      {
        key: 'publish',
        title: 'Publish and learn',
        body: 'We publish to your connected accounts with your consent, then surface what resonates so your next post lands better.',
      },
    ],
  },
  landing_audiences: {
    title: 'Built for how you actually work',
    subtitle:
      'Whether you run one brand or many, Trndinn keeps publishing calm: your examples, your accounts, your consent.',
    items: [
      {
        key: 'founders',
        title: 'Founders and solo creators',
        body: 'Paste your best posts once, generate a week of on-brand drafts, and schedule without living in five tabs.',
      },
      {
        key: 'agencies',
        title: 'Agencies and teams',
        body: 'Keep client voices distinct with Brand Kits built from the examples each client provides, then publish from the accounts they connect.',
      },
      {
        key: 'creators',
        title: 'Growth and content leads',
        body: 'Plan on a visual calendar, automate recurring cadences, and see what resonates, all from one command center.',
      },
    ],
  },
  landing_comparison: {
    title: 'Stop juggling tabs. Start publishing with confidence.',
    subtitle:
      "Manual posting works until it doesn't. Missed slots, off-brand drafts, and no single source of truth.",
    manualLabel: 'Manual',
    trndinnLabel: 'Trndinn',
    rows: [
      { label: 'On-brand drafts from your examples', manual: false, trndinn: true },
      { label: 'Visual calendar with drag-and-drop', manual: false, trndinn: true },
      { label: 'Reliable scheduled publishing (within 60s)', manual: false, trndinn: true },
      { label: 'Recurring posts without copy-paste', manual: false, trndinn: true },
      { label: 'Full publish history and retries', manual: false, trndinn: true },
      { label: 'API and signed webhooks', manual: false, trndinn: true },
    ],
  },
  landing_secondary_features: {
    title: 'Everything else you need to stay consistent',
    subtitle: 'Power features that compound, without adding noise to your workflow.',
    items: [
      {
        key: 'variants',
        title: 'Hook variants in one click',
        body: 'Generate multiple angles from a single prompt and keep the winner. No rewriting from scratch.',
      },
      {
        key: 'recurring',
        title: 'Recurring schedules',
        body: 'Set cadences once and let Trndinn fill your calendar. Edit or pause any upcoming run.',
      },
      {
        key: 'automation',
        title: 'API and webhooks',
        body: 'Wire Trndinn into your stack with Public API v1 and HMAC-signed lifecycle webhooks.',
      },
    ],
  },
  landing_stats: {
    title: 'Built for momentum',
    items: [
      { value: '60s', label: 'Publish accuracy on scheduled posts' },
      { value: '99.9%', label: 'Delivery reliability target' },
      { value: '60 days', label: 'No re-auth on connected accounts' },
      { value: '100%', label: 'Your data, owned by you' },
    ],
  },
  landing_integrations: {
    title: 'Publishes where your audience already is',
    subtitle:
      "LinkedIn is live today, with more channels on the roadmap. You connect accounts; we comply with each platform's policies.",
    channels: [
      { name: 'LinkedIn', status: 'Live' },
      { name: 'X', status: 'Soon' },
      { name: 'Instagram', status: 'Soon' },
      { name: 'Facebook', status: 'Soon' },
      { name: 'Threads', status: 'Soon' },
      { name: 'YouTube', status: 'Soon' },
      { name: 'TikTok', status: 'Soon' },
      { name: 'Pinterest', status: 'Soon' },
      { name: 'Bluesky', status: 'Soon' },
      { name: 'Mastodon', status: 'Soon' },
      { name: 'Reddit', status: 'Soon' },
      { name: 'Telegram', status: 'Soon' },
      { name: 'Discord', status: 'Soon' },
    ],
  },
  landing_trust: {
    title: 'Your data. Your voice. Platform policies respected.',
    subtitle:
      'Trndinn is built to comply with the developer, platform, and AI policies of every network you connect, with clear ownership and deletion on disconnect.',
    disclaimer:
      'Trndinn is not affiliated with, endorsed by, or sponsored by LinkedIn, Microsoft, Meta, or any other connected platform.',
    items: [
      {
        key: 'ownership',
        title: 'You own your content',
        body: 'Your posts, examples, and Brand Kit inputs stay yours. We only process what you provide, with your consent.',
      },
      {
        key: 'compliance',
        title: 'Platform compliance',
        body: "We abide by each network's developer, platform, and AI policies, including LinkedIn and Meta/Instagram rules.",
      },
      {
        key: 'deletion',
        title: 'Delete on disconnect',
        body: "When you disconnect an account, we remove tokens and platform-derived data within each platform's retention limits.",
      },
      {
        key: 'security',
        title: 'Secure by default',
        body: 'Encrypted tokens, signed webhooks, and minimal data retention, designed for teams who take trust seriously.',
      },
    ],
  },
  landing_pricing_teaser: {
    title: "Start free. Scale when you're ready.",
    subtitle:
      '150 free credits to explore. Upgrade for more publishing power. Live prices are pulled from Polar at checkout.',
    ctaLabel: 'View plans',
    ctaHref: '/pricing',
    highlights: [
      { name: 'Free', detail: '150 credits to explore Brand Voice and scheduling' },
      { name: 'Creator', detail: 'For consistent solo publishing' },
      { name: 'Team and Agency', detail: 'Higher limits, webhooks, and team workflows' },
    ],
  },
  landing_faq: {
    title: 'Questions, answered',
    items: [
      {
        q: 'Does Trndinn learn from my LinkedIn posts?',
        a: "No. Your Brand Voice is built only from the examples you choose to provide. We never scrape, crawl, or ingest your social feeds, and we don't train AI on connected-platform data.",
      },
      {
        q: 'Do I keep ownership of my content?',
        a: 'Always. You own your content and inputs. We only use the limited rights needed to host, generate from your inputs, and publish on your behalf.',
      },
      {
        q: 'Is Trndinn compliant with platform rules?',
        a: "Yes. We're built to comply with and abide by the developer, platform, and AI policies of every connected platform, including LinkedIn and Meta/Instagram.",
      },
      {
        q: 'What happens when I disconnect an account?',
        a: "We delete that platform's tokens and platform-derived data, in line with each platform's retention limits.",
      },
      {
        q: 'Which platforms can I publish to today?',
        a: "LinkedIn is live today. Other channels are on the roadmap. You connect accounts when each channel launches, and we comply with that platform's policies.",
      },
      {
        q: 'How does pricing work?',
        a: 'Start free with 150 credits. Paid plans add more credits and features; checkout prices are fetched live from Polar so you always see current rates.',
      },
    ],
  },
  features_page: {
    eyebrow: 'Features',
    title: 'Everything you need to publish with confidence',
    subtitle:
      'A complete workflow: generate from your own examples, schedule with precision, publish reliably, and learn from results.',
    sections: [
      {
        key: 'brand-voice',
        title: 'Brand Voice from your examples',
        body: 'Paste your best posts and brand guidelines. Trndinn builds a voice profile from the examples you provide, so drafts sound like you, with zero scraping of your feeds.',
        bullets: [
          'Bring your own examples and writing samples',
          "Tone, do and don't, and brand colors in one Brand Kit",
          'Consistent voice across every draft',
        ],
      },
      {
        key: 'ai-studio',
        title: 'AI content studio',
        body: 'Generate posts, images, and carousels from your inputs. Refine with one click and keep what works.',
        bullets: [
          'Text, image, and carousel generation',
          'Regenerate single assets or whole sets',
          'Credit-based: use credits on any action',
        ],
      },
      {
        key: 'calendar',
        title: 'Calendar and scheduling',
        body: 'Plan visually with a drag-and-drop calendar. Recurring schedules keep your cadence steady automatically.',
        bullets: [
          'Day, week, and month views',
          'Drag-and-drop reschedule',
          'Recurring workflows (RRULE)',
        ],
      },
      {
        key: 'publishing',
        title: 'Reliable publishing',
        body: 'Publish and schedule to the accounts you connect. Automatic retries, dead-letter handling, and full logs keep delivery dependable.',
        bullets: [
          'Publishes within 60s of schedule',
          'Retry with backoff and failure alerts',
          'Complete publish history and logs',
        ],
      },
      {
        key: 'api',
        title: 'API and webhooks',
        body: 'Automate with a stable Public API v1 and signed webhooks for post lifecycle events.',
        bullets: [
          'Create, schedule, and check status via API',
          'HMAC-signed webhooks',
          'Per-plan rate limits',
        ],
      },
      {
        key: 'compliance',
        title: 'Compliant by design',
        body: "You own your data; we comply with every connected platform's policies and delete platform data on disconnect.",
        bullets: [
          'No scraping, no AI training on platform data',
          'Retention caps honored per platform',
          'GDPR, CCPA, and DPDP aligned',
        ],
      },
    ],
  },
  features_roadmap: {
    eyebrow: 'Product roadmap',
    title: 'Where Trndinn is today, and where it is headed',
    subtitle:
      'An honest look at what is live, what we are building, and what is planned. You stay in control at every step.',
    legendLive: 'Live',
    legendProgress: 'In progress',
    legendPlanned: 'Planned',
    lanes: [
      {
        key: 'now',
        label: 'Now',
        caption: 'Available today',
        status: 'live',
        phases: [
          { tag: 'Phase 0', name: 'Foundation & architecture', value: 'A secure, scalable core with encrypted account tokens and reliable publishing.' },
          { tag: 'Phase 1', name: 'LinkedIn publishing & scheduling', value: 'Connect your LinkedIn, then draft, schedule, and publish with retries and full history.' },
          { tag: 'Phase 1', name: 'Brand Voice from your examples', value: 'A voice profile built only from the posts and guidelines you provide.' },
          { tag: 'Phase 1', name: 'Visual calendar & recurring posts', value: 'Plan a week or month on a drag-and-drop calendar with recurring cadences.' },
        ],
      },
      {
        key: 'next',
        label: 'Next',
        caption: 'Building now',
        status: 'progress',
        phases: [
          { tag: 'Phase 1.5', name: 'Launch & go-to-market', value: 'Pricing, billing, and the polish that takes Trndinn to public launch.' },
          { tag: 'Phase 1', name: 'Public API & webhooks', value: 'Build on Trndinn with a documented API and event webhooks.' },
          { tag: 'Phase 2', name: 'AI content studio', value: 'Deeper post, image, and carousel generation from your own inputs.' },
        ],
      },
      {
        key: 'later',
        label: 'Later',
        caption: 'On the roadmap',
        status: 'planned',
        phases: [
          { tag: 'Phase 3', name: 'Trend intelligence', value: 'Spot what is resonating in your niche to inform your next post.' },
          { tag: 'Phase 4', name: 'Campaign engine', value: 'Plan multi-post campaigns around launches and themes.' },
          { tag: 'Phase 5', name: 'Creative studio', value: 'Richer on-brand visuals and templates for every post.' },
          { tag: 'Phase 6', name: 'More channels', value: 'Publish to more networks you connect, as each one launches.' },
          { tag: 'Phase 7', name: 'Workflow orchestration', value: 'Durable automation for complex, multi-step publishing.' },
          { tag: 'Phase 8', name: 'Video generation', value: 'Generate short-form video from the inputs you provide.' },
          { tag: 'Phase 9', name: 'Analytics intelligence', value: 'Turn results into clear, actionable next steps.' },
          { tag: 'Phase 10', name: 'Teams & agency tools', value: 'Roles, approvals, and multi-brand workspaces.' },
          { tag: 'Phase 11', name: 'Autonomous growth', value: 'An AI growth system that proposes and drafts, with you in control.' },
        ],
      },
    ],
  },
};

export function getDefaultSiteContent(key: string): Record<string, unknown> | null {
  return (DEFAULT_SITE_CONTENT as Record<string, Record<string, unknown>>)[key] ?? null;
}
