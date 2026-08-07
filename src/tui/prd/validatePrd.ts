// validatePrd.ts — the AUTHORING view of the domain-layer validator
// (src/prdload.ts), which loop/wizard import directly without a tui edge.
// Everything on this side of the shim (planner replies, studio header, finalize
// and run gates) is a PRD being written right now, so it also has to satisfy
// "unverified branches forbidden": a task with no verify ships a gate that can
// never fail. The load path stays lenient — see ValidatePrdOptions.
import { validatePrd as validate, type ValidatePrdOptions } from "../../prdload.js";

export function validatePrd(obj: unknown, opts?: ValidatePrdOptions): { ok: boolean; errors: string[] } {
  return validate(obj, { requireVerify: true, ...opts });
}

export type { PRD } from "../../prd.js";
