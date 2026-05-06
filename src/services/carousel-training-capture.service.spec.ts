import { redactCarouselCapturePayload } from './carousel-training-capture.service';

describe('redactCarouselCapturePayload', () => {
  it('redacts long topics when consent is off', () => {
    const topic = 'x'.repeat(400);
    const out = redactCarouselCapturePayload(
      { topicPreview: topic, foo: 'bar' },
      false,
    );
    expect(String(out.topicPreview).length).toBeLessThanOrEqual(200);
  });

  it('keeps longer topic preview when consent opt-in is true', () => {
    const topic = 'y'.repeat(400);
    const out = redactCarouselCapturePayload({ topicPreview: topic }, true);
    expect(String(out.topicPreview).length).toBeGreaterThan(300);
  });
});
