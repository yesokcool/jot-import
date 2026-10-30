/**
 * The longest version of `path` that `fits`, cut in the middle (CSS can only cut at an end): folders give way
 * first ("Work/20…/Weekly notes.md"), then the name's own middle ("Weekly…es.md").
 */
export function middleCut(path: string, fits: (text: string) => boolean): string {
  if (fits(path)) return path;
  const slash = path.lastIndexOf("/");
  if (slash > 0) {
    // Code points, so an emoji in a folder name is never split in half.
    const head = Array.from(path.slice(0, slash));
    const tail = path.slice(slash);
    const keep = longest(head.length - 1, (n) => fits(`${head.slice(0, n).join("")}…${tail}`));
    if (keep >= 0) return `${head.slice(0, keep).join("")}…${tail}`;
  }
  const name = Array.from(slash > 0 ? path.slice(slash + 1) : path);
  const cut = (n: number) => `${name.slice(0, Math.ceil(n / 2)).join("")}…${name.slice(name.length - Math.floor(n / 2)).join("")}`;
  const keep = longest(name.length - 1, (n) => fits(cut(n)));
  return keep >= 0 ? cut(keep) : "…";
}

/** Binary search: the largest n in 0..max where `ok` holds (true up to some n, false after), or -1. */
function longest(max: number, ok: (n: number) => boolean): number {
  let lo = 0;
  let hi = max;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
