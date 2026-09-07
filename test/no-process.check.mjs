/**
 * P0 回归验证：模拟 workerd 运行时（无 process 全局对象），
 * 确认中间件在 context.env 下正常工作、不抛 ReferenceError。
 *
 * 运行：node test/no-process.check.mjs
 */
import assert from 'node:assert/strict';

// mock fetch：返回固定上游响应
globalThis.fetch = async () => new Response('upstream-ok', { status: 200 });

// 模拟 workerd：移除 Node 的 process 全局（ESM 严格模式下不可删则置 undefined）
try {
  delete globalThis.process;
} catch {
  Object.defineProperty(globalThis, 'process', { value: undefined, configurable: true });
}

const { onRequest } = await import('../functions/_middleware.js');

// context.env 提供配置：应正常转发
const resp = await onRequest({
  request: new Request('https://proxy.example.com/api/user'),
  env: { TARGET_DOMAIN: 'my-api.vercel.app' },
});
assert.equal(resp.status, 200);
assert.equal(await resp.text(), 'upstream-ok');

// context.env 缺少配置：应返回 500 而非崩溃
const resp500 = await onRequest({
  request: new Request('https://proxy.example.com/api/user'),
  env: {},
});
assert.equal(resp500.status, 500);

console.log('OK: 无 process 全局时 context.env 工作正常，P0 修复生效');