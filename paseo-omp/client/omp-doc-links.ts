import type { OmpSettingCategory } from "../shared/omp-settings";

const OMP_GITHUB_DOCS = "https://github.com/can1357/oh-my-pi/blob/main/docs";

export interface OmpDocumentationLink {
  label: string;
  accessibilityLabel: string;
  url: string;
}

function settingsLink(
  label: string,
  accessibilityLabel: string,
  anchor?: string,
): OmpDocumentationLink {
  return {
    label,
    accessibilityLabel,
    url: `${OMP_GITHUB_DOCS}/settings.md${anchor ? `#${anchor}` : ""}`,
  };
}

export const OMP_SETTINGS_REFERENCE = settingsLink(
  "Settings reference",
  "Open official OMP settings reference",
);

export const OMP_SETTINGS_GUIDES: readonly OmpDocumentationLink[] = [
  settingsLink(
    "Reading & writing",
    "Open official OMP guide to reading and writing settings",
    "reading-and-writing-settings",
  ),
  settingsLink("Value parsing", "Open official OMP value parsing guide", "value-parsing"),
  settingsLink("Precedence", "Open official OMP configuration precedence guide", "precedence"),
];

const CATEGORY_DOCUMENTATION: Partial<Record<OmpSettingCategory, OmpDocumentationLink>> = {
  appearance: settingsLink(
    "Appearance docs",
    "Open official OMP appearance and terminal settings documentation",
    "appearance-and-terminal",
  ),
  model: {
    label: "Model roles docs",
    accessibilityLabel: "Open official OMP model roles and settings documentation",
    url: `${OMP_GITHUB_DOCS}/models.md#role-aliases-and-settings`,
  },
  interaction: settingsLink(
    "Interaction docs",
    "Open official OMP interaction settings documentation",
    "interaction",
  ),
  context: settingsLink(
    "Context docs",
    "Open official OMP context and compaction settings documentation",
    "context-compaction-and-memory",
  ),
  memory: settingsLink(
    "Memory docs",
    "Open official OMP memory settings documentation",
    "context-compaction-and-memory",
  ),
  files: settingsLink(
    "File docs",
    "Open official OMP editing and reading settings documentation",
    "files-editing-and-reading",
  ),
  shell: settingsLink(
    "Shell docs",
    "Open official OMP shell, eval, and LSP settings documentation",
    "shell-eval-and-lsp",
  ),
  tools: settingsLink(
    "Tool docs",
    "Open official OMP tools and approvals settings documentation",
    "tools-and-approvals",
  ),
  providers: settingsLink(
    "Provider docs",
    "Open official OMP providers and services settings documentation",
    "providers-and-services",
  ),
};

const SETTING_DOCUMENTATION: Readonly<Record<string, OmpDocumentationLink>> = {
  modelRoleStorage: settingsLink(
    "Write location docs",
    "Open official OMP documentation for model role write locations",
    "where-writes-go",
  ),
  enabledModels: settingsLink(
    "Path scope docs",
    "Open official OMP documentation for path-scoped model settings",
    "path-scoped-arrays",
  ),
  enabledProviders: settingsLink(
    "Discovery docs",
    "Open official OMP provider and source discovery documentation",
    "provider-and-source-disabling",
  ),
  disabledProviders: settingsLink(
    "Discovery docs",
    "Open official OMP provider and source discovery documentation",
    "provider-and-source-disabling",
  ),
};

export function documentationForSettingCategory(
  category: OmpSettingCategory,
): OmpDocumentationLink | undefined {
  return CATEGORY_DOCUMENTATION[category];
}

export function documentationForSettingPath(path: string): OmpDocumentationLink | undefined {
  return SETTING_DOCUMENTATION[path];
}
