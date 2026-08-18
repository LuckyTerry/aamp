const fakeModule = new URL('./shared-auth-module.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@bytedance-dev/bytedcli') {
    return { url: fakeModule, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
