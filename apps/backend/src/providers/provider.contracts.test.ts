import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { GatewayConfigService, trustedBase } from '../modules/ai/services/gateway-config.service';
import { GatewayTextService } from '../modules/ai/services/gateway-text.service';
test('gateway aliases do not depend on ARK credentials', () => {
  const cfg = new GatewayConfigService();
  assert.equal(cfg.alias('text'), 'openai-main');
  assert.equal(cfg.alias('video'), 'video-main');
  assert.throws(() => trustedBase('http://example.com', 'gateway'), /HTTPS/);
  assert.throws(() => trustedBase('https://user:key@example.com', 'gateway'), /Invalid/);
});
test('text adapter rejects cloud opt-out before transport and normalizes provider output', async () => {
  let calls = 0;
  const transport = {
    request: async () => {
      calls++;
      return { choices: [{ message: { content: 'hello' } }] };
    },
  };
  const deny = new GatewayTextService(
    new GatewayConfigService(),
    transport as never,
    {
      assert: async () => {
        throw new Error('disabled');
      },
    } as never
  );
  await assert.rejects(() => deny.chatCompletion({ messages: [] }), /disabled/);
  assert.equal(calls, 0);
  const allow = new GatewayTextService(
    new GatewayConfigService(),
    transport as never,
    { assert: async () => {} } as never
  );
  assert.deepEqual(await allow.chatCompletion({ messages: [] }), { text: 'hello' });
});
