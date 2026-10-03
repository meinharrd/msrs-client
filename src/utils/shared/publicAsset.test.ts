import { describe, expect, it } from 'vitest';

import { publicAsset } from './publicAsset';

describe('publicAsset', () => {
  it('prefixes public paths with the build base', () => {
    expect(publicAsset('/assets/icons/playIcon.png')).toBe(`${import.meta.env.BASE_URL}assets/icons/playIcon.png`);
    expect(publicAsset('fonts/x.ttf')).toBe(`${import.meta.env.BASE_URL}fonts/x.ttf`);
  });
});
