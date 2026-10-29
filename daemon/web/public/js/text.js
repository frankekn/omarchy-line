// Split message text into safe link, mention and plain segments. No DOM
// dependencies.
export function splitText(input, mentions) {
  const text = String(input || ""), links = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    const raw = match[0].replace(/[.,!?;:)\]}]+$/, "");
    try {
      const url = new URL(raw);
      if (
        (url.protocol === "http:" || url.protocol === "https:") && raw.length
      ) {
        links.push({
          start: match.index,
          end: match.index + raw.length,
          url: url.href,
        });
      }
    } catch { /* Invalid URLs stay as plain text. */ }
  }
  const spans = (Array.isArray(mentions) ? mentions : []).filter((m) =>
    Number.isInteger(m.start) && Number.isInteger(m.end) && m.start >= 0 &&
    m.end > m.start && m.end <= text.length
  );
  const boundaries = new Set([0, text.length]);
  for (const range of [...links, ...spans]) {
    boundaries.add(range.start);
    boundaries.add(range.end);
  }
  const points = [...boundaries].sort((a, b) => a - b), segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i],
      end = points[i + 1],
      value = text.slice(start, end);
    if (!value) continue;
    const link = links.find((item) => item.start <= start && item.end >= end);
    segments.push({
      text: value,
      url: link?.url || "",
      mention: spans.some((item) => item.start <= start && item.end >= end),
    });
  }
  return segments;
}
