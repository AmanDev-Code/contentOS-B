import { Injectable, Logger } from '@nestjs/common';
import {
  AiModelRegistryService,
  AiModelCategory,
  providerOfModel,
} from './ai-model-registry.service';

/**
 * Single entry point every in-app AI feature uses to talk to the Bifrost
 * gateway. It resolves the ordered model chain for a category from the registry
 * and tries each model until one succeeds ("never fail": text features use text
 * models, image features use image models, and a single model outage falls
 * through to the next configured model). Transport (URL + virtual key) is
 * env-driven via the registry's gateway config.
 *
 * - `chatCompletionRaw` — text/chat with json-mode + fallback chain.
 * - `generateImageB64`  — image generation with fallback chain (base64 out).
 * - `fetchCatalog`      — lists Bifrost-supported models (GET /v1/models) so the
 *                         admin UI can browse/add without the Bifrost docs.
 */

export class AiGatewayError extends Error {
  constructor(
    message: string,
    readonly attempts?: { model: string; error: string }[],
  ) {
    super(message);
    this.name = 'AiGatewayError';
  }
}

export type ChatMessageContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | {
          type: 'image_url';
          image_url: { url: string; detail?: 'low' | 'high' | 'auto' };
        }
    >;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: ChatMessageContent;
}

export interface CatalogModel {
  id: string;
  provider: string;
  category: AiModelCategory;
  /** Human label (canonical slug / name when Bifrost provides one). */
  label: string;
  inputModalities?: string[];
  outputModalities?: string[];
  contextLength?: number;
}

@Injectable()
export class AiGatewayService {
  private readonly logger = new Logger(AiGatewayService.name);
  private catalogCache: { at: number; models: CatalogModel[] } | null = null;
  private static readonly CATALOG_TTL_MS = 5 * 60_000;

  constructor(private readonly registry: AiModelRegistryService) {}

  private cfg() {
    return this.registry.getGatewayConfig();
  }

  private base(): string {
    return this.cfg().baseUrl.replace(/\/$/, '');
  }

  // --- Text / chat ----------------------------------------------------------

  /**
   * Run a chat completion against the text model chain (or an explicit model
   * list), returning the first successful completion's content. Throws
   * `AiGatewayError` only when every candidate fails.
   *
   * For `seo_generation` and `seo_analysis` categories, falls back to `text`
   * if no models are configured for the specific category.
   */
  async chatCompletionRaw(opts: {
    messages: ChatMessage[];
    temperature?: number;
    maxTokens?: number;
    jsonObject?: boolean;
    timeoutMs?: number;
    /** Override the resolved chain (e.g. caller-specific priority). */
    models?: string[];
    category?: AiModelCategory;
  }): Promise<{ content: string; model: string }> {
    const cfg = this.cfg();
    if (!cfg.apiKey) throw new AiGatewayError('AI gateway API key is not set');

    let chain: string[];
    if (opts.models && opts.models.length) {
      chain = opts.models;
    } else if (opts.category === 'vision') {
      chain = this.registry.getVisionChainSync();
    } else if (opts.category === 'seo_generation') {
      chain = this.registry.getModelChainSync('seo_generation');
      if (chain.length === 0) {
        chain = this.registry.getModelChainSync('text');
      }
    } else if (opts.category === 'seo_analysis') {
      chain = this.registry.getModelChainSync('seo_analysis');
      if (chain.length === 0) {
        chain = this.registry.getModelChainSync('text');
      }
    } else {
      chain = this.registry.getModelChainSync(opts.category || 'text');
    }

    if (!chain.length) {
      throw new AiGatewayError(
        `No ${opts.category || 'text'} models are configured in the AI model registry`,
      );
    }
    const endpoint = `${this.base()}/chat/completions`;
    const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs;
    const attempts: { model: string; error: string }[] = [];

    for (const model of chain) {
      try {
        const content = await this.attemptChat(
          endpoint,
          cfg.apiKey,
          model,
          opts,
          timeoutMs,
        );
        if (attempts.length > 0) {
          this.logger.warn(
            `Text gateway recovered on fallback model ${model} after ${attempts.length} failure(s)`,
          );
        }
        return { content, model };
      } catch (e) {
        const msg = (e as Error).message;
        attempts.push({ model, error: msg });
        this.logger.warn(`Text model ${model} failed: ${msg}`);
      }
    }
    throw new AiGatewayError(
      `All ${chain.length} text model(s) failed`,
      attempts,
    );
  }

  private async attemptChat(
    endpoint: string,
    apiKey: string,
    model: string,
    opts: {
      messages: ChatMessage[];
      temperature?: number;
      maxTokens?: number;
      jsonObject?: boolean;
    },
    timeoutMs: number,
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const buildBody = (useJsonMode: boolean) =>
      JSON.stringify({
        model,
        temperature: opts.temperature ?? 0.7,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...(useJsonMode ? { response_format: { type: 'json_object' } } : {}),
        messages: opts.messages,
      });
    try {
      let res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: buildBody(Boolean(opts.jsonObject)),
        signal: controller.signal,
      });

