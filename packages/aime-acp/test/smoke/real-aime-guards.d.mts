export interface ToolProfile {
  readonly expectedToolTitle: 'lookup';
  readonly prompt: string;
}

export function resolveToolProfile(name: unknown): ToolProfile;
export function observeLiveDeltaBeforeTerminal<T>(
  startPrompt: (onUpdate: (update: unknown) => void) => Promise<T>,
  timeoutMs: number,
): Promise<T>;
export function createEvidenceGetter(
  kind: string,
  frames: readonly unknown[],
  stderr: () => string,
): () => {
  readonly kind: string;
  readonly frames: readonly unknown[];
  readonly stderr: string;
};
export function assertSafeToolTurn(
  updates: readonly unknown[],
  allowedName: string,
): void;
export function scanPrivacyEvidence(
  evidence: string,
  forbiddenValues: readonly string[],
): void;

export interface EphemeralEvidenceLog {
  readonly path: string;
  append(value: unknown): Promise<void>;
  sync(): Promise<void>;
  readAndScan(forbiddenValues: readonly string[]): Promise<string>;
  closeAndDelete(): Promise<void>;
}

export function createEphemeralEvidenceLog(
  root: string,
): Promise<EphemeralEvidenceLog>;
