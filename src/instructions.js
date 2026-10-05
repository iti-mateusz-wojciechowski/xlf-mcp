// Reaches the model's system prompt, so it is read before the model has decided
// what to do. Paid for on every request: carry only the ordering and the one rule
// that prevents damage, and let tool descriptions do the rest.
export const SERVER_INSTRUCTIONS = `Business Central XLIFF (.xlf) maintenance: sync target language files with the generated source .g.xlf, and fill empty targets from existing translations.

Prefer these tools over hand-editing .xlf files: they rewrite only the elements that change, so untouched units keep their exact bytes.

Order: xlf_status -> xlf_sync -> xlf_apply_matches -> xlf_list (filter "empty") -> xlf_set_targets for what is left.

Never edit the source .g.xlf; it is compiler output. Previews are the default; pass write:true once the preview looks right rather than previewing twice.`;
