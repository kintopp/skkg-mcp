// Matching a value word by word against recorded text, as the place filters do.

// Folds case and accents, so "zurich" finds "Zürich" and "neuchatel" finds "Neuchâtel".
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('de');
export const words = (s) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** The texts with a word that starts with each word of `value`, so "Bern" matches "Bernhard" but not "Hornbernsee". */
export function startingWith(texts, value) {
  const wanted = words(value);
  return texts.filter((t) => {
    const have = words(t);
    return wanted.every((w) => have.some((h) => h.startsWith(w)));
  });
}
