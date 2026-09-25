# Envoy Docker 部署

生产服务器直接拉取源码，通过 Docker Compose 构建并运行。生产环境包含 Web、Worker 和一次性 Migration 三个容器任务，统一加入
`envoy-network` bridge 网络；PostgreSQL、Redis 和 R2 使用外部服务。

## 1. 环境要求

服务器需要安装：

- Git
- Docker Engine
- Docker Compose v2

检查版本：

```bash
git --version
docker --version
docker compose version
```

## 基线 Schema 版本

本版本需要一个全新的空 PostgreSQL 数据库。它修改了基线 schema，不提供从旧版 Envoy 数据库原地升级的兼容路径。请先单独导出或保留必要数据，
创建新数据库，再按首次部署流程执行 migration。

## 2. 拉取源码

首次部署：

```bash
git clone REPLACE_WITH_REPOSITORY_URL /data/envoy
cd /data/envoy
```

如果源码已经存在：

```bash
cd /data/envoy
git pull --ff-only
```

## 3. 配置环境变量

```bash
cp deploy/env.production.example .env.production
vi .env.production
```

将所有已启用配置中的 `replace_with_*` 替换为真实值，重点确认：

- `PORT=6178`
- `DATABASE_URL` 指向生产 PostgreSQL
- `REDIS_URL` 包含认证信息和 database 编号
- `ENVOY_KEK_BASE64`、管理员密码和 `ENVOY_SESSION_SECRET` 已替换
- 如使用反向代理并需要 Provider IP 白名单，只有在代理会覆盖外部传入的 `X-Forwarded-*` 头、且 Envoy 端口不直接暴露给不受信任客户端时，才设置 `ENVOY_TRUST_PROXY=true`
- 对业务服务的出站回调默认只允许公网 HTTPS 地址；仅当需要调用受信任内网服务时设置 `ENVOY_ALLOW_PRIVATE_CALLBACKS=true`，此时仅内网出站回调可使用 HTTP
- R2 Endpoint、存储桶和 S3 凭据正确
- `OBJECT_STORAGE_PREFIX=envoy`
- ClamAV 为可选配置；不使用时保持 `CLAMAV_HOST` 和 `CLAMAV_PORT` 注释，附件会跳过扫描并标记为 `skipped`

生成 KEK 和 Session Secret：

```bash
openssl rand -base64 32
openssl rand -hex 32
```

`.env.production` 已被 Git 忽略，不会进入 Docker 镜像。

## 4. 构建并启动

```bash
docker compose build
docker compose run --rm migrate
docker compose up -d web worker
```

Compose 默认只将服务绑定到本机 `127.0.0.1:6178`。请在同一主机上配置 HTTPS 反向代理，不要直接将 Compose 端口暴露到公网。
健康检查：

```text
http://127.0.0.1:6178
```

会话 Cookie 会按浏览器访问协议自动设置；通过 HTTPS 反向代理部署时，请转发 `X-Forwarded-Proto`。公网环境必须使用
HTTPS。

查看状态和健康检查：

```bash
docker compose ps
curl --fail http://127.0.0.1:6178/api/health
```

## 5. 更新版本

上面的更新流程不适用于升级到此前述基线 schema 版本的已有数据库；该版本完成全新数据库初始化后，后续更新才可使用此流程。

```bash
cd /data/envoy
git pull --ff-only
docker compose build
docker compose run --rm migrate
docker compose up -d web worker
```

数据库迁移成功后才会更新 Web 和 Worker 容器。

## 6. 常用命令

```bash
# 查看容器
docker compose ps

# 查看日志
docker compose logs -f web
docker compose logs -f worker

# 重启
docker compose restart web worker

# 停止
docker compose down
```

修改 `.env.production` 后，重新创建容器：

```bash
docker compose up -d --force-recreate web worker
```

## 7. 回滚

```bash
cd /data/envoy
git checkout REPLACE_WITH_PREVIOUS_COMMIT
docker compose build
docker compose run --rm migrate
docker compose up -d web worker
```

数据库迁移不会自动回滚，回滚前需要确认旧代码兼容当前数据库结构。
