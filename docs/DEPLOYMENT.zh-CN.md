# Envoy 生产发布与部署指南

本文档适用于将 Envoy 部署到 Linux 服务器，并使用 Nginx、PM2、PostgreSQL、Redis 和 Cloudflare R2 运行生产环境。

Envoy 采用“构建一次、发布产物”的部署模式：在可信的本地环境或 CI 中完成检查和 Next.js 生产构建，将不可变压缩包上传到服务器；服务器不重复构建，只安装与服务器平台匹配的依赖、执行数据库迁移并重载 PM2 进程。

## 1. 运行架构

生产环境包含两个 PM2 进程：

- `envoy-web`：运行 Next.js 管理后台、内部 API、健康检查和邮件服务商 Webhook，监听 `127.0.0.1:6178`。
- `envoy-worker`：异步处理邮件投递、服务商事件、收信、业务回调、对账和事务发件箱。

Nginx 是唯一对公网开放的入口，负责 HTTPS 和反向代理。Web 与 Worker 共用同一套 PostgreSQL、Redis、R2 和加密根密钥配置。

推荐目录结构：

```text
/opt/envoy/
├── current -> /opt/envoy/releases/RELEASE_ID
└── releases/
    ├── PREVIOUS_RELEASE_ID
    └── RELEASE_ID

/etc/envoy/
└── envoy.env                 # 持久化生产配置，不放入发布包
```

## 2. 发布前准备

### 2.1 构建机

构建机需要：

- Node.js `20.9.0` 或更高版本
- pnpm 10
- Git、tar
- 能运行项目测试所依赖的 PostgreSQL 和 Redis

建议使用与生产服务器架构一致的 Linux CI Runner 构建。不要把本机 `node_modules` 打进发布包；发布脚本已经排除该目录，服务器会安装与自身平台匹配的依赖。

### 2.2 生产服务器

服务器需要：

- 独立的 Linux 用户 `envoy`
- Node.js `20.9.0` 或更高版本
- pnpm 10、PM2、curl、Nginx
- PostgreSQL 生产数据库
- 启用了认证的 Redis
- Cloudflare R2 存储桶和 S3 API 凭据
- 使用收信或附件功能时可访问的 ClamAV 服务
- 已解析到服务器的公网域名

检查运行时版本：

```bash
node --version
pnpm --version
pm2 --version
nginx -v
```

不要在生产环境直接使用仓库中的 `docker-compose.yml`。该文件仅用于本地开发，会使用开发凭据并暴露数据库端口。

## 3. 构建发布产物

从准备发布的准确提交构建：

```bash
git checkout REPLACE_WITH_RELEASE_COMMIT
pnpm release:build
```

发布脚本依次执行：

1. `pnpm install --frozen-lockfile`
2. TypeScript 类型检查
3. ESLint 检查
4. 自动化测试
5. Next.js 生产构建
6. 生成发布压缩包和 SHA-256 校验文件

产物位于：

```text
dist/envoy-RELEASE_ID.tar.gz
dist/envoy-RELEASE_ID.tar.gz.sha256
```

发布包不会包含 `.env.local`、`node_modules`、`.next/cache` 或 `.next/dev`。

默认禁止从存在未提交改动的工作区打包。只有在明确理解风险时才能临时放开：

```bash
ENVOY_ALLOW_DIRTY_RELEASE=1 pnpm release:build
```

如果 CI 的前置阶段已经执行并通过测试，可以使用：

```bash
ENVOY_SKIP_TESTS=1 pnpm release:build
```

## 4. 上传发布产物

将压缩包和校验文件一起上传到服务器：

```bash
release_id="REPLACE_WITH_RELEASE_ID"
scp "dist/envoy-${release_id}.tar.gz" \
  "dist/envoy-${release_id}.tar.gz.sha256" \
  deploy@server:/tmp/
```

登录服务器并校验文件：

```bash
ssh deploy@server
cd /tmp
release_id="REPLACE_WITH_RELEASE_ID"
sha256sum --check "envoy-${release_id}.tar.gz.sha256"
```

