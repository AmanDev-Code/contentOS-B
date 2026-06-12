import { LinkedInAuthService } from '../linkedin-auth.service';

describe('LinkedInAuthService — Sprint 1.7 org scopes', () => {
  const config = {
    clientId: 'test-client',
    clientSecret: 'test-secret',
    redirectUri: 'https://example.com/callback',
  };

  it('ORG_PAGE_REQUESTED_SCOPES includes org scopes for company-page publishing', () => {
    const service = new LinkedInAuthService(config);
    const requested = service.getOrgPageRequestedScopes();

    expect(requested).toContain('w_organization_social');
    expect(requested).toContain('r_organization_social');
    expect(requested).toContain('rw_organization_admin');
    expect(requested).not.toContain('r_organization_admin');
    expect(requested).not.toContain('r_member_social');
    expect(requested).not.toContain('r_basicprofile');
  });

  it('PERSONAL_REQUESTED_SCOPES does not include org or restricted scopes', () => {
    const service = new LinkedInAuthService(config);
    const requested = service.getPersonalRequestedScopes();

    expect(requested).toEqual([
      'openid',
      'profile',
      'email',
      'w_member_social',
    ]);
    expect(requested).not.toContain('r_member_social');
    expect(requested).not.toContain('w_organization_social');
    expect(requested).not.toContain('rw_organization_admin');
  });

  it('REQUIRED_SCOPES still only requires personal publishing scopes', () => {
    const service = new LinkedInAuthService(config);
    const required = service.getRequiredScopes();

    expect(required).toContain('openid');
    expect(required).toContain('w_member_social');
    expect(required).not.toContain('w_organization_social');
    expect(required).not.toContain('rw_organization_admin');
  });

  it('authorization URL includes org scopes for company-page flow', async () => {
    const service = new LinkedInAuthService(config);
    const { url } = await service.getAuthorizationUrl(
      'test-state',
      service.getOrgPageRequestedScopes(),
    );

    expect(url).toContain('w_organization_social');
    expect(url).toContain('r_organization_social');
    expect(url).toContain('rw_organization_admin');
    expect(url).not.toContain('r_member_social');
    expect(url).not.toContain('r_basicprofile');
  });

  it('validateScopes passes when org scopes are not granted (graceful degradation)', () => {
    const service = new LinkedInAuthService(config);
    const granted = ['openid', 'profile', 'email', 'w_member_social'];
    const result = service.validateScopes(granted, service.getRequiredScopes());
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });
});
