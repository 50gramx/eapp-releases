import assert from 'node:assert/strict';
import { betterBest, energyTierOf, isRetiredRecord, keepHeldBest, lowerIsBetter, mergeBests, summable } from './aggregate-founders.mjs';

// Energy: lower is better, and a measurement beats a model whatever the number.
assert.equal(lowerIsBetter('energy'), true);
assert.equal(lowerIsBetter('gpu'), false);
assert.equal(betterBest('energy', { value: 125 }, { value: 9 }), true, '9 J/token beats 125');
assert.equal(betterBest('energy', { value: 9 }, { value: 125 }), false, '125 J/token never beats 9');
assert.equal(
  betterBest('energy', { value: 5, tier: 'modelled' }, { value: 20, tier: 'sensor' }),
  true,
  'a sensor reading beats a lower modelled figure',
);
assert.equal(betterBest('energy', { value: 5, tier: 'sensor' }, { value: 4, tier: 'modelled' }), false);
assert.equal(betterBest('gpu', { value: 0.37 }, { value: 60.85 }), true, 'higher is better elsewhere');
assert.equal(betterBest('energy', null, { value: 1 }), true);

// A ratio is never summed into a network total; capacities are.
assert.equal(summable('energy'), false);
assert.equal(summable('cpu'), true);

// The retired idle-utilisation GPU sample is never a best again.
assert.equal(isRetiredRecord('gpu', 'percent'), true);
assert.equal(isRetiredRecord('gpu', 'TFLOP/s'), false);

assert.equal(energyTierOf({ extra: { tier: 'sensor' } }), 'sensor');
assert.equal(energyTierOf({ extra: { method: 'estimated' } }), null, 'a figure from before tiers has none');
// A held best chosen under the inverted rule (no tier) is retracted, not kept.
assert.equal(keepHeldBest('energy', { value: 125, unit: 'joules/token' }), false);
assert.equal(keepHeldBest('energy', { value: 9, unit: 'joules/token', tier: 'sensor' }), true);
assert.equal(keepHeldBest('gpu', { value: 0, unit: 'percent' }), false);
const merged = mergeBests(
  { resources: { energy: { status: 'signed', value: 125, unit: 'joules/token' }, gpu: { status: 'signed', value: 60, unit: 'TFLOP/s' } } },
  { resources: { energy: { status: 'signed', value: 9, unit: 'joules/token', tier: 'sensor' } } },
);
assert.equal(merged.resources.energy.value, 9, 'the corrected rule wins across runs');
assert.equal(merged.resources.gpu.value, 60, 'other bests are still carried forward');
console.log('bests-direction: ok');