必须看到 `OK` 后才能继续。

## 5. 首次初始化服务器

### 5.1 创建运行用户和目录

以下操作只需要执行一次：

```bash
sudo useradd --create-home --shell /bin/bash envoy
sudo install -d -o envoy -g envoy /opt/envoy/releases
sudo install -d -m 750 -o envoy -g envoy /etc/envoy
```

如果服务器已经存在 `envoy` 用户，不要重复创建。

### 5.2 安装 pnpm 和 PM2

安装好 Node.js 后执行：

```bash
sudo corepack enable
sudo corepack prepare pnpm@10.33.0 --activate
sudo npm install --global pm2
```

Node.js、pnpm 和 PM2 必须能被 `envoy` 用户访问：

```bash
sudo -iu envoy bash -lc 'node --version && pnpm --version && pm2 --version'
```

### 5.3 创建生产环境文件

先解压第一个版本，以便取得配置模板：

```bash
release_id="REPLACE_WITH_RELEASE_ID"
release_dir="/opt/envoy/releases/$release_id"

sudo install -d -o envoy -g envoy "$release_dir"
sudo -u envoy tar -xzf "/tmp/envoy-$release_id.tar.gz" -C "$release_dir"
sudo install -m 600 -o envoy -g envoy \
  "$release_dir/deploy/env.production.example" \
  /etc/envoy/envoy.env
sudoedit /etc/envoy/envoy.env
```

生产配置文件至少包含：

```dotenv
NODE_ENV=production
PORT=6178

DATABASE_URL=postgresql://envoy:REPLACE_WITH_DATABASE_PASSWORD@REPLACE_WITH_DATABASE_HOST:5432/envoy?sslmode=require
DATABASE_POOL_SIZE=10
REDIS_URL=redis://default:REPLACE_WITH_URL_ENCODED_REDIS_PASSWORD@REPLACE_WITH_REDIS_HOST:6379/0

ENVOY_KEK_BASE64=REPLACE_WITH_BASE64_ENCODED_32_BYTE_KEY
ENVOY_KEK_VERSION=kek-1
ENVOY_ADMIN_EMAIL=REPLACE_WITH_ADMIN_EMAIL
ENVOY_ADMIN_PASSWORD=REPLACE_WITH_STRONG_ADMIN_PASSWORD
ENVOY_SESSION_SECRET=REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS

OBJECT_STORAGE_DRIVER=s3
OBJECT_STORAGE_PREFIX=envoy
OBJECT_STORAGE_BUCKET=REPLACE_WITH_R2_BUCKET
OBJECT_STORAGE_REGION=auto
OBJECT_STORAGE_ENDPOINT=https://REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com
AWS_ACCESS_KEY_ID=REPLACE_WITH_R2_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY=REPLACE_WITH_R2_SECRET_ACCESS_KEY

CLAMAV_HOST=127.0.0.1
CLAMAV_PORT=3310

DELIVERY_CONCURRENCY=10
EVENT_CONCURRENCY=10
CALLBACK_CONCURRENCY=5
RECONCILIATION_CONCURRENCY=3
ENVOY_CIRCUIT_FAILURE_THRESHOLD=5
ENVOY_CIRCUIT_OPEN_SECONDS=300
```

生成加密根密钥和会话密钥：

```bash
openssl rand -base64 32
openssl rand -hex 32
```

第一条输出用于 `ENVOY_KEK_BASE64`，第二条可用于 `ENVOY_SESSION_SECRET`。不要把命令输出写入终端历史、工单或 Git。

关键配置说明：

