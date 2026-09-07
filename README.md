# Cloudflare Pages 反向代理项目需求文档

## 1. 项目概述

**项目名称**：`cf-pages-proxy`

**核心目标**：提供一个可直接部署到 Cloudflare Pages 的反向代理服务，解决 Vercel 项目在国内无法稳定访问的问题。

**核心价值**：用户通过访问 Pages 分配的 `*.pages.dev` 域名或自定义域名，即可无感知地访问被代理的目标服务器（如 Vercel、Render 等平台部署的服务）。

## 2. 功能需求

### 2.1 核心代理功能

- **全路径转发**：将接收到的所有路径（`/*`）的请求，完整转发到预先配置的目标域名。
  - 例如：访问 `https://代理域名/api/user` 应被转发至 `https://目标域名/api/user`。
- **请求方法透传**：支持 GET、POST、PUT、DELETE、PATCH 等所有 HTTP 方法的透传。
- **请求头透传**：转发请求时，需携带原始请求的 Headers（如 `Authorization`、`Content-Type` 等）。
- **请求体透传**：对于 POST、PUT 等请求，需要将请求体（Body）完整透传。

### 2.2 安全认证（新增）

- **默认无认证**：项目默认不开启任何认证，直接转发请求，开箱即用。
- **可选的请求头 Token 认证**：支持通过环境变量 `AUTH_TOKEN` 启用认证。
  - 当 `AUTH_TOKEN` 未设置或为空时，**不进行任何认证**，所有请求正常转发。
  - 当 `AUTH_TOKEN` 设置且非空时，**启用认证**，仅允许携带正确 Token 的请求通过。
- **认证方式**：要求请求头中包含 `X-API-Key` 字段，其值需与 `AUTH_TOKEN` 环境变量完全一致。
- **认证失败响应**：当认证失败（Token 缺失或不匹配）时，返回 HTTP 401 Unauthorized 状态码，响应体为 `Unauthorized`。

**认证逻辑伪代码**：

```
if (AUTH_TOKEN 存在且非空) {
    if (请求头中的 X-API-Key !== AUTH_TOKEN) {
        返回 401 Unauthorized
    }
}
// 否则正常转发
```

### 2.3 配置管理

- **环境变量配置**：通过 Cloudflare Pages 的环境变量配置以下参数：
  
  | 变量名             | 是否必填  | 默认值    | 说明                         |
  |:--------------- |:----- |:------ |:-------------------------- |
  | `TARGET_DOMAIN` | **是** | 无      | 目标服务器域名（**不带** `https://`） |
  | `AUTH_TOKEN`    | 否     | 空（不启用） | 认证 Token，设置后启用请求头认证        |
  | `PATH_PREFIX`   | 否     | 空      | 需要剥离的路径前缀（可选）              |

### 2.4 响应处理

- **响应透传**：将目标服务器返回的状态码、Headers 和 Body 原样返回给客户端。
- **CORS 支持**：自动添加必要的 CORS 响应头（如 `Access-Control-Allow-Origin: *`），方便前端跨域调用。
- **304 缓存响应**：正确处理来自目标服务器的 304 Not Modified 响应。

### 2.5 日志与调试

- **基础日志输出**：在 Cloudflare Pages Functions 的控制台输出请求日志，格式清晰，便于调试。
  - 示例：`[Proxy] GET /api/user -> https://目标域名/api/user`

## 3. 非功能需求

### 3.1 性能要求

- **冷启动时间**：Pages Functions 的冷启动时间应小于 200ms。
- **响应延迟**：代理转发增加的额外延迟应控制在 50ms 以内。

### 3.2 稳定性

- **错误处理**：当目标服务器返回 5xx 错误或无法连接时，应返回友好的错误信息（如 502 Bad Gateway），并记录错误日志。
- **超时控制**：设置合理的请求超时时间（建议 30 秒），超时后返回 504 Gateway Timeout。

### 3.3 安全性

- **防 SSRF 攻击**：`TARGET_DOMAIN` 应从环境变量读取，不能从用户请求参数中获取。
- **HTTPS 强制**：代理转发时，强制使用 HTTPS 协议访问目标服务器。
- **认证 Token 保护**：认证仅校验 `X-API-Key` 请求头，Token 值通过环境变量配置，不硬编码在代码中。

## 4. 技术约束

### 4.1 部署环境

- **部署平台**：Cloudflare Pages（使用 Pages Functions 功能）
- **运行时**：Cloudflare Workers 环境 (V8 引擎)

### 4.2 技术栈

- **语言**：JavaScript (ES2020+)
- **核心 API**：使用 Cloudflare Pages Functions 提供的 `export const onRequest` 模式。

### 4.3 目录结构

```
/
├── functions/
│   └── _middleware.js   # 核心代理中间件
├── index.html           # 占位文件（避免根路径 404）
└── package.json         # 项目元信息
```

## 5. 核心代码实现预览

```javascript
// functions/_middleware.js
const TARGET_DOMAIN = process.env.TARGET_DOMAIN;
const AUTH_TOKEN = process.env.AUTH_TOKEN;

export const onRequest = async (context) => {
    const { request } = context;

    // 1. 可选认证：仅当 AUTH_TOKEN 设置时才启用
    if (AUTH_TOKEN && AUTH_TOKEN.length > 0) {
        const token = request.headers.get('X-API-Key');
        if (token !== AUTH_TOKEN) {
            return new Response('Unauthorized', { status: 401 });
        }
    }

    // 2. 构建目标 URL
    const url = new URL(request.url);
    url.host = TARGET_DOMAIN;

    // 3. 透传请求
    const modifiedRequest = new Request(url.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body,
    });

    // 4. 发送请求并返回响应
    return fetch(modifiedRequest);
};
```

## 6. 部署与使用说明

### 6.1 部署步骤

1. 将项目源码推送到 GitHub 仓库。
2. 在 Cloudflare Pages 中选择 **“连接到 Git”** 进行部署。
3. 在项目设置的 **“环境变量”** 中添加 `TARGET_DOMAIN`（必填）。
4. （可选）如需启用认证，添加 `AUTH_TOKEN` 环境变量。
5. （可选）绑定自定义域名。

### 6.2 使用示例

**场景一：无认证（默认）**

- 环境变量：
  
  ```
  TARGET_DOMAIN = "my-api.vercel.app"
  # AUTH_TOKEN 不设置
  ```

- 直接访问 `https://代理域名/posts` 即可正常代理。

**场景二：启用认证**

- 环境变量：
  
  ```
  TARGET_DOMAIN = "my-api.vercel.app"
  AUTH_TOKEN = "sk_live_abc123def456"
  ```

- 请求时需在 Header 中添加：
  
  ```
  X-API-Key: sk_live_abc123def456
  ```

- 未携带或携带错误 Token 时，返回 `401 Unauthorized`。

## 7. 后续扩展可能性

- 支持多目标域名路由（按路径或子域名区分）。
- 支持请求/响应内容的修改（如替换文本中的链接）。
- 支持 IP 白名单认证方式。

## 8. 附录：环境变量完整列表

| 变量名             | 是否必填  | 默认值    | 说明                               |
|:--------------- |:----- |:------ |:-------------------------------- |
| `TARGET_DOMAIN` | **是** | 无      | 目标服务器域名（**不带** `https://`）       |
| `AUTH_TOKEN`    | 否     | 空（不启用） | 认证 Token，设置后启用请求头 `X-API-Key` 校验 |
| `PATH_PREFIX`   | 否     | 空      | 需要剥离的路径前缀（暂未实现）                  |

---
