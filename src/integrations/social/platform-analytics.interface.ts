import type {
  AccountAnalytics,
  ConnectedAccount,
  OAuthTokenSet,
  PostAnalytics,
} from './types';

export interface AnalyticsRange {
  readonly from: Date;
  readonly to: Date;
}

// Analytics are optional on a per-platform basis. The provider registry surfaces
// analytics as `undefined` for platforms that don't support it; callers must
// branch rather than assume.
export interface PlatformAnalytics {
  getAccountAnalytics(
    account: ConnectedAccount,
    tokens: OAuthTokenSet,
    range: AnalyticsRange,
  ): Promise<AccountAnalytics>;

  getPostAnalytics(
    account: ConnectedAccount,
    platformPostId: string,
    tokens: OAuthTokenSet,
  ): Promise<PostAnalytics>;
}
