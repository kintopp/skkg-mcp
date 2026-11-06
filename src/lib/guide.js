// Splits src/guide.md into the topics of skkg_guide: one per `##` section, named after its
// heading ("Search in German" is search_in_german). Throws on any text the topics would drop
// or misname, so a bad edit fails at startup and in the tests, never silently.

const topicOf = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** The topics of a guide in Markdown, in order, as [{ topic, title, text }]. */
export function parseGuide(md) {
  // A `##` line inside a fence would start a topic.
  if (/^\s*(```|~~~)/m.test(md)) throw new Error('the guide has a code fence; write code inline');
  const at = md.search(/^## /m);
  if (at === -1) throw new Error('the guide has no `##` section');
  const preamble = md.slice(0, at).replace(/^# .*$/m, '').trim();
  if (preamble) throw new Error('text before the first `##` section would be in no topic; move it into a section');

  const topics = md.slice(at).split(/^(?=## )/m).map((s) => {
    const nl = s.indexOf('\n');
    const title = s.slice(3, nl === -1 ? undefined : nl).trim();
    return { topic: topicOf(title), title, text: nl === -1 ? '' : s.slice(nl + 1).trim() };
  });
  const seen = new Set();
  for (const t of topics) {
    // The topic name drops other letters ("Überblick" would be "berblick").
    if (/[^A-Za-z0-9 ,'()-]/.test(t.title)) throw new Error(`section "${t.title}": use only ASCII letters, digits, and spaces in a heading`);
    if (!t.topic || !t.text) throw new Error(`section "${t.title}" has no name or no text`);
    if (seen.has(t.topic)) throw new Error(`two sections are named ${t.topic}`);
    seen.add(t.topic);
  }
  return topics;
}