      // Retry once without json-mode if the model rejects response_format.
      if (!res.ok && opts.jsonObject) {
        const errText = await res.text();
        if (
          res.status === 400 &&
          /response_format|json_object|json mode|response format/i.test(errText)
        ) {
          res = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: buildBody(false),
            signal: controller.signal,
          });
        } else {
          throw new Error(`HTTP ${res.status}: ${errText.slice(0, 240)}`);
        }
      }

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 240)}`);
      }
      const json = await res.json();
      const content = String(json?.choices?.[0]?.message?.content || '').trim();
      if (!content) throw new Error('Empty completion');
      return content;
    } catch (e) {
      const err = e as Error;
      throw new Error(
        err.name === 'AbortError' ? 'Request timed out' : err.message,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // --- Image ----------------------------------------------------------------

  /** True when at least one image model is configured (drives gateway-vs-legacy routing). */
  hasImageModels(): boolean {
    return this.registry.hasModelsSync('image') && Boolean(this.cfg().apiKey);
  }

  /**
   * Generate an image via the image model chain, returning base64 PNG/JPEG
   * data (decoding a returned URL when the provider only gives one). Throws
   * `AiGatewayError` when every candidate fails.
   */
  async generateImageB64(opts: {
    prompt: string;
    size?: string;
    quality?: string;
    n?: number;
    timeoutMs?: number;
    models?: string[];
  }): Promise<{ b64: string; model: string }> {
    const cfg = this.cfg();
    if (!cfg.apiKey) throw new AiGatewayError('AI gateway API key is not set');
    const chain =
      opts.models && opts.models.length
        ? opts.models
        : this.registry.getModelChainSync('image');
    if (!chain.length) {
      throw new AiGatewayError(
        'No image models are configured in the registry',
      );
    }
    const endpoint = `${this.base()}/images/generations`;
    const timeoutMs = opts.timeoutMs ?? 90_000;
    const attempts: { model: string; error: string }[] = [];

    for (const model of chain) {
      try {
        const b64 = await this.attemptImage(
          endpoint,
          cfg.apiKey,
          model,
          opts,
          timeoutMs,
        );
        if (attempts.length > 0) {
          this.logger.warn(
            `Image gateway recovered on fallback model ${model} after ${attempts.length} failure(s)`,
          );
        }
        return { b64, model };
      } catch (e) {
        const msg = (e as Error).message;
        attempts.push({ model, error: msg });
        this.logger.warn(`Image model ${model} failed: ${msg}`);
      }
    }
    throw new AiGatewayError(
      `All ${chain.length} image model(s) failed`,
      attempts,
    );
  }

  /**
   * OpenAI's newer image models (gpt-image-*, chatgpt-image-*) reject the
   * legacy `response_format` param and use `output_format` instead. They
   * always return base64 data inline (in `data[].b64_json`).
   */
  private static isNewStyleOpenAIImage(model: string): boolean {
    const m = model.toLowerCase();
    return /gpt-image|chatgpt-image/.test(m);
  }

  private buildImageBody(
    model: string,
    opts: { prompt: string; size?: string; quality?: string; n?: number },
  ): Record<string, unknown> {
    const base: Record<string, unknown> = {
      model,
      prompt: opts.prompt,
      n: opts.n ?? 1,
      size: opts.size || '1024x1024',
      ...(opts.quality ? { quality: opts.quality } : {}),
    };
    if (AiGatewayService.isNewStyleOpenAIImage(model)) {
      base.output_format = 'png';
    } else {
      base.response_format = 'b64_json';
    }
    return base;
  }

  private async attemptImage(
    endpoint: string,
    apiKey: string,
    model: string,
    opts: { prompt: string; size?: string; quality?: string; n?: number },
    timeoutMs: number,
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
    try {
      let res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(this.buildImageBody(model, opts)),
        signal: controller.signal,
      });

      // Retry once swapping response_format ↔ output_format if the provider
      // rejects the param we chose (covers models Bifrost routes differently).
      if (!res.ok && res.status === 400) {
        const errText = await res.text();
        if (/response_format|output_format|unknown.parameter/i.test(errText)) {
          const retryBody = {
            model,
            prompt: opts.prompt,
            n: opts.n ?? 1,
            size: opts.size || '1024x1024',
            ...(opts.quality ? { quality: opts.quality } : {}),
            ...(AiGatewayService.isNewStyleOpenAIImage(model)
              ? { response_format: 'b64_json' }
              : { output_format: 'png' }),
          };
          res = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(retryBody),
            signal: controller.signal,
          });
          if (!res.ok) {
            const retryErr = await res.text();
            throw new Error(`HTTP ${res.status}: ${retryErr.slice(0, 240)}`);
          }
        } else {
          throw new Error(`HTTP ${res.status}: ${errText.slice(0, 240)}`);
        }
      }
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 240)}`);
      }
      const json = await res.json();
      const item = Array.isArray(json?.data) ? json.data[0] : null;
      if (item?.b64_json) return item.b64_json as string;
      if (item?.url) return await this.urlToB64(item.url as string, timeoutMs);
      throw new Error('No image data returned');
    } catch (e) {
      const err = e as Error;
      throw new Error(
        err.name === 'AbortError' ? 'Request timed out' : err.message,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async urlToB64(url: string, timeoutMs: number): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`image fetch HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.toString('base64');
    } finally {
      clearTimeout(timer);
    }
  }

  // --- Context-aware image generation (Responses API) -----------------------

  /** True when at least one image_context model is configured. */
  hasImageContextModels(): boolean {
    return (
      this.registry.hasModelsSync('image_context') && Boolean(this.cfg().apiKey)
    );
  }

  /**
   * Generate an image via the OpenAI Responses API `/v1/responses` with the
   * `image_generation` tool. The mainline model (e.g. gpt-5.5, gpt-4o) reads
   * the full input text — post caption, scene direction, brand context — and
   * produces a contextually-aware image. Falls through a model chain like
   * `generateImageB64`.
   */
  async generateContextAwareImageB64(opts: {
    input: string;
    size?: string;
    quality?: string;
    timeoutMs?: number;
    models?: string[];
  }): Promise<{ b64: string; model: string }> {
    const cfg = this.cfg();
    if (!cfg.apiKey) throw new AiGatewayError('AI gateway API key is not set');
    const chain =
      opts.models && opts.models.length
        ? opts.models
        : this.registry.getModelChainSync('image_context');
    if (!chain.length) {
      throw new AiGatewayError(
        'No image_context models configured in the registry',
      );
    }
    const endpoint = `${this.base()}/responses`;
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const attempts: { model: string; error: string }[] = [];

    for (const model of chain) {
      try {
        const b64 = await this.attemptResponsesImage(
          endpoint,
          cfg.apiKey,
          model,
          opts,
          timeoutMs,
        );
        if (attempts.length > 0) {
          this.logger.warn(
            `Responses API image recovered on ${model} after ${attempts.length} failure(s)`,
          );
        }
        return { b64, model };
      } catch (e) {
        const msg = (e as Error).message;
        attempts.push({ model, error: msg });
        this.logger.warn(`Responses API image ${model} failed: ${msg}`);
      }
    }
    throw new AiGatewayError(
      `All ${chain.length} image_context model(s) failed`,
      attempts,
    );
  }

  private async attemptResponsesImage(
    endpoint: string,
    apiKey: string,
    model: string,
    opts: { input: string; size?: string; quality?: string },
    timeoutMs: number,
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = {
        model,
        input: opts.input,
        tools: [
          {
            type: 'image_generation',
            quality: opts.quality || 'medium',
            size: opts.size || '1024x1024',
            output_format: 'png',
          },
        ],
        tool_choice: { type: 'image_generation' },
      };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => 'unknown');
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`);
      }

      const json = await res.json();

      // Extract b64 image from the Responses API output array
      const outputs: any[] = Array.isArray(json?.output) ? json.output : [];
      for (const item of outputs) {
        if (item?.type === 'image_generation_call' && item?.result) {
          const raw: string = item.result;
          // Strip data URI prefix if present
          const b64 = raw.startsWith('data:')
            ? raw.replace(/^data:[^;]+;base64,/, '')
            : raw;
          return b64;
        }
      }
      throw new Error('No image_generation_call found in response output');
    } catch (e) {
      const err = e as Error;
      throw new Error(
        err.name === 'AbortError' ? 'Request timed out' : err.message,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // --- Catalog (model browser) ----------------------------------------------

  /**
   * List models the gateway can serve (GET /v1/models), classified into our
   * categories using Bifrost's `architecture` modalities. Cached briefly so the
   * admin UI can browse without hitting Bifrost on every render.
   */
  async fetchCatalog(force = false): Promise<CatalogModel[]> {
    if (
      !force &&
      this.catalogCache &&
      Date.now() - this.catalogCache.at < AiGatewayService.CATALOG_TTL_MS
    ) {
      return this.catalogCache.models;
    }
    const cfg = this.cfg();
    if (!cfg.apiKey) throw new AiGatewayError('AI gateway API key is not set');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(`${this.base()}/models`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new AiGatewayError(
          `Gateway ${res.status} listing models: ${text.slice(0, 200)}`,
        );
      }
      const json = await res.json();
      const rows: any[] = Array.isArray(json?.data)
        ? json.data
        : Array.isArray(json?.models)
          ? json.models
          : [];
      const models = rows
        .map((row) => this.mapCatalogRow(row))
        .filter((m): m is CatalogModel => Boolean(m));
      // De-dupe by id, keep stable provider+id sort.
      const seen = new Set<string>();
      const deduped = models.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });
      deduped.sort((a, b) =>
        a.provider === b.provider
          ? a.id.localeCompare(b.id)
          : a.provider.localeCompare(b.provider),
      );
      this.catalogCache = { at: Date.now(), models: deduped };
      return deduped;
    } catch (e) {
      if (e instanceof AiGatewayError) throw e;
      const err = e as Error;
      throw new AiGatewayError(
        err.name === 'AbortError'
          ? 'Listing models timed out'
          : `Failed to list gateway models: ${err.message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Classify a model into one of our generation categories using the modality
   * metadata when the gateway provides it, then falling back to well-known
   * Google / OpenAI / Bedrock naming conventions. This is necessary because
   * some providers (notably Vertex) return only an id + display name with no
   * modalities, so a naming heuristic is the only reliable signal.
   *
   * Returns `null` for non-generation models (embeddings, rerankers) so they
   * are excluded from every tab rather than mis-bucketed as text/image.
   */
  private classifyCategory(
    id: string,
    name: string,
    outputModalities: string[],
    pricingImage: boolean,
  ): AiModelCategory | null {
    const hay = `${id} ${name}`.toLowerCase();

    // Embeddings / rerankers are not generation models. Examples:
    // text-embedding-004, gemini-embedding-2, multimodalembedding, *-rerank-*.
    if (/embed|embedding|rerank/.test(hay)) return null;

    // Video generation: Veo (Vertex), Sora (OpenAI), Nova Reel (Bedrock).
    if (
      outputModalities.includes('video') ||
      /\bveo[-\d]|nova-reel|\bsora\b|text-to-video|video-gen/.test(hay)
    ) {
      return 'video';
    }

    // Image upscale / enhance: models that accept an existing image and improve
    // it (super-resolution, creative upscale, style transfer, inpaint, etc.).
    // Must be checked before generic image-gen so they don't get mis-bucketed.
    //  - Bedrock: stability.*upscale*, stability.*inpaint*, amazon.titan-image-*-inpainting
    //  - OpenAI:  (none currently — all OpenAI image models are generators)
    //  - Generic: *-upscale*, *-enhance*, *-super-res*, *-inpaint*
    if (/upscale|super-?res|enhance|inpaint/.test(hay)) {
      return 'image_enhance';
    }

    // Image generation (text-to-image). Covers:
    //  - Vertex/Gemini: imagen-*, gemini-*-image*, *-image-preview, *-image-generation
    //  - OpenAI:        gpt-image-1, dall-e-*
    //  - Bedrock:       amazon.nova-canvas, stability/stable-diffusion/sd3, titan-image
    //  - generic:       flux
    if (
      outputModalities.includes('image') ||
      pricingImage ||
      /imagen|dall-?e|gpt-image|image-preview|image-generation|-image\b|nova-canvas|stable-?diffusion|\bsd3\b|stability|\bflux\b|titan-image/.test(
        hay,
      )
    ) {
      return 'image';
    }

    return 'text';
  }

  private mapCatalogRow(row: any): CatalogModel | null {
    const id = typeof row?.id === 'string' ? row.id : row?.name;
    if (!id || typeof id !== 'string') return null;
    const arch = row?.architecture || {};
    const out: string[] = Array.isArray(arch.output_modalities)
      ? arch.output_modalities
      : [];
    const inp: string[] = Array.isArray(arch.input_modalities)
      ? arch.input_modalities
      : [];
    const pricingImage =
      row?.pricing?.image && Number(row.pricing.image) > 0 ? true : false;
    const name = typeof row?.name === 'string' ? row.name : '';
    const category = this.classifyCategory(id, name, out, pricingImage);
    // `null` => not a generation model (e.g. embeddings/rerankers); hide it so
    // it never pollutes the text/image/video tabs.
    if (category === null) return null;
    const provider =
      (typeof row?.provider === 'string' && row.provider) ||
      providerOfModel(id) ||
      (typeof row?.owned_by === 'string' ? row.owned_by : 'custom');
    return {
      id,
      provider,
      category,
      label:
        (typeof row?.name === 'string' && row.name) ||
        (typeof row?.canonical_slug === 'string' && row.canonical_slug) ||
        id,
      inputModalities: inp.length ? inp : undefined,
      outputModalities: out.length ? out : undefined,
      contextLength:
        typeof row?.context_length === 'number'
          ? row.context_length
          : undefined,
    };
  }
}
