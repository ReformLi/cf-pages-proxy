/**
 * Cloudflare Pages 反向代理中间件
 *
 * 功能：
 *   - 全路径转发：将接收到的所有请求完整转发到 TARGET_DOMAIN
 *   - 方法/请求头/请求体透传
 *   - PATH_PREFIX 前缀剥离（可选）
 *   - CORS 自动注入、304 缓存响应透传
 *   - 可选的请求头 Token 认证（AUTH_TOKEN + X-API-Key）
 *   - 502/504 错误处理、30s 超时
 *   - 防 SSRF（目标域名仅从环境变量读取）、强制 HTTPS
 */

// 目标域名：仅从环境变量读取，禁止从用户请求中获取（防 SSRF）
// 兼容用户可能误带协议或尾部斜杠的写法
const TARGET_DOMAIN = (process.env.TARGET_DOMAIN || '')
  .trim()
  .replace(/^https?:\/\//i, '')
  .replace(/\/+$/, '');

// 可选的路径前缀，转发前会被剥离
const PATH_PREFIX = (process.env.PATH_PREFIX || '')
  .trim()
  .replace(/\/+$/, '');

// 可选的认证 Token：仅当 AUTH_TOKEN 非空时才启用 X-API-Key 校验
const AUTH_TOKEN = (process.env.AUTH_TOKEN || '').trim();

const DEFAULT_TIMEOUT_MS = 30_000; // 建议 30 秒，超时返回 504
const HTTPS = 'https';

// 单跳相关的请求头（hop-by-hop），不应原样透传给下游
const HOP_BY_HOP_HEADERS = [
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/**
 * 构造转发请求头：透传除单跳头之外的原始头，并统一规范化
 */
function buildForwardHeaders(request) {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.includes(lowerKey)) {
      return;
    }
    if (lowerKey.startsWith('cf-')) {
      // Cloudflare 平台注入的开头头不转发，避免信息泄露与循环
      return;
    }
    headers.set(key, value);
  });
  return headers;
}

/**
 * 剥离可选的 PATH_PREFIX 前缀
 */
function stripPathPrefix(pathname) {
  if (!PATH_PREFIX || PATH_PREFIX === '/') {
    return pathname;
  }
  if (pathname === PATH_PREFIX) {
    return '/';
  }
  if (pathname.startsWith(`${PATH_PREFIX}/`)) {
    return pathname.slice(PATH_PREFIX.length);
  }
  return pathname;
}

/**
 * 装配 CORS 响应头
 */
function applyCors(headers) {
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD');
  headers.set('Access-Control-Allow-Headers', '*');
  headers.set('Access-Control-Max-Age', '86400');
}

export const onRequest = async (context) => {
  const { request } = context;

  // 未配置目标域名时，直接返回明确的配置错误（500）
  if (!TARGET_DOMAIN) {
    console.error('[Proxy] Missing required env var: TARGET_DOMAIN');
    const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8' });
    applyCors(headers);
    return new Response('Proxy is not configured: missing TARGET_DOMAIN env var.', {
      status: 500,
      headers,
    });
  }

  // CORS 预检请求直接放行（预检请求通常不携带业务 Token 头，不应要求认证）
  if (request.method === 'OPTIONS') {
    const headers = new Headers();
    applyCors(headers);
    return new Response(null, { status: 204, headers });
  }

  // 可选的请求头 Token 认证：仅当 AUTH_TOKEN 非空时启用
  if (AUTH_TOKEN) {
    const token = request.headers.get('X-API-Key');
    if (token !== AUTH_TOKEN) {
      console.error(`[Proxy] Unauthorized: ${request.method} ${request.url}`);
      const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8' });
      applyCors(headers);
      return new Response('Unauthorized', { status: 401, headers });
    }
  }

  const incomingUrl = new URL(request.url);
  const pathname = stripPathPrefix(incomingUrl.pathname);
  const targetUrl = new URL(`${HTTPS}://${TARGET_DOMAIN}${pathname}${incomingUrl.search}`);

  console.log(`[Proxy] ${request.method} ${incomingUrl.pathname} -> ${targetUrl.href}`);

  const forwardHeaders = buildForwardHeaders(request);

  // 超时控制器：超时返回 504
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const upstreamResponse = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: forwardHeaders,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual', // 交由客户端处理重定向，避免二次代理
      signal: controller.signal,
    });

    const responseHeaders = new Headers(upstreamResponse.headers);
    // set 会覆盖上游下发的同名字段，避免重复/冲突
    applyCors(responseHeaders);

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    // 目标连接失败 / 5xx 层无法直达时，友好返回 502
    if (err && err.name === 'AbortError') {
      console.error(`[Proxy] Gateway Timeout: ${request.method} ${targetUrl.href}`);
      const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8' });
      applyCors(headers);
      return new Response('504 Gateway Timeout: upstream timed out.', {
        status: 504,
        headers,
      });
    }

    console.error(`[Proxy] Bad Gateway: ${request.method} ${targetUrl.href}`, err);
    const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8' });
    applyCors(headers);
    return new Response('502 Bad Gateway: failed to reach upstream.', {
      status: 502,
      headers,
    });
  } finally {
    clearTimeout(timer);
  }
};