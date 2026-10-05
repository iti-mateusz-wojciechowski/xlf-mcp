// Reaches the model's system prompt, so it is read before the model has decided
// what to do. Paid for on every request: carry only the ordering and the rules
// that prevent damage, and let tool descriptions do the rest.
export const SERVER_INSTRUCTIONS = `Business Central XLIFF (.xlf) maintenance: keep language files in step with the generated source .g.xlf, reuse existing translations, add languages.

Prefer these tools over hand-editing .xlf files: they change only the units that need it, so diffs stay minimal.

Order: xlf_status -> xlf_sync -> xlf_apply_matches -> xlf_list (filter "needs-any") -> xlf_set_targets for what is left. New language: xlf_create.

Never edit the source .g.xlf; it is compiler output. Before writing a translation, check xlf_find for the term's existing translation and keep %n placeholders intact. Previews are the default; pass write:true once the preview looks right.`;
