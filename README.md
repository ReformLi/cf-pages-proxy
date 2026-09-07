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
- **请求头过滤**：透传时自动剥离单跳请求头（`connection`、`host`、`transfer-encoding` 等）及 Cloudflare 注入的 `cf-*` 头，保证代理协议正确性并避免平台信息泄露。
- **请求体透传**：对于 POST、PUT 等请求，需要将请求体（Body）完整透传。

### 2.2 安全认证（新增）

- **默认无认证**：项目默认不开启任何认证，直接转发请求，开箱即用。
- **可选的请求头 Token 认证**：支持通过环境变量 `AUTH_TOKEN` 启用认证。
  - 当 `AUTH_TOKEN` 未设置或为空时，**不进行任何认证**，所有请求正常转发。
  - 当 `AUTH_TOKEN` 设置且非空时，**启用认证**，仅允许携带正确 Token 的请求通过。
- **认证方式**：要求请求头中包含 `X-API-Key` 字段，其值需与 `AUTH_TOKEN` 环境变量完全一致。
- **认证失败响应**：当认证失败（Token 缺失或不匹配）时，返回 HTTP 401 Unauthorized 状态码，响应体为 `Unauthorized`。
- **认证失败响应头**：401 响应携带 `WWW-Authenticate: X-API-Key realm="proxy"`，符合 HTTP 语义，便于客户端识别认证方式。
- **时序安全比较**：Token 校验采用常量时间比较算法，防止攻击者通过响应时间差逐字节猜测 Token。

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

#### 2.3.1 环境变量配置

- **环境变量配置**：通过 Cloudflare Pages 的环境变量配置以下参数：
  
  | 变量名             | 是否必填  | 默认值    | 说明                         |
  |:--------------- |:----- |:------ |:-------------------------- |
  | `TARGET_DOMAIN` | **是** | 无      | 目标服务器域名（**不带** `https://`） |
  | `AUTH_TOKEN`    | 否     | 空（不启用） | 认证 Token，设置后启用请求头认证        |
  | `PATH_PREFIX`   | 否     | 空      | 需要剥离的路径前缀（可选）              |

- **TARGET_DOMAIN 容错**：配置值会自动去除误带的 `https://` / `http://` 协议前缀及尾部斜杠（即 `https://my-api.vercel.app/` 与 `my-api.vercel.app` 等效），但仍推荐按规范填写纯域名。

#### 2.3.2 环境变量安全（Secret）

- **敏感信息加密**：对于包含敏感信息的环境变量（如 `TARGET_DOMAIN` 中若包含自定义 Token 或密钥），应设置为 Secret（加密环境变量）。

- **Secret 特性**：
  - 设置后，变量值在仪表盘中**不可见**，仅显示为 `••••••••`。
  - 有效防止凭证泄露，适合存储 API 密钥、Token、包含认证信息的域名等。
  - 在代码中通过 `context.env.变量名` 读取时，**无需任何特殊处理**。

- **推荐设为 Secret 的变量**：
  - `TARGET_DOMAIN`：如果其值包含 Bearer Token 或其他敏感参数。
  - `AUTH_TOKEN`：本身就是认证密钥，**强烈建议加密**。

- **配置方式**：在 Cloudflare Pages 项目设置的 **“变量和密钥”** 中，添加变量时勾选 **“加密”** 即可。

### 2.4 响应处理

- **响应透传**：将目标服务器返回的状态码、Headers 和 Body 原样返回给客户端。
- **CORS 支持**：自动添加必要的 CORS 响应头（如 `Access-Control-Allow-Origin: *`），方便前端跨域调用。
- **304 缓存响应**：正确处理来自目标服务器的 304 Not Modified 响应。
- **3xx 重定向 Location 重写**：目标服务器返回 3xx 且 `Location` 指向目标域名时，自动改写为代理域名（保留路径 / 查询参数 / 锚点），避免客户端被重定向绕过代理；指向外域或相对路径的 `Location` 原样透传。
- **OPTIONS 预检处理**：`OPTIONS` 预检请求不转发到目标服务器，也不要求认证（预检不携带自定义头），直接返回 204 并附带完整 CORS 头。

### 2.5 日志与调试

- **基础日志输出**：在 Cloudflare Pages Functions 的控制台输出请求日志，格式清晰，便于调试。
  - 示例：`[Proxy] GET /api/user -> https://目标域名/api/user`
- **错误日志输出**：认证失败（401）、上游连接失败（502）、上游超时（504）、配置缺失（500）均通过 `console.error` 输出，包含请求方法与目标 URL。
  - 示例：`[Proxy] Bad Gateway: GET https://目标域名/api/user`

## 3. 非功能需求

### 3.1 性能要求

