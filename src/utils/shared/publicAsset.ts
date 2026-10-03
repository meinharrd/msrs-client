/**
 * URL of a file in `public/`, honouring Vite's `base`. A normal build keeps `/assets/...`; a relative-base
 * build (RELATIVE_BASE=true) yields `./assets/...`, which works under a sub-path and at a Swarm root alike.
 */
export function publicAsset(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`;
}