| 配置项 | 说明 |
| --- | --- |
| `PORT` | Web 服务端口，默认并固定使用 `6178`。 |
| `DATABASE_URL` | PostgreSQL 连接串；云数据库通常应启用 TLS。 |
| `REDIS_URL` | Redis 连接串；末尾 `/0` 表示 database 0，可按隔离策略改为 `/14` 等明确编号。密码中的特殊字符必须做 URL 编码。 |
| `ENVOY_KEK_BASE64` | 凭据封装加密根密钥，解码后必须恰好 32 字节。丢失后已加密的服务商和回调凭据无法恢复。 |
| `ENVOY_KEK_VERSION` | 当前 KEK 版本标识。轮换时不得覆盖旧版本标识。 |
| `ENVOY_KEK_KEYRING_JSON` | 可选，轮换期间保存仍需解密旧数据的历史 KEK。 |
| `ENVOY_SESSION_SECRET` | 管理后台会话签名密钥，至少 32 个随机字符。 |
| `OBJECT_STORAGE_PREFIX` | 必须为 `envoy`，所有对象会写入存储桶的 `envoy/` 目录。 |
| `CLAMAV_HOST` | 生产环境启用收信或附件时必须配置并保证 Worker 可访问。 |

生产配置只创建一次，后续发布继续复用 `/etc/envoy/envoy.env`。单独离线备份 `ENVOY_KEK_BASE64`，并将文件权限保持为 `600`：

```bash
sudo chown envoy:envoy /etc/envoy/envoy.env
sudo chmod 600 /etc/envoy/envoy.env
```

## 6. 首次发布

将生产配置链接到当前发布目录并执行部署脚本：

```bash
release_id="REPLACE_WITH_RELEASE_ID"
release_dir="/opt/envoy/releases/$release_id"

sudo -u envoy ln -s /etc/envoy/envoy.env "$release_dir/.env.local"

sudo -iu envoy bash -lc \
  "cd '$release_dir' && ./scripts/deploy-pm2.sh"

sudo -u envoy ln -sfn "$release_dir" /opt/envoy/current
```

部署脚本会：

1. 检查 Node.js、pnpm、PM2、curl 和 `.env.local`。
2. 验证发布包包含 `.next/BUILD_ID`，默认拒绝在服务器构建。
3. 使用锁文件安装服务器平台依赖。
4. 执行 `001_initial.sql` V1 数据库迁移。
5. 启动或重载 `envoy-web` 和 `envoy-worker`。
6. 最多等待 30 秒，直到两个进程都有有效 PID 且 `/api/health` 返回 `status: ok`。
7. 健康检查通过后执行 `pm2 save`。

迁移脚本具有幂等记录，同一个迁移不会被重复应用。数据库迁移是向前执行的，不会在代码回滚时自动回退。

## 7. 配置 PM2 开机启动

以 `envoy` 用户执行：

```bash
sudo -iu envoy pm2 startup
```

PM2 会打印一条需要管理员权限执行的命令。检查其中的用户和 HOME 路径确实指向 `envoy` 后，执行该命令，再保存进程列表：

```bash
sudo -iu envoy pm2 save
```

不要使用 root 用户直接运行 Envoy 应用进程。验证开机服务：

```bash
sudo systemctl status pm2-envoy
sudo -iu envoy pm2 status
```

## 8. 配置 Nginx 和 HTTPS

复制项目提供的模板：

```bash
sudo cp \
  /opt/envoy/current/deploy/nginx/envoy.conf.example \
  /etc/nginx/sites-available/envoy.conf
sudoedit /etc/nginx/sites-available/envoy.conf
```

至少替换以下内容：

- `envoy.example.com`：替换为真实公网域名。
- TLS 证书和私钥路径：确保对应文件已经存在。
- 如确有需要，调整 `client_max_body_size 32m`，但应同时评估收信 MIME 和附件大小限制。

启用站点并检查配置：

```bash
sudo ln -s /etc/nginx/sites-available/envoy.conf /etc/nginx/sites-enabled/envoy.conf
sudo nginx -t
sudo systemctl reload nginx
```

应用只监听回环地址 `127.0.0.1:6178`，不要在防火墙中对公网开放 `6178`。公网只应开放 `80` 和 `443`。

验证反向代理：

```bash
curl --fail https://envoy.example.com/api/health
```

正常响应应包含：

```json
{"name":"envoy","status":"ok"}
```

健康检查会验证 PostgreSQL、Redis 和事务发件箱积压查询，但不会替代 R2、ClamAV 或邮件服务商的实际连通性测试。

## 9. 配置邮件服务商 Webhook

