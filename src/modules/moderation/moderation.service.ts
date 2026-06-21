import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { SupabaseService } from '../../services/supabase.service';
import { NotificationService } from '../../services/notification.service';
import {
  containsCussWord,
  containsOutputUnsafeWord,
  CUSS_WORDS,
} from './cuss-words';

@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);

  private readonly strikeLimit: number;
  private readonly strikeWindowHours: number;

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly notificationService: NotificationService,
  ) {
    this.strikeLimit = parseInt(process.env.MODERATION_STRIKE_LIMIT || '3', 10);
    this.strikeWindowHours = parseInt(
      process.env.MODERATION_STRIKE_WINDOW_HOURS || '24',
      10,
    );
  }

  /** Returns the full word list (for the admin/auth-gated endpoint). */
  getWordList(): readonly string[] {
    return CUSS_WORDS;
  }

  /** Check text for profanity. */
  checkProfanity(text: string): { blocked: boolean; matchCount: number } {
    const result = containsCussWord(text);
    return { blocked: result.hit, matchCount: result.matches.length };
  }

  /**
   * Run reduced safety check on LLM output.
   * Uses the OUTPUT_SAFETY_WORDS list which allows proper names (Dick),
   * mild expressions (damn, crap), and anatomical terms in context.
   */
  checkOutputSafety(generatedCaption: string): {
    safe: boolean;
    matches: string[];
  } {
    const result = containsOutputUnsafeWord(generatedCaption);
    return { safe: !result.hit, matches: result.matches };
  }

  /**
   * Record a moderation strike for a user.
   *
   * Never stores raw input — only the SHA-256 hash.
   */
  async recordStrike(
    userId: string,
    rawText: string,
    matchedTerms: string[],
    source: 'ui' | 'api',
  ): Promise<{ strikeCount: number; thresholdReached: boolean }> {
    const textHash = createHash('sha256').update(rawText).digest('hex');

    const supabase = this.supabaseService.getServiceClient();

    const { error: insertError } = await supabase
      .from('moderation_strikes')
      .insert({
        user_id: userId,
        attempted_text_hash: textHash,
        matched_terms: matchedTerms,
        source,
      });

    if (insertError) {
      this.logger.error(
        `Failed to record moderation strike: ${insertError.message}`,
      );
    }

    const strikeCount = await this.getRecentStrikeCount(userId);
    const thresholdReached = strikeCount >= this.strikeLimit;

    if (thresholdReached) {
      await this.notifyAdminOnThreshold(userId, strikeCount);
    }

    return { strikeCount, thresholdReached };
  }

  /** Count strikes in the rolling window. */
  async getRecentStrikeCount(userId: string): Promise<number> {
    const windowStart = new Date(
      Date.now() - this.strikeWindowHours * 60 * 60 * 1000,
    ).toISOString();

    const { count, error } = await this.supabaseService
      .getServiceClient()
      .from('moderation_strikes')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', windowStart);

    if (error) {
      this.logger.error(`Failed to count moderation strikes: ${error.message}`);
      return 0;
    }

    return count ?? 0;
  }

  /** Fire an admin notification when the threshold is reached. */
  async notifyAdminOnThreshold(
    userId: string,
    strikeCount: number,
  ): Promise<void> {
    this.logger.warn(
      `User ${userId} reached ${strikeCount} moderation strikes in ${this.strikeWindowHours}h window`,
    );

    await this.notificationService.createNotification({
      title: 'Moderation: User flagged for review',
      message: `User ${userId} has ${strikeCount} profanity strikes in the last ${this.strikeWindowHours}h. Manual review recommended.`,
      type: 'warning',
      category: 'system',
      isBroadcast: true,
      priority: 2,
      data: {
        userId,
        strikeCount,
        windowHours: this.strikeWindowHours,
      },
    });
  }
}
