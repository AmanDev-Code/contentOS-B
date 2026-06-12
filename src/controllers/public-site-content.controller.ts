import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { SiteContentService } from '../services/site-content.service';
import { SubscriptionService } from '../services/subscription.service';

/**
 * Public, unauthenticated reads for the marketing site:
 *  - announcement marquee
 *  - editable marketing copy blocks
 *  - legal page bodies
 *  - pricing display metadata + LIVE pricing (dynamic from Polar)
 */
@Controller('public')
export class PublicSiteContentController {
  constructor(
    private readonly siteContent: SiteContentService,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  @Get('announcements')
  async announcements() {
    return { announcements: await this.siteContent.listPublicAnnouncements() };
  }

  @Get('site-content')
  async allContent() {
    return { content: await this.siteContent.getAllPublicContent() };
  }

  @Get('site-content/:key')
  async content(@Param('key') key: string) {
    const c = await this.siteContent.getContentPublic(key);
    if (!c) throw new NotFoundException('Unknown content key');
    return c;
  }

  @Get('legal')
  async legalList() {
    return { pages: await this.siteContent.listLegalPublic() };
  }

  @Get('legal/:slug')
  async legal(@Param('slug') slug: string) {
    const page = await this.siteContent.getLegalPublic(slug);
    if (!page) throw new NotFoundException('Legal page not found');
    return page;
  }

  /** Plan feature bullets / descriptions / highlights (NOT prices). */
  @Get('pricing-meta')
  async pricingMeta() {
    return this.siteContent.getPricingMetaPublic();
  }

  /** Live, dynamic prices pulled from Polar at runtime (cached). */
  @Get('pricing-live')
  async pricingLive() {
    return this.subscriptionService.getPublicLivePricing();
  }
}