- **冷启动时间**：Pages Functions 的冷启动时间应小于 200ms。
- **响应延迟**：代理转发增加的额外延迟应控制在 50ms 以内。

### 3.2 稳定性

- **错误处理**：当目标服务器返回 5xx 错误或无法连接时，应返回友好的错误信息（如 502 Bad Gateway），并记录错误日志。
- **超时控制**：设置合理的请求超时时间（建议 30 秒），超时后返回 504 Gateway Timeout。
- **配置缺失兜底**：`TARGET_DOMAIN` 未配置时返回 500 及明确错误文案（`Proxy is not configured: missing TARGET_DOMAIN env var.`），而非抛出未处理异常。

### 3.3 安全性

- **防 SSRF 攻击**：`TARGET_DOMAIN` 应从环境变量读取，不能从用户请求参数中获取。
- **HTTPS 强制**：代理转发时，强制使用 HTTPS 协议访问目标服务器。
- **认证 Token 保护**：认证仅校验 `X-API-Key` 请求头，Token 值通过环境变量配置，不硬编码在代码中。
- **平台头过滤**：转发时剥离 Cloudflare 注入的 `cf-*` 请求头及单跳头，避免向目标服务器泄露平台信息。
- **时序攻击防护**：Token 比较为常量时间运算，无法通过响应耗时逐字节推测 Token 内容。

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
├── test/
│   ├── proxy.test.mjs        # 单元测试（Node 直接运行，无需测试框架）
│   └── no-process.check.mjs  # workerd 环境回归检查（无 process 全局）
├── index.html           # 占位文件（避免根路径 404）
├── package.json         # 项目元信息（含 wrangler 本地调试 / 部署脚本）
├── .dev.vars.example    # 本地环境变量模板（复制为 .dev.vars 使用）
└── .gitignore           # Git 忽略规则（含 .dev.vars）
```

### 4.4 本地测试（test 目录）

`test/` 目录是本地自动化测试，**不参与线上运行**（部署时仅作为静态文件上传，对代理功能零影响）。修改代理逻辑后建议先跑测试再推送。

**运行方式**（仅需 Node.js，无需安装测试框架）：

```bash
node test/proxy.test.mjs        # 主测试
node test/no-process.check.mjs  # workerd 环境回归检查
```

**文件说明**：

| 文件 | 作用 |
|:---|:---|
| `proxy.test.mjs` | 主测试，13 个用例。原理：直接导入 `functions/_middleware.js` 的**真实代码**在 Node 中运行，用 stub 替换全局 `fetch` 模拟目标服务器的各种响应，逐项断言中间件行为。覆盖：配置缺失（500）、CORS 预检（204）、全路径/请求体转发、强制 HTTPS、头部过滤、`PATH_PREFIX` 剥离、Token 认证（401/放行/预检豁免）、304 透传、3xx Location 重写、网络错误（502）、超时（504） |
| `no-process.check.mjs` | 专项回归检查。模拟 Cloudflare 真实运行时（workerd 中无 `process` 全局对象），删除 `process` 后加载中间件，确认仅靠 `context.env` 即可正常工作、不抛 `ReferenceError`。防止后续改动重新引入对 `process.env` 的直接依赖 |

**为什么需要**：Cloudflare Pages 每次部署只验证构建能否跑通，**不会验证代理逻辑是否正确**。本地测试可在 1 秒内完成全部检查，避免“部署成功但功能损坏”的问题。

## 5. 核心代码实现预览

```javascript
// functions/_middleware.js
// 环境变量在 Pages Functions 运行时（workerd）中通过 context.env 访问

