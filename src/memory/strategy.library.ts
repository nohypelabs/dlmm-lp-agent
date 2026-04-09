/**
 * Strategy Library
 *
 * Defines LP strategy presets that control bin shape, side, and range.
 * These presets are passed through to openPosition() to drive StrategyType
 * selection and bin range computation on the live branch.
 */

export type StrategyShape = 'spot' | 'curve' | 'bid_ask';
export type EntrySide = 'both' | 'token_only' | 'sol_only';

export interface LPStrategy {
  id: string;
  name: string;
  shape: StrategyShape;
  side: EntrySide;
  binsBelow: number; // bins below active bin
  binsAbove: number; // bins above active bin
  description: string;
  bestFor: string;
}

export const STRATEGY_PRESETS: LPStrategy[] = [
  {
    id: 'spot_balanced',
    name: 'Spot Balanced',
    shape: 'spot',
    side: 'both',
    binsBelow: 50,
    binsAbove: 50,
    description: 'Standard 50/50 LP. Good for sideways markets.',
    bestFor: 'Stable / range-bound tokens',
  },
  {
    id: 'curve_balanced',
    name: 'Curve Balanced',
    shape: 'curve',
    side: 'both',
    binsBelow: 40,
    binsAbove: 40,
    description: 'Concentrated near active bin. More fees, higher IL risk.',
    bestFor: 'Low-volatility tokens where you want max fee capture',
  },
  {
    id: 'bid_ask',
    name: 'Bid-Ask',
    shape: 'bid_ask',
    side: 'both',
    binsBelow: 60,
    binsAbove: 60,
    description: 'Spread at edges. Good for volatile tokens.',
    bestFor: 'High-volatility tokens or new listings',
  },
  {
    id: 'single_sided_token',
    name: 'Single-Sided Token',
    shape: 'spot',
    side: 'token_only',
    binsBelow: 60,
    binsAbove: 0,
    description: 'Deploy token only. DCA out as price pumps.',
    bestFor: "Meridian-style single_sided_reseed — sell into strength",
  },
];

/**
 * Look up a preset by id. Returns null when not found.
 */
export function getPreset(id: string): LPStrategy | null {
  return STRATEGY_PRESETS.find(s => s.id === id) ?? null;
}

/**
 * Return all available presets.
 */
export function listPresets(): LPStrategy[] {
  return STRATEGY_PRESETS;
}

/**
 * Return the default preset (spot_balanced).
 */
export function getDefaultPreset(): LPStrategy {
  // spot_balanced is always index 0 — non-null assertion is safe here
  return STRATEGY_PRESETS[0] as LPStrategy;
}
