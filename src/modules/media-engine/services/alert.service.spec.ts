import { MediaEngineAlertService } from './alert.service';
import { CacheService } from '../../../services/cache.service';
import { EmailService } from '../../../services/email.service';
import { ConfigService } from '@nestjs/config';

/**
 * Covers the new observability event emitters added so the Media Engine
 * admin Event Log surfaces cache hits/misses, engine attempts/fallbacks,
 * session registrations, and URL-validation outcomes — not just successes.
 */
describe('MediaEngineAlertService — observability events', () => {
  let service: MediaEngineAlertService;
  let sendEmail: jest.Mock;

  beforeEach(() => {
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;

    sendEmail = jest.fn().mockResolvedValue(undefined);
    const emailService = { sendEmail } as unknown as EmailService;

    const configService = {
      get: jest.fn().mockReturnValue('admin@trndinn.com'),
    } as unknown as ConfigService;

    service = new MediaEngineAlertService(cache, emailService, configService);
  });

  it('emitCacheHit records a CACHE_HIT info event', () => {
    service.emitCacheHit('https://cdn.example/video.mp4', 'private-api');
    const [event] = service.getRecentEvents(1);
    expect(event.event).toBe('CACHE_HIT');
    expect(event.severity).toBe('info');
    expect(event.engine).toBe('private-api');
  });

  it('emitCacheMiss records a CACHE_MISS info event', () => {
    service.emitCacheMiss('https://cdn.example/video.mp4');
    const [event] = service.getRecentEvents(1);
    expect(event.event).toBe('CACHE_MISS');
    expect(event.severity).toBe('info');
  });

  it('emitCacheStale records a CACHE_STALE warning event with statusCode', () => {
    service.emitCacheStale('https://cdn.example/video.mp4', 403);
    const [event] = service.getRecentEvents(1);
    expect(event.event).toBe('CACHE_STALE');
    expect(event.severity).toBe('warning');
    expect(event.details?.statusCode).toBe(403);
  });

  it('emitEngineAttempt records ENGINE_ATTEMPT with the engine name', () => {
    service.emitEngineAttempt('mobile-api', 'https://x');
    const [event] = service.getRecentEvents(1);
    expect(event.event).toBe('ENGINE_ATTEMPT');
    expect(event.severity).toBe('info');
    expect(event.engine).toBe('mobile-api');
  });

  it('emitEngineFailed records ENGINE_FAILED warning with the error detail', () => {
    service.emitEngineFailed('private-api', 'https://x', 'boom');
    const [event] = service.getRecentEvents(1);
    expect(event.event).toBe('ENGINE_FAILED');
    expect(event.severity).toBe('warning');
    expect(event.engine).toBe('private-api');
    expect(event.details?.error).toBe('boom');
  });

  it('emitSessionRegistered records SESSION_REGISTERED with account + platform', () => {
    service.emitSessionRegistered('acct-1', 'instagram');
    const [event] = service.getRecentEvents(1);
    expect(event.event).toBe('SESSION_REGISTERED');
    expect(event.severity).toBe('info');
    expect(event.accountId).toBe('acct-1');
    expect(event.platform).toBe('instagram');
  });

  it('emitUrlValidation uses warning severity when the URL is expired', () => {
    service.emitUrlValidation('https://x', 'expired', 410);
    const [event] = service.getRecentEvents(1);
    expect(event.event).toBe('URL_VALIDATION');
    expect(event.severity).toBe('warning');
    expect(event.details?.status).toBe('expired');
    expect(event.details?.statusCode).toBe(410);
  });

  it('emitUrlValidation uses info severity when the URL is alive', () => {
    service.emitUrlValidation('https://x', 'alive', 200);
    const [event] = service.getRecentEvents(1);
    expect(event.event).toBe('URL_VALIDATION');
    expect(event.severity).toBe('info');
    expect(event.details?.status).toBe('alive');
  });
});
