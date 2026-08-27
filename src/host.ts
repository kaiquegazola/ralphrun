export const HOST_PLATFORMS = [
  "aix",
  "android",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "openbsd",
  "sunos",
  "win32",
] as const;

export type HostPlatform = (typeof HOST_PLATFORMS)[number];
export type RequiredHost = HostPlatform | HostPlatform[];

const HOST_SET = new Set<string>(HOST_PLATFORMS);

export function isHostPlatform(value: unknown): value is HostPlatform {
  return typeof value === "string" && HOST_SET.has(value);
}

export function isRequiredHost(value: unknown): value is RequiredHost {
  if (isHostPlatform(value)) return true;
  return Array.isArray(value) && value.length > 0 && value.every(isHostPlatform);
}

export function hostRequirementLabel(required: RequiredHost): string {
  return Array.isArray(required) ? required.join(", ") : required;
}

export function hostMismatch(required: RequiredHost | undefined, platform: NodeJS.Platform = process.platform): string | null {
  if (!required) return null;
  const allowed = Array.isArray(required) ? required : [required];
  if (allowed.includes(platform as HostPlatform)) return null;
  return `required_host=${hostRequirementLabel(required)}; current_host=${platform}`;
}