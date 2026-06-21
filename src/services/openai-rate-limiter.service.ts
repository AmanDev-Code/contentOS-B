import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface QueuedRequest<T> {
  userId: string;
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
  retryCount: number;
}

interface UserQueue {
  requests: QueuedRequest<unknown>[];
  lastProcessedAt: number;
}

/**
 * Global OpenAI rate limiter with fair per-user queuing.
 *
 * Features:
 * - Global concurrency limit (default 15 concurrent requests)
 * - Per-user fair queuing (round-robin scheduling)
 * - Exponential backoff on rate limit (429) errors
 * - Request queueing instead of immediate failure
 * - Stale request cleanup
 */
@Injectable()
export class OpenAIRateLimiterService implements OnModuleInit {
  private readonly logger = new Logger(OpenAIRateLimiterService.name);

  /** Max concurrent OpenAI API calls globally */
  private readonly maxConcurrent: number;

  /** Max wait time for a queued request (ms) before timeout */
  private readonly maxQueueTimeMs: number;

  /** Current number of active requests */
  private activeRequests = 0;

  /** Per-user request queues */
  private readonly userQueues = new Map<string, UserQueue>();

  /** Round-robin index for fair scheduling */
  private roundRobinIndex = 0;

  /** Queue processing lock to prevent concurrent drain */
  private isProcessing = false;

  /** Backoff state for rate limit recovery */
  private globalBackoffUntil = 0;

  /** Default exponential backoff delays (ms) */
  private readonly backoffDelays = [1000, 2000, 4000, 8000, 16000, 30000];

  /** Max retries per request */
  private readonly maxRetries: number;

  constructor(private readonly configService: ConfigService) {
    this.maxConcurrent = parseInt(
      this.configService.get<string>('OPENAI_MAX_CONCURRENT') || '15',
      10,
    );
    this.maxQueueTimeMs = parseInt(
      this.configService.get<string>('OPENAI_MAX_QUEUE_TIME_MS') || '300000', // 5 minutes
      10,
    );
    this.maxRetries = parseInt(
      this.configService.get<string>('OPENAI_MAX_RETRIES') || '4',
      10,
    );
  }

  onModuleInit() {
    this.logger.log(
      `OpenAI rate limiter initialized: maxConcurrent=${this.maxConcurrent}, maxQueueTime=${this.maxQueueTimeMs}ms, maxRetries=${this.maxRetries}`,
    );

    // Start stale request cleanup interval
    setInterval(() => this.cleanupStaleRequests(), 30000);
  }

  /**
   * Execute an OpenAI API call with global rate limiting and fair per-user queuing.
   *
   * @param userId - User ID for fair queuing
   * @param fn - Async function that makes the OpenAI API call
   * @param options - Optional configuration
   */
  async execute<T>(
    userId: string,
    fn: () => Promise<T>,
    options?: {
      /** Priority (lower = higher priority, default 5) */
      priority?: number;
      /** Custom timeout for this request */
      timeoutMs?: number;
    },
  ): Promise<T> {
    // If we're under global backoff, wait
    const now = Date.now();
    if (this.globalBackoffUntil > now) {
      const waitTime = this.globalBackoffUntil - now;
      this.logger.warn(`Global backoff active, waiting ${waitTime}ms`);
      await this.sleep(waitTime);
    }

    return new Promise<T>((resolve, reject) => {
      const request: QueuedRequest<T> = {
        userId,
        fn,
        resolve: resolve,
        reject,
        enqueuedAt: Date.now(),
        retryCount: 0,
      };

      this.enqueue(request);
      this.processQueue();
    });
  }

