# Envoy Docker 部署

生产服务器直接拉取源码，通过 Docker Compose 构建并运行。生产环境包含 Web、Worker 和一次性数据库迁移三个容器任务，统一加入
`envoy-network` bridge 网络；PostgreSQL 和 R2 使用外部服务。

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
cp docker-compose.example.yml docker-compose.yml
cp .env.example .env.production
vi .env.production
```

`docker-compose.yml` 是服务器自行维护的配置，已被 Git 忽略；后续更新源码不会覆盖它。

项目只维护 `.env.example` 一份配置示例：本地复制为 `.env.local`，生产复制为 `.env.production`。
示例默认使用本地开发配置；生产需要修改数据库地址，并启用下方的对象存储配置。
`NODE_ENV=production` 由 Docker 镜像设置，无需在环境文件中重复配置。

将所有已启用配置中的 `replace_with_*` 替换为真实值，重点确认：

- `PORT=6178`
- `DATABASE_URL` 指向 PostgreSQL 14+，使用直连或会话连接池；不能用事务连接池承载 LISTEN
- `ENVOY_KEK_BASE64`、管理员密码和 `ENVOY_SESSION_SECRET` 已替换
- 如使用反向代理并需要 Provider IP 白名单，只有在代理会覆盖外部传入的 `X-Forwarded-*` 头、且 Envoy 端口不直接暴露给不受信任客户端时，才设置 `ENVOY_TRUST_PROXY=true`
- 对业务服务的出站回调默认只允许公网 HTTPS 地址；仅当需要调用受信任内网服务时设置 `ENVOY_ALLOW_PRIVATE_CALLBACKS=true`，此时仅内网出站回调可使用 HTTP
- R2 Endpoint、存储桶和独立的 `OBJECT_STORE_ACCESS_KEY_ID` / `OBJECT_STORE_SECRET_ACCESS_KEY` 正确；AWS 默认凭据链保留给 SES，不与 R2 共用
- `OBJECT_STORAGE_PREFIX=envoy`
- 将 `OBJECT_STORAGE_DRIVER=local` 改为 `s3`，取消对象存储配置的注释；R2 使用 `OBJECT_STORAGE_REGION=auto`
- 生产镜像在启动 Web、Worker 或迁移任务前拒绝 `local`、未知驱动或缺少存储桶/区域；Web 和 Worker 必须使用同一 S3 桶、区域、端点、前缀和凭据。只修复 Web 容器内 `/app/var` 的写权限无法让 Worker 读取该容器的文件，容器重建也可能丢失这些文件
- 自定义 S3 端点（包括 R2）必须显式提供成对的独立 `OBJECT_STORE_*` 凭据，不回退使用 SES 的 AWS 凭据链；无自定义端点的 AWS S3 可使用默认 AWS 凭据链
- 附件扫描由 `CLAMAV_HOST` 自动决定：Web 和 Worker 都配置扫描器主机时必须取得 `clean` 结果；都不配置时仅校验存储文件的大小和 SHA-256，结果标记为 `verified`，不代表已扫描。两端配置必须一致；业务无需配置扫描主机、端口或超时。详见 [附件安全合同及接入清单](ATTACHMENT-SAFETY.md)

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

此全新项目的 `db/migrations/001_initial.sql` 已包含完整应用结构和出站变更流。后续结构变更追加连续版本 SQL，并在 `db/migrations/checksums.json` 登记 SHA-256。
修改类型化定义、数据库行为或英文业务备注后，执行 `pnpm db:generate` 更新 `db/schema.sql`，执行 `pnpm db:check` 验证；生成器不改写迁移文件，并拒绝缺表、缺字段或空备注的输出。

迁移在同一个事务与 advisory lock 下验证已执行版本的完整 catalog、校验 checksum、应用缺少版本并核对目标快照。执行记录写入 `envoy_meta.migrations`，BullMQ 单独维护其内部结构。
此重置后的 V1 需要新数据库；非空但没有迁移记录的应用数据库会被拒绝。后续有记录的升级保留业务数据。SQL 失败、结构漂移或 checksum 不符会拒绝执行并回滚，不会自动修复或清库。

未来执行需要表锁的迁移前，先备份并停止、排空 Web/Worker 写入；遇到锁冲突时排空写入后重试。
迁移成功后再启动对应 Web/Worker，健康检查与 Worker 启动要求迁移记录达到当前版本。

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

```bash
cd /data/envoy
git pull --ff-only
docker compose build
docker compose run --rm migrate
docker compose up -d web worker
```

数据库迁移或结构校验成功后才会更新 Web 和 Worker 容器。

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

回滚只替换兼容当前数据库结构的应用代码，不会自动恢复数据库；如需恢复数据，请使用经过验证的备份恢复流程。

默认一个 Web 与一个 Worker 的连接预算最多为 48（另留迁移、监控及余量）；增加副本时同步调整数据库连接上限。迁移命令按版本建立或升级业务结构，再调用 BullMQ 官方 API 初始化队列 schema；Web 和 Worker 不执行结构变更。R2 使用桶默认加密，不设置 AWS 专用 SSE 请求头。
