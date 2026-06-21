import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../guards/auth.guard';
import { AdminGuard } from '../guards/admin.guard';
import {
  AiModelRegistryService,
  AiModelCategory,
} from '../services/ai-model-registry.service';
import { AiGatewayService } from '../services/ai-gateway.service';
import {
  WebResearchService,
  WebResearchConfig,
} from '../services/web-research.service';

/**
 * Admin control for the AI gateway model registry. The gateway URL + key are
 * env-driven (single Bifrost virtual key); admins manage which `provider/model`
 * strings are available per category (text / image / video), their priority
 * order (= fallback chain), and which one is primary ("active") for each.
 */
@ApiTags('admin-ai-models')
@Controller('admin/ai-models')
@ApiBearerAuth()
@UseGuards(AuthGuard, AdminGuard)
export class AdminAiModelsController {
  constructor(
    private readonly registry: AiModelRegistryService,
    private readonly gateway: AiGatewayService,
    private readonly webResearch: WebResearchService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List AI models by category, active selection, and gateway info',
  })
  list() {
    return this.registry.list();
  }

  @Get('catalog')
  @ApiOperation({
    summary:
      'List models the Bifrost gateway can serve (so admins can browse + add)',
  })
  async catalog(@Query('refresh') refresh?: string) {
    try {
      const models = await this.gateway.fetchCatalog(refresh === '1');
      return { ok: true, models };
    } catch (e) {
      return { ok: false, models: [], message: (e as Error).message };
    }
  }

  @Post()
  @ApiOperation({
    summary: 'Add a model (provider/model string) to a category',
  })
  async add(
    @Body()
    body: {
      label?: string;
      model: string;
      provider?: string;
      category?: AiModelCategory;
      makeActive?: boolean;
    },
  ) {
    const entry = await this.registry.addModel(body);
    const state = await this.registry.list();
    return { entry, ...state };
  }

  @Put('active')
  @ApiOperation({ summary: 'Set the primary model for a category' })
  async setActive(@Body() body: { category: AiModelCategory; id: string }) {
    await this.registry.setActive(body?.category, body?.id);
    return this.registry.list();
  }

  @Put('enabled')
  @ApiOperation({ summary: 'Enable/disable a model in the fallback chain' })
  async setEnabled(@Body() body: { id: string; enabled: boolean }) {
    await this.registry.setEnabled(body?.id, Boolean(body?.enabled));
    return this.registry.list();
  }

  @Put('reorder')
  @ApiOperation({
    summary: 'Reorder model priority (fallback chain) within a category',
  })
  async reorder(
    @Body() body: { category: AiModelCategory; orderedIds: string[] },
  ) {
    await this.registry.reorder(body?.category, body?.orderedIds || []);
    return this.registry.list();
  }

  @Post('test')
  @ApiOperation({
    summary:
      'Ping the gateway with a model (routes by category) to verify it works',
  })
  test(@Body() body: { model: string; category?: AiModelCategory }) {
    return this.registry.testModel(body?.model, body?.category || 'text');
  }

  @Post('vision-analyze')
  @ApiOperation({
    summary:
      'Analyze an uploaded image with a vision model and return what the AI sees (try-it tester)',
  })
  async visionAnalyze(
    @Body()
    body: {
      model: string;
      imageDataUrl: string;
      prompt?: string;
    },
  ): Promise<{
    ok: boolean;
    model?: string;
    analysis?: string;
    latencyMs: number;
    message?: string;
  }> {
    const started = Date.now();
    const model = (body?.model || '').trim();
    const imageDataUrl = (body?.imageDataUrl || '').trim();
    if (!model) {
      return { ok: false, latencyMs: 0, message: 'model is required' };
    }
    if (
      !imageDataUrl ||
      !/^data:image\/[a-z0-9.+-]+;base64,/i.test(imageDataUrl)
    ) {
      return {
        ok: false,
        latencyMs: 0,
        message: 'A base64 image data URL is required',
      };
    }
    // Guard against oversized payloads (~10MB original ≈ ~13.5MB base64).
    if (imageDataUrl.length > 14_000_000) {
      return {
        ok: false,
        latencyMs: 0,
        message: 'Image too large (max ~10MB).',
      };
    }
    const prompt =
      (body?.prompt || '').trim() ||
      'Describe what you see in this image for a graphic designer who will recreate the visual style. Cover: the exact colors with hex codes, any shapes/icons/symbols and how they look, typography if present, the lighting and mood, and the overall composition. Be concrete and specific.';
    try {
      const { content, model: usedModel } =
        await this.gateway.chatCompletionRaw({
          models: [model],
          category: 'vision',
          maxTokens: 1024,
          temperature: 0.3,
          timeoutMs: 60_000,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: imageDataUrl } },
              ],
            },
          ],
        });
      return {
        ok: true,
        model: usedModel,
        analysis: content,
        latencyMs: Date.now() - started,
      };
    } catch (e) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: (e as Error).message,
      };
    }
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove a model from the registry' })
  async remove(@Param('id') id: string) {
    await this.registry.removeModel(id);
    return this.registry.list();
  }

  /* ───── Web Research (Tavily) ───── */

  @Get('web-research')
  @ApiOperation({ summary: 'Get web research (Tavily) config' })
  getWebResearch() {
    return this.webResearch.getConfig();
  }

  @Put('web-research')
  @ApiOperation({ summary: 'Update web research (Tavily) config' })
  async updateWebResearch(@Body() body: Partial<WebResearchConfig>) {
    await this.webResearch.updateConfig(body);
    return this.webResearch.getConfig();
  }

  @Post('web-research/test')
  @ApiOperation({ summary: 'Run a test Tavily search to verify the key works' })
  async testWebResearch(@Body() body: { query?: string }) {
    const query =
      body?.query?.trim() || 'latest trends in social media marketing';
    const result = await this.webResearch.search(query, {
      maxResults: 3,
      includeAnswer: true,
    });
    if (!result) {
      return {
        ok: false,
        message:
          'Search returned no results. Check API key and enabled status.',
      };
    }
    return {
      ok: true,
      query: result.query,
      answer: result.answer,
      sourceCount: result.sources.length,
      sources: result.sources.slice(0, 3).map((s) => ({
        title: s.title,
        url: s.url,
        snippet: s.snippet.slice(0, 200),
      })),
      responseTimeMs: result.responseTimeMs,
    };
  }
}
