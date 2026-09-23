export type RoleSearchFields = {
  id: string;
  name: string;
  description?: string;
};

export function filterRoles<T extends RoleSearchFields>(roles: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...roles];
  return roles.filter((role) => {
    const haystack = `${role.name} ${role.id} ${role.description ?? ""}`.toLowerCase();
    return haystack.includes(needle);
  });
}
