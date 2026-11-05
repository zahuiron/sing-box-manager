# sing-box-manager

一个面板，管理多台服务器上的 [sing-box](https://github.com/SagerNet/sing-box)。

集中管理服务器、入站节点、配置草稿、模板和客户端订阅。Panel 提供网页与管理 API，Agent 部署在各台服务器上，负责本机配置、核心启停和日志；两者通过 HTTPS 通信。

[快速开始](#快速开始) · [Docker 部署](#docker-部署) · [使用指南](#使用指南) · [配置参考](#配置参考) · [源码构建](#源码构建)

## 功能特性

- **多服务器管理**：统一查看状态和版本，管理服务器顺序，启动、停止或重启核心。
- **入站节点管理**：创建、编辑、复制和删除入站，支持目标核心 Schema 表单与完整 JSONC 编辑。
- **草稿与发布**：先保存中心草稿，再显式发布；发布时校验配置、检查版本冲突并保留备份，应用失败时尝试回滚。
- **三类模板**：服务端模板、客户端模板和用户模板，复用配置片段及多协议认证。
- **客户端订阅**：多份独立订阅，按已发布节点生成出站，支持节点分组、预览、下载和 NAT 地址覆盖。
- **服务与日志**：核心异常退出自动恢复，日志按需跟随，支持搜索、过滤、复制和导出。
- **备份与恢复**：统一导出服务器、模板、订阅、草稿和发布快照，保留 ID 与订阅链接密钥。

Go 后端使用标准库，前端构建后嵌入 Panel 程序，无需额外数据库或常驻 Node.js 服务。界面支持简体中文、英文、深浅主题和自定义强调色。

## 支持环境

| 环境 | 系统服务 | 架构 |
| --- | --- | --- |
| Debian 系，含 Ubuntu 等衍生系统 | systemd | x86_64 / ARM64 |
| Alpine | OpenRC | x86_64 / ARM64 |
| Docker | 独立 Alpine 镜像 | linux/amd64、linux/arm64 |

安装脚本自动识别系统和架构。三种环境都由 Agent 直接管理 sing-box 子进程；Panel 可部署在另一台机器上。

## 快速开始

下列命令使用测试版 `0.0.0.2`。脚本的 `--version` 使用 `v0.0.0.2`，镜像标签使用 `0.0.0.2`；测试版不更新 `latest`。

以下命令以 root 执行。Panel 所在机器需能访问各 Agent 的管理端口。

### 1. 安装 Panel

在管理面板所在机器执行：

```sh
curl -fsSL https://raw.githubusercontent.com/zahuiron/sing-box-manager/main/deploy/install-sing-box-manager-panel.sh | sh -s -- --version v0.0.0.2 --port 18080
```

安装后打开 `http://<面板地址>:18080`，填写面板 URL 和密钥，名称可留空。首次安装自动生成密钥，保存在 `/etc/sing-box-manager-panel/config.json` 的 `secret`；重复部署保留已有密钥。也可通过 `--secret` 指定。

默认监听 `0.0.0.0:18080`。使用 HTTPS 时，可配置反向代理，或通过 `--cert`、`--key` 指定 Panel 证书。

### 2. 安装 Agent

在每台运行 sing-box 的服务器上，先准备单文件配置与已签发的 TLS 证书，再执行：

```sh
curl -fsSL https://raw.githubusercontent.com/zahuiron/sing-box-manager/main/deploy/install-sing-box-manager-agent.sh | sh -s -- --version v0.0.0.2 --port 9091
```

默认配置路径为 `/etc/sing-box-manager-agent/sing-box.json`，工作目录为 `/var/lib/sing-box-manager-agent`。Agent 自动从配置中定位已有证书或 ACME 缓存，也可通过参数覆盖路径。

脚本默认安装最新稳定版 sing-box；使用已有核心时加 `--skip-sing-box`，指定版本时加 `--sing-box-version <版本号>`。接管已有部署时，会停止旧核心服务并取消其开机启动，保留原服务文件，部署失败时尝试恢复。更新 Agent 会重启其托管的核心。

### 3. 接入服务器

在 Panel 的“总览”中添加服务器：

| 字段 | 填写内容 |
| --- | --- |
| 名称 | 便于识别的服务器名称 |
| URL | `https://node.example.com:9091`，域名须在 Agent 证书覆盖范围内 |
| Token | `/etc/sing-box-manager-agent/config.json` 中的 `token` |

测试连接并保存后，即可进入该服务器的概览、节点、配置和日志。首次读取配置会将远端文件导入为中心草稿。

## Docker 部署

Panel 和 Agent 使用独立镜像，支持 `linux/amd64`、`linux/arm64`：

| 组件 | 测试版镜像 | 默认启动命令 | 用途 |
| --- | --- | --- | --- |
| Panel | `ghcr.io/zahuiron/sing-box-manager-panel:0.0.0.2` | `sing-box-manager-panel` | 网页与管理 API |
| Agent | `ghcr.io/zahuiron/sing-box-manager-agent:0.0.0.2` | `sing-box-manager-agent -env` | 管理同一容器内的 sing-box 核心 |

镜像版本直接使用镜像标签选择。启动参数通过容器环境变量配置，默认值和用途见下方[配置参考](#配置参考)。Panel 默认使用 HTTP，监听 `0.0.0.0:18080`；Agent 默认使用 HTTPS，监听 `:9091`。修改端口使用 `PANEL_LISTEN` 或 `AGENT_LISTEN`。

宿主机目录由部署时自行指定，挂载到以下容器内目录：

| 组件 | 默认容器内目录 | 用途 |
| --- | --- | --- |
| Panel | `/var/lib/sing-box-manager-panel/` | 服务器列表、模板、订阅、配置草稿与发布快照、`master.key` 和自动生成的 `panel.key` |
| Agent | `/etc/sing-box-manager-agent/` | 核心配置 `sing-box.json`，以及发布时生成的 `sing-box.json.bak` |
| Agent | `/var/lib/sing-box-manager-agent/` | 核心工作目录，保存下载的 `bin/sing-box`、版本记录、自动生成的 `agent.key` 及核心运行数据 |

Agent 镜像的 `XDG_DATA_HOME` 默认指向 `/var/lib/sing-box-manager-agent`，ACME 证书、私钥及账户缓存位于其 `certmagic/` 子目录，随 Agent 数据一起持久化。

Agent 启动前，须准备核心配置并挂载整个配置目录，以支持发布时的原子替换。自定义证书路径或 ACME 缓存路径时，须将相应文件挂载到容器内。Agent 默认下载最新稳定版核心，也可通过 `SING_BOX_VERSION` 指定版本；程序保存在数据目录中。按实际部署设置管理端口及核心业务端口的映射，或使用宿主机网络。

未指定 `PANEL_SECRET` / `AGENT_TOKEN` 时，首次启动会自动生成访问密钥并写入各自的数据目录，仅生成时在容器日志输出 `generated access key: ...`。保留数据目录即可在重启、重建后复用；显式指定密钥时优先使用，不输出到日志。

打开 Panel 地址，使用 Panel 密钥连接；添加 Agent 时填写其 HTTPS 地址及 Agent Token。Panel 自己提供 HTTPS 时，须同时指定 `PANEL_TLS_CERT` 和 `PANEL_TLS_KEY`；通过反向代理提供 HTTPS 时，Panel 可继续使用 HTTP。

已有 Docker 部署更新时，将原宿主机数据目录挂载到上述新容器内路径，保留原密钥文件。核心配置文件名不同时，通过 `SING_BOX_CONFIG` 指向实际文件。原生部署须先停用旧 Panel、Agent 服务，将原运行配置分别迁至 `/etc/sing-box-manager-panel/config.json`、`/etc/sing-box-manager-agent/config.json`，再运行新安装脚本；已有配置中的数据目录及核心路径会保留，迁移目录时同步修改对应字段。

## 使用指南

### 节点与配置发布

1. 在“节点”中选择服务器，创建或编辑入站；出站、端点和服务在该服务器的完整配置中编辑。
2. 点击“保存草稿”，将修改保存在 Panel。`r2` 等标记表示草稿版本号。
3. 可先执行“核心校验”，再点击“发布配置”。发布会由目标核心校验并写入远端，原来运行中的核心会重启，已停止的核心保持停止。

“未保存”表示修改仍在浏览器中，“未发布”表示草稿尚未发布到远端。复制节点后，应检查监听端口和配置引用。字段表单保留未知字段，编辑后会移除注释；JSON 视图支持 JSONC、搜索、撤销、重做和格式化。

“导入远端”将当前远端配置作为新基线，替换草稿与发布快照；“恢复发布快照”将最近快照恢复为草稿，仍需再次发布。遇到版本冲突时，先保留自己的修改，再重新读取并合并。

### 模板

| 类型 | 保存内容 | 使用位置 |
| --- | --- | --- |
| 服务端模板 | 完整配置、配置片段或协议对象 | 服务器配置与节点编辑 |
| 客户端模板 | 客户端完整配置或配置片段 | 订阅中的“选择模板” |
| 用户模板 | 同一用户的多协议认证 | 节点与订阅中的用户选择 |

模板与用户均可独立创建，无需连接服务器。配置模板使用内置字段定义，支持按 `type` 选择协议，也可切换 JSONC；类别沿用 `inbounds`、`outbounds`、`dns`、`route` 等 sing-box 原文。

创建用户模板时，“用户”可填中文，仅作管理标识；协议的 `name`、`username`、密码或 UUID 独立填写。节点通过“选择用户模板”导入认证，支持多用户的入站可多选。用户模板不用于 Panel 登录。

服务端模板按配置类别和已有协议匹配，调用时保留节点 tag；用户认证按协议用户名或 UUID 更新，其余认证保留。调用只复制内容，后续修改模板库不会自动更新节点或订阅。Shadowsocks 2022 AES 多用户出站需先填写服务端主密钥。

### 客户端订阅

1. 先将节点及对应用户认证保存并发布，再创建订阅、选择用户模板。
2. 点击“选择模板”，可多选客户端完整配置或片段。对象按选择顺序合并，数组追加，字段冲突时报错；模板中的 `outbounds` 须移除或清空，由 Panel 生成。
3. 勾选需要的节点，可修改订阅中的名称、对外地址、端口和 SNI。NAT 环境填写实际业务映射；默认地址取 Agent URL 主机名，端口取入站监听端口。
4. 按需启用直连，创建选择组或测速组，并分别选择节点及其他组。成员使用固定标识关联，改名保留引用；取消节点或删除组时清理对应引用，禁止循环引用。
5. 点击“预览”检查完整配置与实际认证，修正窗口中列出的错误后保存。随后可复制独立链接、复制配置或下载文件；重置链接或删除订阅后，旧链接失效。

订阅使用模板副本和已发布配置中的认证；未发布的密码不会导出。远端手动修改后需重新导入。更新模板副本、节点选择或发布配置后，客户端下次拉取生效。持有订阅链接即可取得对应配置，请妥善保存。

<details>
<summary>订阅支持的协议与生成范围</summary>

- 支持 AnyTLS、Hysteria/Hysteria2、VLESS/VMess、Trojan、TUIC、Shadowsocks、HTTP/Mixed/SOCKS、Naive、Snell v6 的常规入站，以及 TLS/Reality 和常见 V2Ray transport。
- ECH、强制客户端证书、组合链路、动态用户及中继不自动生成。缺少认证或不支持的节点会说明原因；每份配置最多 4096 个节点、2 MiB，客户端核心须支持对应字段。
- 选择、测速、直连等特殊出站排在普通节点前，组成员也采用此顺序；普通节点沿用服务器顺序。仅启用直连时可生成直连配置。
- 生成订阅时不访问 Agent，也不改变服务器。订阅预览使用面板内置 Schema 检查，实际运行兼容性以客户端核心为准。

</details>

### 备份与恢复

在“设置 → 备份与恢复”导出单个 JSON，包含服务器及排序、三类模板、订阅及链接密钥、草稿和发布快照。**备份为明文，包含 Token、密码和 UUID。**

恢复时先校验文件，再居中确认并整体替换 Panel 数据；失败时回退，进程中断后在下次启动时恢复。文件最大 128 MiB，保留 ID 和链接密钥；面板地址不变时，原订阅链接继续有效。恢复不连接 Agent，远端配置仍需手动发布。

手动备份原始数据目录时，需一起保存 `panel.json`、`drafts/`、`library.bin`、`master.key`，以及存在时的 `panel.key`。网页导出的 JSON 不依赖旧存储密钥。Panel 部署参数、访问密钥、浏览器偏好，以及远端证书和日志不在备份范围内。

### 服务、日志与面板连接

核心意外退出后三秒自动重试，一分钟最多五次；手动停止会取消重试。停止核心后 Agent 仍可访问；重启 Agent 会重启其托管的核心，启动行为由 `auto_start` 决定。

日志来自核心标准输出和标准错误。请去掉 sing-box 配置中的 `log.output`；日志缓冲最多 1000 行、256 KiB，每次核心启动清空。网页支持暂停、搜索、级别过滤、复制和导出，“清空显示”只清理当前网页。容器的 `docker logs` 主要显示 Agent 自身日志。

业务服务器在“总览”管理；左下角和“设置 → 服务器”保存其他 Panel 的连接，显示当前 Panel 运行时间。连接及密钥保存在当前站点的浏览器中，“断开连接”清除当前密钥。Panel 最多管理 64 台服务器，状态按需读取，日志仅在查看时跟随；关闭网页或停止 Panel 不影响各服务器的核心运行。

## 配置参考

<details>
<summary>安装脚本参数</summary>

以下为首次安装且未提供覆盖时的默认值；重复安装时，运行配置中未显式覆盖的字段沿用已有值。`--listen` 优先于 `--port`。

| 参数 | Panel 默认值 | Agent 默认值 | 用途 |
| --- | --- | --- | --- |
| `--port` | `18080` | `9091` | 管理端口 |
| `--listen` | `0.0.0.0:18080` | `:9091` | 完整监听地址，可指定 IP 与端口 |
| `--version` | `latest` | `latest` | 本项目 Release 标签；测试版须显式指定，如 `v0.0.0.2` |
| `--binary` | 未指定 | 未指定 | 使用本地 Panel / Agent 程序；省略时按架构下载本项目 Release |
| `--secret` | 自动生成 | — | Panel 访问密钥 |
| `--token` | — | 自动生成 | Agent 访问 Token |
| `--data-dir` | `/var/lib/sing-box-manager-panel` | — | Panel 业务数据目录 |
| `--cert` / `--key` | 未设置，使用 HTTP | 从核心配置自动定位 | HTTPS 证书与私钥文件，显式指定时须成对设置 |
| `--tls-domain` | — | 自动选择 | 选择 Agent 使用的 ACME 证书域名 |
| `--acme-dir` | — | 自动定位，见 TLS 证书复用 | 覆盖 ACME 缓存根目录 |
| `--sing-box-version` | — | `latest` | 要安装的核心版本；默认最新稳定版，支持带或不带 `v` |
| `--skip-sing-box` | — | 不启用 | 跳过核心安装，使用已有核心 |
| `--sing-box-binary` | — | 从 PATH 查找，找不到时安装至 `/var/lib/sing-box-manager-agent/bin/sing-box` | 核心程序位置 |
| `--sing-box-config` | — | `/etc/sing-box-manager-agent/sing-box.json` | 需预先准备的核心单文件配置 |
| `--work-dir` | — | `/var/lib/sing-box-manager-agent` | 核心工作目录 |
| `--auto-start true/false` | — | `true` | 是否随 Agent 启动核心 |
| `--service` | — | `sing-box` | 待接管的已有核心服务名 |
| `--help` / `-h` | 不启用 | 不启用 | 显示脚本参数并退出 |

首次接管已停止的旧核心服务时，未指定 `--auto-start` 则保持停止。

脚本将 Panel、Agent 程序分别安装到 `/usr/local/bin/sing-box-manager-panel`、`/usr/local/bin/sing-box-manager-agent`，运行配置分别写入 `/etc/sing-box-manager-panel/config.json`、`/etc/sing-box-manager-agent/config.json`。脚本生成的访问密钥保存在对应运行配置中。

Panel 支持参数、环境变量和配置文件，优先级依次降低；修改文件后重启生效。访问密钥为 1–1024 个可见 ASCII 字符，不含空格，可用 `sing-box-manager-panel -generate-secret` 生成。

Debian 系使用 `systemctl status sing-box-manager-panel`、`systemctl status sing-box-manager-agent`；Alpine 使用对应的 `rc-service sing-box-manager-panel status`、`rc-service sing-box-manager-agent status`。这些系统服务命令管理 Panel 或 Agent，核心启停在面板完成。

</details>

<details>
<summary>镜像环境变量</summary>

以下变量由容器中的程序读取；路径均指容器内部。宿主机路径通过容器挂载自行选择，修改数据、密钥或证书位置时须同步调整挂载。

**Panel**

| 变量 | 镜像默认值 | 用途 |
| --- | --- | --- |
| `PANEL_LISTEN` | `0.0.0.0:18080` | 完整监听地址，包含 IP 与端口 |
| `PANEL_DATA_DIR` | `/var/lib/sing-box-manager-panel` | 面板业务数据目录 |
| `PANEL_SECRET` | 未设置，首次自动生成 | 面板访问密钥；显式设置时优先使用 |
| `PANEL_SECRET_FILE` | `/var/lib/sing-box-manager-panel/panel.key` | 未指定访问密钥时读取或生成的密钥文件 |
| `PANEL_TLS_CERT` | 未设置 | Panel 自己提供 HTTPS 时使用的证书文件 |
| `PANEL_TLS_KEY` | 未设置 | 对应的证书私钥文件；与 `PANEL_TLS_CERT` 成对设置 |

Panel 访问密钥须为 1–1024 个可见 ASCII 字符，不含空格。证书变量均未设置时使用 HTTP；证书续期后支持重载。

**Agent**

| 变量 | 镜像默认值 | 用途 |
| --- | --- | --- |
| `AGENT_LISTEN` | `:9091` | HTTPS 管理接口的完整监听地址，空主机部分表示监听全部地址 |
| `AGENT_TOKEN` | 未设置，首次自动生成 | Agent 访问 Token，至少 32 个非空白字符；显式设置时优先使用 |
| `AGENT_TOKEN_FILE` | `/var/lib/sing-box-manager-agent/agent.key` | 未指定 Token 时读取或生成的密钥文件 |
| `AGENT_TLS_CERT` | 从核心配置自动定位 | 覆盖 Agent 使用的 HTTPS 证书文件 |
| `AGENT_TLS_KEY` | 从核心配置自动定位 | 覆盖证书私钥文件；与 `AGENT_TLS_CERT` 成对设置 |
| `AGENT_TLS_DOMAIN` | 自动选择 | 选择 ACME 证书域名 |
| `AGENT_ACME_DIR` | 自动定位，见 TLS 证书复用 | 覆盖 ACME 缓存根目录 |
| `AGENT_SERVICE` | `sing-box` | 核心服务标识；容器内仍由 Agent 直接管理核心进程 |
| `SING_BOX_VERSION` | `latest` | 要安装的核心版本，默认最新稳定版 |
| `SING_BOX_AUTO_INSTALL` | `true` | 启动时按需安装核心；使用自行提供的程序时可设为 `false` |
| `SING_BOX_BINARY` | `/var/lib/sing-box-manager-agent/bin/sing-box` | 核心程序位置 |
| `SING_BOX_CONFIG` | `/etc/sing-box-manager-agent/sing-box.json` | 需预先准备的核心单文件配置 |
| `SING_BOX_WORK_DIR` | `/var/lib/sing-box-manager-agent` | 核心工作目录，核心配置中的相对路径以此为基准 |
| `SING_BOX_AUTO_START` | `true` | 是否随 Agent 启动核心；`false` 时仅运行 Agent，须已有可加载的证书 |

Docker 中的 Agent 默认从环境变量启动。脚本安装时，持久化的配置由安装脚本参数设置。自动生成的密钥只在生成时输出；日志清理后可从密钥文件读取，更新时须保留对应的数据目录。

| 系统变量 | 镜像默认值 | 用途 |
| --- | --- | --- |
| `XDG_DATA_HOME` | `/var/lib/sing-box-manager-agent` | 核心与 Agent 共同使用的默认数据根目录；ACME 缓存位于其 `certmagic/` 子目录 |

</details>

<details>
<summary>TLS 证书复用</summary>

Agent 可读取配置中的 `certificate_path`、`key_path`，或按 ACME 域名定位 `certificates/<签发机构>/<域名>/<域名>.crt` 和 `.key`。缓存目录优先取 `data_directory`，否则使用 `$XDG_DATA_HOME/certmagic` 或 `$HOME/.local/share/certmagic`；`--acme-dir` 可显式覆盖。

多域名时用 `--tls-domain` 选择，特殊路径可用 `--cert`、`--key` 覆盖。`account_key` 是 ACME 账户密钥，不能代替证书私钥。原生脚本部署前须已有可加载的证书；Docker 首次启动可先运行核心等待签发，最多五分钟。

Panel 验证 Agent 的证书链、有效期和地址匹配；私有 CA 可在服务器接入设置中配置受信 CA。证书签发与续期由 sing-box 负责，Agent 从本机加载文件，在新 TLS 连接时检查更新，每分钟最多一次；服务 reload 可立即重载。加载失败保留原证书。

</details>

<details>
<summary>Agent API</summary>

接口通过 HTTPS 访问，要求 `Authorization: Bearer <token>`。

| 接口 | 用途 |
| --- | --- |
| `GET /v1/status` | API、Agent、核心版本、服务状态和部署环境 |
| `GET /v1/config` | 原始配置与 ETag |
| `GET /v1/schema` | 目标核心的完整 Schema，按需生成并缓存 |
| `POST /v1/config/check` | `{"content":"配置原文"}`，仅校验 |
| `PUT /v1/config` | 同上，可加 `"apply":true`；须带当前 `If-Match` |
| `POST /v1/service/{action}` | start、stop、restart |
| `GET /v1/logs?lines=100&follow=true` | 读取近期日志并按需跟随 |

配置最大 2 MiB，校验通过后备份并原子写入。外部修改返回 412，并行变更返回 409；超时或断线后应重新查询结果。Agent 最多四个日志读取者，日常服务器列表接口不返回保存的 Agent Token。

</details>

## 源码构建

构建环境与 [Release 工作流](.github/workflows/release.yml)一致：Go 1.27.3、Node.js 24、npm。以下命令在 Linux 仓库目录执行：

```sh
npm --prefix web ci --ignore-scripts --no-audit --no-fund
npm --prefix web run build
mkdir -p .tools/build
CGO_ENABLED=0 go build -buildvcs=false -trimpath -o .tools/build/sing-box-manager-panel ./cmd/sing-box-manager-panel
CGO_ENABLED=0 go build -buildvcs=false -trimpath -o .tools/build/sing-box-manager-agent ./cmd/sing-box-manager-agent
```

以 root 通过本地程序安装：

```sh
sh deploy/install-sing-box-manager-panel.sh --binary "$PWD/.tools/build/sing-box-manager-panel" --port 18080
sh deploy/install-sing-box-manager-agent.sh --binary "$PWD/.tools/build/sing-box-manager-agent" --skip-sing-box --port 9091
```

Agent 仍需先准备 sing-box 配置和证书；需要由脚本安装核心时去掉 `--skip-sing-box`。构建 Docker 镜像使用对应文件：

```sh
docker build -f Dockerfile.sing-box-manager-panel -t sing-box-manager-panel .
docker build -f Dockerfile.sing-box-manager-agent -t sing-box-manager-agent .
```

<details>
<summary>源码结构与发布产物</summary>

| 项目 | Panel | Agent |
| --- | --- | --- |
| 启动入口 | `cmd/sing-box-manager-panel/main.go` | `cmd/sing-box-manager-agent/main.go` |
| 业务实现 | `internal/panel/` | `internal/agent/` |
| 程序与系统服务 | `sing-box-manager-panel` | `sing-box-manager-agent` |
| Docker 构建文件 | `Dockerfile.sing-box-manager-panel` | `Dockerfile.sing-box-manager-agent` |
| 安装脚本 | `deploy/install-sing-box-manager-panel.sh` | `deploy/install-sing-box-manager-agent.sh` |

`web/` 为网页，构建后嵌入 Panel；`internal/coreinstall/` 提供核心下载安装。模板字段定义内置于 `web/src/schema/sing-box.schema.json`，由对应版本的 `sing-box schema` 输出更新，网页按需加载。

工作流按版本标签或手动指定的已有标签发布四个 Linux 程序包：`sing-box-manager-panel-linux-amd64.tar.gz`、`sing-box-manager-panel-linux-arm64.tar.gz`、`sing-box-manager-agent-linux-amd64.tar.gz`、`sing-box-manager-agent-linux-arm64.tar.gz`。程序包附带许可证、第三方声明和源码地址；两个多架构镜像发布到 GHCR，稳定版更新 latest 标签。镜像内许可证分别位于 `/usr/share/licenses/sing-box-manager-panel/`、`/usr/share/licenses/sing-box-manager-agent/`，Panel 的“设置 → 许可证”可查看声明。

版本使用 `主版本.次版本.修订版本.测试版本`，Git 标签加 `v` 前缀。第四位大于 0 为测试版，归零为正式版；测试更新第四位加 1，小更新第三位加 1，中更新第二位加 1，大更新第一位加 1，增加某位时将其后各位归零。测试版标为 Prerelease，不更新 Docker 的 `latest`。

</details>

## 致谢与许可证

- [sing-box](https://github.com/SagerNet/sing-box)：代理核心。
- [sing-box-dashboard](https://github.com/SagerNet/sing-box-dashboard)：通用 UI 源码和样式。

采用 [GPL-3.0-or-later](LICENSE)。第三方来源与许可见[第三方说明](web/THIRD_PARTY.md)。

## 免责声明

使用本项目时，请遵守所在地法律法规和服务商条款，勿用于未经授权的访问、攻击或其他违法活动。

在适用法律允许的范围内，本项目按“现状”提供，不作任何明示或默示担保；版权持有人和贡献者不承担因使用本项目产生的损失。具体条款见[许可证](LICENSE)。
