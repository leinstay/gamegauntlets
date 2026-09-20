// pio-global.js — tiny ES module bridge so the classic-script legacy world (pgwheel.js) can use the
// module-only public/js/pio/pio.js. Sets `window.GGPio = { createPio }` and fires `ggpio:ready` once
// available (module scripts execute after HTML parsing, so pgwheel.js — injected later, on first page
// load — never actually needs to wait for the event in practice, but the event exists for correctness).
// "?v=dev" is rewritten to the release hash by the deploy step (like the HTML files): static module imports
// do not inherit the query of the importing script, and unversioned modules were cached for a year.
import { createPio } from "./pio.js?v=dev";

window.GGPio = { createPio: createPio };
document.dispatchEvent(new CustomEvent("ggpio:ready"));
