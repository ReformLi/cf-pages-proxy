/**
 * 本地单元测试：mock Workers Web API (fetch/Request/Response/process.env)，
 * 直接执行 functions/_middleware.js 的真实代码，验证转发规则。
 *
 * 运行：node test/proxy.test.mjs
 *
 * 说明：_middleware.js 在模块加载时读取环境变量，因此不同配置需通过
 *      动态 import（带 cache-buster）加载全新模块实例来测试。
 */
import assert from 'node:assert/strict';

const results = [];
function pass(name) {
  results.push(`  ✓ ${name}`);
}

// ---- mock 全局 fetch：捕获转发参数并返回可配置的上游响应 ----
const originalFetch = globalThis.fetch;
let calls = [];
function installFetchStub(behavior) {
  globalThis.fetch = async (url, init = {}) => {
    let body = init.body;
    if (body instanceof ReadableStream) {
      body = await new Response(body).text();
    }
    calls.push({
      url,
      method: init.method,
      headers: Object.fromEntries(init.headers.entries()),
      body,
      signal: init.signal,
      redirect: init.redirect,
    });
    if (behavior.error === 'abort') {
      const e = new Error('This operation was aborted');
      e.name = 'AbortError';
      throw e;
    }
    if (behavior.error === 'network') {
      throw new TypeError('fetch failed');
    }
    return behavior.respond(url);
  };
}
function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// 以指定环境变量加载全新模块实例（cache-buster 绕过 ESM 缓存）
let cacheSeed = 0;
async function loadFresh(env) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = String(v);
  }
  cacheSeed += 1;
  const mod = await import(`../functions/_middleware.js?seed=${cacheSeed}`);
  return mod.onRequest;
}

async function makeCall(onRequest, url, options = {}) {
  const req = new Request(url, {
    method: options.method || 'GET',
    headers: options.headers || {},
    ...(options.body ? { body: options.body } : {}),
  });
  return onRequest({ request: req });
}

// ============ 用例 1：未配置 TARGET_DOMAIN 返回 500 ============
{
  const onReq = await loadFresh({ TARGET_DOMAIN: '' });
  const resp = await makeCall(onReq, 'https://proxy.example.com/api/user');
  assert.equal(resp.status, 500);
  pass('未配置 TARGET_DOMAIN 时返回 500');
}

// ============ 用例 2：OPTIONS 预检返回 204 + CORS ============
{
  const onReq = await loadFresh({ TARGET_DOMAIN: 'my-api.vercel.app' });
  const resp = await makeCall(onReq, 'https://proxy.example.com/anything', { method: 'OPTIONS' });
  assert.equal(resp.status, 204);
  assert.equal(resp.headers.get('Access-Control-Allow-Origin'), '*');
  pass('OPTIONS 预检返回 204 并注入 CORS');
}

// ============ 用例 3：全路径转发 + GET + 头部透传 + CORS ============
{
  const onReq = await loadFresh({ TARGET_DOMAIN: 'my-api.vercel.app' });
  calls = [];
  installFetchStub({
    respond: () => new Response('hello', { status: 200 }),
  });
  const resp = await makeCall(onReq, 'https://proxy.example.com/api/user?page=1', {
    headers: { Authorization: 'Bearer abc', 'X-Custom': 'val', host: 'proxy.example.com' },
  });
  assert.equal(resp.status, 200);
  const c = calls[0];
  assert.equal(c.url, 'https://my-api.vercel.app/api/user?page=1');
  assert.equal(c.method, 'GET');
  assert.equal(c.headers.authorization, 'Bearer abc');
  assert.equal(c.headers['x-custom'], 'val');
  assert.equal(c.headers.host, undefined, 'host 不转发');
  assert.equal(resp.headers.get('Access-Control-Allow-Origin'), '*');
  pass('GET 全路径转发 + 头部透传 + CORS');
}

// ============ 用例 4：POST body 透传 ============
{
  const onReq = await loadFresh({ TARGET_DOMAIN: 'my-api.vercel.app' });
  calls = [];
  installFetchStub({ respond: () => new Response('ok') });
  await makeCall(onReq, 'https://proxy.example.com/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"a":1}',
  });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body, '{"a":1}');
  pass('POST 请求体透传');
}

