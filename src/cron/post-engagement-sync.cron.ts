import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  UserPublishedPostRepository,
  type PendingEngagementPost,
} from '../repositories/user-published-post.repository';
import { LinkedinService } from '../services/linkedin.service';

/**
 * Engagement-ranked style learning (Sprint 1.6, task #1132 — the original
 * "rank by performance" vision on top of the always-on recency style block).
 *
 * Runs hourly and pulls reactions/comments for published posts that are old
 * enough to have accumulated engagement, then writes an `engagement_score` so
 * PostStyleLearningService can feed the user's TOP-PERFORMING posts (not just
 * the most recent ones) into the generation prompt.
 *
 * Delay window — founder decision: wait {@link ENGAGEMENT_DELAY_HOURS}h after
 * publish before pulling stats (LinkedIn posts accumulate most engagement in
 * the first 24h, so an earlier read would under-rank good posts).
 *
 * Account handling — founder decision (Option B):
 *   • ORGANISATION posts: use the existing org analytics (r_organization_social),
 *     which already work today.
 *   • PERSONAL posts: use member analytics, gated on the restricted
 *     `r_member_social` scope. If that scope is NOT granted, the LinkedIn call
 *     reports it as unavailable and we DEGRADE GRACEFULLY — no thrown error, no
 *     failed job; those posts simply keep recency-based ranking until LinkedIn
 *     approves the scope.
 *
 * Scoring formula: `engagement_score = reactions + comments * 2`. Comments are
 * weighted higher than reactions because a comment is a stronger signal of a
 * resonant post than a one-tap reaction. A post read with genuinely zero
 * engagement is scored 0 (so it won't be re-queried). Because top-performer
 * selection sorts NULLS LAST, a scored-0 post still outranks a never-scored
 * (null) post — intentional: we measured the 0-post and it underperformed,
 * whereas a null post just hasn't been measured yet.
 */
const ENGAGEMENT_DELAY_HOURS = 24;
const BATCH_LIMIT = 100;
const ORG_ANALYTICS_FETCH_LIMIT = 100;

@Injectable()
export class PostEngagementSyncCronService {
  private readonly logger = new Logger(PostEngagementSyncCronService.name);

  constructor(
    private readonly publishedPostRepo: UserPublishedPostRepository,
    private readonly linkedinService: LinkedinService,
  ) {}

  @Cron('0 * * * *', { name: 'post-engagement-sync' })
  async sync(): Promise<void> {
    const cutoff = new Date(
      Date.now() - ENGAGEMENT_DELAY_HOURS * 60 * 60 * 1000,
    ).toISOString();

    let pending: PendingEngagementPost[];
    try {
      pending = await this.publishedPostRepo.getPostsAwaitingEngagement(
        cutoff,
        BATCH_LIMIT,
      );
    } catch (err) {
      this.logger.error(
        `Engagement sync query failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (!pending || pending.length === 0) {
      this.logger.debug('Engagement sync: no posts awaiting engagement');
      return;
    }

    this.logger.log(
      `Engagement sync: ${pending.length} post(s) past the ${ENGAGEMENT_DELAY_HOURS}h window awaiting engagement`,
    );

    const byUser = new Map<string, PendingEngagementPost[]>();
    for (const post of pending) {
      const list = byUser.get(post.userId) ?? [];
      list.push(post);
      byUser.set(post.userId, list);
    }

    for (const [userId, posts] of byUser) {
      try {
        await this.syncUser(userId, posts);
      } catch (err) {
        // One user's failure must never abort the whole sweep.
        this.logger.warn(
          `Engagement sync failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async syncUser(
    userId: string,
    posts: PendingEngagementPost[],
  ): Promise<void> {
    // 1) ORGANISATION posts — analytics already work via r_organization_social.
    const orgEngagement = await this.fetchOrganizationEngagement(userId);

    const remaining: PendingEngagementPost[] = [];
    for (const post of posts) {
      const match = orgEngagement.get(this.normalizeUrn(post.linkedinPostId));
      if (match) {
        await this.applyEngagement(
          post,
          match.reactions,
          match.comments,
          'organization',
        );
      } else {
        remaining.push(post);
      }
    }

    if (remaining.length === 0) return;

    // 2) PERSONAL posts — gated on r_member_social; degrade gracefully.
    let member: {
      available: boolean;
      byPostId: Map<string, { reactions: number; comments: number }>;
    };
    try {
      member = await this.linkedinService.getMemberPostEngagement(
        userId,
        remaining.map((p) => p.linkedinPostId),
      );
    } catch (err) {
      // Defensive: getMemberPostEngagement is designed not to throw, but if it
      // ever does, treat personal analytics as unavailable rather than failing.
      this.logger.warn(
        `Member engagement lookup threw for user ${userId} (treating as unavailable): ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (!member.available) {
      this.logger.log(
        `Personal analytics not available yet for user ${userId} — ` +
          `${remaining.length} personal post(s) keep recency-based ranking.`,
      );
      return;
    }

    for (const post of remaining) {
      const m = member.byPostId.get(this.normalizeUrn(post.linkedinPostId));
      // No reading for this post (e.g. deleted / 404): leave engagement_score
      // null so it stays on recency ranking and is retried next run.
      if (!m) continue;
      await this.applyEngagement(post, m.reactions, m.comments, 'member');
    }
  }

  private async fetchOrganizationEngagement(
    userId: string,
  ): Promise<Map<string, { reactions: number; comments: number }>> {
    const engagement = new Map<
      string,
      { reactions: number; comments: number }
    >();

    let orgUrns: string[] = [];
    try {
      const { identities } =
        await this.linkedinService.getPostingIdentities(userId);
      orgUrns = identities
        .filter((i) => i.actorType === 'organization' && i.organizationUrn)
        .map((i) => i.organizationUrn as string);
    } catch (err) {
      // No org identities (or lookup failed) — personal-only user. Not an error.
      this.logger.debug(
        `No organization identities for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return engagement;
    }

    for (const orgUrn of orgUrns) {
      try {
        const analytics = await this.linkedinService.getPostAnalytics(
          userId,
          ORG_ANALYTICS_FETCH_LIMIT,
          'organization',
          orgUrn,
        );
        for (const row of analytics ?? []) {
          if (!row?.id) continue;
          engagement.set(this.normalizeUrn(row.id), {
            reactions: Number(row.likes) || 0,
            comments: Number(row.comments) || 0,
          });
        }
      } catch (err) {
        this.logger.warn(
          `Org analytics fetch failed for ${orgUrn} (user ${userId}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return engagement;
  }

  private async applyEngagement(
    post: PendingEngagementPost,
    reactions: number,
    comments: number,
    source: 'organization' | 'member',
  ): Promise<void> {
    const safeReactions = Math.max(0, Math.round(Number(reactions) || 0));
    const safeComments = Math.max(0, Math.round(Number(comments) || 0));
    const engagementScore = this.computeEngagementScore(
      safeReactions,
      safeComments,
    );

    try {
      await this.publishedPostRepo.updateEngagement({
        id: post.id,
        reactions: safeReactions,
        comments: safeComments,
        engagementScore,
      });
      this.logger.log(
        `Engagement synced (${source}) for post ${post.id}: ` +
          `reactions=${safeReactions} comments=${safeComments} score=${engagementScore}`,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to persist engagement for post ${post.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** reactions + comments*2 — comments weighted higher (stronger signal). */
  private computeEngagementScore(reactions: number, comments: number): number {
    return Math.max(0, reactions) + Math.max(0, comments) * 2;
  }

  private normalizeUrn(value: string): string {
    return (value || '').trim().toLowerCase();
  }
}