在管理后台创建服务商账户及 Webhook 后，Envoy 会生成不可猜测的入口地址：

```text
https://envoy.example.com/api/provider-events/{provider}/{opaqueEndpointId}
```

将完整地址配置到对应服务商后台。根据服务商类型同时配置签名密钥、公钥、Basic Auth、Topic ARN 或 IP 白名单。不要自行构造或复用 `opaqueEndpointId`。

上线前至少验证：

- 邮件投递事件能进入 Envoy。
- 签名错误的请求会被拒绝。
- 送达、退信和投诉事件能正确更新投递状态。
- 无效邮箱能进入抑制列表。
- 业务回调使用公网 HTTPS 地址并能验证 Envoy 的签名。
- 如启用收信，原始内容和附件写入 R2 的 `envoy/` 前缀。

## 10. 后续版本发布

每个版本使用一个全新的发布目录，不覆盖历史目录：

```bash
cd /tmp
release_id="REPLACE_WITH_RELEASE_ID"
sha256sum --check "envoy-${release_id}.tar.gz.sha256"

release_dir="/opt/envoy/releases/$release_id"

sudo install -d -o envoy -g envoy "$release_dir"
sudo -u envoy tar -xzf "/tmp/envoy-$release_id.tar.gz" -C "$release_dir"
sudo -u envoy ln -s /etc/envoy/envoy.env "$release_dir/.env.local"

sudo -iu envoy bash -lc \
  "cd '$release_dir' && ./scripts/deploy-pm2.sh"

sudo -u envoy ln -sfn "$release_dir" /opt/envoy/current
```

只有在部署脚本成功、健康检查通过后才更新 `/opt/envoy/current`。

## 11. 回滚

代码回滚使用之前保留的发布目录：

```bash
prior_release=/opt/envoy/releases/REPLACE_WITH_PRIOR_RELEASE_ID

sudo -iu envoy bash -lc \
  "cd '$prior_release' && ./scripts/deploy-pm2.sh"

sudo -u envoy ln -sfn "$prior_release" /opt/envoy/current
```

注意：

- 数据库迁移不会自动回滚。
- 回滚前必须确认旧代码兼容当前数据库结构。
- `/etc/envoy/envoy.env` 是跨版本共享配置；如果新版增加了必填变量，回滚时也要确认旧版能够忽略它们。
- 不要删除当前运行版本和最近一个可用版本。

## 12. 日常运维

查看状态和日志：

```bash
sudo -iu envoy pm2 status
sudo -iu envoy pm2 logs envoy-web
sudo -iu envoy pm2 logs envoy-worker
sudo -iu envoy pm2 monit
```

重载进程：

```bash
sudo -iu envoy bash -lc \
  'cd /opt/envoy/current && pm2 startOrReload ecosystem.config.cjs --update-env'
```

修改 `/etc/envoy/envoy.env` 后必须重载进程。涉及数据库结构变更时应重新运行完整部署脚本，而不是只重载 PM2。

检查内部和公网健康状态：

```bash
curl --fail http://127.0.0.1:6178/api/health
curl --fail https://envoy.example.com/api/health
```

查看 Nginx 日志：

```bash
sudo journalctl -u nginx --since '30 minutes ago'
sudo tail -n 200 /var/log/nginx/error.log
```

## 13. 应急服务器构建

正常发布不在服务器执行构建。如果发布包缺少 `.next/BUILD_ID`，部署脚本会直接失败。

仅在无法重新生成发布包的紧急情况下，才允许显式启用服务器构建：

```bash
ENVOY_BUILD_ON_SERVER=1 ./scripts/deploy-pm2.sh
```

应急构建要求服务器上有完整源码和构建依赖，资源消耗更高，也降低了产物可重复性。问题恢复后应尽快重新走标准发布流程。

## 14. 备份与密钥管理

至少建立以下备份：

- PostgreSQL 定时备份，并定期验证恢复流程。
- R2 对象保留和生命周期策略，防止误删原始邮件或附件。
- `/etc/envoy/envoy.env` 的加密备份。
- `ENVOY_KEK_BASE64` 的独立离线备份。