// ============ 用例 5：PATH_PREFIX 剥离 ============
{
  const onReq = await loadFresh({ TARGET_DOMAIN: 'my-api.vercel.app', PATH_PREFIX: '/api' });
  installFetchStub({ respond: () => new Response('stripped') });
  calls = [];
  await makeCall(onReq, 'https://proxy.example.com/api/user');
  assert.equal(calls[0].url, 'https://my-api.vercel.app/user', '前缀剥离');
  calls = [];
  await makeCall(onReq, 'https://proxy.example.com/other/page');
  assert.equal(calls[0].url, 'https://my-api.vercel.app/other/page', '未匹配保留原路径');
  pass('PATH_PREFIX 前缀剥离，未匹配保持原路径');
}

// ============ 用例 6：304 响应透传 ============
{
  const onReq = await loadFresh({ TARGET_DOMAIN: 'my-api.vercel.app' });
  installFetchStub({ respond: () => new Response(null, { status: 304 }) });
  const resp = await makeCall(onReq, 'https://proxy.example.com/static.css');
  assert.equal(resp.status, 304);
  pass('304 Not Modified 原样透传');
}

// ============ 用例 7：网络错误返回 502 ============
{
  const onReq = await loadFresh({ TARGET_DOMAIN: 'my-api.vercel.app' });
  installFetchStub({ error: 'network' });
  const resp = await makeCall(onReq, 'https://proxy.example.com/fail');
  assert.equal(resp.status, 502);
  assert.match(await resp.text(), /502/);
  pass('目标无法连接返回 502');
}

// ============ 用例 8：超时返回 504 ============
{
  const onReq = await loadFresh({ TARGET_DOMAIN: 'my-api.vercel.app' });
  installFetchStub({ error: 'abort' }); // 模拟 AbortController 超时中止
  const resp = await makeCall(onReq, 'https://proxy.example.com/slow');
  assert.equal(resp.status, 504);
  assert.match(await resp.text(), /504/);
  pass('请求超时返回 504');
}

// ============ 用例 10：可选的请求头 Token 认证 ============
{
  const onReq = await loadFresh({ TARGET_DOMAIN: 'my-api.vercel.app', AUTH_TOKEN: 'sk_live_abc123' });
  installFetchStub({ respond: () => new Response('authed', { status: 200 }) });

  // 未携带 Token -> 401
  const respNoToken = await makeCall(onReq, 'https://proxy.example.com/posts');
  assert.equal(respNoToken.status, 401);
  assert.equal(await respNoToken.text(), 'Unauthorized');

  // 携带错误 Token -> 401
  const respBad = await makeCall(onReq, 'https://proxy.example.com/posts', {
    headers: { 'x-api-key': 'wrong' },
  });
  assert.equal(respBad.status, 401);

  // 携带正确 Token -> 正常转发
  calls = [];
  const respOK = await makeCall(onReq, 'https://proxy.example.com/posts', {
    headers: { 'x-api-key': 'sk_live_abc123' },
  });
  assert.equal(respOK.status, 200);
  assert.equal(calls[0].url, 'https://my-api.vercel.app/posts');
  assert.equal(calls[0].headers['x-api-key'], 'sk_live_abc123', 'Token 头正常透传');

  // OPTIONS 预检不受认证约束
  const respOpt = await makeCall(onReq, 'https://proxy.example.com/posts', { method: 'OPTIONS' });
  assert.equal(respOpt.status, 204);
  pass('AUTH_TOKEN 启用时校验 X-API-Key：未携带/错误返回 401，正确转发，预检放行');
}

// ============ 用例 11：未设置 AUTH_TOKEN 时默认不认证 ============
{
  const onReq = await loadFresh({ TARGET_DOMAIN: 'my-api.vercel.app', AUTH_TOKEN: undefined });
  installFetchStub({ respond: () => new Response('open', { status: 200 }) });
  const resp = await makeCall(onReq, 'https://proxy.example.com/posts');
  assert.equal(resp.status, 200);
  pass('未设置 AUTH_TOKEN 时不做认证，直接转发');
}

// ============ 用例 9：强制 HTTPS ============
{
  const onReq = await loadFresh({ TARGET_DOMAIN: 'my-api.vercel.app' });
  calls = [];
  installFetchStub({ respond: () => new Response('https') });
  await makeCall(onReq, 'http://proxy.example.com/x');
  assert.match(calls[0].url, /^https:\/\//);
  pass('转发强制使用 HTTPS');
}

restoreFetch();

console.log(`\nProxy test results (${results.length} passed):`);
results.forEach((r) => console.log(r));
console.log('\nAll tests passed.');