export const onRequest = async (context) => {
    const { request, env } = context;
    const TARGET_DOMAIN = env.TARGET_DOMAIN;
    const AUTH_TOKEN = env.AUTH_TOKEN;

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

> **注意事项**：
>
> - **环境变量修改后必须重新部署才能生效**：环境变量在部署时绑定到运行环境，修改后需触发新部署（推送新提交、控制台 "Retry deployment" 均可）。
> - **Production 与 Preview 环境相互独立**：两套环境变量需分别配置。正式域名读取 Production 变量，预览 / 分支部署域名读取 Preview 变量，只配一套会导致另一套读到空值。

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

### 6.3 故障排查

**核心：区分「代理返回的 401」与「目标站返回的 401」**

| 特征 | 代理的 401 | 目标站的 401 |
|:---|:---|:---|
| `Content-Type` | `text/plain` | 目标站业务类型（如 `application/json`） |
| 响应体 | 纯文本 `Unauthorized` | 目标站业务响应（如 `{"errorCode": 401, ...}`） |
| `WWW-Authenticate` 头 | 有（`X-API-Key realm="proxy"`） | 无 |
| 上游特征头（如 `x-vercel-id`） | 无 | 有（证明请求已到达目标站） |

- **代理的 401**：`AUTH_TOKEN` 已启用，但请求头 `X-API-Key` 缺失或值不匹配 → 检查请求头字段名与 Token 值是否与 `AUTH_TOKEN` 完全一致。
- **目标站的 401**：代理已放行（存在 `x-vercel-id` 等上游响应头可证明），是目标 API 自身的鉴权失败 → 需在请求中携带目标站要求的凭证（如 `Authorization: Bearer <token>`），与代理的 `AUTH_TOKEN` 无关。

**常见现象速查**

| 现象 | 原因与处理 |
|:---|:---|
| 500 文本 `Proxy is not configured: missing TARGET_DOMAIN env var.` | `TARGET_DOMAIN` 未配置，或只配置到了另一个环境（Production / Preview 需分别配置） |
| 502 Bad Gateway | 目标服务器无法连接：检查 `TARGET_DOMAIN` 是否正确、目标站是否在线 |
| 504 Gateway Timeout | 目标服务器响应超过 30 秒 |
| 修改环境变量后行为未变化 | 环境变量在部署时绑定，需触发重新部署后才生效 |

## 7. 后续扩展可能性

以下扩展均在 **Cloudflare Pages 部署形态不变**的前提下规划（仅使用环境变量、KV / Cache API 绑定等 Pages 免费能力），按实现成本分档，供后续迭代参考。

### 7.1 第一梯队：纯代码 + 环境变量，零新增依赖

| 功能 | 说明 | 成本 |
|:---|:---|:---|
| 路径黑/白名单 | `PATH_BLOCKLIST=/admin,/debug` 命中直接 403，防止目标站管理后台经代理暴露 | 很低 |
| 地区访问控制 | 读取 `request.cf.country`，支持 `GEO_BLOCK=CN` 或 `GEO_ALLOW=US,JP` 两种模式，防滥用 | 很低 |
| User-Agent 拦截 | 按模式拦截爬虫/扫描器（`curl`、`python-requests`、`bot` 等） | 很低 |
| 健康检查端点 | `/__proxy/health` 返回 JSON：非敏感配置状态（认证开关、前缀等）、版本号，可对接 uptime 监控 | 很低 |
| 观测头注入 | 响应注入 `X-Proxy-Request-ID` + `Server-Timing`（上游耗时），快速定位延迟来自代理还是目标站 | 低 |
| 多目标路由 | `ROUTE_MAP=/api→a.vercel.app,/img→b.oss.com`，按路径前缀分发到不同目标站 | 中 |

### 7.2 第二梯队：需新增 KV 绑定（仍属 Pages 免费能力）

| 功能 | 说明 | 注意 |
|:---|:---|:---|
| 简易限流 | KV 计数实现 `RATE_LIMIT=60/min` 按 IP 限流 | KV 免费额度每日仅 1000 次写，高频站点会超限；可改用 Cache API（更宽松但边缘节点间不共享、精度低） |
| 访问统计 | 请求数 / 路径 Top N，KV 累计 | 同样受写额度限制，可采用采样写入 |
| Token 轮换 | 支持多个有效 Token（KV 存列表），实现无损换 Token | KV 读额度 10 万次/天，充足可行 |

### 7.3 第三梯队：进阶但仍在边界内

- **双活 Failover**：`TARGET_DOMAIN_BACKUP`，主目标 502 / 超时后自动切换备用站。
- **HMAC 时效签名**：URL 携带过期时间戳 + 签名，防止 Token 泄露后被永久滥用，安全性显著高于裸 Token。
- **HTML 响应体链接重写**：把响应体中目标域名的绝对链接替换为代理域名。注意会消耗 CPU 时间（免费档每请求 10ms CPU），建议仅对 `text/html` 的小响应启用。
- **WebSocket 代理**：Pages Functions 支持透传 WebSocket 升级，按需实现。

### 7.4 明确不支持（需更换部署形态）

以下能力超出 Pages Functions 边界，需升级为标准 Workers（付费计划）或其他形态：

- 定时健康巡检（Cron Triggers）
- 精确全局限流与在线状态（Durable Objects）
- 大规模日志管道（Queues / Logpush）

## 8. 附录：环境变量完整列表

| 变量名             | 是否必填  | 默认值    | 说明                               |
|:--------------- |:----- |:------ |:-------------------------------- |
| `TARGET_DOMAIN` | **是** | 无      | 目标服务器域名（**不带** `https://`）       |
| `AUTH_TOKEN`    | 否     | 空（不启用） | 认证 Token，设置后启用请求头 `X-API-Key` 校验 |
| `PATH_PREFIX`   | 否     | 空      | 需要剥离的路径前缀（可选）              |

---
