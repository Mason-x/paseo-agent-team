export const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,47}$/;

export function isSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

export function slugify(name: string, fallback = "item"): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!slug) return fallback.slice(0, 48);
  if (!/^[a-z]/.test(slug)) return `${fallback.charAt(0)}-${slug}`.slice(0, 48);
  return slug;
}

/** Tracks whether an ID should still follow name edits. Used so CJK composition does not rewrite the sibling ID field. */
export type AutoSlug = {
  reset(locked: boolean, id: string, name: string): void;
  nextFromName(locked: boolean, name: string): string | null;
  markManual(): void;
  resolve(locked: boolean, name: string, id: string): string;
};

export function createAutoSlug(fallback: string): AutoSlug {
  let follows = true;
  return {
    reset(locked, id, name) {
      follows = !locked && (!isSlug(id) || id === slugify(name, fallback));
    },
    nextFromName(locked, name) {
      if (locked || !follows) return null;
      return slugify(name, fallback);
    },
    markManual() {
      follows = false;
    },
    resolve(locked, name, id) {
      if (locked || !follows) return id;
      return slugify(name, fallback);
    },
  };
}

export function uniqueCopyId(baseId: string, existingIds: ReadonlySet<string>): string {
  const root = baseId.replace(/-copy(?:-\d+)?$/, "");
  let candidate = `${root}-copy`.slice(0, 48);
  let n = 2;
  while (existingIds.has(candidate) || !isSlug(candidate)) {
    const suffix = `-copy-${n}`;
    candidate = `${root.slice(0, 48 - suffix.length)}${suffix}`;
    n += 1;
    if (n > 99) break;
  }
  return candidate;
}
