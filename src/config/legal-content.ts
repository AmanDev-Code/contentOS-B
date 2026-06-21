/**
 * Default legal page templates (Phase 1.5 GTM).
 *
 * Entity details and contact emails are configured below. Admins can override
 * any page body from /admin/legal via the `legal_pages` DB table.
 *
 * Compliance framing (mandatory, applied throughout):
 *  - Trndinn is FULLY COMPLIANT with and ABIDES BY the developer / platform /
 *    AI policies of LinkedIn, Meta / Instagram, X, and every connected platform.
 *  - We affirm user data ownership + consent everywhere.
 *  - Brand-voice / style features use ONLY content the user provides — never
 *    scraped/ingested platform data, never "AI trained on your social data".
 *  - "Not affiliated with or endorsed by LinkedIn, Microsoft, or Meta."
 */

export interface LegalPageDefault {
  slug: string;
  title: string;
  summary: string;
  seoDescription: string;
  version: string;
  effectiveDate: string;
  sortOrder: number;
  /** Markdown body. */
  body: string;
}

export const LEGAL_PAGE_SLUGS = [
  'privacy',
  'terms',
  'cookies',
  'aup',
  'dpa',
  'subprocessors',
  'refund',
  'data-rights',
] as const;

export type LegalPageSlug = (typeof LEGAL_PAGE_SLUGS)[number];

const EFFECTIVE_DATE = 'May 2, 2026';
const LEGAL_ENTITY_NAME = 'Trndinn Innovation Pvt Ltd';
const LEGAL_ENTITY_ADDRESS = 'Indira Enclave, AECS Marathahalli, 560037, India';
const COMPLIANCE_EMAIL = 'compliance@trndinn.com';
const SUPPORT_EMAIL = 'support@trndinn.com';
const GOVERNING_LAW_COUNTRY = 'India';
const GOVERNING_LAW_VENUE = 'the courts in Bengaluru, Karnataka, India';
const MINIMUM_AGE = '18';
const EU_UK_REPRESENTATIVE =
  'Aman Ahuja, Trndinn Innovation Pvt Ltd, Indira Enclave, AECS Marathahalli, 560037, India — aman@trndinn.com';
const GRIEVANCE_OFFICER_NAME = 'Aman Ahuja';
const GRIEVANCE_OFFICER_EMAIL = 'aman@trndinn.com';
const REFUND_WINDOW_DAYS = '3';

const NOT_AFFILIATED =
  'Trndinn is an independent product and is **not affiliated with, sponsored by, or endorsed by LinkedIn, Microsoft, Meta, Instagram, or X**. All product names, logos, and brands are property of their respective owners and are used for identification only.';

const PLATFORM_COMPLIANCE = `## Platform Compliance & Data Ownership

Trndinn is built to **comply with and abide by the developer, platform, and AI policies of every connected platform** (including LinkedIn, Meta/Instagram, and X). We never operate against those policies.

- **You own your data.** Content you create, upload, or provide remains yours. You grant us only the limited rights needed to provide the service (store, process, and publish to the accounts you connect).
- **Consent first.** We act on your connected accounts only with your explicit consent and only to **publish and schedule** the content you create.
- **No scraping.** We do not scrape, crawl, or harvest platform data. We access connected platforms solely through their official APIs and within their terms.
- **No AI training on platform data.** Our AI features are powered **only by the examples and inputs you provide to us** — not by data pulled from your social feeds or other members. We do not use connected-platform member data to train models.
- **Retention caps & deletion.** We retain connected-platform data only as long as necessary and honor each platform's caching/retention limits. When you disconnect an account or delete your account, we delete the associated tokens and platform-derived data (see *Data Retention*).

${NOT_AFFILIATED}`;

