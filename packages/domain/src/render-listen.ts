export const LISTEN_RENDER_BIT_DEPTH = 16;

const UUID_STEM =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function slugifyRenderName(name: string): string {
  const stripped = name.replace(/\.(flac|wav)$/i, "");
  const slug = stripped
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80)
    .replace(/[-.]+$/g, "");
  if (!slug || WINDOWS_RESERVED.test(slug)) {
    return "mix";
  }
  return slug;
}

export function listenRenderFileName(planName: string, masterStem: string): string {
  let slug = slugifyRenderName(planName);
  if (slug === masterStem.toLowerCase() || UUID_STEM.test(slug)) {
    slug = `${slug}-listen`;
  }
  return `${slug}.flac`;
}

export function listenRenderRelPath(planName: string, masterStem: string): string {
  return `renders/${listenRenderFileName(planName, masterStem)}`;
}
