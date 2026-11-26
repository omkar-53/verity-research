const rate = (value) => {
  if (!value?.trim()) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
};

export function modelUsage(env, provider, model, inputTokens, outputTokens, thinkingTokens = 0) {
  const inputRate = rate(env.GEMINI_INPUT_USD_PER_MTOK);
  const outputRate = rate(env.GEMINI_OUTPUT_USD_PER_MTOK);
  const estimatedUsd = provider === 'Ollama' ? 0 : inputRate === null || outputRate === null
    ? null
    : (inputTokens * inputRate + (outputTokens + thinkingTokens) * outputRate) / 1_000_000;
  return { kind: 'generation', provider, model, inputTokens, outputTokens, thinkingTokens, estimatedUsd };
}

export function summarizeUsage(events) {
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let thinkingTokens = 0;
  let embeddingCalls = 0;
  let embeddingTokens = 0;
  let estimatedUsd = 0;
  let unpricedCalls = 0;
  for (const event of events) {
    if (event.kind === 'embedding') {
      embeddingCalls++;
      embeddingTokens += event.inputTokens;
      continue;
    }
    calls++;
    inputTokens += event.inputTokens;
    outputTokens += event.outputTokens;
    thinkingTokens += event.thinkingTokens;
    if (event.estimatedUsd === null) unpricedCalls++;
    else estimatedUsd += event.estimatedUsd;
  }
  return { calls, inputTokens, outputTokens, thinkingTokens, embeddingCalls, embeddingTokens,
    cost: { estimatedUsd: unpricedCalls ? null : estimatedUsd, unpricedCalls } };
}
