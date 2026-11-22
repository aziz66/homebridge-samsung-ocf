/**
 * OCF discovery helpers: parse the /device/0 batch and /oic/res directory.
 *
 * The /device/0 "batch" is a CBOR list: a leading device-collection rep, then
 * {href, rep} entries. A bare {href} entry is a STUB ("resource exists, not
 * fetched yet"), distinct from an empty {} rep (confirmed empty). Mirrors the
 * reference registry/batch.py:parse_device0_batch + is_stub_rep.
 */
export type Rep = Record<string, unknown>;

export function isStubRep(rep: unknown): boolean {
  return !!rep && typeof rep === "object" && Object.keys(rep as object).length === 1 && "href" in (rep as object);
}

/** Parse a /device/0 batch list into {href: rep}, dropping stub placeholders. */
export function parseDevice0Batch(device0: unknown[]): Record<string, Rep> {
  const out: Record<string, Rep> = {};
  for (const item of device0) {
    if (item && typeof item === "object" && "href" in item) {
      const href = (item as { href: string }).href;
      const rep = (item as { rep?: Rep }).rep;
      if (rep && typeof rep === "object" && !isStubRep({ ...rep, href })) {
        out[href] = rep;
      } else if (rep && typeof rep === "object") {
        out[href] = rep;
      }
    }
  }
  return out;
}

export interface OcfLink {
  href: string;
  rt?: string[];
  if?: string[];
  p?: { bm?: number };
  eps?: Array<{ ep: string }>;
}

/** Device types (oic.d.*) and platform identity extracted from /oic/d + /oic/res. */
export function deviceTypesFrom(oicD?: Rep, oicRes?: OcfLink[]): string[] {
  const types = new Set<string>();
  const rt = (oicD?.["rt"] as string[]) ?? [];
  for (const t of rt) types.add(t);
  // /oic/res device-collection link also advertises the device types
  for (const l of oicRes ?? []) {
    if (l.href === "/oic/d" || (l.rt ?? []).some((t) => t.startsWith("oic.d.") || t === "oic.wk.d")) {
      for (const t of l.rt ?? []) types.add(t);
    }
  }
  return [...types];
}
