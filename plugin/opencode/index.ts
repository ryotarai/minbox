/**
 * Entry of the minbox plugin for OpenCode 2.x: the folder minbox lists in OPENCODE_CONFIG_CONTENT's
 * "plugins". A plain object with `id` and `setup` is what `Plugin.define` from @opencode/plugin returns,
 * so the plugin needs no package (verified with OpenCode 2.1.4). The work is in minbox.ts.
 */
import { realDeps, setupLocation, sharedCore } from './minbox.ts'

export default {
  id: 'minbox',
  async setup(ctx: any) {
    return setupLocation(ctx, sharedCore(realDeps()), (msg) => console.error(msg))
  },
}