const RETENTION_SECTION = `## Data Retention

We retain personal data only as long as necessary to provide the service, comply with legal obligations, resolve disputes, and enforce agreements. For data obtained through connected-platform APIs we additionally honor each platform's caching and retention limits, applying the **shortest applicable** period:

- **LinkedIn:** profile data cached up to 24 hours; social actions up to 48 hours; organization data up to 8 weeks; standardized data up to 12 months. Tokens and LinkedIn-derived data are deleted on disconnect or account closure; on termination we delete within 10 days and can certify deletion on request.
- **Meta / Instagram:** Platform Data is deleted promptly on your request, account deletion, or removal of permissions, and in any case within **90 days**; Instagram user content is removed within **24 hours** of an owner's deletion request. We store such data only for the minimum period necessary.
- **X and other platforms:** we honor revocation, minimize stored data, and never sell or transfer platform data to third parties.`;

export const DEFAULT_LEGAL_PAGES: Record<LegalPageSlug, LegalPageDefault> = {
  privacy: {
    slug: 'privacy',
    title: 'Privacy Policy',
    summary:
      'How Trndinn collects, uses, shares, and protects your personal data — and the rights you have over it.',
    seoDescription:
      "Trndinn's Privacy Policy: what data we collect, how we use it, your GDPR/CCPA/DPDP rights, and our platform-compliance commitments.",
    version: '1.0',
    effectiveDate: EFFECTIVE_DATE,
    sortOrder: 1,
    body: `**Effective date:** ${EFFECTIVE_DATE}
**Controller:** ${LEGAL_ENTITY_NAME}, ${LEGAL_ENTITY_ADDRESS} ("Trndinn", "we", "us").

This Privacy Policy explains how we handle personal data when you use the Trndinn website and application (the "Service"). We apply it globally and align it with the **EU/UK GDPR**, the **California CCPA/CPRA**, and **India's DPDP Act, 2023**.

## 1. Data We Collect

- **Account data:** name, email, password hash, organization, locale, timezone.
- **Content you provide:** posts, drafts, media, brand examples, and writing samples **you choose to give us**. These power your Brand Voice profile — built **only from the examples you provide**, never from data scraped or ingested from your social platforms.
- **Connected-account data:** OAuth tokens and the minimum profile/account data needed to publish and schedule to accounts **you connect** (e.g., LinkedIn). Accessed only via official platform APIs, with your consent.
- **Usage & device data:** log data, IP address, browser/device info, and product analytics (see Cookie Policy).
- **Billing data:** handled by our payment processor (Polar); we store limited billing metadata, not full card numbers.

## 2. How We Use Data

To provide and secure the Service; to generate content **from inputs you supply**; to publish and schedule to your connected accounts; to process payments; to provide support; to improve the product (aggregated/de-identified where feasible); and to comply with legal obligations. **Legal bases (GDPR):** contract, consent, legitimate interests, and legal obligation.

## 3. AI & Your Content

Our AI features operate on the content and examples **you provide**. We do **not** train models on connected-platform member data, and we do **not** scrape, crawl, harvest, or ingest your social feeds. You retain ownership of your inputs and outputs.

## 4. Sharing & Sub-processors

We share data with service providers (sub-processors) strictly to operate the Service — see the [Sub-processors list](/legal/subprocessors). We **do not sell** your personal data and **do not "share" it** for cross-context behavioral advertising as defined by the CCPA/CPRA. We disclose connected platforms (LinkedIn, Meta/Instagram, etc.) as data recipients where you direct publishing.

${PLATFORM_COMPLIANCE}

${RETENTION_SECTION}

## 5. International Transfers

We may transfer data internationally (including to/from ${GOVERNING_LAW_COUNTRY}). Where required we rely on Standard Contractual Clauses (SCCs) and equivalent safeguards. EU/UK users: our Article 27 representative is ${EU_UK_REPRESENTATIVE}.

## 6. Your Rights

Depending on your location you may have rights to access, correct, delete, port, restrict, or object to processing, and to withdraw consent. **California (CCPA/CPRA):** rights to know, delete, correct, and opt out of sale/share (we honor Global Privacy Control). **India (DPDP):** rights to access, correction, erasure, grievance redressal, and nomination. Exercise rights via the [Data Subject Rights page](/legal/data-rights) or ${COMPLIANCE_EMAIL}.

## 7. Security

We use encryption in transit and at rest, access controls, and least-privilege practices. No method is 100% secure, but we work to protect your data.

## 8. Children

The Service is not directed to children under ${MINIMUM_AGE}. We do not knowingly collect their data.

## 9. Changes & Contact

We may update this Policy; material changes will be notified. Questions: ${COMPLIANCE_EMAIL}. Data Protection Officer / Grievance Officer (India DPDP): ${GRIEVANCE_OFFICER_NAME}, ${GRIEVANCE_OFFICER_EMAIL}.`,
  },

  terms: {
    slug: 'terms',
    title: 'Terms of Service',
    summary:
      'The agreement governing your use of Trndinn, including acceptable use, billing, and platform-compliance commitments.',
    seoDescription:
      "Trndinn's Terms of Service: your rights and responsibilities, billing, acceptable use, and our platform-compliance commitments.",
    version: '1.0',
    effectiveDate: EFFECTIVE_DATE,
    sortOrder: 2,
    body: `**Effective date:** ${EFFECTIVE_DATE}
These Terms of Service ("Terms") are a contract between you and **${LEGAL_ENTITY_NAME}** ("Trndinn") governing your use of the Service.

## 1. Acceptance

By creating an account or using the Service you agree to these Terms, our [Privacy Policy](/legal/privacy), and our [Acceptable Use Policy](/legal/aup).

## 2. Accounts

You are responsible for your account, credentials, and the activity under it. You must provide accurate information and be at least ${MINIMUM_AGE} years old.

## 3. The Service

Trndinn helps you create content with AI **from the examples and inputs you provide**, and publish and schedule that content to accounts **you connect**. You retain ownership of your content; you grant us a limited license to host, process, and publish it on your behalf.

## 4. Your Responsibilities

You are responsible for the content you create and publish and for complying with the terms of every platform you connect. You must not use the Service to scrape platform data, bypass platform limits, or violate any platform's policies.

${PLATFORM_COMPLIANCE}

## 5. Billing

Paid plans are billed through our processor (**Polar**) on a monthly or annual cycle. Prices are shown at checkout and may change with notice. Credits and plan allotments are described on the [Pricing page](/pricing). See the [Refund & Cancellation Policy](/legal/refund).

## 6. Intellectual Property

Trndinn and its software are owned by ${LEGAL_ENTITY_NAME}. You receive a limited, non-exclusive, non-transferable right to use the Service.

## 7. Disclaimers & Limitation of Liability

The Service is provided "as is". To the maximum extent permitted by law, ${LEGAL_ENTITY_NAME} disclaims implied warranties and limits liability as set out here. AI outputs may be inaccurate — review before publishing.

## 8. Termination

You may stop using the Service at any time. We may suspend or terminate accounts that violate these Terms or platform policies. On termination we delete connected-platform tokens and platform-derived data per our [Privacy Policy](/legal/privacy).

## 9. Governing Law

These Terms are governed by the laws of ${GOVERNING_LAW_COUNTRY}, without regard to conflict-of-law rules. Disputes are subject to ${GOVERNING_LAW_VENUE}.

## 10. Contact

${LEGAL_ENTITY_NAME}, ${LEGAL_ENTITY_ADDRESS} — ${COMPLIANCE_EMAIL}.

${NOT_AFFILIATED}`,
  },

  cookies: {
    slug: 'cookies',
    title: 'Cookie Policy',
    summary:
      'What cookies and similar technologies we use, and how to control them.',
    seoDescription:
      "Trndinn's Cookie Policy: the cookies and similar technologies we use, their purposes, and how to manage your preferences.",
    version: '1.0',
    effectiveDate: EFFECTIVE_DATE,
    sortOrder: 3,
    body: `**Effective date:** ${EFFECTIVE_DATE}

This Cookie Policy explains how **${LEGAL_ENTITY_NAME}** ("Trndinn") uses cookies and similar technologies on the Service.

## 1. What Are Cookies

Cookies are small files stored on your device. We also use local storage and similar technologies.

## 2. Categories We Use

- **Strictly necessary:** authentication, security, load balancing. Cannot be disabled.
- **Functional:** remembering preferences (e.g., theme, dismissed banners).
- **Analytics:** product analytics (e.g., PostHog) to understand usage. Used with consent where required.
- **Marketing:** limited; only with consent where required.

## 3. Consent

In the EU/UK and other regions requiring prior consent, non-essential cookies load **only after you consent** via our cookie banner. You can change your choices at any time.

## 4. Managing Cookies

Control cookies via our banner/preferences and your browser settings. California users can use **Global Privacy Control (GPC)**; see [Your Privacy Choices](/legal/data-rights).

## 5. Contact

Questions: ${COMPLIANCE_EMAIL}.`,
  },

  aup: {
    slug: 'aup',
    title: 'Acceptable Use Policy',
    summary:
      'What you may and may not do with Trndinn — including platform-compliance rules.',
    seoDescription:
      "Trndinn's Acceptable Use Policy: prohibited activities and our commitment to platform compliance and responsible use.",
    version: '1.0',
    effectiveDate: EFFECTIVE_DATE,
    sortOrder: 4,
    body: `**Effective date:** ${EFFECTIVE_DATE}

This Acceptable Use Policy ("AUP") applies to everyone who uses Trndinn. Violations may result in suspension or termination.

## 1. Prohibited Activities

You must not:

- Scrape, crawl, harvest, or ingest data from any platform, or build lead lists / CRM enrichment from platform data.
- Attempt to bypass any platform's rate limits, technical restrictions, or terms.
- Use the Service to train AI on connected-platform member data.
- Publish unlawful, infringing, deceptive, hateful, or harassing content.
- Send spam or violate anti-spam laws.
- Reverse engineer, disrupt, or compromise the Service or its security.
- Misrepresent affiliation or impersonate others.

## 2. Responsible & Compliant Use

You agree to use connected accounts only to **publish and schedule** content **you create**, with your consent, and in compliance with each platform's policies.

${PLATFORM_COMPLIANCE}

## 3. Enforcement

We may investigate and take action (including content removal, suspension, or termination) for violations, and cooperate with lawful requests.

## 4. Contact

Report abuse: ${COMPLIANCE_EMAIL}.`,
  },

  dpa: {
    slug: 'dpa',
    title: 'Data Processing Agreement',
    summary:
      'Terms governing Trndinn’s processing of personal data on behalf of business customers (GDPR Art. 28).',
    seoDescription:
      "Trndinn's Data Processing Agreement (DPA): roles, sub-processors, security, international transfers, and data-subject assistance.",
    version: '1.0',
    effectiveDate: EFFECTIVE_DATE,
    sortOrder: 5,
    body: `**Effective date:** ${EFFECTIVE_DATE}

This Data Processing Agreement ("DPA") forms part of the [Terms of Service](/legal/terms) between the customer ("Controller") and **${LEGAL_ENTITY_NAME}** ("Processor", "Trndinn") and applies where we process personal data on the Controller's behalf under the GDPR and comparable laws.

## 1. Roles & Scope

The Controller determines purposes and means; Trndinn processes personal data only on documented instructions, as needed to provide the Service.

## 2. Sub-processors

The Controller authorizes the sub-processors listed at [/legal/subprocessors](/legal/subprocessors). We impose data-protection obligations on each sub-processor and remain responsible for their performance. We will give notice of changes and allow reasonable objection.

## 3. Security

We maintain appropriate technical and organizational measures (encryption in transit/at rest, access controls, logging, least privilege).

## 4. Data-Subject & Authority Assistance

We assist the Controller, taking into account the nature of processing, with data-subject requests and with obligations under Articles 32–36 GDPR.

## 5. International Transfers

Where personal data is transferred internationally, we rely on **Standard Contractual Clauses (SCCs)** and equivalent safeguards (e.g., for transfers to/from ${GOVERNING_LAW_COUNTRY}).

## 6. Deletion & Return

On termination, we delete or return personal data as instructed, subject to legal retention requirements and the retention caps in our [Privacy Policy](/legal/privacy).

## 7. Audits

We make available information necessary to demonstrate compliance and allow audits subject to reasonable confidentiality and scheduling.

## 8. Contact

DPA requests / signature: ${COMPLIANCE_EMAIL}.`,
  },

  subprocessors: {
    slug: 'subprocessors',
    title: 'Sub-processors',
    summary:
      'Third parties we use to provide the Service, and connected platforms you publish to.',
    seoDescription:
      "Trndinn's list of sub-processors and connected platforms, the data they handle, and where they operate.",
    version: '1.0',
    effectiveDate: EFFECTIVE_DATE,
    sortOrder: 6,
    body: `**Effective date:** ${EFFECTIVE_DATE}

We use the sub-processors below to provide the Service. We update this list as our vendors change and provide notice where required by our [DPA](/legal/dpa).

## Infrastructure & Platform

| Sub-processor | Purpose | Data | Region |
|---|---|---|---|
| AWS | Hosting & compute | Service & account data | ap-south-1 (Mumbai, India) |
| Supabase | Database & auth (hosted on AWS) | Account & content data | ap-south-1 (Mumbai, India) |
| MinIO (self-hosted on AWS) | Media/object storage | Uploaded media | ap-south-1 (Mumbai, India) |

## AI Providers (process only content you provide)

| Sub-processor | Purpose | Data | Region |
|---|---|---|---|
| AWS Bedrock (via our AI gateway) | Generate content from **your inputs** | Prompts & examples you provide | ap-south-1 (Mumbai, India) |
| Google Vertex / OpenAI / Anthropic (via our AI gateway) | Generate content from **your inputs** | Prompts & examples you provide | Provider regions (US/EU as applicable) |

## Operations

| Sub-processor | Purpose | Data | Region |
|---|---|---|---|
| Polar | Payments & billing (merchant of record) | Billing metadata | Global |
| SMTP2GO | Transactional email | Email address | Global |
| PostHog (self-hosted) | Product analytics | Usage data | ap-south-1 (Mumbai, India) |

## Connected Platforms (you direct publishing to these)

| Platform | Role | Data |
|---|---|---|
| LinkedIn | Publishing/scheduling target | Content you publish; tokens; minimum profile/account data |
| Meta / Instagram | Publishing/scheduling target | Content you publish; tokens |
| X | Publishing/scheduling target | Content you publish; tokens |

${NOT_AFFILIATED}

Questions: ${COMPLIANCE_EMAIL}.`,
  },

  refund: {
    slug: 'refund',
    title: 'Refund & Cancellation Policy',
    summary: 'How subscriptions, cancellations, refunds, and credits work.',
    seoDescription:
      "Trndinn's Refund & Cancellation Policy: billing cycles, cancellations, refund eligibility, and credit handling.",
    version: '1.0',
    effectiveDate: EFFECTIVE_DATE,
    sortOrder: 7,
    body: `**Effective date:** ${EFFECTIVE_DATE}

This policy explains billing, cancellations, and refunds for Trndinn subscriptions, processed via **Polar**.

## 1. Billing Cycles

Plans are billed monthly or annually, in advance. Annual plans may include a discount shown at checkout.

## 2. Cancellation

You can cancel anytime from your billing settings. Cancellation stops future renewals; you keep access until the end of the current paid period.

## 3. Refunds

Except where required by law, payments are non-refundable. We may, at our discretion, provide a prorated refund or account credit for billing errors or qualifying issues. Contact ${COMPLIANCE_EMAIL} within ${REFUND_WINDOW_DAYS} days.

## 4. Credits

Credits power actions in the Service (see [Pricing](/pricing)). Trial credits expire per the trial terms; plan credits reset each billing period; bonus/reward credits do not expire. Credits have no cash value and are non-transferable.

## 5. Statutory Rights

Nothing here limits non-waivable consumer rights you may have under ${GOVERNING_LAW_COUNTRY} law.

## 6. Contact

Billing questions: ${SUPPORT_EMAIL}.`,
  },

  'data-rights': {
    slug: 'data-rights',
    title: 'Your Privacy Choices & Data Rights',
    summary:
      'Exercise your GDPR, CCPA/CPRA, and India DPDP rights — access, deletion, correction, and opt-out.',
    seoDescription:
      'Exercise your data rights with Trndinn: access, delete, correct, port, and opt out of sale/share under GDPR, CCPA/CPRA, and India DPDP.',
    version: '1.0',
    effectiveDate: EFFECTIVE_DATE,
    sortOrder: 8,
    body: `**Effective date:** ${EFFECTIVE_DATE}

We respect your control over your data. This page explains your choices and how to exercise them.

## Your Rights

- **Access / Know** — what data we hold about you.
- **Deletion / Erasure** — delete your data (subject to legal retention).
- **Correction** — fix inaccurate data.
- **Portability** — receive your data in a portable format.
- **Restrict / Object** — limit certain processing (GDPR).
- **Withdraw consent** — at any time, without affecting prior processing.
- **Do Not Sell or Share** — we do **not** sell or "share" personal data for cross-context behavioral advertising; we honor **Global Privacy Control (GPC)** signals.

## How to Submit a Request

Email ${COMPLIANCE_EMAIL} or use the in-app request form. We verify your identity before fulfilling requests and respond within the timeframe required by applicable law. You may authorize an agent to act on your behalf.

## Region-Specific

- **EU/UK (GDPR):** you may lodge a complaint with your supervisory authority. Article 27 representative: ${EU_UK_REPRESENTATIVE}.
- **California (CCPA/CPRA):** rights to know, delete, correct, and opt out of sale/share; we do not discriminate for exercising rights.
- **India (DPDP, 2023):** rights to access, correction, erasure, grievance redressal, and nomination. **Grievance Officer:** ${GRIEVANCE_OFFICER_NAME}, ${GRIEVANCE_OFFICER_EMAIL}, ${LEGAL_ENTITY_ADDRESS}.

## Connected Accounts

Disconnecting a platform in Settings deletes its tokens and platform-derived data per our [Privacy Policy](/legal/privacy).`,
  },
};

