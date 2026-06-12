import { SocialConnectionBridgeService } from '../social-connection-bridge.service';
import { SocialAccountAlreadyConnectedError, type OAuthTokenSet } from '../types';

// Minimal chainable Supabase query-builder mock. Every non-terminal call returns
// `this`; terminal resolvers (`maybeSingle`, `single`) and awaiting the builder
// itself resolve to the configured result.
class QueryBuilderMock {
  public constructor(
    private readonly cfg: {
      maybeSingle?: { data: unknown; error: unknown };
      single?: { data: unknown; error: unknown };
      awaited?: { data?: unknown; error: unknown };
    },
  ) {}
  select() {
    return this;
  }
  insert() {
    return this;
  }
  update() {
    return this;
  }
  delete() {
    return this;
  }
  eq() {
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  maybeSingle() {
    return Promise.resolve(this.cfg.maybeSingle ?? { data: null, error: null });
  }
  single() {
    return Promise.resolve(this.cfg.single ?? { data: null, error: null });
  }
  then(resolve: (v: unknown) => unknown) {
    return Promise.resolve(this.cfg.awaited ?? { data: [], error: null }).then(resolve);
  }
}

function makeClient(builders: QueryBuilderMock[]) {
  let i = 0;
  return {
    from: jest.fn(() => builders[Math.min(i++, builders.length - 1)]),
  };
}

const tokens: OAuthTokenSet = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: new Date(Date.now() + 3600_000),
  scopes: ['openid', 'w_member_social'],
};

function makeService(client: unknown, vault: Partial<{ storeTokens: jest.Mock; rotateTokens: jest.Mock }>) {
  const supabase = { getServiceClient: () => client } as never;
  const tokenVault = {
    storeTokens: vault.storeTokens ?? jest.fn().mockResolvedValue(undefined),
    rotateTokens: vault.rotateTokens ?? jest.fn().mockResolvedValue(undefined),
  } as never;
  return new SocialConnectionBridgeService(supabase, tokenVault);
}

describe('SocialConnectionBridgeService.connectLinkedIn', () => {
  it('inserts a new account and stores tokens in the vault', async () => {
    const insertedRow = {
      id: 'acc-1',
      user_id: 'user-1',
      platform: 'linkedin',
      platform_account_id: 'member-1',
      account_type: 'personal',
      display_name: 'Ada',
      profile_url: null,
      avatar_url: null,
      status: 'active',
      connected_at: new Date().toISOString(),
      last_used_at: null,
      metadata: {},
    };
    const client = makeClient([
      new QueryBuilderMock({ maybeSingle: { data: null, error: null } }), // SELECT existing
      new QueryBuilderMock({ single: { data: insertedRow, error: null } }), // INSERT
    ]);
    const storeTokens = jest.fn().mockResolvedValue(undefined);
    const service = makeService(client, { storeTokens });

    const result = await service.connectLinkedIn({
      userId: 'user-1',
      memberId: 'member-1',
      displayName: 'Ada',
      tokens,
    });

    expect(result.id).toBe('acc-1');
    expect(result.platformAccountId).toBe('member-1');
    expect(storeTokens).toHaveBeenCalledWith('acc-1', tokens);
  });

  it('updates in place and rotates tokens when the same user re-auths', async () => {
    const existingRow = {
      id: 'acc-1',
      user_id: 'user-1',
      platform: 'linkedin',
      platform_account_id: 'member-1',
      account_type: 'personal',
      display_name: 'Ada',
      profile_url: null,
      avatar_url: null,
      status: 'reauth_required',
      connected_at: new Date().toISOString(),
      last_used_at: null,
      metadata: {},
    };
    const client = makeClient([
      new QueryBuilderMock({ maybeSingle: { data: existingRow, error: null } }), // SELECT existing
      new QueryBuilderMock({ awaited: { error: null } }), // UPDATE
    ]);
    const rotateTokens = jest.fn().mockResolvedValue(undefined);
    const storeTokens = jest.fn();
    const service = makeService(client, { rotateTokens, storeTokens });

    const result = await service.connectLinkedIn({
      userId: 'user-1',
      memberId: 'member-1',
      tokens,
    });

    expect(result.status).toBe('active');
    expect(rotateTokens).toHaveBeenCalledWith('acc-1', tokens);
    expect(storeTokens).not.toHaveBeenCalled();
  });

  it('throws SocialAccountAlreadyConnectedError when another user owns the account', async () => {
    const otherRow = {
      id: 'acc-2',
      user_id: 'user-2',
      platform: 'linkedin',
      platform_account_id: 'member-1',
      account_type: 'personal',
      display_name: null,
      profile_url: null,
      avatar_url: null,
      status: 'active',
      connected_at: new Date().toISOString(),
      last_used_at: null,
      metadata: {},
    };
    const client = makeClient([
      new QueryBuilderMock({ maybeSingle: { data: otherRow, error: null } }),
    ]);
    const service = makeService(client, {});

    await expect(
      service.connectLinkedIn({ userId: 'user-1', memberId: 'member-1', tokens }),
    ).rejects.toBeInstanceOf(SocialAccountAlreadyConnectedError);
  });

  it('resolves a unique-violation race to a 409 when another user won the insert', async () => {
    const winnerRow = {
      id: 'acc-2',
      user_id: 'user-2',
      platform: 'linkedin',
      platform_account_id: 'member-1',
      account_type: 'personal',
      display_name: null,
      profile_url: null,
      avatar_url: null,
      status: 'active',
      connected_at: new Date().toISOString(),
      last_used_at: null,
      metadata: {},
    };
    const client = makeClient([
      new QueryBuilderMock({ maybeSingle: { data: null, error: null } }), // SELECT -> none
      new QueryBuilderMock({ single: { data: null, error: { code: '23505' } } }), // INSERT conflict
      new QueryBuilderMock({ maybeSingle: { data: winnerRow, error: null } }), // re-SELECT winner
    ]);
    const service = makeService(client, {});

    await expect(
      service.connectLinkedIn({ userId: 'user-1', memberId: 'member-1', tokens }),
    ).rejects.toBeInstanceOf(SocialAccountAlreadyConnectedError);
  });
});
