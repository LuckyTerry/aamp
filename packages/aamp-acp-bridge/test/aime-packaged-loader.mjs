const fakeModule = new URL('./aime-packaged-fake-bytedcli.mjs', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@bytedance-dev/bytedcli') {
    return { url: fakeModule, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
