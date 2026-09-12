/**
 * THE BETRAYED WILL — §26 historical vocabulary gate.
 *
 * The setting is Babylonian / Mesopotamian. Every piece of generated geometry,
 * every material name, every prop kind and every line of environmental text has
 * to read as the alluvial plain between the Tigris and the Euphrates in the
 * first millennium BCE. European medieval and modern vocabulary is the single
 * most common way a "historical" game silently stops being historical, so the
 * allow list and the reject list live in one place and are enforced three ways:
 *
 *   1. `bash lint.sh` greps src/content and src/assets for rejected terms.
 *   2. `validateWorldData()` rejects any material, kind or region name that is
 *      not on the allow list.
 *   3. `tests/verify.mjs` asserts the two lists are disjoint and non-empty, so
 *      neither can decay into a stub that passes vacuously.
 *
 * This module is the ONE file lint.sh deliberately excludes from rule 8: it is
 * the declaration of the banned vocabulary, so of course it contains it. The
 * exclusion is by exact path, never by pattern, so a rejected term appearing
 * anywhere else still fails the build.
 */

/** Architecture and structural vocabulary that belongs in this world. */
export const ARCHITECTURE_ALLOWED = Object.freeze([
  'mud-brick wall', 'baked-brick facing', 'buttressed facade', 'blind niche',
  'flat roof', 'roof parapet', 'courtyard', 'gatehouse', 'arched gateway',
  'processional way', 'ziggurat terrace', 'temple cella', 'store room',
  'grain silo', 'oil jar row', 'palm-beam ceiling', 'reed screen',
  'bitumen-lined drain', 'stone-lined canal', 'mud-brick bench', 'kiln',
  'alley', 'stepped mud-brick stair', 'wooden door with bronze studs',
  'glazed-brick relief', 'cuneiform stele', 'boundary stone (kudurru)',
  'buttress pier', 'enclosure wall', 'pylon', 'embankment', 'mooring quay',
  'reed hut', 'livestock pen', 'ash heap', 'wash yard', 'market stall',
  'rock outcrop', 'dune bank', 'dry watercourse bank', 'stair stringer',
]);

/**
 * Vocabulary that must never appear in generated content. Two families:
 * European medieval/Gothic (wrong civilisation, wrong millennium) and modern
 * (wrong everything). Listed in the terms a generator or a writer would
 * plausibly reach for, not as an exhaustive art-history survey.
 */
export const ARCHITECTURE_REJECTED = Object.freeze([
  'pointed Gothic arch', 'flying buttress', 'crenellated stone tower',
  'conical roof', 'slate roof', 'half-timbered facade', 'gable window',
  'stained glass', 'marble colonnade (classical order)', 'doric column',
  'corinthian capital', 'iron portcullis gate', 'modern signage',
  'glass window pane', 'chimney stack', 'cobblestone street (European pattern)',
  'plate armor', 'plate armour', 'longsword', 'greatsword', 'crossbow',
  'musket', 'revolver', 'rifle', 'denim', 't-shirt', 'jeans', 'sneakers',
  'eyeglasses', 'neon', 'plastic',
]);

/**
 * Substring keys used for *scanning*. `ARCHITECTURE_REJECTED` holds whole
 * phrases for exact validation and for reading; these are the distinctive
 * fragments a phrase check would miss, because a generator that invented
 * "gothic tracery" or "doric order" would not reproduce the listed phrase
 * verbatim. lint.sh reads this array straight out of the module, so the linter
 * and the runtime validator cannot drift apart.
 */
export const REJECTED_TERMS = Object.freeze([
  'gothic', 'portcullis', 'flying buttress', 'crenellat', 'half-timbered',
  'stained glass', 'gable window', 'conical roof', 'slate roof',
  'doric', 'corinthian', 'chimney', 'cobblestone', 'plate armor',
  'plate armour', 'longsword', 'greatsword', 'crossbow', 'musket',
  'revolver', 'rifle', 'denim', 't-shirt', 'jeans', 'sneakers',
  'eyeglasses', 'neon', 'plastic', 'baroque', 'victorian', 'tudor',
]);

/** True when `text` contains any rejected term (case-insensitive). */
export function containsRejectedTerm(text) {
  if (typeof text !== 'string') return null;
  const lower = text.toLowerCase();
  for (const term of REJECTED_TERMS) {
    if (lower.includes(term)) return term;
  }
  return null;
}

/** True when `phrase` is on the allow list, compared case-insensitively. */
export function isAllowedArchitecture(phrase) {
  if (typeof phrase !== 'string') return false;
  const lower = phrase.toLowerCase();
  return ARCHITECTURE_ALLOWED.some((a) => a.toLowerCase() === lower);
}
