'use strict';
// Concept-art loader (public/js/hero-sheets.js): mastery tier mapping and fallback. Rendering only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
require('../public/js/hero-sheets.js');
const S = globalThis.WCHSheets;

test('concept art: mastery tier is 0 for Lv1-9, 1 for 10-19, 2 for 20-29, 3 for 30+', () => {
    assert.deepStrictEqual([1, 9, 10, 19, 20, 29, 30, 50].map(S.masteryTier), [0, 0, 1, 1, 2, 2, 3, 3]);
});
test('concept art: heroes without tier art fall back to base (tier 0)', () => {
    for (const h of ['NOAH', 'DESTINY', 'MARKIE', 'ESPIRIT', 'SMITESH', 'DAVE', 'DONNA'])
        for (const lv of [1, 12, 25, 40]) assert.strictEqual(S.artTier(h, lv), 0);
});
test('concept art: one-shot actions hold their last frame, loops wrap', () => {
    assert.strictEqual(S.conceptFrame('attack', 10000, 500), 7);
    assert.strictEqual(S.conceptFrame('hurt', 10000), 3);
    assert.strictEqual(S.conceptFrame('idle', 150 * 7), 1);
});
test('concept art: every sheet in the manifest exists with the right size', () => {
    const dir = path.join(__dirname, '..', 'public', 'assets', 'concept-v2');
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    for (const h of Object.keys(m.heroes)) for (const [a, A] of Object.entries(m.anims)) {
        const buf = fs.readFileSync(path.join(dir, `${h}_${a}_${A.fw}x${A.fh}_${A.n}f.png`));
        assert.strictEqual(buf.readUInt32BE(16), A.fw * A.n, h + ' ' + a + ' width');
        assert.strictEqual(buf.readUInt32BE(20), A.fh, h + ' ' + a + ' height');
    }
    assert.strictEqual(Object.keys(m.heroes).length, 7);
});
