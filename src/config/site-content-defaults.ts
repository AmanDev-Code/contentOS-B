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
  'about_us',
] as const;

export type SiteContentKey = (typeof SITE_CONTENT_KEYS)[number];

export const DEFAULT_SITE_CONTENT: Record<
  SiteContentKey,
  Record<string, unknown>
> = {
  landing_hero: {
    eyebrow: 'All-in-one agentic social platform',
    title: 'Run your social growth on autopilot with AI agents',
    subtitle:
      "Trndinn's agents draft on-brand posts from the examples you provide, schedule them on a visual calendar, and publish to the accounts you connect — then feed your Content Engine to rank, distribute, and newsletter. You stay in control; agents do the work.",
    primaryCta: { label: 'Start free — 150 credits', href: '/auth' },
    secondaryCta: { label: 'See agentic workflows', href: '/features#agentic' },
    trustLine: 'No card required. 150 free credits to start.',
  },
  landing_backers: {
    title: 'Backed by the programs building what comes next',
    subtitle:
      'Trndinn is a member of leading startup and AI programs that back early-stage builders.',
    items: [
      {
        key: 'nvidia',
        name: 'NVIDIA Inception',
        href: 'https://www.nvidia.com/en-us/startups/',
      },
      {
        key: 'google',
        name: 'Google for Startups',
        href: 'https://startup.google.com/',
      },
      {
        key: 'aws',
        name: 'AWS Activate',
        href: 'https://aws.amazon.com/activate/',
      },
      {
        key: 'elevenlabs',
        name: 'ElevenLabs Grants',
        href: 'https://elevenlabs.io/startup-grants',
      },
    ],
  },
  landing_pillars: {
    title: 'Create, schedule, manage, and grow — one agentic workflow',
    subtitle:
      'Four pillars where AI agents handle the busywork and you keep brand control.',
    items: [
      {
        key: 'generate',
        title: 'Create with agents',
        body: 'Draft posts, images, and carousels in the Agent. Brand Voice learns only from examples you provide — never scraped from your feeds.',
      },
      {
        key: 'schedule',
        title: 'Schedule everywhere you connect',
        body: 'Visual calendar, drag-and-drop, recurring cadences. LinkedIn live today; more channels on the roadmap.',
      },
      {
        key: 'publish',
        title: 'Manage with confidence',
        body: 'Publish with retries and full history. Public API v1 and signed webhooks for your automation stack.',
      },
      {
        key: 'analyze',
        title: 'Grow with Content Engine',
        body: 'SEO articles, clusters, 31-platform distribution, internal links, and newsletter — agents feed the funnel.',
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
    title: 'Who is Trndinn for?',
    subtitle:
      'Agentic creators, LinkedIn-first teams, and growth leads who want one platform — not five tabs.',
    items: [
      {
        key: 'agentic',
        title: 'Agentic',
        body: "Tell Trndinn's Agent what to publish — or wire your stack via API and webhooks. MCP and CLI coming soon for Claude, ChatGPT, and Cursor.",
      },
      {
        key: 'linkedin',
        title: 'LinkedIn-first',
        body: 'Personal profiles and Company Pages, posting identity picker, and Brand Voice built from your examples — not scraped from feeds.',
      },
      {
        key: 'content-engine',
        title: 'Content Engine',
        body: 'Turn keywords into articles, distribute to 31 platforms, interlink, score SEO/AEO/GEO, and email your list — one agentic loop.',
      },
    ],
  },
  landing_comparison: {
    title:
      'Stop prompting in five tools. Start growing with one agentic platform.',
    subtitle:
      "Manual posting works until it doesn't. Missed slots, off-brand drafts, and no single source of truth.",
    manualLabel: 'Manual',
    trndinnLabel: 'Trndinn',
    rows: [
      {
        label: 'Agent drafts + schedules end-to-end',
        manual: false,
        trndinn: true,
      },
      {
        label: 'Brand Voice from your examples (no scraping)',
        manual: false,
        trndinn: true,
      },
      {
        label: 'SEO article → social distribution loop',
        manual: false,
        trndinn: true,
      },
      {
        label: 'Visual calendar with drag-and-drop',
        manual: false,
        trndinn: true,
      },
      {
        label: 'Reliable scheduled publishing (within 60s)',
        manual: false,
        trndinn: true,
      },
      { label: 'API and signed webhooks', manual: false, trndinn: true },
    ],
  },
  landing_secondary_features: {
    title: 'Everything else you need to stay consistent',
    subtitle:
      'Power features that compound, without adding noise to your workflow.',
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
      {
        name: 'Free',
        detail: '150 credits to explore Brand Voice and scheduling',
      },
      { name: 'Creator', detail: 'For consistent solo publishing' },
      {
        name: 'Team and Agency',
        detail: 'Higher limits, webhooks, and team workflows',
      },
    ],
  },
  landing_faq: {
    title: 'Questions, answered',
    items: [
      {
        q: 'What does agentic mean on Trndinn?',
        a: 'Agentic means AI that completes multi-step workflows — draft, adapt per platform, schedule, publish, and distribute — with minimal UI friction. Today that includes the in-app Agent, Brand Kit, calendar, Public API v1, webhooks, and Content Engine. MCP and CLI for external agents like Claude and ChatGPT are on the roadmap.',
      },
      {
        q: 'Does Trndinn learn from my LinkedIn posts?',
        a: "No. Your Brand Voice is built only from the examples you choose to provide. We never scrape, crawl, or ingest your social feeds, and we don't train AI on connected-platform data.",
      },
      {
        q: 'Can I connect Claude or ChatGPT today?',
        a: 'Use Public API v1 and signed webhooks to wire Trndinn into your automation stack today. A dedicated MCP server and CLI for Claude, ChatGPT, and Cursor are coming soon.',
      },
      {
        q: 'Which platforms can I publish to today?',
        a: 'LinkedIn is live today — personal profiles and Company Pages. Other channels are on the roadmap and marked Coming soon on our site. You connect accounts when each channel launches.',
      },
      {
        q: 'What is the Content Engine?',
        a: 'Content Engine turns keywords into SEO articles, distributes adapted copies to 31 platforms, builds internal links, scores SEO/AEO/GEO quality, and powers newsletter campaigns — so social is fed by search growth, not just prompts.',
      },
      {
        q: 'How does pricing work?',
        a: 'Start free with 150 credits. Paid plans (Creator, Team, Agency) add more credits and features; checkout prices are fetched live from Polar so you always see current rates.',
      },
    ],
  },
  features_page: {
    eyebrow: 'Features',
    title:
      'Everything you need for agentic social media — create, schedule, manage, and grow',
    subtitle:
      'One platform where AI agents handle the busywork and you keep brand control.',
    sections: [],
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
          {
            tag: 'Phase 0',
            name: 'Foundation & architecture',
            value:
              'A secure, scalable core with encrypted account tokens and reliable publishing.',
          },
          {
            tag: 'Phase 1',
            name: 'LinkedIn publishing & scheduling',
            value:
              'Connect your LinkedIn, then draft, schedule, and publish with retries and full history.',
          },
          {
            tag: 'Phase 1',
            name: 'Brand Voice from your examples',
            value:
              'A voice profile built only from the posts and guidelines you provide.',
          },
          {
            tag: 'Phase 1',
            name: 'Visual calendar & recurring posts',
            value:
              'Plan a week or month on a drag-and-drop calendar with recurring cadences.',
          },
        ],
      },
      {
        key: 'next',
        label: 'Next',
        caption: 'Building now',
        status: 'progress',
        phases: [
          {
            tag: 'Phase 1.5',
            name: 'Launch & go-to-market',
            value:
              'Pricing, billing, and the polish that takes Trndinn to public launch.',
          },
          {
            tag: 'Phase 1',
            name: 'Public API & webhooks',
            value: 'Build on Trndinn with a documented API and event webhooks.',
          },
          {
            tag: 'Phase 2',
            name: 'AI content studio',
            value:
              'Deeper post, image, and carousel generation from your own inputs.',
          },
        ],
      },
      {
        key: 'later',
        label: 'Later',
        caption: 'On the roadmap',
        status: 'planned',
        phases: [
          {
            tag: 'Phase 3',
            name: 'Trend intelligence',
            value:
              'Spot what is resonating in your niche to inform your next post.',
          },
          {
            tag: 'Phase 4',
            name: 'Campaign engine',
            value: 'Plan multi-post campaigns around launches and themes.',
          },
          {
            tag: 'Phase 5',
            name: 'Creative studio',
            value: 'Richer on-brand visuals and templates for every post.',
          },
          {
            tag: 'Phase 6',
            name: 'More channels',
            value:
              'Publish to more networks you connect, as each one launches.',
          },
          {
            tag: 'Phase 7',
            name: 'Workflow orchestration',
            value: 'Durable automation for complex, multi-step publishing.',
          },
          {
            tag: 'Phase 8',
            name: 'Video generation',
            value: 'Generate short-form video from the inputs you provide.',
          },
          {
            tag: 'Phase 9',
            name: 'Analytics intelligence',
            value: 'Turn results into clear, actionable next steps.',
          },
          {
            tag: 'Phase 10',
            name: 'Teams & agency tools',
            value: 'Roles, approvals, and multi-brand workspaces.',
          },
          {
            tag: 'Phase 11',
            name: 'Autonomous growth',
            value:
              'An AI growth system that proposes and drafts, with you in control.',
          },
        ],
      },
    ],
  },
  about_us: {
    seoTitle: 'About Us | Trndinn',
    seoDescription:
      "Learn about Trndinn's mission, values, and the team building the future of social content creation.",
    heroHeadline: 'Building the future of social content creation',
    heroSubtitle:
      "We're on a mission to help creators, brands, and teams publish with confidence—powered by AI that respects your voice and your data.",
    heroEyebrow: 'About Trndinn',
    mainContent: `## Our Story

Trndinn was founded with a simple belief: creating great social content shouldn't require an army of agencies or hours of manual work. We set out to build a platform that combines the power of AI with your unique brand voice—because the best content comes from what makes you, you.

## Our Mission

We exist to help creators, founders, marketers, and teams publish consistently and confidently across social platforms. Everyone who creates should have access to tools that amplify their voice, not replace it.

## Our Approach

- **Your voice, your data**: Your Brand Voice is built only from the examples you provide. We never scrape your feeds or train AI on your platform data.
- **Platform compliance**: We build to comply with every connected platform's developer and content policies.
- **Creator-first**: Whether you're a solo founder or a marketing team, our tools are designed to fit your workflow, not the other way around.

## Our Values

- **Transparency**: Clear pricing, honest roadmap, no dark patterns.
- **Ownership**: You own your content, your examples, and your brand voice.
- **Reliability**: 99.9% delivery target, encrypted tokens, secure by default.
- **Creativity**: AI assists; humans create. We're here to amplify, not replace.
`,
    missionStatement:
      'Helping creators publish with confidence—powered by AI that respects their voice.',
    values: [
      {
        title: 'Transparency',
        description:
          'Clear pricing, honest roadmap, no dark patterns. We believe in building trust through openness.',
      },
      {
        title: 'Ownership',
        description:
          'You own your content. Your examples stay yours. Your brand voice belongs to you alone.',
      },
      {
        title: 'Reliability',
        description:
          '99.9% delivery target, encrypted tokens, secure by default. Your trust is our foundation.',
      },
      {
        title: 'Creativity',
        description:
          'AI assists; humans create. We amplify your ideas, not replace your creative spark.',
      },
    ],
  },
};

export function getDefaultSiteContent(
  key: string,
): Record<string, unknown> | null {
  return (
    (DEFAULT_SITE_CONTENT as Record<string, Record<string, unknown>>)[key] ??
    null
  );
}
