/** Native Paseo identity palette and Agent Profile icon set. */

export const IDENTITY_COLOR_NAMES = [
  "violet",
  "sky",
  "emerald",
  "orange",
  "pink",
  "indigo",
  "teal",
  "red",
  "amber",
  "blue",
] as const;

export type IdentityColorName = (typeof IDENTITY_COLOR_NAMES)[number];
export type IdentityColor = "none" | IdentityColorName;

const LEGACY_COLOR_ALIASES: Record<string, IdentityColorName> = {
  cyan: "sky",
  rose: "pink",
  green: "emerald",
  purple: "violet",
};

const IDENTITY_FOREGROUND_LIGHT: Record<IdentityColorName, string> = {
  violet: "#6d49b5",
  sky: "#3d6985",
  emerald: "#3e6e5d",
  orange: "#845838",
  pink: "#974168",
  indigo: "#5251c2",
  teal: "#3e6d6c",
  red: "#9c4243",
  amber: "#716239",
  blue: "#39649e",
};

const IDENTITY_FOREGROUND_DARK: Record<IdentityColorName, string> = {
  violet: "#a392d5",
  sky: "#6aa6ce",
  emerald: "#6cae96",
  orange: "#cc8f64",
  pink: "#d87da3",
  indigo: "#9299d5",
  teal: "#6cacab",
  red: "#d88381",
  amber: "#b29d64",
  blue: "#7ba1d5",
};

/** Native Agent Profile keys → Lucide names the plugin `Icon` can draw. */
const NATIVE_ICON_KEYS: Record<string, string> = {
  code: "Code",
  terminal: "Terminal",
  bug: "Bug",
  wrench: "Wrench",
  hammer: "Hammer",
  flask: "FlaskConical",
  testTube: "TestTube",
  microscope: "Microscope",
  search: "Search",
  eye: "Eye",
  palette: "Palette",
  feather: "Feather",
  pencil: "Pencil",
  fileText: "FileText",
  book: "BookOpen",
  rocket: "Rocket",
  package: "Package",
  boxes: "Boxes",
  server: "Server",
  database: "Database",
  cpu: "Cpu",
  cloud: "Cloud",
  globe: "Globe",
  gitBranch: "GitBranch",
  layers: "Layers",
  compass: "Compass",
  brain: "Brain",
  sparkles: "Sparkles",
  shield: "Shield",
};

/** Same 29 icons as native Agent Profile, in the same five-column order. */
export const ROLE_ICON_NAMES = [
  "Code",
  "Terminal",
  "Bug",
  "Wrench",
  "Hammer",
  "FlaskConical",
  "TestTube",
  "Microscope",
  "Search",
  "Eye",
  "Palette",
  "Feather",
  "Pencil",
  "FileText",
  "BookOpen",
  "Rocket",
  "Package",
  "Boxes",
  "Server",
  "Database",
  "Cpu",
  "Cloud",
  "Globe",
  "GitBranch",
  "Layers",
  "Compass",
  "Brain",
  "Sparkles",
  "Shield",
] as const;

const NATIVE_ICON_SET = new Set<string>(ROLE_ICON_NAMES);

export function pickerIconNames(current: string | undefined): string[] {
  const resolved = resolveRoleIcon(current);
  if (resolved === DEFAULT_ROLE_ICON || NATIVE_ICON_SET.has(resolved)) {
    return [...ROLE_ICON_NAMES];
  }
  return [...ROLE_ICON_NAMES, resolved];
}

export const DEFAULT_ROLE_ICON = "Star";

const LUCIDE_NAME = /^[A-Z][A-Za-z0-9]+$/;

export function isDarkSurface(hex: string): boolean {
  const value = hex.trim().replace("#", "");
  if (value.length < 6) return true;
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  if ([red, green, blue].some((channel) => Number.isNaN(channel))) return true;
  return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255 < 0.5;
}

export function resolveIdentityColor(value: string | undefined): IdentityColor {
  const trimmed = value?.trim().toLowerCase() ?? "";
  if (!trimmed) return "none";
  const aliased = LEGACY_COLOR_ALIASES[trimmed] ?? trimmed;
  return IDENTITY_COLOR_NAMES.some((name) => name === aliased)
    ? (aliased as IdentityColorName)
    : "none";
}

export function identityForeground(color: IdentityColor, surfaceHex: string): string | undefined {
  if (color === "none") return undefined;
  return isDarkSurface(surfaceHex)
    ? IDENTITY_FOREGROUND_DARK[color]
    : IDENTITY_FOREGROUND_LIGHT[color];
}

export function storedIdentityColor(color: IdentityColor): string | undefined {
  return color === "none" ? undefined : color;
}

export function resolveRoleIcon(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return DEFAULT_ROLE_ICON;
  const camel = trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
  const mapped = NATIVE_ICON_KEYS[trimmed] ?? NATIVE_ICON_KEYS[camel];
  if (mapped) return mapped;
  if (LUCIDE_NAME.test(trimmed)) return trimmed;
  return DEFAULT_ROLE_ICON;
}

export function storedRoleIcon(icon: string): string | undefined {
  const resolved = resolveRoleIcon(icon);
  return resolved === DEFAULT_ROLE_ICON ? undefined : resolved;
}

export function isDefaultRoleIcon(value: string | undefined): boolean {
  return !value?.trim() || resolveRoleIcon(value) === DEFAULT_ROLE_ICON;
}