KEK 轮换时：

1. 为新密钥使用新的 `ENVOY_KEK_VERSION`。
2. 在 `ENVOY_KEK_KEYRING_JSON` 中保留仍需解密旧数据的历史密钥。
3. 完成数据重封装并验证后，才能移除旧密钥。

不要直接覆盖旧 KEK，也不要把生产密钥提交到 Git、CI 日志或聊天记录。

## 15. 常见故障排查

### 健康检查返回 503

查看完整响应和两个 PM2 日志：

```bash
curl --silent --show-error http://127.0.0.1:6178/api/health
sudo -iu envoy pm2 logs envoy-web --lines 200
sudo -iu envoy pm2 logs envoy-worker --lines 200
```

常见原因包括 PostgreSQL 不可达、Redis 认证失败、数据库尚未迁移或配置文件没有链接到当前发布目录。

### Redis 返回 `NOAUTH`

`REDIS_URL` 缺少用户名或密码。使用完整连接串，并确保密码经过 URL 编码：

```text
redis://default:REPLACE_WITH_URL_ENCODED_PASSWORD@REPLACE_WITH_HOST:6379/REPLACE_WITH_DATABASE_NUMBER
```

末尾的数字是 Redis database 编号。生产环境应明确填写，避免不同服务意外共用默认 database。

### 数据库提示表不存在

确认连接的是目标生产数据库，然后重新执行：

```bash
sudo -iu envoy bash -lc \
  'cd /opt/envoy/current && NODE_ENV=production pnpm db:migrate'
```

当前未正式部署时只保留一份 `001_initial.sql`，不会依赖多个历史迁移脚本。

### PM2 显示进程在线但公网无法访问

依次检查：

```bash
curl --fail http://127.0.0.1:6178/api/health
sudo nginx -t
sudo systemctl status nginx
sudo ss -lntp | grep 6178
```

如果内部健康检查正常，问题通常位于 Nginx、TLS 证书、DNS 或防火墙。

### R2 写入失败

检查：

- Endpoint 是否为当前 Cloudflare 账户的 R2 S3 Endpoint。
- Access Key 是否具有目标存储桶的读写权限。
- `OBJECT_STORAGE_BUCKET` 是否正确。
- `OBJECT_STORAGE_REGION` 是否为 `auto`。
- 对象是否写入 `envoy/` 前缀。

### Worker 持续重启

优先检查 Redis 认证、数据库连接、KEK 格式和 ClamAV 可达性：

```bash
sudo -iu envoy pm2 logs envoy-worker --lines 300
```

`ENVOY_KEK_BASE64` 必须能解码为恰好 32 字节。

## 16. 上线检查清单

正式导入流量前逐项确认：

- [ ] 发布包 SHA-256 校验通过。
- [ ] 代码来源是预期的 Git 提交，构建阶段的类型检查、Lint 和测试全部通过。
- [ ] `/etc/envoy/envoy.env` 权限为 `600`，且不包含占位符。
- [ ] 管理员密码和会话密钥已经替换为高强度随机值。
- [ ] `ENVOY_KEK_BASE64` 已做独立离线备份。
- [ ] `001_initial.sql` 已应用到正确的 PostgreSQL 数据库。
- [ ] Redis 使用认证连接，且 database 编号符合隔离策略。
- [ ] R2 读写正常，附件位于 `envoy/` 前缀。
- [ ] 使用收信或附件时，ClamAV 可从 Worker 访问。
- [ ] `envoy-web` 和 `envoy-worker` 均为 online。
- [ ] 内部 `/api/health` 返回 HTTP 200 和 `status: ok`。
- [ ] Nginx 配置检查通过，公网 HTTPS 健康检查正常。
- [ ] 邮件服务商 Webhook 使用正确的公网 HTTPS 地址并通过签名验证。
- [ ] 业务回调可达且能验证签名。
- [ ] PM2 开机启动已启用并经过重启验证。
- [ ] PostgreSQL、R2、环境配置和 KEK 的备份策略已经生效。
