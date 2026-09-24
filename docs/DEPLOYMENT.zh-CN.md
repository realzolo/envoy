# Envoy 发布部署指南

本文只介绍 Envoy 应用本身的构建、上传、启动、升级和回滚流程。

部署方式为：**本地或 CI 构建，上传构建产物，服务器安装依赖并通过 PM2 启动**。服务器默认不执行 Next.js 构建。

## 1. 环境要求

构建机需要：

- Node.js `20.9.0` 或更高版本
- pnpm 10
- Git、tar

服务器需要：

- Node.js `20.9.0` 或更高版本
- pnpm 10、PM2、tar、curl
- 可访问的 PostgreSQL
- 已启用认证的 Redis
- Cloudflare R2 存储桶
- 启用收信或附件时可访问的 ClamAV

安装 pnpm 和 PM2：

```bash
corepack enable
corepack prepare pnpm@10.33.0 --activate
npm install --global pm2
```

## 2. 本地构建发布包

在项目根目录执行：

```bash
pnpm release:build
```

该命令会依次执行依赖安装、类型检查、Lint、测试和 Next.js 生产构建，成功后生成：

```text
dist/envoy-RELEASE_ID.tar.gz
```

发布包不包含 `.env.local` 和 `node_modules`。

建议在与服务器架构一致的 Linux CI 环境中构建。默认不允许从有未提交改动的工作区打包。

## 3. 上传发布包

设置本次发布 ID，值为文件名中 `envoy-` 和 `.tar.gz` 之间的部分：

```bash
release_id="REPLACE_WITH_RELEASE_ID"

ssh deploy@server "mkdir -p /opt/envoy/releases/${release_id}"
scp "dist/envoy-${release_id}.tar.gz" \
  "deploy@server:/opt/envoy/releases/${release_id}/"
```

## 4. 首次部署

登录服务器：

```bash
ssh deploy@server
```

进入对应版本目录并解压：

```bash
release_id="REPLACE_WITH_RELEASE_ID"
release_dir="/opt/envoy/releases/$release_id"
cd "$release_dir"
tar -xzf "envoy-${release_id}.tar.gz"
```

创建生产环境配置：

```bash
mkdir -p /opt/envoy
cp "$release_dir/deploy/env.production.example" /opt/envoy/envoy.env
vi /opt/envoy/envoy.env
```

将模板中的所有 `replace_with_*` 替换为真实值，重点确认：

- `PORT=6178`
- `DATABASE_URL` 指向生产 PostgreSQL
- `REDIS_URL` 包含认证信息和明确的 database 编号
- `ENVOY_KEK_BASE64`、管理员账号密码和 `ENVOY_SESSION_SECRET` 已替换
- R2 Endpoint、存储桶和 S3 凭据正确
- `OBJECT_STORAGE_PREFIX=envoy`
- 启用收信或附件时，`CLAMAV_HOST` 和 `CLAMAV_PORT` 可用

生成 KEK 和 Session Secret：

```bash
openssl rand -base64 32
openssl rand -hex 32
```

注意：

- `ENVOY_KEK_BASE64` 解码后必须为 32 字节，并且必须单独备份。丢失后无法解密已有服务商凭据。
- Redis 连接串末尾 `/0` 表示 database 0，需要使用其他 database 时直接改为 `/14` 等编号。
- Redis 密码包含特殊字符时必须进行 URL 编码。
- R2 对象统一保存在存储桶的 `envoy/` 前缀下。

链接环境配置并部署：

```bash
ln -s /opt/envoy/envoy.env "$release_dir/.env.local"

cd "$release_dir"
./scripts/deploy-pm2.sh

ln -sfn "$release_dir" /opt/envoy/current
```

部署脚本会自动：

1. 安装锁定版本的依赖。
2. 执行 V1 数据库迁移。
3. 启动或重载 `envoy-web` 和 `envoy-worker`。
4. 检查两个 PM2 进程和 `/api/health`。
5. 健康检查通过后执行 `pm2 save`。

## 5. 验证部署

```bash
pm2 status
pm2 logs envoy-web --lines 100
pm2 logs envoy-worker --lines 100
curl --fail http://127.0.0.1:6178/api/health
```

正常情况下，两个 PM2 进程都是 `online`，健康检查返回 HTTP 200，并包含：

```json
{"name":"envoy","status":"ok"}
```

应用默认监听 `127.0.0.1:6178`。

## 6. 后续版本发布

本地重新构建，并按照第 3 节将压缩包直接上传到新的版本目录。登录服务器后执行：

```bash
release_id="REPLACE_WITH_NEW_RELEASE_ID"
release_dir="/opt/envoy/releases/$release_id"
cd "$release_dir"
tar -xzf "envoy-${release_id}.tar.gz"
ln -s /opt/envoy/envoy.env "$release_dir/.env.local"

cd "$release_dir"
./scripts/deploy-pm2.sh

ln -sfn "$release_dir" /opt/envoy/current
```

每个版本使用独立目录，不要覆盖旧版本。只有部署脚本成功后才更新 `/opt/envoy/current`。

## 7. 回滚

切换到上一个可用版本并重新加载 PM2：

```bash
previous_release="/opt/envoy/releases/REPLACE_WITH_PREVIOUS_RELEASE_ID"

cd "$previous_release"
./scripts/deploy-pm2.sh

ln -sfn "$previous_release" /opt/envoy/current
```

数据库迁移不会自动回滚。执行代码回滚前，需要确认旧版本代码兼容当前数据库结构。

## 8. 常用命令

```bash
pm2 status
pm2 logs envoy-web
pm2 logs envoy-worker
pm2 restart envoy-web
pm2 restart envoy-worker
pm2 save
```

修改 `/opt/envoy/envoy.env` 后，重新加载两个进程：

```bash
cd /opt/envoy/current
pm2 startOrReload ecosystem.config.cjs --update-env
```

服务器提示缺少 `.next/BUILD_ID` 时，说明上传的不是完整发布包，应重新执行 `pnpm release:build` 后上传。
