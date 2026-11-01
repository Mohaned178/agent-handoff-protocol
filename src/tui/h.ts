// Views are built without JSX (spec D2): Node runs `src/` from source with type stripping, which has no JSX transform,
// so `h(Box, { ... }, child)` stands in for `<Box ...>child</Box>`.

import { createElement } from "react";

export const h = createElement;
