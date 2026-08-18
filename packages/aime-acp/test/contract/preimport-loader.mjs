export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@bytedance-dev/bytedcli' || specifier === './program.js') {
    throw new Error('TEST_FORBIDDEN_PREIMPORT_RESOLUTION');
  }
  return nextResolve(specifier, context);
}
