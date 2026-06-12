import axios from 'axios';
import sharp from 'sharp';
import { ConfigService } from '@nestjs/config';
import { MediaGenerationService } from './media-generation.service';
import { MinioService } from './minio.service';
import { CacheService } from './cache.service';
import { OpenAIRateLimiterService } from './openai-rate-limiter.service';
import { AiGatewayService } from './ai-gateway.service';
import { WebResearchService } from './web-research.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('MediaGenerationService — createCarouselPdfFromImageUrls', () => {
  let service: MediaGenerationService;

  beforeEach(() => {
    jest.clearAllMocks();
    const config = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;
    const minio = {} as MinioService;
    const cache = {
      get: jest.fn(),
      set: jest.fn(),
    } as unknown as CacheService;
    const rateLimiter = {
      executeWithRetry: jest.fn((_u: string, fn: () => unknown) => fn()),
    } as unknown as OpenAIRateLimiterService;
    const gateway = {
      hasImageModels: jest.fn().mockReturnValue(false),
    } as unknown as AiGatewayService;
    const webResearch = {
      isEnabled: jest.fn().mockReturnValue(false),
    } as unknown as WebResearchService;
    service = new MediaGenerationService(
      config,
      minio,
      cache,
      rateLimiter,
      gateway,
      webResearch,
    );
  });

  it('produces a PDF starting with %PDF for reachable slide URLs', async () => {
    const jpegBuf = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: '#336699',
      },
    })
      .jpeg()
      .toBuffer();

    mockedAxios.get.mockResolvedValue({
      data: jpegBuf,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as never,
    });

    const pdf = await service.createCarouselPdfFromImageUrls([
      'https://cdn.example/slide1.jpg',
      'https://cdn.example/slide2.jpg',
    ]);

    expect(pdf.length).toBeGreaterThan(200);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
  });

  it('throws when URL list is empty', async () => {
    await expect(service.createCarouselPdfFromImageUrls([])).rejects.toThrow(
      'No valid carousel image URLs',
    );
  });
});