  /**
   * Execute with automatic retry on rate limit errors.
   */
  async executeWithRetry<T>(
    userId: string,
    fn: () => Promise<T>,
    context?: string,
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.execute(userId, fn);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (this.isRateLimitError(lastError)) {
          const backoffMs =
            this.backoffDelays[
              Math.min(attempt, this.backoffDelays.length - 1)
            ];
          this.logger.warn(
            `OpenAI rate limit hit (attempt ${attempt + 1}/${this.maxRetries + 1}), ` +
              `backing off ${backoffMs}ms. Context: ${context || 'unknown'}`,
          );

          // Set global backoff to help all users
          this.globalBackoffUntil = Math.max(
            this.globalBackoffUntil,
            Date.now() + backoffMs,
          );

          await this.sleep(backoffMs);
          continue;
        }

        // Non-rate-limit errors should not retry
        throw lastError;
      }
    }

    throw lastError || new Error('OpenAI request failed after max retries');
  }

  /**
   * Get current queue statistics.
   */
  getStats(): {
    activeRequests: number;
    maxConcurrent: number;
    queuedRequestsByUser: Record<string, number>;
    totalQueued: number;
    globalBackoffActive: boolean;
    globalBackoffRemainingMs: number;
  } {
    const queuedRequestsByUser: Record<string, number> = {};
    let totalQueued = 0;

    for (const [userId, queue] of this.userQueues.entries()) {
      queuedRequestsByUser[userId] = queue.requests.length;
      totalQueued += queue.requests.length;
    }

    const now = Date.now();
    return {
      activeRequests: this.activeRequests,
      maxConcurrent: this.maxConcurrent,
      queuedRequestsByUser,
      totalQueued,
      globalBackoffActive: this.globalBackoffUntil > now,
      globalBackoffRemainingMs: Math.max(0, this.globalBackoffUntil - now),
    };
  }

  private enqueue<T>(request: QueuedRequest<T>): void {
    let userQueue = this.userQueues.get(request.userId);
    if (!userQueue) {
      userQueue = { requests: [], lastProcessedAt: 0 };
      this.userQueues.set(request.userId, userQueue);
    }
    userQueue.requests.push(request);
  }

  private async processQueue(): Promise<void> {
    // Prevent concurrent processing
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.activeRequests < this.maxConcurrent) {
        // Check global backoff
        const now = Date.now();
        if (this.globalBackoffUntil > now) {
          break;
        }

        const request = this.getNextRequest();
        if (!request) break;

        // Check if request has timed out in queue
        const waitTime = now - request.enqueuedAt;
        if (waitTime > this.maxQueueTimeMs) {
          request.reject(
            new Error(
              `OpenAI request timed out in queue after ${Math.round(waitTime / 1000)}s`,
            ),
          );
          continue;
        }

        this.activeRequests++;
        this.processRequest(request);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Fair round-robin selection of next request across all users.
   */
  private getNextRequest(): QueuedRequest<unknown> | null {
    const userIds = Array.from(this.userQueues.keys());
    if (userIds.length === 0) return null;

    // Try each user starting from round-robin index
    for (let i = 0; i < userIds.length; i++) {
      const idx = (this.roundRobinIndex + i) % userIds.length;
      const userId = userIds[idx];
      const userQueue = this.userQueues.get(userId);

      if (userQueue && userQueue.requests.length > 0) {
        const request = userQueue.requests.shift()!;
        userQueue.lastProcessedAt = Date.now();

        // Update round-robin index to next user
        this.roundRobinIndex = (idx + 1) % userIds.length;

        // Clean up empty queues
        if (userQueue.requests.length === 0) {
          this.userQueues.delete(userId);
        }

        return request;
      }
    }

    return null;
  }

  private async processRequest(request: QueuedRequest<unknown>): Promise<void> {
    const startTime = Date.now();

    try {
      const result = await request.fn();
      request.resolve(result);

      if (process.env.OPENAI_RATE_LIMITER_DEBUG === 'true') {
        this.logger.debug(
          `OpenAI request completed: userId=${request.userId} elapsed=${Date.now() - startTime}ms`,
        );
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      if (this.isRateLimitError(err) && request.retryCount < this.maxRetries) {
        // Re-queue with backoff
        request.retryCount++;
        const backoffMs =
          this.backoffDelays[
            Math.min(request.retryCount - 1, this.backoffDelays.length - 1)
          ];

        this.logger.warn(
          `OpenAI rate limit, re-queuing (retry ${request.retryCount}/${this.maxRetries}) ` +
            `with ${backoffMs}ms delay. userId=${request.userId}`,
        );

        // Set global backoff
        this.globalBackoffUntil = Math.max(
          this.globalBackoffUntil,
          Date.now() + backoffMs,
        );

        // Re-enqueue after backoff
        setTimeout(() => {
          this.enqueue(request);
          this.processQueue();
        }, backoffMs);
      } else {
        request.reject(err);
      }
    } finally {
      this.activeRequests--;
      // Trigger next request processing
      setImmediate(() => this.processQueue());
    }
  }

  private isRateLimitError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes('429') ||
      message.includes('rate limit') ||
      message.includes('too many requests') ||
      message.includes('rate_limit_exceeded')
    );
  }

  private cleanupStaleRequests(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [userId, userQueue] of this.userQueues.entries()) {
      const originalLength = userQueue.requests.length;
      userQueue.requests = userQueue.requests.filter((req) => {
        const age = now - req.enqueuedAt;
        if (age > this.maxQueueTimeMs) {
          req.reject(
            new Error(
              `OpenAI request expired in queue after ${Math.round(age / 1000)}s`,
            ),
          );
          return false;
        }
        return true;
      });
      cleaned += originalLength - userQueue.requests.length;

      if (userQueue.requests.length === 0) {
        this.userQueues.delete(userId);
      }
    }

    if (cleaned > 0) {
      this.logger.warn(
        `Cleaned up ${cleaned} stale OpenAI requests from queue`,
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
