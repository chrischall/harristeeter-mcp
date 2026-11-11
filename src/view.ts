import { createViewKit } from '@chrischall/mcp-utils';

export const { viewArg, viewResponse } = createViewKit(['compact', 'full', 'raw'], {
  note: 'compact returns a projection of the documented fields; "full" returns the API payload minified; "raw" pretty-prints it.',
  label: 'harristeeter-mcp',
});