/** Bracket tokens from pre-launch draft templates — must not ship to users. */
const LEGAL_PLACEHOLDER_RE =
  /\[(?:EFFECTIVE_DATE|LEGAL_ENTITY_NAME|LEGAL_ENTITY_ADDRESS|PLACEHOLDER)\]/;

/** Detect draft/placeholder legal copy (DB override or legacy defaults). */
export function hasLegalPlaceholders(
  value: string | null | undefined,
): boolean {
  if (value == null) return false;
  const text = String(value);
  if (!text.trim()) return false;
  if (LEGAL_PLACEHOLDER_RE.test(text)) return true;
  if (text.includes('1.0-draft')) return true;
  if (/template pending review/i.test(text)) return true;
  if (/>\s*\*\*internal note/i.test(text)) return true;
  return false;
}

/** True when a `legal_pages` row still contains launch-blocker placeholders. */
export function isStaleLegalDbRow(
  row: Record<string, unknown> | null,
): boolean {
  if (!row) return false;
  return (
    hasLegalPlaceholders(row.body as string | undefined) ||
    hasLegalPlaceholders(row.version as string | undefined) ||
    hasLegalPlaceholders(row.effective_date as string | undefined) ||
    hasLegalPlaceholders(row.title as string | undefined) ||
    hasLegalPlaceholders(row.summary as string | undefined)
  );
}

export function getDefaultLegalPage(slug: string): LegalPageDefault | null {
  return (
    (DEFAULT_LEGAL_PAGES as Record<string, LegalPageDefault>)[slug] ?? null
  );
}
