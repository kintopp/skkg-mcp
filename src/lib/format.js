// Small value formatters shared by the tools. No imports, so any lib module can use them.

// A database value as a string field: numbers and strings alike, null as absent.
export const asStr = (v) => (v === null || v === undefined ? undefined : String(v));

// "an actor", "a person": the article for a record type or other lowercase word.
export const withArticle = (word) => `${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word}`;
