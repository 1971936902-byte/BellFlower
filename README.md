# BellFlower

风铃草 BellFlower 是一个轻量跨网络虚拟局域网 Demo。本仓库实现需求说明书中的控制面最小可用闭环：设备用同一组网密钥入网、自动分配 `10.144.0.0/24` 虚拟 IP、同步在线状态、生成点对点优先和中继降级的链路视图，并提供网页控制台与 CLI 客户端用于验证。

> 当前 Demo 不直接安装系统 TUN/TAP 驱动，也不下发真实 WireGuard 配置。Windows、iOS、Android 的 WireGuard/TUN 集成需要平台权限、签名和发布流水线，已保留为下一阶段客户端内核对接点。

## 功能

- 密钥组网：相同 `networkKey` 自动进入同一虚拟网络。
- 设备身份：支持备注名称、平台、能力和候选端点上报。
- 虚拟 IP：从 `10.144.0.2` 开始自动分配，网段为 `10.144.0.0/24`。
- 状态监控：心跳保持在线，超时自动离线。
- 链路视图：UDP 能力可用时标记为 `p2p`，否则降级为 `relay`。
- 控制台：浏览器打开服务地址即可查看设备列表。
- CLI 客户端：用于模拟 Windows、iOS、Android 设备入网和心跳。

## 快速启动

```powershell
node src/server.js
```

打开 `http://localhost:8787`，输入组网密钥和设备备注即可入网。

也可以启动一个 CLI 设备：

```powershell
$env:BELLFLOWER_KEY="demo-secret"
$env:BELLFLOWER_NAME="Windows-PC"
node src/client.js
```

另开终端启动第二个设备：

```powershell
$env:BELLFLOWER_KEY="demo-secret"
$env:BELLFLOWER_NAME="Android-Phone"
node src/client.js
```

## HTTP API

### 健康检查

```http
GET /health
```

### 设备入网

```http
POST /api/join
content-type: application/json

{
  "networkKey": "demo-secret",
  "name": "Windows-PC",
  "platform": "windows",
  "capabilities": ["udp", "relay"],
  "endpoints": ["udp:0.0.0.0:51820"]
}
```

### 心跳

```http
POST /api/heartbeat
content-type: application/json

{
  "networkId": "返回的 networkId",
  "deviceId": "返回的 device.id"
}
```

### 查询网络

```http
GET /api/networks/{networkId}
```

## WebSocket 协议

连接 `ws://localhost:8787/ws` 后先发送 `join` 消息：

```json
{
  "type": "join",
  "networkKey": "demo-secret",
  "name": "iPhone",
  "platform": "ios",
  "capabilities": ["udp", "relay"],
  "endpoints": ["udp:0.0.0.0:51820"]
}
```

服务端会返回 `joined`，并在设备状态变化时广播 `peers`。客户端可周期发送：

```json
{ "type": "heartbeat" }
```

## 测试

```powershell
node --test
```

## 后续集成路线

1. 服务端增加正式 SQLite 表结构、STUN 候选地址收集和中继节点管理。
2. Windows 客户端接入 Wintun/WireGuard-Go，按控制面下发的 peer 信息生成真实隧道配置。
3. Flutter 客户端接入 WireGuard 移动端 SDK，实现后台保活和虚拟 IP 访问。
4. 增加真实链路探测、端口连通性测试、Relay 流量转发与国内节点部署配置。
