/**
 * Reads ruvnet/ruflo `.claude/agents` markdown files and writes
 * `shared/templates/ruflo-catalog.ts`.
 *
 * Usage:
 *   git clone --depth 1 --filter=blob:none --sparse https://github.com/ruvnet/ruflo.git .tmp-ruflo-agents
 *   git -C .tmp-ruflo-agents sparse-checkout set .claude/agents
 *   node scripts/import-ruflo-agents.mjs
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const sourceRoot = join(root, ".tmp-ruflo-agents", ".claude", "agents");
const outFile = join(root, "shared", "templates", "ruflo-catalog.ts");

const SKIP_NAMES = new Set(["MIGRATION_SUMMARY.md", "README.md"]);
const PREAMBLE =
  "You are running as a Paseo Agent Team role. Coordinate with create_agent and send_agent_prompt. Do not call claude-flow, ruflo, or mcp__claude-flow tools. Prefer existing roster members. Return every output-contract item.\n\n";
const DEFAULT_RESTRICTION =
  "Do not call claude-flow, ruflo, or mcp__claude-flow tools. Use Paseo create_agent and send_agent_prompt.";
const SHELL_SPAWN =
  /codex exec|claude -p|skip-git-repo-check|workspace-write|--sandbox\s+workspace-write/i;
const IDENTITY_COLORS = [
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
];
const CATEGORY_ICONS = {
  analysis: "Search",
  architecture: "Layers",
  consensus: "GitBranch",
  core: "Code",
  custom: "Wrench",
  data: "Database",
  development: "Terminal",
  devops: "Rocket",
  documentation: "FileText",
  "dual-mode": "GitBranch",
  "flow-nexus": "Cloud",
  github: "GitBranch",
  goal: "Compass",
  "hive-mind": "Brain",
  neural: "Brain",
  optimization: "Cpu",
  payments: "Package",
  reasoning: "Sparkles",
  security: "Shield",
  sona: "Brain",
  sparc: "Compass",
  specialized: "Boxes",
  specialists: "Wrench",
  sublinear: "Cpu",
  swarm: "Boxes",
  templates: "FileText",
  testing: "FlaskConical",
  v3: "Sparkles",
};
const COORD_HINT = /coordinator|orchestrator|queen/;
const CLAUDE_HINT =
  /coordinator|orchestrator|queen|planner|architect|reviewer|researcher|analyst|security|spec/;
const MAX_MEMBERS = 8;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".md") && !SKIP_NAMES.has(name)) out.push(full);
  }
  return out;
}

function parseFrontmatter(text) {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { fm: {}, body: text.trim() };
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { fm: {}, body: text.trim() };
  const raw = text.slice(3, end).replace(/^\r?\n/, "");
  const body = text.slice(end + 4).trim();
  const fm = {};
  let key = null;
  let multiline = false;
  const acc = [];
  const flush = () => {
    if (key && multiline) fm[key] = acc.join(" ").trim();
    multiline = false;
    acc.length = 0;
  };
  for (const line of raw.split(/\r?\n/)) {
    if (multiline) {
      if (/^[A-Za-z][\w-]*:\s*/.test(line) && !line.startsWith(" ")) {
        flush();
      } else {
        acc.push(line.trim());
        continue;
      }
    }
    const match = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!match) continue;
    key = match[1];
    const rest = match[2];
    if (rest === "|" || rest === ">") {
      multiline = true;
      acc.length = 0;
    } else {
      fm[key] = rest.replace(/^["']|["']$/g, "").trim();
    }
  }
  flush();
  return { fm, body };
}

function slugify(value, fallback = "role") {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!slug) return fallback.slice(0, 48);
  if (!/^[a-z]/.test(slug)) return `${fallback.charAt(0)}-${slug}`.slice(0, 48);
  return slug;
}

function titleCase(value) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\bApi\b/g, "API")
    .replace(/\bCicd\b/g, "CI/CD")
    .replace(/\bSparc\b/g, "SPARC")
    .replace(/\bMl\b/g, "ML")
    .replace(/\bTdd\b/g, "TDD")
    .replace(/\bPr\b/g, "PR")
    .replace(/\bCi\b/g, "CI");
}

function displayName(fmName, fileStem) {
  const fromFm = fmName.includes(" ") ? fmName : titleCase(fmName);
  const fromFile = titleCase(fileStem);
  const pick = fromFile.length > fromFm.length ? fromFile : fromFm;
  return clipLine(pick, 40);
}

function clipLine(value, max) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd();
}

function clipText(value, max) {
  const text = value.trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd();
}

function hashColor(id) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return IDENTITY_COLORS[hash % IDENTITY_COLORS.length];
}

