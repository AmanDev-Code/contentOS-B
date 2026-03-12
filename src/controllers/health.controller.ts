import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SupabaseService } from '../services/supabase.service';
import { N8nService } from '../services/n8n.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private supabaseService: SupabaseService,
    private n8nService: N8nService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Health check endpoint' })
  async healthCheck() {
    const checks = {
      api: 'healthy',
      database: 'unknown',
      n8n: 'unknown',
      timestamp: new Date().toISOString(),
    };

    try {
      const { data, error } = await this.supabaseService
        .getServiceClient()
        .from('profiles')
        .select('id')
        .limit(1);
      checks.database = error ? 'unhealthy' : 'healthy';
    } catch (error) {
      checks.database = 'unhealthy';
    }

    try {
      const n8nHealthy = await this.n8nService.healthCheck();
      checks.n8n = n8nHealthy ? 'healthy' : 'unhealthy';
    } catch (error) {
      checks.n8n = 'unhealthy';
    }

    return checks;
  }

  @Get('ping')
  @ApiOperation({ summary: 'Simple ping endpoint' })
  ping() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
