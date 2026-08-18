const fakeBytedcli = `
const touchAcp = () => { throw new Error('ACP_TOUCH_SENTINEL'); };
export const auth = {
  async getExternalBytecloudAuthStatus() { return { authenticated: false }; },
  async byteCloudAuthEnsureAuth() { return { status: 'ready' }; },
  async byteCloudAuthUserInfo() { return { employeeId: 'test-user' }; },
  async byteCloudAuthLogin() { return { status: 'success' }; },
  async byteCloudAuthBeginLogin() { return {}; },
  async byteCloudAuthCompleteLogin() { return { status: 'success' }; },
};
export const utils = {
  setCloudSite() {}, setAuthAs() {}, setHttpConfig() {},
};
export const api = { aime: {
  async listSpaces() { return { spaces: [{ id: 'test-space', type: 'personal', status: 'active' }] }; },
  async listModels() { touchAcp(); },
  async createSession() { touchAcp(); },
  async getSession() { touchAcp(); },
  async sendMessage() { touchAcp(); },
  async *streamEvents() { touchAcp(); },
} };
`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@bytedance-dev/bytedcli') {
    return {
      shortCircuit: true,
      url: `data:text/javascript,${encodeURIComponent(fakeBytedcli)}`,
    };
  }
  return nextResolve(specifier, context);
}
