export function textContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textContent).join('');
  if (
    typeof value === 'object' &&
    value !== null &&
    value.type === 'text' &&
    typeof value.text === 'string'
  ) {
    return value.text;
  }
  return '';
}

export function agentMessageText(frames) {
  return frames
    .filter(
      (frame) => frame?.params?.update?.sessionUpdate === 'agent_message_chunk',
    )
    .map((frame) => textContent(frame.params.update.content))
    .join('')
    .trim();
}
