import { z } from "zod";
import { SLUG_PATTERN } from "../ids";

export const SlugSchema = z.string().regex(SLUG_PATTERN);
export const ShortTextSchema = z.string().trim().min(1).max(40);
export const DescriptionSchema = z.string().trim().max(160);
export const StringListSchema = z.array(z.string().trim().min(1).max(500)).max(30);

export function uniqueIds<K extends string>(key: K) {
  return (value: Record<K, Array<{ id: string }>>) => {
    const items = value[key];
    return new Set(items.map((item) => item.id)).size === items.length;
  };
}
