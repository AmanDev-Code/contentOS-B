import { Injectable, NestMiddleware, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { CacheService } from '../services/cache.service';

interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  max: number; // Maximum number of requests per window
  message?: string;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
}

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    sub: string;
  };
}

@Injectable()
export class RateLimitMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RateLimitMiddleware.name);

  // Rate limit configurations for different endpoints
  private readonly rateLimits: Record<string, RateLimitConfig> = {
    '/generation/topics': {
      windowMs: 60 * 60 * 1000, // 1 hour
      max: 50, // 50 requests per hour
      message: 'Too many topic generation requests. Please try again later.',
    },
    '/generation/content': {
      windowMs: 60 * 60 * 1000, // 1 hour
      max: 30, // 30 requests per hour
      message: 'Too many content generation requests. Please try again later.',
    },
    '/media/generate-image': {
      windowMs: 60 * 60 * 1000, // 1 hour
      max: 100, // 100 requests per hour
      message: 'Too many image generation requests. Please try again later.',
    },
    '/media/generate-carousel': {
      windowMs: 60 * 60 * 1000, // 1 hour
      max: 20, // 20 requests per hour
      message: 'Too many carousel generation requests. Please try again later.',
    },
    '/posts/publish': {
      windowMs: 60 * 60 * 1000, // 1 hour
      max: 50, // 50 posts per hour
      message: 'Too many publishing requests. Please try again later.',
    },
    '/posts/schedule': {
      windowMs: 60 * 60 * 1000, // 1 hour
      max: 100, // 100 scheduled posts per hour
      message: 'Too many scheduling requests. Please try again later.',
    },
    '/linkedin/publish': {
      windowMs: 60 * 60 * 1000, // 1 hour
      max: 25, // 25 LinkedIn posts per hour
      message: 'Too many LinkedIn publishing requests. Please try again later.',
    },
  };

  constructor(private readonly cacheService: CacheService) {}

  async use(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      // Skip rate limiting for non-authenticated requests or non-rate-limited endpoints
      if (!req.user?.id) {
        return next();
      }

      const userId = req.user.id;
      const endpoint = this.getEndpointKey(req.path, req.method);
      const rateLimitConfig = this.rateLimits[endpoint];

      if (!rateLimitConfig) {
        return next();
      }

      // Check rate limit
      const isAllowed = await this.checkRateLimit(userId, endpoint, rateLimitConfig);

      if (!isAllowed) {
        this.logger.warn(`Rate limit exceeded for user ${userId} on endpoint ${endpoint}`);
        
        // Get current usage for headers
        const usage = await this.getCurrentUsage(userId, endpoint);
        
        res.set({
          'X-RateLimit-Limit': rateLimitConfig.max.toString(),
          'X-RateLimit-Remaining': Math.max(0, rateLimitConfig.max - usage.count).toString(),
          'X-RateLimit-Reset': usage.resetTime.toString(),
          'X-RateLimit-Window': rateLimitConfig.windowMs.toString(),
        });

        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: rateLimitConfig.message || 'Too many requests',
            error: 'Too Many Requests',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      // Add rate limit headers to successful requests
      const usage = await this.getCurrentUsage(userId, endpoint);
      res.set({
        'X-RateLimit-Limit': rateLimitConfig.max.toString(),
        'X-RateLimit-Remaining': Math.max(0, rateLimitConfig.max - usage.count).toString(),
        'X-RateLimit-Reset': usage.resetTime.toString(),
        'X-RateLimit-Window': rateLimitConfig.windowMs.toString(),
      });

      next();
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      
      this.logger.error('Rate limiting error:', error.message);
      next(); // Continue on rate limiting errors to avoid blocking legitimate requests
    }
  }

  private getEndpointKey(path: string, method: string): string {
    // Normalize path to match rate limit configurations
    const normalizedPath = path.replace(/\/+$/, ''); // Remove trailing slashes
    
    // Check for exact matches first
    if (this.rateLimits[normalizedPath]) {
      return normalizedPath;
    }

    // Check for pattern matches
    for (const endpoint of Object.keys(this.rateLimits)) {
      if (normalizedPath.startsWith(endpoint)) {
        return endpoint;
      }
    }

    return normalizedPath;
  }

  private async checkRateLimit(
    userId: string,
    endpoint: string,
    config: RateLimitConfig,
  ): Promise<boolean> {
    const key = `rate_limit:${userId}:${endpoint}`;
    const now = Date.now();
    const windowStart = now - config.windowMs;

    try {
      // Get current window data
      const windowData = await this.cacheService.get(key);
      
      if (!windowData) {
        // First request in this window
        await this.cacheService.set(
          key,
          JSON.stringify({
            count: 1,
            windowStart: now,
            requests: [now],
          }),
          Math.ceil(config.windowMs / 1000), // TTL in seconds
        );
        return true;
      }

      const data = JSON.parse(windowData);
      
      // Clean old requests outside the current window
      const validRequests = data.requests.filter((timestamp: number) => timestamp > windowStart);
      
      if (validRequests.length >= config.max) {
        return false;
      }

      // Add current request
      validRequests.push(now);
      
      // Update cache
      await this.cacheService.set(
        key,
        JSON.stringify({
          count: validRequests.length,
          windowStart: Math.min(data.windowStart, windowStart),
          requests: validRequests,
        }),
        Math.ceil(config.windowMs / 1000),
      );

      return true;
    } catch (error) {
      this.logger.error(`Rate limit check failed: ${error.message}`);
      return true; // Allow request on cache errors
    }
  }

  private async getCurrentUsage(userId: string, endpoint: string): Promise<{
    count: number;
    resetTime: number;
  }> {
    const key = `rate_limit:${userId}:${endpoint}`;
    const config = this.rateLimits[endpoint];
    
    try {
      const windowData = await this.cacheService.get(key);
      
      if (!windowData) {
        return {
          count: 0,
          resetTime: Date.now() + config.windowMs,
        };
      }

      const data = JSON.parse(windowData);
      const now = Date.now();
      const windowStart = now - config.windowMs;
      
      // Count valid requests in current window
      const validRequests = data.requests.filter((timestamp: number) => timestamp > windowStart);
      
      return {
        count: validRequests.length,
        resetTime: Math.min(...validRequests) + config.windowMs,
      };
    } catch (error) {
      this.logger.error(`Failed to get current usage: ${error.message}`);
      return {
        count: 0,
        resetTime: Date.now() + config.windowMs,
      };
    }
  }

  // Method to get rate limit status for a user (useful for frontend)
  async getRateLimitStatus(userId: string, endpoint: string): Promise<{
    limit: number;
    remaining: number;
    resetTime: number;
    windowMs: number;
  }> {
    const config = this.rateLimits[endpoint];
    
    if (!config) {
      return {
        limit: 0,
        remaining: 0,
        resetTime: 0,
        windowMs: 0,
      };
    }

    const usage = await this.getCurrentUsage(userId, endpoint);
    
    return {
      limit: config.max,
      remaining: Math.max(0, config.max - usage.count),
      resetTime: usage.resetTime,
      windowMs: config.windowMs,
    };
  }
}