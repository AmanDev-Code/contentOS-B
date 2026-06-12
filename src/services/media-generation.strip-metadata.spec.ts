import sharp from 'sharp';
import { MediaGenerationService } from './media-generation.service';

describe('MediaGenerationService.stripAiPublishMetadata', () => {
  const service = Object.create(
    MediaGenerationService.prototype,
  ) as MediaGenerationService;

  it('re-encodes PNG without preserving EXIF orientation metadata', async () => {
    const input = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 3,
        background: { r: 225, g: 111, b: 19 },
      },
    })
      .png()
      .toBuffer();

    const out = await service.stripAiPublishMetadata(input);
    expect(out.length).toBeGreaterThan(0);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('png');
    expect(meta.exif).toBeUndefined();
  });
});
