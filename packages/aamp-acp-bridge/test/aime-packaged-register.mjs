import { register } from 'node:module'

if (!process.env.AIME_ACP_FAKE_SCENARIO || !process.env.AIME_ACP_FAKE_TRACE) {
  throw new Error('packaged AIME test loader requires isolated scenario and trace files')
}

register(new URL('./aime-packaged-loader.mjs', import.meta.url).href, import.meta.url)
