import {
  buildCreditSlices,
  calculateTotalCredits,
  calculateTotalHalfCredits,
} from './pricing';

describe('custom topic pricing', () => {
  it('text post is 2 credits', () => {
    expect(calculateTotalCredits('text')).toBe(2);
    expect(calculateTotalHalfCredits('text')).toBe(4);
    expect(buildCreditSlices('text')).toEqual([
      expect.objectContaining({
        subtaskKey: 'text',
        credits: 2,
        halfCredits: 4,
      }),
    ]);
  });

  it('image with N=4 charges 2 + 12 = 14 credits', () => {
    expect(calculateTotalCredits('image', 4)).toBe(14);
    expect(calculateTotalHalfCredits('image', 4)).toBe(28);
    const slices = buildCreditSlices('image', 4);
    expect(slices).toHaveLength(5);
    expect(slices[0].credits).toBe(2);
    expect(slices.slice(1).every((s) => s.credits === 3)).toBe(true);
  });

  it('carousel 12 slides charges 2 + 30 = 32 credits', () => {
    expect(calculateTotalCredits('carousel', undefined, 12)).toBe(32);
    expect(calculateTotalHalfCredits('carousel', undefined, 12)).toBe(64);
    const slices = buildCreditSlices('carousel', undefined, 12);
    expect(slices).toHaveLength(13);
    expect(slices[0].credits).toBe(2);
    expect(slices.slice(1).every((s) => s.credits === 2.5)).toBe(true);
    expect(slices.slice(1).every((s) => s.halfCredits === 5)).toBe(true);
  });

  it('carousel 5 slides matches half-credit rounding', () => {
    expect(calculateTotalCredits('carousel', undefined, 5)).toBe(14.5);
    expect(calculateTotalHalfCredits('carousel', undefined, 5)).toBe(29);
  });
});
