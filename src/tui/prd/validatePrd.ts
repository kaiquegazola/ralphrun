// validatePrd.ts — re-export shim; the validator lives in the domain-layer
// pipeline (src/prdload.ts) so loop/wizard can import it without a tui edge.
export { validatePrd } from "../../prdload.js";
export type { PRD } from "../../prd.js";
