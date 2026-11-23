/** Index of `url` in `text` where it is a complete URL, not the prefix of a longer one (`.../pull/7` in `.../pull/70`). -1 if absent. */
export function urlIndex(text: string, url: string): number {
  for (let at = text.indexOf(url); at >= 0; at = text.indexOf(url, at + 1)) {
    if (!/[\w/-]/.test(text.charAt(at + url.length))) return at;
  }
  return -1;
}
