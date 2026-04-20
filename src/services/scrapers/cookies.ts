export function parseCookieString(raw: string): Array<{ name: string; value: string }> {
  const input = String(raw || '').trim();
  if (!input) return [];

  const parts = input.split(';').map((p) => p.trim()).filter(Boolean);
  const out: Array<{ name: string; value: string }> = [];
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name || !value) continue;
    out.push({ name, value });
  }
  return out;
}

export async function addCookieStringToDomains(
  context: any,
  cookieString: string,
  domains: string[],
): Promise<void> {
  const pairs = parseCookieString(cookieString);
  if (pairs.length === 0) return;

  const cookies = domains.flatMap((domain) =>
    pairs.map((p) => ({
      name: p.name,
      value: p.value,
      domain,
      path: '/',
      secure: true,
      sameSite: 'None',
    })),
  );

  await context.addCookies(cookies);
}

