export const DEFAULT_PROFILE_NAME = "default";

export function profilesRoot(hermesHome: string): string {
  return `${hermesHome}\\profiles`;
}

export function getProfileHome(
  hermesHome: string,
  name: string,
): { name: string; root: string; isDefault: boolean } {
  const isDefault = name === DEFAULT_PROFILE_NAME;
  return {
    name,
    root: isDefault ? hermesHome : `${profilesRoot(hermesHome)}\\${name}`,
    isDefault,
  };
}

export function isDefaultProfileName(name: string): boolean {
  return name === DEFAULT_PROFILE_NAME;
}
