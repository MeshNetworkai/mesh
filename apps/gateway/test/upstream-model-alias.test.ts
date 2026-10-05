import { describe, expect, it } from 'vitest';
import { parseModelPolicy, upstreamModelFor } from '@mesh/config';

describe('upstreamModelFor', () => {
  const policy = parseModelPolicy({ networkModels: { 'llama-3.1-8b': 'llama3.1:8b', 'meta-llama/llama-3.1-8b-instruct': 'llama3.1:8b', 'mesh/mock': 'mesh/mock' } });
  it('maps a short alias to the full upstream id with the same tag', () => {
    expect(upstreamModelFor(policy, 'llama-3.1-8b')).toBe('meta-llama/llama-3.1-8b-instruct');
  });
  it('leaves full ids and unknown models unchanged', () => {
    expect(upstreamModelFor(policy, 'meta-llama/llama-3.1-8b-instruct')).toBe('meta-llama/llama-3.1-8b-instruct');
    expect(upstreamModelFor(policy, 'anthropic/claude-3.5-sonnet')).toBe('anthropic/claude-3.5-sonnet');
    expect(upstreamModelFor(policy, 'mesh/mock')).toBe('mesh/mock');
  });
});
