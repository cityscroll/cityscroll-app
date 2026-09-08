/** Count rendered article prose, excluding navigation, metadata and link URLs. */
export function guideWordCounts(html) {
  const words = (value) => (value.replace(/<[^>]*>/g, " ")
    .replace(/&(?:[a-z]+|#\d+|#x[\da-f]+);/gi, " ")
    .match(/[\p{L}\p{N}]+(?:['’−-][\p{L}\p{N}]+)*/gu) || []).length;
  const body = html.match(/<div class="guide-body">([\s\S]*?)\n  <\/div>/)?.[1] || "";
  const framing = [...html.matchAll(/<p class="(?:node-lede|guide-question|guide-notice[^\"]*)">([\s\S]*?)<\/p>/g)]
    .map((match) => match[1]).join(" ");
  // Closed disclosure content is not on the initial reading path; its summary is.
  const visible = (value) => value.replace(/<details\b(?![^>]*\bopen\b)[^>]*>([\s\S]*?)<\/details>/g,
    (_, contents) => contents.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1] || "");
  return { visible_main_path: words(visible(framing + body)), total_body: words(body) };
}
