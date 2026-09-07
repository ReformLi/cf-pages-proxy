/**
 * Cloudflare Pages 反向代理中间件
 *
 * 功能：
 *   - 全路径转发：将接收到的所有请求完整转发到 TARGET_DOMAIN
 *   - 方法/请求头/请求体透传
 *   - PATH_PREFIX 前缀剥离（可选）
 *   - CORS 自动注入、304 缓存响应透传
 *   - 可选的请求头 Token 认证（AUTH_TOKEN + X-API-Key）
 *   - 3xx Location 头重写（重定向继续走代理，不绕过）
 *   - 502/504 错误处理、30s 超时
 *   - 防 SSRF（目标域名仅从环境变量读取）、强制 HTTPS
 *
 * 环境变量：必须通过 context.env 读取（Pages Functions 运行于 workerd，
 * 无 process 对象）；process.env 仅作为本地 Node 测试的兜底。
 */

// 请求超时：超时返回 504
const DEFAULT_TIMEOUT_MS = 30_000;

// 单跳请求头（hop-by-hop），不应原样透传给下游
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
 * 读取环境变量：优先 Pages Functions 的 context.env，
 * 兼容本地 Node 环境的 process.env。
 * 注意：workerd 中 process 未定义，必须用 typeof 守卫防止 ReferenceError。
 */
function getEnv(env, name) {
  if (env && env[name] !== undefined && env[name] !== null) {
    return env[name];
  }
  if (typeof process !== 'undefined' && process.env && process.env[name] !== undefined) {
    return process.env[name];
  }
  return undefined;
}

/** 规范化目标域名：去除误带的协议前缀与尾部斜杠 */
function parseTargetDomain(env) {
  return String(getEnv(env, 'TARGET_DOMAIN') || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

/** 规范化路径前缀 */
function parsePathPrefix(env) {
  return String(getEnv(env, 'PATH_PREFIX') || '')
    .trim()
    .replace(/\/+$/, '');
}

/** 规范化认证 Token */
function parseAuthToken(env) {
  return String(getEnv(env, 'AUTH_TOKEN') || '').trim();
}

/**
 * 构造转发请求头：透传除单跳头之外的原始头
 */
function buildForwardHeaders(request) {
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.includes(lowerKey)) {
      return;
    }
    if (lowerKey.startsWith('cf-')) {
      // Cloudflare 平台注入的请求头不转发，避免信息泄露与循环
      return;
    }
    headers.set(key, value);
  });
  return headers;
}

/**
 * 剥离可选的 PATH_PREFIX 前缀
 */
function stripPathPrefix(pathname, pathPrefix) {
  if (!pathPrefix || pathPrefix === '/') {
    return pathname;
  }
  if (pathname === pathPrefix) {
    return '/';
  }
  if (pathname.startsWith(`${pathPrefix}/`)) {
    return pathname.slice(pathPrefix.length);
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

/**
 * 常量时间字符串比较，防止逐字符短路造成的时序侧信道
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

/**
 * 重写 3xx 响应的 Location 头：
 * 指向目标域名的绝对 URL 改写为代理域名，避免客户端绕过代理；
 * 相对路径由客户端基于代理域名解析，天然正确，无需处理；
 * 外域 Location 原样透传。
 */
function rewriteLocation(location, targetHost, proxyOrigin) {
  if (!/^https?:\/\//i.test(location)) {
    return location;
  }
  try {
    const loc = new URL(location);
    if (loc.host === targetHost) {
      return `${proxyOrigin}${loc.pathname}${loc.search}${loc.hash}`;
    }
  } catch {
    // 非法 URL，原样返回
  }
  return location;
}

export const onRequest = async (context) => {
  const { request, env } = context;

  // 环境变量在 Pages Functions 中通过 context.env 提供
  const targetDomain = parseTargetDomain(env);
  const pathPrefix = parsePathPrefix(env);
  const authToken = parseAuthToken(env);

  // 未配置目标域名时，直接返回明确的配置错误（500）
  if (!targetDomain) {
    console.error('[Proxy] Missing required env var: TARGET_DOMAIN');
    const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8' });
    applyCors(headers);
    return new Response('Proxy is not configured: missing TARGET_DOMAIN env var.', {
      status: 500,
      headers,
    });
  }

  // CORS 预检请求直接放行（预检不携带业务 Token 头，不应要求认证）
  if (request.method === 'OPTIONS') {
    const headers = new Headers();
    applyCors(headers);
    return new Response(null, { status: 204, headers });
  }

  // 可选的请求头 Token 认证：仅当 AUTH_TOKEN 非空时启用
  if (authToken) {
    const token = request.headers.get('X-API-Key');
    if (!token || !timingSafeEqual(token, authToken)) {
      console.error(`[Proxy] Unauthorized: ${request.method} ${request.url}`);
      const headers = new Headers({
        'content-type': 'text/plain; charset=utf-8',
        'www-authenticate': 'X-API-Key realm="proxy"',
      });
      applyCors(headers);
      return new Response('Unauthorized', { status: 401, headers });
    }
  }

  const incomingUrl = new URL(request.url);
  const pathname = stripPathPrefix(incomingUrl.pathname, pathPrefix);
  const targetUrl = new URL(`https://${targetDomain}${pathname}${incomingUrl.search}`);

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
      redirect: 'manual', // 3xx 原样返回，由代理重写 Location 后交客户端处理
      signal: controller.signal,
    });

    const responseHeaders = new Headers(upstreamResponse.headers);
    // set 会覆盖上游下发的同名字段，避免重复/冲突
    applyCors(responseHeaders);

    // 3xx 重定向：Location 指向目标域名时重写为代理域名，避免客户端绕过代理
    const location = upstreamResponse.headers.get('Location');
    if (location && upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
      responseHeaders.set(
        'Location',
        rewriteLocation(location, targetDomain, incomingUrl.origin)
      );
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    // 目标连接失败 / 请求中止时，友好返回 502/504
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