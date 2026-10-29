/**
 * Netlify Build Plugin entry point. Netlify treats every named export of this module as an event handler and rejects
 * anything that is not an event name, so only the handlers are exported here. The implementation and its helpers live
 * in lib.js.
 */

export { onPostBuild, onSuccess } from "./lib.js";
