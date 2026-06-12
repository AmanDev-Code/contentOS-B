import {
  Injectable,
  Logger,
  OnModuleInit,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { AppSettingsService } from './app-settings.service';

/**
 * Central registry for the AI gateway (Bifrost) models used across the app.
 *
 * Models are grouped by **category** — `text`, `image`, `video` — mirroring the
 * generation surfaces in the product. Each category keeps an *ordered* list of
 * `provider/model` strings; the first enabled entry (or the explicit "active"
 * one) is the primary, and the rest form an automatic fallback chain so a
 * single model outage never fails a request ("never fail": try the next model).
 *
 * The gateway URL + key stay env-driven (one Bifrost virtual key routes Bedrock /
 * OpenAI / Gemini / Vertex by the `provider/model` prefix). Admins manage the
 * model lists + ordering + active selection per category at runtime.
 *
 * Persisted in `app_settings` under AI_MODELS_KEY. Kept in an in-memory cache so
 * consuming services can resolve a model chain synchronously with no DB hit on
 * the hot path; the cache refreshes lazily (non-blocking) and on every write.
 * Legacy single-list registries (pre-category) are migrated to `text` on read.
 */

export const AI_MODELS_KEY = 'ai_models';
const REFRESH_MS = 30_000;

export type AiModelCategory =
  | 'text'
  | 'text_formatter'
  | 'vision'
  | 'image'
  | 'image_context'
  | 'image_enhance'
  | 'video';
export const AI_MODEL_CATEGORIES: AiModelCategory[] = [
  'text',
  'text_formatter',
  'vision',
  'image',
  'image_context',
  'image_enhance',
  'video',
];

/** Provider prefixes Bifrost recognizes in `provider/model` (see core/schemas/bifrost.go). */
const KNOWN_PROVIDERS = [
  'openai',
  'anthropic',
  'bedrock',
  'vertex',
  'gemini',
  'azure',
  'cohere',
  'mistral',
  'groq',
  'openrouter',
  'ollama',
  'perplexity',
  'xai',
  'cerebras',
  'deepseek',
];

export interface AiModelEntry {
  id: string;
  label: string;
  /** Bifrost model string, e.g. "bedrock/moonshotai.kimi-k2.5", "openai/gpt-4o". */
  model: string;
  provider: string;
  category: AiModelCategory;
  /** Disabled models are skipped in the fallback chain (kept for quick re-enable). */
  enabled: boolean;
  addedAt: string;
}

type ActiveMap = Record<AiModelCategory, string | null>;

interface AiModelsRegistry {
  models: AiModelEntry[];
  active: ActiveMap;
}

export function providerOfModel(model: string): string {
  const i = model.indexOf('/');
  if (i > 0) {
    const p = model.slice(0, i).toLowerCase();
    if (KNOWN_PROVIDERS.includes(p)) return p;
  }
  return 'custom';
}

function emptyActive(): ActiveMap {
  return {
    text: null,
    text_formatter: null,
    vision: null,
    image: null,
    image_context: null,
    image_enhance: null,
    video: null,
  };
}

function isCategory(value: unknown): value is AiModelCategory {
  return (
    value === 'text' ||
    value === 'text_formatter' ||
    value === 'vision' ||
    value === 'image' ||
    value === 'image_context' ||
    value === 'image_enhance' ||
    value === 'video'
  );
}

@Injectable()
export class AiModelRegistryService implements OnModuleInit {
  private readonly logger = new Logger(AiModelRegistryService.name);
  private cache: AiModelsRegistry = { models: [], active: emptyActive() };
  private cachedAt = 0;
  private refreshing = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly appSettings: AppSettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh().catch((e) =>
      this.logger.warn(`AI model registry init failed: ${(e as Error).message}`),
    );
    // Seed the text category from env on first boot so admins see a starting model.
    if (this.cache.models.length === 0) {
      const envModel = this.envModel();
      if (envModel) {
        const entry: AiModelEntry = {
          id: randomUUID(),
          label: 'Default (from env)',
          model: envModel,
          provider: providerOfModel(envModel),
          category: 'text',
          enabled: true,
          addedAt: new Date().toISOString(),
        };
        this.cache = {
          models: [entry],
          active: { ...emptyActive(), text: entry.id },
        };
        await this.persist().catch(() => undefined);
      }
    }
  }

  /** Env/config fallback model string (text). */
  private envModel(): string {
    return (
      this.configService.get<string>('aiRefinement.model') ||
      process.env.AI_REFINEMENT_MODEL ||
      ''
    );
  }

  /** Load + migrate the stored registry (legacy `{ activeId, models[] }` → categories). */
  private async refresh(): Promise<void> {
    const stored = await this.appSettings.get<
      Partial<AiModelsRegistry> & {
        activeId?: string | null;
        models?: Array<Partial<AiModelEntry>>;
      }
    >(AI_MODELS_KEY);
    if (stored && Array.isArray(stored.models)) {
      const models: AiModelEntry[] = stored.models
        .filter((m) => m && typeof m.model === 'string' && m.model.trim())
        .map((m) => ({
          id: m.id || randomUUID(),
          label: (m.label || m.model || '').toString().slice(0, 100),
          model: (m.model as string).trim(),
          provider: m.provider || providerOfModel(m.model as string),
          category: isCategory(m.category) ? m.category : 'text',
          enabled: m.enabled !== false,
          addedAt: m.addedAt || new Date().toISOString(),
        }));
      const storedActive = (stored.active || {}) as Partial<ActiveMap>;
      const active: ActiveMap = {
        // legacy `activeId` becomes the text active.
        text: storedActive.text ?? stored.activeId ?? null,
        text_formatter: storedActive.text_formatter ?? null,
        vision: storedActive.vision ?? null,
        image: storedActive.image ?? null,
        image_context: storedActive.image_context ?? null,
        image_enhance: storedActive.image_enhance ?? null,
        video: storedActive.video ?? null,
      };
      this.cache = { models, active: this.normalizeActive(models, active) };
    }
    this.cachedAt = Date.now();
  }

  /** Drop active ids that no longer exist / are disabled / changed category. */
  private normalizeActive(models: AiModelEntry[], active: ActiveMap): ActiveMap {
    const next = { ...active };
    for (const cat of AI_MODEL_CATEGORIES) {
      const id = next[cat];
      const ok =
        id && models.some((m) => m.id === id && m.category === cat && m.enabled);
      if (!ok) {
        const firstEnabled = models.find(
          (m) => m.category === cat && m.enabled,
        );
        next[cat] = firstEnabled?.id ?? null;
      }
    }
    return next;
  }

  private maybeRefresh(): void {
    if (this.refreshing || Date.now() - this.cachedAt < REFRESH_MS) return;
    this.refreshing = true;
    this.refresh()
      .catch(() => undefined)
      .finally(() => {
        this.refreshing = false;
      });
  }

  private async persist(): Promise<void> {
    this.cache.active = this.normalizeActive(this.cache.models, this.cache.active);
    await this.appSettings.set(AI_MODELS_KEY, this.cache);
    this.cachedAt = Date.now();
  }

  // --- Hot-path resolution (synchronous) -----------------------------------

  /**
   * Ordered fallback chain of `provider/model` strings for a category: the
   * primary (active, else first enabled) first, then the remaining enabled
   * models in priority order. Empty when nothing is configured. Triggers a
   * non-blocking refresh when the cache is stale.
   */
  getModelChainSync(category: AiModelCategory): string[] {
    this.maybeRefresh();
    const inCat = this.cache.models.filter(
      (m) => m.category === category && m.enabled,
    );
    if (inCat.length === 0) return [];
    const activeId = this.cache.active[category];
    const primary = inCat.find((m) => m.id === activeId);
    const ordered = primary
      ? [primary, ...inCat.filter((m) => m.id !== primary.id)]
      : inCat;
    return ordered.map((m) => m.model);
  }

  /**
   * Vision/image-analysis chain. Uses the dedicated `vision` category when an
   * admin has configured it; otherwise falls back to the `text` chain so brand
   * image analysis keeps working out of the box (text models like Claude/GPT/
   * Gemini are vision-capable). Empty only when neither category has a model.
   */
  getVisionChainSync(): string[] {
    const vision = this.getModelChainSync('vision');
    if (vision.length > 0) return vision;
    return this.getModelChainSync('text');
  }

  /**
   * Primary model string for a category. Falls back to the env model for text
   * so existing text features keep working before any admin configuration.
   */
  getActiveModelSync(category: AiModelCategory = 'text'): string {
    const chain = this.getModelChainSync(category);
    if (chain.length > 0) return chain[0];
    return category === 'text' ? this.envModel() : '';
  }

  /** True when at least one enabled model exists for the category. */
  hasModelsSync(category: AiModelCategory): boolean {
    return this.getModelChainSync(category).length > 0;
  }

  /** Gateway transport config (env-driven). Model handled separately. */
  getGatewayConfig() {
    const baseUrl =
      this.configService.get<string>('aiRefinement.baseUrl') ||
      process.env.AI_REFINEMENT_BASE_URL ||
      'https://openrouter.ai/api/v1';
    const apiKey =
      this.configService.get<string>('aiRefinement.apiKey') ||
      process.env.AI_REFINEMENT_API_KEY ||
      process.env.OPENROUTER_API_KEY ||
      process.env.OPENAI_API_KEY ||
      '';
    const timeoutMs =
      Number(
        this.configService.get<number>('aiRefinement.timeoutMs') ||
          process.env.AI_REFINEMENT_TIMEOUT_MS ||
          '30000',
      ) || 30000;
    return { baseUrl, apiKey, timeoutMs };
  }

  // --- Admin operations -----------------------------------------------------

  async list(): Promise<{
    active: ActiveMap;
    models: AiModelEntry[];
    gateway: { baseUrl: string; hasApiKey: boolean; timeoutMs: number };
  }> {
    await this.refresh();
    const g = this.getGatewayConfig();
    return {
      active: this.cache.active,
      models: this.cache.models,
      gateway: {
        baseUrl: g.baseUrl,
        hasApiKey: !!g.apiKey,
        timeoutMs: g.timeoutMs,
      },
    };
  }

  async addModel(input: {
    label?: string;
    model: string;
    provider?: string;
    category?: AiModelCategory;
    makeActive?: boolean;
  }): Promise<AiModelEntry> {
    const model = (input.model || '').trim();
    if (!model) throw new BadRequestException('model is required');
    if (model.length > 200)
      throw new BadRequestException('model string too long');
    const category: AiModelCategory = isCategory(input.category)
      ? input.category
      : 'text';
    await this.refresh();
    if (
      this.cache.models.some(
        (m) =>
          m.category === category &&
          m.model.toLowerCase() === model.toLowerCase(),
      )
    ) {
      throw new BadRequestException(
        `That model is already in the ${category} list`,
      );
    }
    const entry: AiModelEntry = {
      id: randomUUID(),
      label: (input.label || model).trim().slice(0, 100),
      model,
      provider: (input.provider || providerOfModel(model)).slice(0, 40),
      category,
      enabled: true,
      addedAt: new Date().toISOString(),
    };
    this.cache.models.push(entry);
    // Make active when explicitly requested or when the category has no primary yet.
    if (input.makeActive || !this.cache.active[category]) {
      this.cache.active[category] = entry.id;
    }
    await this.persist();
    return entry;
  }

  async removeModel(id: string): Promise<void> {
    await this.refresh();
    const before = this.cache.models.length;
    this.cache.models = this.cache.models.filter((m) => m.id !== id);
    if (this.cache.models.length === before) {
      throw new NotFoundException('Model not found');
    }
    await this.persist();
  }

  async setActive(category: AiModelCategory, id: string): Promise<void> {
    if (!isCategory(category))
      throw new BadRequestException('Invalid category');
    await this.refresh();
    const entry = this.cache.models.find((m) => m.id === id);
    if (!entry) throw new NotFoundException('Model not found');
    if (entry.category !== category) {
      throw new BadRequestException(
        `Model is in the ${entry.category} category, not ${category}`,
      );
    }
    // Activating a model implicitly enables it.
    entry.enabled = true;
    this.cache.active[category] = id;
    await this.persist();
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.refresh();
    const entry = this.cache.models.find((m) => m.id === id);
    if (!entry) throw new NotFoundException('Model not found');
    entry.enabled = enabled;
    await this.persist();
  }

  /** Reorder priority within a category (orderedIds = new front-to-back order). */
  async reorder(category: AiModelCategory, orderedIds: string[]): Promise<void> {
    if (!isCategory(category))
      throw new BadRequestException('Invalid category');
    await this.refresh();
    const inCat = this.cache.models.filter((m) => m.category === category);
    const rank = new Map(orderedIds.map((id, i) => [id, i]));
    inCat.sort(
      (a, b) =>
        (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
    // Rebuild the global list keeping other categories in place.
    const others = this.cache.models.filter((m) => m.category !== category);
    this.cache.models = [...others, ...inCat];
    await this.persist();
  }

  // --- Testing --------------------------------------------------------------

  /**
   * Validate a model end-to-end against the gateway, using the right endpoint
   * for its category: text → /chat/completions, image → /images/generations,
   * video → gateway reachability ping (generation not wired yet).
   */
  async testModel(
    model: string,
    category: AiModelCategory = 'text',
  ): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    const m = (model || '').trim();
    if (!m) throw new BadRequestException('model is required');
    const cfg = this.getGatewayConfig();
    if (!cfg.apiKey) {
      return { ok: false, latencyMs: 0, message: 'Gateway API key not set' };
    }
    const base = cfg.baseUrl.replace(/\/$/, '');
    if (category === 'image') {
      const isNewStyle = /gpt-image|chatgpt-image/i.test(m);
      const body: Record<string, unknown> = {
        model: m,
        prompt: 'A small flat solid blue circle centered on a white background',
        n: 1,
        size: '1024x1024',
      };
      if (isNewStyle) {
        body.output_format = 'png';
      } else {
        body.response_format = 'b64_json';
      }
      const result = await this.pingEndpoint(
        `${base}/images/generations`,
        cfg.apiKey,
        body,
        90_000,
        (json) =>
          Array.isArray(json?.data) &&
          json.data.length > 0 &&
          (json.data[0].b64_json || json.data[0].url)
            ? 'Image model generated a test image'
            : 'Image model responded (no image payload)',
      );
      // Retry with the opposite param if the provider rejected our first choice.
      if (!result.ok && /response_format|output_format|unknown.parameter/i.test(result.message)) {
        const retryBody: Record<string, unknown> = {
          model: m,
          prompt: 'A small flat solid blue circle centered on a white background',
          n: 1,
          size: '1024x1024',
        };
        if (isNewStyle) {
          retryBody.response_format = 'b64_json';
        } else {
          retryBody.output_format = 'png';
        }
        return this.pingEndpoint(
          `${base}/images/generations`,
          cfg.apiKey,
          retryBody,
          90_000,
          (json) =>
            Array.isArray(json?.data) &&
            json.data.length > 0 &&
            (json.data[0].b64_json || json.data[0].url)
              ? 'Image model generated a test image'
              : 'Image model responded (no image payload)',
        );
      }
      return result;
    }
    if (category === 'image_enhance') {
      // Upscaler/enhancer models require an input image — we can't send a real
      // upscale request without one. Confirm the gateway is reachable instead.
      const started = Date.now();
      try {
        const res = await this.rawGet(`${base}/models`, cfg.apiKey, 15_000);
        return {
          ok: res.ok,
          latencyMs: Date.now() - started,
          message: res.ok
            ? 'Gateway reachable — model saved for image upscaling/enhancement'
            : `Gateway ${res.status}`,
        };
      } catch (e) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          message: (e as Error).message,
        };
      }
    }
    if (category === 'video') {
      const started = Date.now();
      try {
        const res = await this.rawGet(`${base}/models`, cfg.apiKey, 15_000);
        return {
          ok: res.ok,
          latencyMs: Date.now() - started,
          message: res.ok
            ? 'Gateway reachable — video generation is not wired yet; model saved for future use'
            : `Gateway ${res.status}`,
        };
      } catch (e) {
        return {
          ok: false,
          latencyMs: Date.now() - started,
          message: (e as Error).message,
        };
      }
    }
    if (category === 'vision') {
      // Real multimodal probe: send a self-contained 64x64 solid-blue PNG
      // (data URI — no external fetch) and confirm the model reads the color.
      // 1x1 pixels are rejected by Bedrock ("Could not process image"), so use 64x64.
      const BLUE_PNG_64 =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAhklEQVR4nO3PAQkAAAzDsPg3vcsYg0MEtMg49YL8gGnqBfkB09QL8gOmqRfkB0xTL8gPmKZekB8wTb0gP2CaekF+wDT1gvyAaeoF+QHT1AvyA6apF+QHTFMvyA+Ypl6QHzBNvSA/YJp6QX7ANPWC/IBp6gX5AdPUC/IDpqkX5AdMUy/IDxh2x/zw4oy2iHkAAAAASUVORK5CYII=';
      return this.pingEndpoint(
        `${base}/chat/completions`,
        cfg.apiKey,
        {
          model: m,
          max_tokens: 16,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'What color is this image? One word.' },
                { type: 'image_url', image_url: { url: BLUE_PNG_64 } },
              ],
            },
          ],
        },
        Math.min(cfg.timeoutMs, 30000),
        (json) => {
          const txt = json?.choices?.[0]?.message?.content;
          return typeof txt === 'string' && txt.trim()
            ? `Vision OK — model saw the image and replied: "${String(txt).slice(0, 40)}"`
            : 'Model responded (vision-capable)';
        },
      );
    }
    // text
    return this.pingEndpoint(
      `${base}/chat/completions`,
      cfg.apiKey,
      { model: m, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
      Math.min(cfg.timeoutMs, 20000),
      () => 'Model responded successfully',
    );
  }

  private async rawGet(url: string, apiKey: string, timeoutMs: number) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async pingEndpoint(
    endpoint: string,
    apiKey: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    okMessage: (json: any) => string,
  ): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const latencyMs = Date.now() - started;
      if (res.ok) {
        let json: any = null;
        try {
          json = await res.json();
        } catch {
          /* non-JSON success is still a success */
        }
        return { ok: true, latencyMs, message: okMessage(json) };
      }
      const text = await res.text();
      return {
        ok: false,
        latencyMs,
        message: `Gateway ${res.status}: ${text.slice(0, 240)}`,
      };
    } catch (e) {
      const err = e as Error;
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: err.name === 'AbortError' ? 'Request timed out' : err.message,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
