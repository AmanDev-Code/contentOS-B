import { OutboundWebhookService } from '../outbound-webhook.service';

describe('OutboundWebhookService', () => {
  describe('signPayload', () => {
    let service: OutboundWebhookService;

    beforeEach(() => {
      service = new OutboundWebhookService(null as any);
    });

    it('produces deterministic HMAC-SHA256 signatures', () => {
      const payload = JSON.stringify({
        event: 'post.published',
        data: { id: '123' },
      });
      const secret = 'test-secret-key';
      const sig1 = service.signPayload(payload, secret);
      const sig2 = service.signPayload(payload, secret);
      expect(sig1).toBe(sig2);
      expect(sig1).toMatch(/^sha256=[a-f0-9]{64}$/);
    });

    it('different secrets produce different signatures', () => {
      const payload = '{"test": true}';
      const sig1 = service.signPayload(payload, 'secret-a');
      const sig2 = service.signPayload(payload, 'secret-b');
      expect(sig1).not.toBe(sig2);
    });

    it('different payloads produce different signatures', () => {
      const secret = 'test-secret';
      const sig1 = service.signPayload('{"a":1}', secret);
      const sig2 = service.signPayload('{"a":2}', secret);
      expect(sig1).not.toBe(sig2);
    });
  });

  describe('verifySignature', () => {
    let service: OutboundWebhookService;

    beforeEach(() => {
      service = new OutboundWebhookService(null as any);
    });

    it('returns true for valid signature', () => {
      const payload = '{"event":"test"}';
      const secret = 'verify-test';
      const sig = service.signPayload(payload, secret);
      expect(service.verifySignature(payload, secret, sig)).toBe(true);
    });

    it('returns false for tampered payload', () => {
      const secret = 'verify-test';
      const sig = service.signPayload('{"event":"original"}', secret);
      expect(service.verifySignature('{"event":"tampered"}', secret, sig)).toBe(
        false,
      );
    });

    it('returns false for wrong secret', () => {
      const payload = '{"event":"test"}';
      const sig = service.signPayload(payload, 'correct-secret');
      expect(service.verifySignature(payload, 'wrong-secret', sig)).toBe(false);
    });
  });

  describe('SSRF validation', () => {
    it('rejects localhost URLs', async () => {
      const service = new OutboundWebhookService({
        getServiceClient: () => ({
          rpc: jest.fn().mockResolvedValue({ data: 'vault-id', error: null }),
          from: jest.fn().mockReturnValue({
            insert: jest.fn().mockReturnValue({
              select: jest.fn().mockReturnValue({
                single: jest.fn().mockResolvedValue({
                  data: {
                    id: 'wh-1',
                    url: 'http://localhost:3000',
                    events: [],
                  },
                  error: null,
                }),
              }),
            }),
          }),
        }),
      } as any);

      await expect(
        service.create('user-1', { url: 'http://localhost:3000/webhook' }),
      ).rejects.toThrow(/localhost/);
    });

    it('rejects private IP addresses', async () => {
      const service = new OutboundWebhookService(null as any);

      await expect(
        service.create('user-1', { url: 'http://192.168.1.1/webhook' }),
      ).rejects.toThrow(/private/i);

      await expect(
        service.create('user-1', { url: 'http://10.0.0.1/webhook' }),
      ).rejects.toThrow(/private/i);

      await expect(
        service.create('user-1', { url: 'http://172.16.0.1/webhook' }),
      ).rejects.toThrow(/private/i);
    });

    it('rejects non-http protocols', async () => {
      const service = new OutboundWebhookService(null as any);

      await expect(
        service.create('user-1', { url: 'ftp://example.com/webhook' }),
      ).rejects.toThrow(/http/i);
    });

    it('rejects invalid URLs', async () => {
      const service = new OutboundWebhookService(null as any);

      await expect(
        service.create('user-1', { url: 'not-a-url' }),
      ).rejects.toThrow(/invalid/i);
    });
  });

  describe('event validation', () => {
    it('rejects unsupported event types', async () => {
      const service = new OutboundWebhookService(null as any);

      await expect(
        service.create('user-1', {
          url: 'https://example.com/webhook',
          events: ['invalid.event'],
        }),
      ).rejects.toThrow(/unsupported/i);
    });
  });

  describe('getSupportedEvents', () => {
    it('returns the supported event list', () => {
      const events = OutboundWebhookService.getSupportedEvents();
      expect(events).toContain('post.published');
      expect(events).toContain('post.failed');
      expect(events).toContain('post.scheduled');
      expect(events).toContain('post.cancelled');
    });
  });
});
