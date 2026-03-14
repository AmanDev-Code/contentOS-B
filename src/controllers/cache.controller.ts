import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiBody } from '@nestjs/swagger';
import { CacheService } from '../services/cache.service';

@ApiTags('cache')
@Controller('cache')
export class CacheController {
  private readonly logger = new Logger(CacheController.name);

  constructor(private cacheService: CacheService) {}

  @Get(':key')
  @ApiOperation({ summary: 'Get cached data by key' })
  @ApiParam({ name: 'key', description: 'Cache key' })
  getCachedData(@Param('key') key: string) {
    const data = this.cacheService.get(key);

    if (data === null) {
      return { success: false, message: 'Cache miss' };
    }

    return { success: true, data };
  }

  @Post('set')
  @ApiOperation({ summary: 'Set data in cache' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        data: { type: 'object' },
        ttl: { type: 'number', default: 3600 },
      },
      required: ['key', 'data'],
    },
  })
  @HttpCode(HttpStatus.OK)
  setCachedData(@Body() body: { key: string; data: any; ttl?: number }) {
    const { key, data, ttl = 3600 } = body;

    this.cacheService.set(key, data, ttl);

    return { success: true, message: 'Data cached successfully' };
  }

  @Delete(':key')
  @ApiOperation({ summary: 'Delete cached data by key' })
  @ApiParam({ name: 'key', description: 'Cache key' })
  @HttpCode(HttpStatus.OK)
  deleteCachedData(@Param('key') key: string) {
    const deleted = this.cacheService.delete(key);

    return {
      success: deleted,
      message: deleted ? 'Cache entry deleted' : 'Cache entry not found',
    };
  }

  @Delete('invalidate/user/:userId')
  @ApiOperation({ summary: 'Invalidate all cache for a user' })
  @ApiParam({ name: 'userId', description: 'User ID' })
  @HttpCode(HttpStatus.OK)
  invalidateUserCache(@Param('userId') userId: string) {
    const deletedCount = this.cacheService.invalidateUser(userId);

    return {
      success: true,
      message: `Invalidated ${deletedCount} cache entries for user`,
      deletedCount,
    };
  }

  @Get('stats/info')
  @ApiOperation({ summary: 'Get cache statistics' })
  getCacheStats() {
    return this.cacheService.getStats();
  }

  @Delete('clear/all')
  @ApiOperation({ summary: 'Clear all cache (for testing)' })
  @HttpCode(HttpStatus.OK)
  clearAllCache() {
    this.cacheService.clear();
    return { success: true, message: 'All cache cleared' };
  }
}
