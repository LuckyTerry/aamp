const fakeModule = new URL('./fake-bytedcli-module.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@bytedance-dev/bytedcli') {
    return { url: fakeModule, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