function extractBullets(body, headingPattern) {
  const heading = body.search(headingPattern);
  const section = heading === -1 ? body : body.slice(heading);
  const next = section.search(/\n## /);
  const block = next === -1 ? section.slice(0, 4000) : section.slice(0, next);
  const items = [];
  const patterns = [/^\s*(?:[-*]|\d+\.)\s+\*\*(.+?)\*\*:?\s*(.*)$/, /^\s*(?:[-*]|\d+\.)\s+(.+)$/];
  for (const line of block.split(/\r?\n/)) {
    let item = "";
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (!match) continue;
      item = match[2] ? `${match[1]}: ${match[2]}` : match[1];
      break;
    }
    item = item.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
    if (item.length < 8) continue;
    items.push(clipLine(item, 500));
    if (items.length >= 8) break;
  }
  return items;
}

function firstParagraph(body) {
  const text = body.replace(/^#.+\n+/, "");
  const youAre = text.match(/You are[^\n]+(?:\n(?!#|\s*```)[^\n]+){0,2}/);
  if (youAre) return clipLine(youAre[0], 2000);
  const first =
    text
      .split(/\n\n/)[0]
      ?.replace(/```[\s\S]*$/g, "")
      .replace(/\s+/g, " ")
      .trim() ?? "";
  return clipLine(first, 2000);
}

function stripClaudeFlow(body) {
  return body
    .replace(/```[\w-]*\n[\s\S]*?```/g, (block) => (/mcp__claude-flow/i.test(block) ? "" : block))
    .replace(/mcp__claude-flow__[A-Za-z0-9_]+/g, "Paseo tools")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function categoryOf(rel) {
  const parts = rel.split(/[/\\]/);
  if (parts.length === 1) return "specialists";
  return parts[0];
}

function scorePath(rel) {
  const lower = rel.replace(/\\/g, "/").toLowerCase();
  let score = lower.split("/").length;
  if (lower.startsWith("v3/")) score += 20;
  if (lower.startsWith("templates/")) score += 10;
  return score;
}

function preferredProviders(id, category) {
  if (CLAUDE_HINT.test(id) || /sparc|hive-mind|swarm|goal|reasoning/.test(category)) {
    return ["claude"];
  }
  if (/coder|tester|worker|dev|implementer|specialist|engineer/.test(id)) return ["codex"];
  return ["claude"];
}

function restrictionsFor(id, category) {
  const items = [DEFAULT_RESTRICTION];
  if (/researcher|analyst|analyzer|reviewer/.test(id) || category === "analysis") {
    items.push(
      "Do not edit, create, or delete files unless the coordinator assigns implementation.",
    );
  }
  return items;
}

function outputContract(body) {
  const items = extractBullets(body, /^## .*output/im);
  if (items.length > 0) return items.slice(0, 6);
  return ["Deliverable", "Evidence", "Open issues"];
}

const files = walk(sourceRoot).sort((a, b) => {
  const ra = relative(sourceRoot, a);
  const rb = relative(sourceRoot, b);
  return scorePath(ra) - scorePath(rb) || ra.localeCompare(rb);
});

const byId = new Map();
for (const file of files) {
  const rel = relative(sourceRoot, file);
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const { fm, body } = parseFrontmatter(text);
  if (String(fm.type ?? "").toLowerCase() === "documentation") continue;
  const fileStem = file.replace(/\\/g, "/").split("/").pop().replace(/\.md$/, "");
  const rawName = fm.name || fileStem;
  const id = slugify(rawName, slugify(fileStem, "role"));
  if (byId.has(id)) continue;
  const cleaned = stripClaudeFlow(body);
  const mission = firstParagraph(cleaned) || clipLine(fm.description || rawName, 2000);
  const responsibilities = extractBullets(cleaned, /^## .*?(responsib|purpose)/im);
  const category = categoryOf(rel);
  if (category === "dual-mode") continue;
  const name = displayName(rawName, fileStem);
  const prompt = clipText(`${PREAMBLE}${cleaned || mission}`, 20000);
  if (
    SHELL_SPAWN.test(prompt) ||
    SHELL_SPAWN.test(mission) ||
    responsibilities.some((item) => SHELL_SPAWN.test(item))
  ) {
    continue;
  }
  byId.set(id, {
    id,
    name,
    description: clipLine(fm.description || mission, 160),
    mission: mission || name,
    responsibilities: (responsibilities.length > 0
      ? responsibilities
      : [clipLine(mission || name, 500)]
    ).slice(0, 8),
    restrictions: restrictionsFor(id, category),
    systemPrompt: prompt,
    outputContract: outputContract(cleaned),
    preferredProviders: preferredProviders(id, category),
    color: hashColor(id),
    icon: CATEGORY_ICONS[category] ?? "Code",
    category,
  });
}

const roles = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
const grouped = new Map();
for (const role of roles) {
  const list = grouped.get(role.category) ?? [];
  list.push(role);
  grouped.set(role.category, list);
}

function pickCoordinator(list) {
  return (
    list.find((role) => COORD_HINT.test(role.id) || COORD_HINT.test(role.name.toLowerCase())) ??
    list[0]
  );
}

const teams = [];
const usedAsTeam = new Set();
for (const [category, list] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  if (list.length < 2) continue;
  const coordinator = pickCoordinator(list);
  const members = list.filter((role) => role.id !== coordinator.id).slice(0, MAX_MEMBERS);
  if (members.length === 0) continue;
  const id = slugify(`${category}-team`, "team");
  teams.push({
    id,
    name: clipLine(titleCase(`${category} team`), 40),
    description: clipLine(
      `Ruflo ${category} roles: ${coordinator.name} coordinates ${members.map((role) => role.name).join(", ")}.`,
      160,
    ),
    coordinatorRoleId: coordinator.id,
    memberRoleIds: members.map((role) => role.id),
    operatingRules:
      "Coordinator decomposes work with send_agent_prompt. Implementation and independent review stay on different members. Do not call claude-flow tools.",
  });
  usedAsTeam.add(category);
}

const leftovers = roles.filter((role) => !usedAsTeam.has(role.category));
if (leftovers.length >= 2) {
  const coordinator =
    leftovers.find((role) => role.id === "project-coordinator") ?? pickCoordinator(leftovers);
  const members = leftovers.filter((role) => role.id !== coordinator.id).slice(0, MAX_MEMBERS);
  if (members.length > 0) {
    teams.push({
      id: "specialists-team",
      name: "Specialists Team",
      description: "Language, mobile, data, security, and other singleton Ruflo specialists.",
      coordinatorRoleId: coordinator.id,
      memberRoleIds: members.map((role) => role.id),
      operatingRules:
        "Assign the specialist that matches the stack. Coordinator synthesizes; specialists stay in their domain.",
    });
  }
}

const featured = [
  {
    id: "coding-team",
    name: "Coding Team",
    description: "Plan, implement, test, and independently review a software change.",
    coordinatorRoleId: "hierarchical-coordinator",
    memberRoleIds: [
      "planner",
      "system-architect",
      "coder",
      "backend-dev",
      "tester",
      "reviewer",
    ].filter((id) => byId.has(id)),
    operatingRules:
      "Implementation and independent review must be done by different members. When two members would edit the same files, sequence them or send one to a separate worktree via create_workspace.",
  },
  {
    id: "research-team",
    name: "Research Team",
    description: "Investigate a question with sources, checks, and a cautious conclusion.",
    coordinatorRoleId: "planner",
    memberRoleIds: [
      "researcher",
      "code-analyzer",
      "analyst",
      "api-docs",
      "security-auditor",
    ].filter((id) => byId.has(id)),
    operatingRules:
      "Research members must not edit project files. Quote sources. Separate supported claims from speculation.",
  },
].filter((team) => byId.has(team.coordinatorRoleId) && team.memberRoleIds.length > 0);

const teamById = new Map();
for (const team of [...featured, ...teams]) {
  if (!teamById.has(team.id)) teamById.set(team.id, team);
}

mkdirSync(dirname(outFile), { recursive: true });
const header = `/* Generated from ruvnet/ruflo .claude/agents. Do not edit by hand.
 * Refresh: node scripts/import-ruflo-agents.mjs
 */
import type { Role } from "../schemas/role";
import type { Team } from "../schemas/team";
import { bindPreferredProfile, type HostProfile } from "./types";

export type RufloRoleSpec = {
  id: string;
  name: string;
  description: string;
  mission: string;
  responsibilities: string[];
  restrictions: string[];
  systemPrompt: string;
  outputContract: string[];
  preferredProviders: string[];
  color: string;
  icon: string;
  category: string;
};

export type RufloTeamSpec = {
  id: string;
  name: string;
  description: string;
  coordinatorRoleId: string;
  memberRoleIds: string[];
  operatingRules: string;
};

export const RUFLO_ROLE_SPECS: readonly RufloRoleSpec[] = ${JSON.stringify(roles, null, 2)};

export const RUFLO_TEAM_SPECS: readonly RufloTeamSpec[] = ${JSON.stringify([...teamById.values()], null, 2)};

export function rufloRoles(profiles: readonly HostProfile[], now: string): Role[] {
  return RUFLO_ROLE_SPECS.map((spec) => ({
    id: spec.id,
    name: spec.name,
    description: spec.description,
    mission: spec.mission,
    responsibilities: spec.responsibilities,
    restrictions: spec.restrictions,
    systemPrompt: spec.systemPrompt,
    outputContract: spec.outputContract,
    preferredProfiles: [bindPreferredProfile(profiles, spec.preferredProviders)],
    fallbackProfiles: [],
    color: spec.color,
    icon: spec.icon,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }));
}

export function rufloTeams(now: string): Team[] {
  return RUFLO_TEAM_SPECS.map((spec) => ({
    id: spec.id,
    name: spec.name,
    description: spec.description,
    coordinatorRoleId: spec.coordinatorRoleId,
    members: spec.memberRoleIds.map((roleId) => ({ roleId, enabled: true })),
    operatingRules: spec.operatingRules,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }));
}
`;
writeFileSync(outFile, header);
console.log(`Wrote ${roles.length} roles and ${teamById.size} teams to ${relative(root, outFile)}`);
