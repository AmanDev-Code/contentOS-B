import {
  CREDIT_COSTS,
  buildCreditCostMatrix,
  generateCost,
  getPlanAllotment,
  getPlanDisplayName,
  postNowCost,
  regenerateAllImagesCost,
  regenerateCarouselCost,
  regenerateSingleImageCost,
  scheduleCost,
} from './credit-costs';

describe('credit-costs single source of truth', () => {
  describe('Post Now costs (FLAT, do not scale)', () => {
    it('matches the confirmed matrix', () => {
      expect(postNowCost('text')).toBe(2.5);
      expect(postNowCost('image')).toBe(6);
      expect(postNowCost('carousel')).toBe(12);
    });

    it('adds the PDF add-on when requested', () => {
      expect(postNowCost('text', { pdf: true })).toBe(2.5 + 12);
      expect(postNowCost('carousel', { pdf: true })).toBe(12 + 12);
    });
  });

  describe('Schedule costs (FLAT, do not scale)', () => {
    it('matches the confirmed matrix', () => {
      expect(scheduleCost('text')).toBe(4);
      expect(scheduleCost('image')).toBe(7.5);
      expect(scheduleCost('carousel')).toBe(15);
    });

    it('adds the PDF add-on when requested', () => {
      expect(scheduleCost('image', { pdf: true })).toBe(7.5 + 12);
    });

    it('costs strictly more than Post Now (scheduling premium)', () => {
      expect(scheduleCost('text')).toBeGreaterThan(postNowCost('text'));
      expect(scheduleCost('image')).toBeGreaterThan(postNowCost('image'));
      expect(scheduleCost('carousel')).toBeGreaterThan(postNowCost('carousel'));
    });
  });

  describe('Generate / Regenerate costs (SCALE per unit)', () => {
    it('text generate is the flat base', () => {
      expect(generateCost('text')).toBe(2);
    });

    it('image generate scales: 2 + 3·images', () => {
      expect(generateCost('image', 1)).toBe(5);
      expect(generateCost('image', 4)).toBe(2 + 3 * 4);
    });

    it('carousel generate scales: 2 + 2.5·slides', () => {
      expect(generateCost('carousel', 1, 6)).toBe(2 + 2.5 * 6);
    });

    it('regenerate helpers scale by count', () => {
      expect(regenerateSingleImageCost()).toBe(3);
      expect(regenerateAllImagesCost(3)).toBe(9);
      expect(regenerateCarouselCost(8)).toBe(20);
    });

    it('FLAT post/schedule image cost differs from SCALING generate cost', () => {
      // Post Now image is flat (6) regardless of image count, but generating
      // 3 images scales (2 + 9 = 11). This distinction must be preserved.
      expect(postNowCost('image')).toBe(6);
      expect(generateCost('image', 3)).toBe(11);
    });
  });

  describe('plan allotments + display names', () => {
    it('maps internal plan_type to monthly allotment', () => {
      expect(getPlanAllotment('free')).toBe(50);
      expect(getPlanAllotment('standard')).toBe(500);
      expect(getPlanAllotment('pro')).toBe(2000);
      expect(getPlanAllotment('ultimate')).toBe(10000);
      expect(getPlanAllotment('unknown')).toBe(50);
      expect(getPlanAllotment(null)).toBe(50);
    });

    it('maps internal plan_type to marketing name', () => {
      expect(getPlanDisplayName('free')).toBe('Free');
      expect(getPlanDisplayName('standard')).toBe('Solo');
      expect(getPlanDisplayName('pro')).toBe('Growth');
      expect(getPlanDisplayName('ultimate')).toBe('Agency');
    });
  });

  describe('serializable matrix for the frontend', () => {
    it('buildCreditCostMatrix mirrors CREDIT_COSTS exactly', () => {
      const matrix = buildCreditCostMatrix();
      expect(matrix.postNow).toEqual(CREDIT_COSTS.postNow);
      expect(matrix.schedule).toEqual(CREDIT_COSTS.schedule);
      expect(matrix.generate).toEqual(CREDIT_COSTS.generate);
      expect(matrix.regenerate).toEqual(CREDIT_COSTS.regenerate);
      expect(matrix.pdfAddOn).toBe(CREDIT_COSTS.pdfAddOn);
      expect(matrix.reschedule).toBe(0);
      expect(matrix.legacyGenerate).toBe(1.5);
      expect(matrix.aiTextFormatting).toBe(0.5);
    });

    it('returns a deep copy (mutating the matrix never touches the source)', () => {
      const matrix = buildCreditCostMatrix();
      matrix.postNow.text = 999;
      expect(CREDIT_COSTS.postNow.text).toBe(2.5);
    });
  });
});
