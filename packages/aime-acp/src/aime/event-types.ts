export interface EventMeta {
  readonly eventId?: string;
  readonly offset: number;
  readonly timestampMs: number;
  readonly rawType: string;
}

export interface NormalizedMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface NormalizedReference {
  readonly id: string;
  readonly title: string;
  readonly uri: string;
  readonly snippet: string;
}

export interface NormalizedPlan {
  readonly id?: string;
  readonly status: string;
}

export interface NormalizedPlanStep {
  readonly id?: string;
  readonly status?: string;
  readonly title?: string;
  readonly summary?: string;
}

export interface NormalizedToolCall {
  readonly id?: string;
  readonly name: string;
  readonly status?: string;
  readonly description?: string;
}

export type NormalizedAimeEvent =
  | { readonly kind: 'ping' }
  | (EventMeta & {
      readonly kind: 'message.create';
      readonly message: NormalizedMessage;
      readonly replyMessageId?: string;
    })
  | (EventMeta & {
      readonly kind: 'message.delta';
      readonly messageId: string;
      readonly content: string;
      readonly finished: boolean;
    })
  | (EventMeta & {
      readonly kind: 'progress';
      readonly status:
        | 'preparing'
        | 'thinking'
        | 'executing'
        | 'waiting_for_next';
    })
  | (EventMeta & { readonly kind: 'think.tips'; readonly text: string })
  | (EventMeta & {
      readonly kind: 'reference';
      readonly references: readonly NormalizedReference[];
    })
  | (EventMeta & {
      readonly kind: 'plan.update';
      readonly plan: NormalizedPlan;
    })
  | (EventMeta & {
      readonly kind: 'step.update';
      readonly step: NormalizedPlanStep;
    })
  | (EventMeta & {
      readonly kind: 'action.use_tool';
      readonly tool: NormalizedToolCall;
    })
  | (EventMeta & {
      readonly kind: 'action.tool_call_required';
      readonly question: string;
      readonly options: readonly string[];
    })
  | (EventMeta & { readonly kind: 'unknown' });
